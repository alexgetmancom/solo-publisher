//! The golden host's publication reminders (`notifications/jobs.ts`):
//! `studio_notification_jobs` rows, queued and cancelled as the TypeScript
//! scheduler writes them.

use db::rusqlite::{Connection, params};
use domain::application::ports::Clock;
use domain::studio::boundaries::{Reminder, Reminders};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use serde_json::json;

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
