//! Asks the provider what became of a video publication whose outcome this
//! Studio never learned, and records the answer.
//!
//! Asking is safe because the publication is fenced by its job's request id:
//! re-issuing it returns the post the provider already made. The platform
//! link means published; a provider-side failure means the audience got
//! nothing, so the target goes back to `failed` where the ordinary retry can
//! pick it up; anything else is still in flight and stays in
//! `verification_required`. Deliberately provider-only: a native upload has no
//! such fence, and re-sending one is how a video gets published twice.

use db::rusqlite::{OptionalExtension, params};
use foundation::config::Config;
use serde_json::{Map, Value, json};

use super::Publishing;
use super::boundaries::{ProviderOutcome, VideoProvider};
use super::video_assets::video_public_url;
use super::video_data::{VideoTargetRow, video_target};
use super::video_fence::zernio_publish_fence;
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::repositories::StudioSettingsStore;
use crate::{Error, Result};

/// What the operator can see on the platform.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct KnownPublication {
    pub provider_post_id: Option<String>,
    pub external_id: Option<String>,
    pub url: Option<String>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct SettleVideoInput<'a> {
    pub video_draft_id: i64,
    pub target: &'a str,
    pub apply: bool,
    pub known: Option<KnownPublication>,
}

fn outcome_json(outcome: &ProviderOutcome) -> Value {
    json!({
        "providerPostId": outcome.provider_post_id,
        "externalId": outcome.external_id,
        "url": outcome.url,
        "failure": outcome.failure,
    })
}

fn merge(mut base: Map<String, Value>, extra: Map<String, Value>) -> Map<String, Value> {
    for (key, value) in extra {
        base.insert(key, value);
    }
    base
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("built as an object"),
    }
}

