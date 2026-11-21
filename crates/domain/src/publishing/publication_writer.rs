//! Persists a publication plan: locale rows, delivery jobs and the draft's
//! schedule, in the caller's transaction. A target whose delivery is settled,
//! in flight or half-published is never replanned.

use std::sync::LazyLock;

use content::Locale;
use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{params, params_from_iter};
use regex::Regex;
use serde_json::Value;

use super::Publishing;
use super::cancellation::clear_delivery_cancellation;
use super::delivery_payload::{has_resume_state, new_delivery_payload};
use super::payload::localize_target_payload;
use super::publication_plan::{PublicationPlan, PublishMode};
use super::queue::{EnqueuePublishJob, enqueue_publish_job_tx};
use super::queue_state::{json_text, parse_payload};
use crate::Result;
use crate::targets::{is_site_target, target_locale};

static SITE_REASON_LOCALE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?:^|_)(ru|en)(?:_|$)").unwrap());

fn media_json(media: &[content::message::MediaItem]) -> SqlValue {
    json_text(&Value::Array(media.iter().cloned().map(Value::Object).collect()))
}

fn publish_at_for_locale(plan: &PublicationPlan, locale: Locale) -> Option<&str> {
    match (plan.mode, locale) {
        (PublishMode::Immediate, _) => Some(&plan.now),
        (PublishMode::Scheduled, Locale::En) => plan.en_at.as_deref(),
        (PublishMode::Scheduled, Locale::Ru) => plan.ru_at.as_deref(),
    }
}

impl Publishing<'_> {
    pub fn persist_publication_plan_tx(&self, plan: &PublicationPlan) -> Result<()> {
        let sqlite = self.sqlite;
        // Planning this publication's delivery withdraws any standing "cancel
        // the rest": the jobs written below are the operator asking again.
        clear_delivery_cancellation(sqlite, &plan.publication_key)?;
        for locale in &plan.locales {
            let source = plan.payload.locale(locale.locale);
            let published_at = if source.site_enabled {
                source
                    .publish_at
                    .clone()
                    .or_else(|| (plan.mode == PublishMode::Immediate).then(|| plan.now.clone()))
            } else {
                None
            };
            sqlite.execute(
                r#"update "post_locales" set "slug" = ?, "html" = ?, "entities_json" = ?, "story_media_json" = ?, "site_media_json" = ?, "site_enabled" = ?, "publish_at" = ?, "published_at" = ?, "updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ?)"#,
                params![
                    source.slug,
                    locale.html,
                    locale.entities_json,
                    media_json(&source.story_media),
                    media_json(&source.site_media),
                    i64::from(source.site_enabled),
                    source.publish_at,
                    published_at,
                    plan.now,
                    plan.draft_id,
                    locale.locale.as_str()
                ],
            )?;
        }
        // A job that carries what it has already published is a delivery in
        // progress, whatever its status says: the rest of a Threads chain
        // waits in exactly the `queued` and `failed` rows this deletes.
        let unfinished: Vec<(i64, String)> = sqlite
            .prepare(
                r#"select "job_id", "target", "payload_json" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."status" in (?, ?))"#,
            )?
            .query_map(params![plan.publication_key, "queued", "failed"], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?, row.get::<_, Option<String>>(2)?))
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter(|(_, _, payload)| has_resume_state(&parse_payload(payload.as_deref())))
            .map(|(job_id, target, _)| (job_id, target))
            .collect();
        let keep = if unfinished.is_empty() {
            String::new()
        } else {
            format!(
                r#" and "publish_jobs"."job_id" not in ({})"#,
                vec!["?"; unfinished.len()].join(", ")
            )
        };
        sqlite.execute(
            &format!(
                r#"delete from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."status" in (?, ?){keep})"#
            ),
            params_from_iter(
                [
                    SqlValue::Text(plan.publication_key.clone()),
                    SqlValue::Text("queued".into()),
                    SqlValue::Text("failed".into()),
                ]
                .into_iter()
                .chain(unfinished.iter().map(|(job_id, _)| SqlValue::Integer(*job_id))),
            ),
        )?;
        sqlite.execute(
            r#"delete from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."status" in (?, ?))"#,
            params![plan.publication_key, "queued", "failed"],
        )?;
        // "publishing" counts as final on purpose: a worker already holds that
        // job and may have hit the platform. Re-planning mid-delivery leaves
        // those targets on the previous plan.
        let mut final_targets: Vec<String> = sqlite
            .prepare(
                r#"select "target" from "publish_jobs" where ("publish_jobs"."publication_key" = ? and "publish_jobs"."status" in (?, ?, ?, ?))"#,
            )?
            .query_map(
                params![plan.publication_key, "publishing", "published", "skipped", "verification_required"],
                |row| row.get(0),
            )?
            .collect::<db::rusqlite::Result<_>>()?;
        final_targets.extend(unfinished.into_iter().map(|(_, target)| target));
        let final_site_locales: Vec<String> = sqlite
            .prepare(
                r#"select "reason" from "site_jobs" where ("site_jobs"."publication_key" = ? and "site_jobs"."status" in (?, ?))"#,
            )?
            .query_map(params![plan.publication_key, "rendering", "published"], |row| row.get::<_, String>(0))?
            .collect::<db::rusqlite::Result<Vec<_>>>()?
            .into_iter()
            .filter_map(|reason| SITE_REASON_LOCALE.captures(&reason).map(|found| found[1].to_owned()))
            .collect();
        for (target, enabled) in plan.targets.iter() {
            let publish_at = target_locale(target).and_then(|locale| publish_at_for_locale(plan, locale));
            if enabled
                && let Some(publish_at) = publish_at
                && !is_site_target(target)
                && !final_targets.iter().any(|done| done == target)
            {
                // Every target still here is one the plan may build from
                // scratch: the half-delivered ones were kept above.
                let payload = new_delivery_payload(localize_target_payload(&plan.payload, target));
                enqueue_publish_job_tx(
                    self,
                    &EnqueuePublishJob {
                        publication_key: &plan.publication_key,
                        target,
                        payload: &payload,
                        publish_at: Some(publish_at),
                    },
                )?;
            }
        }
        for (locale, enabled) in [
            (Locale::Ru, plan.targets.get("site_ru")),
            (Locale::En, plan.targets.get("site_en")),
        ] {
            if enabled
                && let Some(publish_at) = publish_at_for_locale(plan, locale)
                && !final_site_locales.iter().any(|done| done == locale.as_str())
            {
                sqlite.execute(
                    r#"insert into "site_jobs" ("publication_key", "reason", "status", "next_attempt_at", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?)"#,
                    params![
                        plan.publication_key,
                        format!("site_{}", locale.as_str()),
                        "queued",
                        publish_at,
                        plan.now,
                        plan.now
                    ],
                )?;
            }
        }
        sqlite.execute(
            r#"update "drafts" set "status" = ?, "post_id" = ?, "publish_mode" = ?, "scheduled_at" = ?, "scheduled_en_at" = ?, "updated_at" = ? where "drafts"."id" = ?"#,
            params![
                "scheduled",
                plan.post_id,
                plan.mode.as_str(),
                plan.ru_at,
                plan.en_at,
                plan.now,
                plan.draft_id
            ],
        )?;
        Ok(())
    }
}
