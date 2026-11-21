//! `operations/commands/scope-plan.ts`: what a command scoped by `target` /
//! `locale` would actually reach, reported before it runs.

use content::Locale;
use db::rusqlite::Connection;
use domain::targets::target_locale;
use serde::Serialize;
use serde_json::{Map, Value, json};

use super::super::publication_ref::ResolvedPublicationRef;

#[derive(Clone, Debug, Serialize)]
pub(crate) struct ScopedTarget {
    target: String,
    status: String,
    url: Option<String>,
    published: bool,
}

pub(crate) fn locale_of(target: &str) -> Option<&'static str> {
    target_locale(target).map(Locale::as_str)
}

/// `publicationScope`. A target with a job but no delivery row yet is still
/// in scope: `retry` works off the jobs.
pub(crate) fn publication_scope(
    sqlite: &Connection,
    reference: &ResolvedPublicationRef,
    target: Option<&str>,
    locale: Option<&str>,
) -> Result<Vec<ScopedTarget>, db::rusqlite::Error> {
    let scoped = |value: &str| {
        target.is_none_or(|target| value == target) && locale.is_none_or(|locale| locale_of(value) == Some(locale))
    };
    let mut rows: Vec<ScopedTarget> = Vec::new();
    let mut set = |row: ScopedTarget| match rows.iter_mut().find(|existing| existing.target == row.target) {
        Some(existing) => *existing = row,
        None => rows.push(row),
    };
    let jobs: Vec<(String, String)> = sqlite
        .prepare(r#"select "target", "status" from "publish_jobs" where "publish_jobs"."publication_key" = ?"#)?
        .query_map([&reference.publication_key], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (target, status) in jobs {
        if scoped(&target) {
            set(ScopedTarget {
                target,
                status,
                url: None,
                published: false,
            });
        }
    }
    let targets: Vec<(String, String, Option<String>)> = sqlite
        .prepare(
            r#"select "target", "status", "url" from "publication_targets" where "publication_targets"."publication_key" = ?"#,
        )?
        .query_map([&reference.publication_key], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
        .collect::<Result<_, _>>()?;
    for (target, status, url) in targets {
        if scoped(&target) {
            let published = status == "published";
            set(ScopedTarget {
                target,
                status,
                url,
                published,
            });
        }
    }
    rows.sort_by(|left, right| left.target.cmp(&right.target));
    Ok(rows)
}

/// `scopePlan`: `detail` goes between the targets and the hint.
pub(crate) fn scope_plan(
    action: &str,
    reference: &ResolvedPublicationRef,
    scope: Vec<ScopedTarget>,
    detail: Map<String, Value>,
) -> Value {
    let hint = if scope.is_empty() {
        "nothing is in scope; widen --target or --locale"
    } else {
        "re-run with apply to perform it"
    };
    let mut plan = Map::new();
    plan.insert("ok".into(), json!(true));
    plan.insert("applied".into(), json!(false));
    plan.insert("action".into(), json!(action));
    plan.insert("post_id".into(), json!(reference.post_id));
    plan.insert("publication_key".into(), json!(reference.publication_key));
    plan.insert("targets".into(), serde_json::to_value(scope).unwrap_or_default());
    plan.extend(detail);
    plan.insert("hint".into(), json!(hint));
    Value::Object(plan)
}
