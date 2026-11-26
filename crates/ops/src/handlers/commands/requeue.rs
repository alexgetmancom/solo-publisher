//! `ops retry` over one publication — which
//! targets it names and how its result reads. The requeue itself belongs to
//! Publishing, which Studio's retry button also goes through.

use delivery::Delivery;
use delivery::external_removals::{
    RemovalOptions, TargetRemovalAttempt, TargetRemovalResult, attempt_published_target_removals,
};
use domain::publishing::Publishing;
use domain::publishing::publication_source::PublicationSource;
use domain::publishing::requeue::{AudienceReached, RETRY_UNLESS_HELD, RequeueOptions, RequeueOutcome, RequeueScope};
use serde_json::{Map, Value, json};

use super::super::publication_ref::ResolvedPublicationRef;
use super::scope_plan::locale_of;
use super::{object, refusal};

/// `requeuePublicationTx`.
fn requeue_publication_tx(
    publishing: &Publishing<'_>,
    reference: &ResolvedPublicationRef,
    source: &PublicationSource,
    target: Option<&str>,
) -> domain::Result<Value> {
    let targets = match target {
        Some(target) => vec![target.to_owned()],
        None => jobbed_targets(publishing, reference)?,
    };
    if targets.is_empty() {
        return Err(refusal("no publish jobs found"));
    }
    let names: Vec<&str> = targets.iter().map(String::as_str).collect();
    let results = publishing.requeue_publication_targets_tx(
        &RequeueScope {
            post_id: Some(reference.post_id),
            publication_key: reference.publication_key.clone(),
        },
        &names,
        &RequeueOptions {
            from: &RETRY_UNLESS_HELD,
            // An operator naming one target may be restoring a publication
            // whose job rows were never created.
            create_missing: target.is_some(),
            // `ops retry` sends the whole thing again; finishing a partial
            // publication is `ops resume-from`.
            audience_reached: AudienceReached::Republish,
            source: &|| Ok(source.clone()),
        },
    )?;
    Ok(json!({
        // Every target still held means nothing was requeued.
        "ok": results.iter().any(|row| row.outcome != RequeueOutcome::NotRetryable),
        "post_id": reference.post_id,
        "publication_key": reference.publication_key,
        "target": target,
        "targets": results.iter().map(|row| row.target.clone()).collect::<Vec<_>>(),
        "results": results,
    }))
}

/// Targets this publication has ever delivered to, first job first.
fn jobbed_targets(publishing: &Publishing<'_>, reference: &ResolvedPublicationRef) -> domain::Result<Vec<String>> {
    let rows: Vec<String> = publishing
        .sqlite
        .prepare(r#"select "target" from "publish_jobs" where "publish_jobs"."publication_key" = ?"#)?
        .query_map([&reference.publication_key], |row| row.get(0))?
        .collect::<Result<_, _>>()?;
    Ok(unique(rows))
}

pub(crate) fn unique(values: Vec<String>) -> Vec<String> {
    let mut seen: Vec<String> = Vec::new();
    for value in values {
        if !seen.contains(&value) {
            seen.push(value);
        }
    }
    seen
}

fn publication_targets(publishing: &Publishing<'_>, publication_key: &str) -> domain::Result<Vec<String>> {
    Ok(publishing
        .sqlite
        .prepare(r#"select "target" from "publication_targets" where "publication_targets"."publication_key" = ?"#)?
        .query_map([publication_key], |row| row.get(0))?
        .collect::<Result<_, _>>()?)
}

/// `requeuePublicationScopeTx`.
pub(crate) fn requeue_publication_scope_tx(
    publishing: &Publishing<'_>,
    reference: &ResolvedPublicationRef,
    source: &PublicationSource,
    target: Option<&str>,
    locale: Option<&str>,
) -> domain::Result<Map<String, Value>> {
    let Some(locale) = locale.filter(|_| target.is_none()) else {
        return Ok(object(requeue_publication_tx(publishing, reference, source, target)?));
    };
    let targets: Vec<String> = publication_targets(publishing, &reference.publication_key)?
        .into_iter()
        .filter(|value| locale_of(value) == Some(locale))
        .collect();
    // A mutation that matched nothing is not a success.
    if targets.is_empty() {
        return Err(refusal(format!(
            "no {locale} targets found for {}",
            reference.publication_key
        )));
    }
    let results = targets
        .iter()
        .map(|value| requeue_publication_tx(publishing, reference, source, Some(value)))
        .collect::<domain::Result<Vec<_>>>()?;
    Ok(object(json!({"ok": true, "locale": locale, "results": results})))
}

/// `requeueAfterRemovalTx`: only what was taken down goes back up. A named
/// target with no durable remote row is already gone and may be replaced; one
/// whose deletion was attempted and failed may not.
pub(crate) fn requeue_after_removal_tx(
    publishing: &Publishing<'_>,
    reference: &ResolvedPublicationRef,
    source: &PublicationSource,
    removals: &[TargetRemovalResult],
    target: Option<&str>,
) -> domain::Result<Value> {
    let succeeded: Vec<String> = removals
        .iter()
        .filter(|row| row.ok)
        .map(|row| row.target.clone())
        .collect();
    let attempted = |value: &str| {
        removals
            .iter()
            .any(|row| row.skipped != Some(true) && row.target == value)
    };
    let targets = match target {
        Some(target) if !succeeded.iter().any(|value| value == target) => {
            if attempted(target) {
                Vec::new()
            } else {
                vec![target.to_owned()]
            }
        }
        _ => succeeded,
    };
    let results = targets
        .iter()
        .map(|value| requeue_publication_tx(publishing, reference, source, Some(value)))
        .collect::<domain::Result<Vec<_>>>()?;
    Ok(json!({"ok": !targets.is_empty(), "results": results}))
}

/// `attemptTextFallbackRemovals`: takes down the targets an edit could not
/// reach in place — the edit's own answer, so a target rewritten in place is
/// never also deleted and published again.
pub(crate) async fn attempt_text_fallback_removals(
    delivery: &Delivery<'_>,
    reference: &ResolvedPublicationRef,
    target: Option<&str>,
    locale: &str,
    edited: &[Map<String, Value>],
) -> domain::Result<Vec<(String, Vec<TargetRemovalAttempt>)>> {
    let rewritten: Vec<&str> = edited
        .iter()
        .filter(|row| row.get("ok") == Some(&Value::Bool(true)))
        .filter_map(|row| row.get("target").and_then(Value::as_str))
        .collect();
    let targets: Vec<String> = publication_targets(&delivery.publishing(), &reference.publication_key)?
        .into_iter()
        .filter(|value| {
            target.is_none_or(|target| value == target)
                && locale_of(value) == Some(locale)
                && !rewritten.contains(&value.as_str())
        })
        .collect();
    let mut results = Vec::new();
    for value in targets {
        let attempts = attempt_published_target_removals(
            delivery,
            &RemovalOptions {
                publication_key: reference.publication_key.clone(),
                target: Some(value.clone()),
                locale: None,
            },
        )
        .await?;
        results.push((value, attempts));
    }
    Ok(results)
}
