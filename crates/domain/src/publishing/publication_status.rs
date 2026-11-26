//! Folds a post's target jobs into its one status. This asks no one anything
//! and writes no delivery state — delivery's reconciliation is the one that
//! asks the platform whether an ambiguous publication landed.

use content::Locale;
use db::rusqlite::{OptionalExtension, params};
use serde_json::{Map, Value, json};

use super::Publishing;
use super::state::{
    PlanRecord, effective_publication_status, is_deferred_locale, is_post_job_final, plan_object, plan_schedule_at,
};
use crate::Result;
use crate::application::ports::{DomainEventInput, Severity};
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::channels::registered_post_target_ids;
use crate::repositories::record_event;
use crate::targets::{is_site_target, target_locale};

struct PublicationJob {
    target: String,
    status: String,
    error: Option<String>,
}

fn job_counts(jobs: &[&PublicationJob]) -> (usize, usize) {
    (
        jobs.iter()
            .filter(|job| matches!(job.status.as_str(), "failed" | "verification_required"))
            .count(),
        jobs.iter()
            .filter(|job| matches!(job.status.as_str(), "published" | "skipped"))
            .count(),
    )
}

impl Publishing<'_> {
    fn event(&self, input: DomainEventInput) -> Result<bool> {
        record_event(self.sqlite, self.clock, &input)
    }

    pub fn refresh_publication_status(&self, post_id: i64) -> Result<()> {
        let existing: Option<String> = self
            .sqlite
            .query_row(
                r#"select "status" from "drafts" where "drafts"."post_id" = ?"#,
                [post_id],
                |row| row.get(0),
            )
            .optional()?;
        let Some(previous) = existing else { return Ok(()) };
        if previous == "cancelled" {
            return Ok(());
        }
        let key = publication_ref(PublicationRefKind::Post, post_id);
        let read = |sql: &str| -> Result<Vec<PublicationJob>> {
            Ok(self
                .sqlite
                .prepare(sql)?
                .query_map([&key], |row| {
                    Ok(PublicationJob {
                        target: row.get(0)?,
                        status: row.get(1)?,
                        error: row.get(2)?,
                    })
                })?
                .collect::<db::rusqlite::Result<_>>()?)
        };
        let mut all = read(
            r#"select "target", "status", "last_error" from "publish_jobs" where "publish_jobs"."publication_key" = ?"#,
        )?;
        // Only the canonical site rows: a repair reason (`edit_en`,
        // `refresh_en_site`) is not a delivery target.
        all.extend(
            read(
                r#"select "reason", "status", "last_error" from "site_jobs" where "site_jobs"."publication_key" = ?"#,
            )?
            .into_iter()
            .filter(|job| is_site_target(&job.target)),
        );
        let registered = registered_post_target_ids(self.sqlite)?;
        let plan = self.publication_plan_from_db(post_id, &registered)?;
        self.emit_locale_completion(post_id, &all, plan.as_ref())?;
        let pairs: Vec<(String, String)> = all.iter().map(|job| (job.target.clone(), job.status.clone())).collect();
        let Some(effective) = effective_publication_status(&pairs, plan.as_ref(), &registered) else {
            return Ok(());
        };
        // The completion event is announced once per transition, so the
        // transition itself is claimed atomically: the write carries the
        // status this cycle read.
        let moved = self
            .sqlite
            .query_row(
                r#"update "drafts" set "status" = ?, "updated_at" = ? where ("drafts"."post_id" = ? and "drafts"."status" = ?) returning "id""#,
                params![effective, self.now(), post_id, previous],
                |row| row.get::<_, i64>(0),
            )
            .optional()?
            .is_some();
        if moved
            && effective != "scheduled"
            && previous != effective
            && all.iter().all(|job| is_post_job_final(&job.status))
        {
            let (failed, published) = job_counts(&all.iter().collect::<Vec<_>>());
            self.event(DomainEventInput {
                publication_ref: Some(key),
                event_type: "delivery.post.completed".into(),
                severity: Severity::Info,
                target: None,
                message: if failed > 0 {
                    format!("Post #{post_id} completed with {failed} failed target(s)")
                } else {
                    format!("Post #{post_id} published successfully")
                },
                details: Some(object(json!({
                    "post_id": post_id, "total": all.len(), "failed": failed, "published": published,
                }))),
                cooldown_seconds: None,
            })?;
        }
        Ok(())
    }

    fn emit_locale_completion(&self, post_id: i64, jobs: &[PublicationJob], plan: Option<&PlanRecord>) -> Result<()> {
        let Some(plan) = plan.filter(|plan| plan.get("mode").and_then(Value::as_str) == Some("scheduled")) else {
            return Ok(());
        };
        let mut enabled_locales: Vec<Locale> = Vec::new();
        for (target, enabled) in crate::json::object_entries(&plan_object(plan.get("targets"))) {
            if foundation::js::truthy(enabled)
                && let Some(locale) = target_locale(target)
                && !enabled_locales.contains(&locale)
            {
                enabled_locales.push(locale);
            }
        }
        if enabled_locales.len() < 2 {
            return Ok(());
        }
        let by_locale = |locale: Locale| -> Vec<&PublicationJob> {
            jobs.iter()
                .filter(|job| target_locale(&job.target) == Some(locale))
                .collect()
        };
        let key = publication_ref(PublicationRefKind::Post, post_id);
        for locale in [Locale::Ru, Locale::En] {
            let completed = by_locale(locale);
            if completed.is_empty() || completed.iter().any(|job| !is_post_job_final(&job.status)) {
                continue;
            }
            let remaining: Vec<Value> = enabled_locales
                .iter()
                .copied()
                .filter(|other| *other != locale)
                .filter(|other| {
                    let other_jobs = by_locale(*other);
                    if !other_jobs.is_empty() && other_jobs.iter().all(|job| is_post_job_final(&job.status)) {
                        return false;
                    }
                    is_deferred_locale(plan, locale, *other)
                })
                .map(|other| json!({ "locale": other.as_str(), "scheduled_at": plan_schedule_at(plan, other) }))
                .collect();
            if remaining.is_empty() {
                continue;
            }
            let already_emitted = self
                .sqlite
                .query_row(
                    r#"select "id" from "publication_events" where ("publication_events"."publication_key" = ? and "publication_events"."event_type" = ? and "publication_events"."target" = ?)"#,
                    params![key, "delivery.post.locale.completed", locale.as_str()],
                    |row| row.get::<_, i64>(0),
                )
                .optional()?;
            if already_emitted.is_some() {
                continue;
            }
            let (failed, published) = job_counts(&completed);
            self.event(DomainEventInput {
                publication_ref: Some(key.clone()),
                event_type: "delivery.post.locale.completed".into(),
                severity: if failed > 0 { Severity::Warn } else { Severity::Info },
                target: Some(locale.as_str().into()),
                message: format!(
                    "Post #{post_id} {} publication part completed",
                    locale.as_str().to_uppercase()
                ),
                details: Some(object(json!({
                    "post_id": post_id,
                    "locale": locale.as_str(),
                    "total": completed.len(),
                    "failed": failed,
                    "published": published,
                    "targets": completed
                        .iter()
                        .map(|job| json!({ "target": job.target, "status": job.status, "error": job.error }))
                        .collect::<Vec<_>>(),
                    "remaining": remaining,
                }))),
                cooldown_seconds: Some(365 * 24 * 60 * 60),
            })?;
        }
        Ok(())
    }
}

pub(crate) fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("details are built as objects"),
    }
}
