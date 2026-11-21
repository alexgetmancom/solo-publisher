//! `operations/skip.ts` and `operations/resend.ts`: the two other answers to
//! a target that did not land — finish without it, or send a settled post to
//! a platform it never went to. Both go through Publishing, which the bot's
//! buttons also use.

use db::rusqlite::OptionalExtension;
use domain::publishing::abandon::AbandonOutcome;
use domain::publishing::extra_delivery::ExtraDeliveryScope;
use domain::publishing::publication_owner::refresh_publication_owner;
use domain::publishing::requeue::{RequeueOutcome, RequeueScope};
use domain::targets::is_site_target;
use serde_json::{Value, json};

use super::super::publication_ref::ResolvedPublicationRef;
use super::requeue::unique;
use super::{CommandHandle, object, refusal};
use crate::context::{OpResult, to_value};

/// `skipPublicationTargets`.
pub(crate) fn skip_publication_targets(
    handle: &CommandHandle<'_>,
    reference: &ResolvedPublicationRef,
    target: Option<&str>,
    apply: bool,
    actor_type: &str,
) -> OpResult {
    let targets = match target {
        Some(target) => vec![target.to_owned()],
        None => jobbed_targets(handle, reference)?,
    };
    if targets.is_empty() {
        return Err(refusal(format!("no delivery targets found for {}", reference.publication_key)).into());
    }
    let mut plan = object(json!({
        "ok": true,
        "action": "skip",
        "publication_key": reference.publication_key,
        "post_id": reference.post_id,
        "targets": targets,
    }));
    if !apply {
        plan.insert("applied".into(), json!(false));
        plan.insert(
            "hint".into(),
            json!("re-run with apply to finish the publication without these targets"),
        );
        return Ok(Value::Object(plan));
    }
    let names: Vec<&str> = targets.iter().map(String::as_str).collect();
    let results = handle.publishing.abandon_publication_targets(
        &RequeueScope {
            post_id: Some(reference.post_id),
            publication_key: reference.publication_key.clone(),
        },
        &names,
    )?;
    let abandoned = results
        .iter()
        .filter(|row| row.outcome == AbandonOutcome::Abandoned)
        .count();
    // The publication was held open by the very jobs just abandoned.
    refresh_publication_owner(&handle.publishing, &reference.publication_key)?;
    plan.insert("applied".into(), json!(true));
    plan.insert("abandoned".into(), json!(abandoned));
    plan.insert("results".into(), to_value(&results)?);
    plan.insert("actor_type".into(), json!(actor_type));
    Ok(Value::Object(plan))
}

/// Every target this publication has a delivery row for, social and site
/// alike: `abandon` decides which of them it may give up on.
fn jobbed_targets(handle: &CommandHandle<'_>, reference: &ResolvedPublicationRef) -> domain::Result<Vec<String>> {
    let sqlite = handle.publishing.sqlite;
    let mut targets: Vec<String> = sqlite
        .prepare(r#"select "target" from "publish_jobs" where "publish_jobs"."publication_key" = ?"#)?
        .query_map([&reference.publication_key], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    let reasons: Vec<String> = sqlite
        .prepare(r#"select "reason" from "site_jobs" where "site_jobs"."publication_key" = ?"#)?
        .query_map([&reference.publication_key], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    targets.extend(reasons);
    Ok(unique(targets))
}

/// `resendPublicationTarget`: creates the one job the target never had and
/// refuses a target that already published, so no surface can post twice.
pub(crate) fn resend_publication_target(
    handle: &CommandHandle<'_>,
    reference: &ResolvedPublicationRef,
    target: &str,
    apply: bool,
    actor_type: &str,
) -> OpResult {
    // The site is rendered by its own build from the pages a publication owns.
    if is_site_target(target) {
        return Err(refusal(format!("{target} is built, not delivered: use repair-content")).into());
    }
    let post_id = reference.post_id;
    let draft_id: Option<i64> = handle
        .publishing
        .sqlite
        .query_row(
            r#"select "id" from "drafts" where "drafts"."post_id" = ?"#,
            [post_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(draft_id) = draft_id else {
        return Err(refusal(format!("no draft found for post {post_id}")).into());
    };
    let mut plan = object(json!({
        "ok": true,
        "action": "resend",
        "publication_key": reference.publication_key,
        "post_id": post_id,
        "draft_id": draft_id,
        "target": target,
    }));
    if !apply {
        plan.insert("applied".into(), json!(false));
        plan.insert(
            "hint".into(),
            json!("re-run with apply to send the published post to this target"),
        );
        return Ok(Value::Object(plan));
    }
    let publishing = &handle.publishing;
    let result = publishing.deliver_extra_target(
        &ExtraDeliveryScope {
            draft_id,
            post_id,
            publication_key: reference.publication_key.clone(),
        },
        target,
        &|| publishing.publication_source_from_db(post_id),
    )?;
    plan.insert("ok".into(), json!(result.outcome == RequeueOutcome::Requeued));
    plan.insert("applied".into(), json!(true));
    plan.insert("result".into(), to_value(&result)?);
    plan.insert("actor_type".into(), json!(actor_type));
    Ok(Value::Object(plan))
}
