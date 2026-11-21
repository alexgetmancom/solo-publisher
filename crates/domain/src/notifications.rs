//! Publication reminders (`notifications/jobs.ts`): the
//! `studio_notification_jobs` rows scheduling a publication queues and
//! cancelling it retires. Turning a due row into its journal event is the
//! Notifications worker's (`runNotificationCycle`), which is not here.

use db::rusqlite::{Connection, params};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::json;

use crate::Result;
use crate::application::ports::Clock;
use crate::repositories::stamp;
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
