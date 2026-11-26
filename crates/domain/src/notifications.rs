//! Publication reminders: the
//! `studio_notification_jobs` rows scheduling a publication queues and
//! cancelling it retires, and the Notifications worker's cycle that turns a
//! due row into its journal event (`runNotificationCycle`).

use db::rusqlite::{Connection, params};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::{Map, Value, json};

use crate::Result;
use crate::application::ports::{Clock, DomainEventInput, Severity};
use crate::repositories::{record_event, stamp, transaction};
use crate::studio::boundaries::{Reminder, Reminders};

/// The reminder scheduler on the connection a caller hands it.
#[derive(Clone, Copy)]
pub struct ReminderJobs<C> {
    clock: C,
}

impl<C: Clock> ReminderJobs<C> {
    pub fn new(clock: C) -> Self {
        Self { clock }
    }
}

impl<C: Clock> Reminders for ReminderJobs<C> {
    /// `scheduleReminder`: nothing when reminders are off or the time passed.
    fn schedule(&self, sqlite: &Connection, reminder: &Reminder<'_>) -> Result<()> {
        let now = self.clock.now();
        if !reminder.reminders.enabled || reminder.publish_at <= now {
            return Ok(());
        }
        let lead = reminder.publish_at.as_millisecond() - reminder.reminders.minutes * 60_000;
        let run_at = to_iso_string(
            Timestamp::from_millisecond(lead.max(now.as_millisecond()))
                .map_err(|error| crate::Error::message(error.to_string()))?,
        );
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
                crate::json::stringify(&payload),
                timestamp
            ],
        )?;
        Ok(())
    }

    /// `cancelScheduledNotifications`: every reminder still queued for it.
    fn cancel(&self, sqlite: &Connection, publication_ref: &str) -> Result<()> {
        sqlite.execute(
            r#"update "studio_notification_jobs" set "status" = 'cancelled', "updated_at" = ? where ("studio_notification_jobs"."ref" = ? and "studio_notification_jobs"."status" = 'queued')"#,
            params![stamp(&self.clock), publication_ref],
        )?;
        Ok(())
    }
}

/// `runNotificationCycle` (the `notifications` loop): every due queued job
/// becomes a `studio.notification.reminder.due` event, which the Telegram
/// event loop delivers. Claim and event are one transaction: marking the job
/// delivered first let a failing event write swallow the reminder.
pub fn run_notification_cycle(sqlite: &Connection, clock: &dyn Clock) -> Result<usize> {
    let now = to_iso_string(clock.now());
    let jobs: Vec<(i64, i64, String, String, String)> = sqlite
        .prepare(
            r#"select "id", "actor_id", "ref", "kind", "payload_json" from "studio_notification_jobs" where ("studio_notification_jobs"."status" = 'queued' and "studio_notification_jobs"."run_at" <= ?) order by "studio_notification_jobs"."run_at" asc, "studio_notification_jobs"."id" asc limit 50"#,
        )?
        .query_map([&now], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?)))?
        .collect::<db::rusqlite::Result<_>>()?;
    let mut delivered = 0;
    for (id, actor_id, publication_ref, kind, payload) in jobs {
        let emitted = transaction(sqlite, || {
            let claimed = sqlite.execute(
                r#"update "studio_notification_jobs" set "status" = 'delivered', "updated_at" = ? where ("studio_notification_jobs"."id" = ? and "studio_notification_jobs"."status" = 'queued')"#,
                params![now, id],
            )?;
            if claimed == 0 {
                return Ok(false);
            }
            let payload: Map<String, Value> = serde_json::from_str(&payload).unwrap_or_default();
            // `String(payload.title ?? job.ref)`.
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
                sqlite,
                clock,
                &DomainEventInput {
                    publication_ref: Some(publication_ref.clone()),
                    event_type: "studio.notification.reminder.due".into(),
                    severity: Severity::Info,
                    target: None,
                    message: format!("Publication reminder: {title}"),
                    details: Some(details),
                    cooldown_seconds: None,
                },
            )?;
            Ok(true)
        })?;
        if emitted {
            delivered += 1;
        }
    }
    Ok(delivered)
}