impl Publishing<'_> {
    pub async fn settle_video_target(
        &self,
        config: &Config,
        provider: &impl VideoProvider,
        input: &SettleVideoInput<'_>,
    ) -> Result<Map<String, Value>> {
        let reference = publication_ref(PublicationRefKind::Video, input.video_draft_id);
        let target = input.target;
        let row = video_target(self.sqlite, input.video_draft_id, target)?
            .ok_or_else(|| Error::message(format!("{reference} has no {target} target")))?;
        // A target carrying a link is already settled.
        if row.external_id.as_deref().is_some_and(|id| !id.is_empty())
            || row.external_url.as_deref().is_some_and(|url| !url.is_empty())
        {
            return Err(Error::message(format!("{target} already has its platform publication")));
        }
        // `failed` is asked about too: the provider's verdict usually put a
        // target there, and that verdict has been wrong about a live Reel.
        if !matches!(row.status.as_str(), "verification_required" | "published" | "failed") {
            return Err(Error::message(format!(
                "{target} is {}, and only a target awaiting its platform link is settled this way",
                row.status
            )));
        }
        if row.delivery_provider != "zernio" {
            return Err(Error::message(format!(
                "{target} is delivered natively, which has no idempotent replay: settle it from what the platform shows"
            )));
        }
        let account_id = row
            .provider_account_id
            .clone()
            .filter(|id| !id.is_empty())
            .ok_or_else(|| Error::message(format!("{target} has no provider account id")))?;

        // What the operator can see on the platform outranks anything this
        // Studio can work out from the provider.
        if let Some(known) = input.known.as_ref().filter(|known| {
            known.external_id.as_deref().is_some_and(|id| !id.is_empty())
                || known.url.as_deref().is_some_and(|url| !url.is_empty())
        }) {
            let observed = ProviderOutcome {
                provider_post_id: known.provider_post_id.clone().or_else(|| row.provider_post_id.clone()),
                external_id: known.external_id.clone(),
                url: known.url.clone(),
                failure: None,
            };
            if !input.apply {
                return Ok(object(json!({
                    "ref": reference, "target": target, "observed": outcome_json(&observed), "applied": false,
                })));
            }
            let recorded = self.record_video_settlement(&row, input.video_draft_id, &observed)?;
            return Ok(merge(recorded, object(json!({ "observed": outcome_json(&observed) }))));
        }

        let publish_job: (i64, String) = self
            .sqlite
            .query_row(
                r#"select "id", "run_at" from "video_jobs" where ("video_jobs"."video_target_id" = ? and "video_jobs"."kind" = ?) order by "video_jobs"."id" desc"#,
                params![row.id, "publish"],
                |found| Ok((found.get(0)?, found.get(1)?)),
            )
            .optional()?
            .ok_or_else(|| Error::message(format!("{target} has no publish job to ask about")))?;
        let request_id = zernio_publish_fence(publish_job.0, &publish_job.1);
        let plan = object(json!({
            "ref": reference, "target": target, "provider": "zernio", "requestId": request_id, "applied": false,
        }));
        if !input.apply {
            return Ok(plan);
        }
        // A publication whose id is known is asked about; one whose id is not
        // is asked for, under the fence that makes asking indistinguishable
        // from having asked before.
        let outcome = match row.provider_post_id.as_deref().filter(|id| !id.is_empty()) {
            Some(provider_post_id) => provider.post_outcome(provider_post_id, "instagram").await?,
            None => {
                let draft = self.get_video_draft(input.video_draft_id)?;
                let public_url = video_public_url(self.sqlite, config, draft.studio_media_asset_id)?;
                ProviderOutcome {
                    failure: None,
                    ..provider
                        .publish_instagram_reel(
                            &account_id,
                            &public_url,
                            &Value::Object(row.metadata.clone()),
                            &request_id,
                        )
                        .await?
                }
            }
        };
        let recorded = self.record_video_settlement(&row, input.video_draft_id, &outcome)?;
        Ok(merge(plan, recorded))
    }

    fn record_video_settlement(
        &self,
        row: &VideoTargetRow,
        video_draft_id: i64,
        outcome: &ProviderOutcome,
    ) -> Result<Map<String, Value>> {
        let now = self.now();
        let landed = outcome.external_id.as_deref().is_some_and(|id| !id.is_empty())
            || outcome.url.as_deref().is_some_and(|url| !url.is_empty());
        let failure = outcome.failure.clone().filter(|failure| !failure.is_empty());
        let status = if landed {
            "published"
        } else if failure.is_some() {
            "failed"
        } else {
            "verification_required"
        };
        // Fenced on the state this settlement was decided from: the checks
        // ran before a provider round-trip, and the reconciliation sweep
        // settles the same target under its own fence.
        let settled = self
            .sqlite
            .query_row(
                r#"update "video_targets" set "status" = ?, "provider_post_id" = ?, "external_id" = ?, "external_url" = ?, "published_at" = ?, "last_error" = ?, "confirmation_source" = ?, "verified_at" = ?, "updated_at" = ? where ("video_targets"."id" = ? and "video_targets"."status" = ? and "video_targets"."external_id" is null and "video_targets"."external_url" is null) returning "id""#,
                params![
                    status,
                    outcome.provider_post_id,
                    outcome.external_id,
                    outcome.url,
                    landed.then(|| row.published_at.clone().unwrap_or_else(|| now.clone())),
                    (!landed).then(|| {
                        outcome
                            .failure
                            .clone()
                            .unwrap_or_else(|| "awaiting the platform link from the provider".into())
                    }),
                    if landed { "provider_verify" } else { "idempotency_replay" },
                    landed.then_some(now.as_str()),
                    now,
                    row.id,
                    row.status
                ],
                |found| found.get::<_, i64>(0),
            )
            .optional()?;
        if settled.is_none() {
            return Err(Error::message(format!(
                "{} was settled by something else while the provider was being asked; read its state again",
                row.target
            )));
        }
        let retention_hours = StudioSettingsStore::new(self.sqlite).profile()?.video_retention_hours;
        self.refresh_video_draft_status(video_draft_id, retention_hours)?;
        // An answer is an outcome, and an outcome is what the operator is
        // waiting to hear.
        self.boundaries
            .video_completion
            .record_if_final(self.sqlite, video_draft_id)?;
        Ok(object(json!({
            "applied": true,
            "providerPostId": outcome.provider_post_id,
            "externalId": outcome.external_id,
            "url": outcome.url,
            "failure": outcome.failure,
            "status": status,
        })))
    }
}
