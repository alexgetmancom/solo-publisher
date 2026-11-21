//! The golden host's publication reminders (`notifications/jobs.ts`):
//! `studio_notification_jobs` rows, queued and cancelled as the TypeScript
//! scheduler writes them.

use db::rusqlite::{Connection, params};
use domain::application::ports::{Clock, DomainEventInput, Severity};
use domain::repositories::record_event;
use domain::studio::boundaries::{Reminder, Reminders};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::{Map, Value, json};

use super::host::GoldenHost;

impl Reminders for GoldenHost {
    /// `scheduleReminder`: nothing when reminders are off or the time passed.
    fn schedule(&self, sqlite: &Connection, reminder: &Reminder<'_>) -> domain::Result<()> {
        let now = self.clock.now();
        if !reminder.reminders.enabled || reminder.publish_at <= now {
            return Ok(());
        }
        let lead = reminder.publish_at.as_millisecond() - reminder.reminders.minutes * 60_000;
        let run_at = to_iso_string(Timestamp::from_millisecond(lead.max(now.as_millisecond())).expect("in range"));
        let timestamp = to_iso_string(now);
        let payload = json!({
            "title": reminder.title,
            "targets": reminder.targets,
            "publish_at": to_iso_string(reminder.publish_at),
            "minutes": reminder.reminders.minutes,
        });
        sqlite.execute(
            r#"insert into "studio_notification_jobs" ("id", "actor_id", "ref", "kind", "run_at", "status", "payload_json", "created_at", "updated_at") values (null, ?1, ?2, ?3, ?4, 'queued', ?5, ?6, ?6) on conflict ("studio_notification_jobs"."ref", "studio_notification_jobs"."kind") do update set "run_at" = ?4, "status" = 'queued', "payload_json" = ?5, "updated_at" = ?6"#,
            params![
                reminder.actor_id,
                reminder.publication_ref,
                reminder.kind,
                run_at,
                domain::json::stringify(&payload),
                timestamp
            ],
        )?;
        Ok(())
    }

    /// `cancelScheduledNotifications`: every reminder still queued for it.
    fn cancel(&self, sqlite: &Connection, publication_ref: &str) -> domain::Result<()> {
        sqlite.execute(
            r#"update "studio_notification_jobs" set "status" = 'cancelled', "updated_at" = ? where ("studio_notification_jobs"."ref" = ? and "studio_notification_jobs"."status" = 'queued')"#,
            params![to_iso_string(self.clock.now()), publication_ref],
        )?;
        Ok(())
    }
}

/// `runNotificationCycle` (the Notifications worker): every due queued job
/// becomes a `studio.notification.reminder.due` event, claimed and journalled
/// as one unit.
pub fn run_notification_cycle(sqlite: &Connection, clock: &dyn Clock) -> domain::Result<usize> {
    let now = to_iso_string(clock.now());
    let jobs: Vec<(i64, i64, String, String, String)> = sqlite
        .prepare(
            r#"select "id", "actor_id", "ref", "kind", "payload_json" from "studio_notification_jobs" where ("studio_notification_jobs"."status" = 'queued' and "studio_notification_jobs"."run_at" <= ?) order by "studio_notification_jobs"."run_at" asc, "studio_notification_jobs"."id" asc limit 50"#,
        )?
        .query_map([&now], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
        .collect::<Result<_, _>>()?;
    let mut delivered = 0;
    for (id, actor_id, publication_ref, kind, payload) in jobs {
        let tx = sqlite.unchecked_transaction()?;
        let claimed = tx.execute(
            r#"update "studio_notification_jobs" set "status" = 'delivered', "updated_at" = ? where ("studio_notification_jobs"."id" = ? and "studio_notification_jobs"."status" = 'queued')"#,
            params![now, id],
        )?;
        if claimed == 0 {
            continue;
        }
        let payload: Map<String, Value> = serde_json::from_str(&payload).unwrap_or_default();
        let title = match payload.get("title") {
            Some(Value::String(title)) => title.clone(),
            Some(other) if !other.is_null() => other.to_string(),
            _ => publication_ref.clone(),
        };
        let mut details = Map::new();
        details.insert("actor_id".into(), json!(actor_id));
        details.insert("notification_job_id".into(), json!(id));
        details.insert("kind".into(), json!(kind));
        details.extend(payload);
        record_event(
            &tx,
            clock,
            &DomainEventInput {
                publication_ref: Some(publication_ref),
                event_type: "studio.notification.reminder.due".into(),
                severity: Severity::Info,
                target: None,
                message: format!("Publication reminder: {title}"),
                details: Some(details),
                cooldown_seconds: None,
            },
        )?;
        tx.commit()?;
        delivered += 1;
    }
    Ok(delivered)
}
