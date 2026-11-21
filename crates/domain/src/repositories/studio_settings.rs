use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, params, params_from_iter};
use serde::Serialize;

use crate::application::conversation_flow::PublicationKind;
use crate::application::ports::{
    StudioBackupSettingsRecord, StudioNotificationSettingsRecord, StudioProfilePatch, StudioProfileRecord,
    StudioYoutubeSettingsRecord,
};
use crate::{Error, Result, json};

/// Owner and Studio-wide settings.
pub struct StudioSettingsStore<'a> {
    sqlite: &'a Connection,
}

fn json_text(value: &impl Serialize) -> Result<SqlValue> {
    Ok(SqlValue::Text(json::stringify(&serde_json::to_value(value)?)))
}

impl<'a> StudioSettingsStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    /// What this Studio is and how its deployment behaves. Always present: the
    /// migration that created the table inserted the fresh-install row with it.
    pub fn profile(&self) -> Result<StudioProfileRecord> {
        let row = self
            .sqlite
            .query_row(
                r#"select "id", "timezone", "timezone_label", "site_enabled", "video_prepare_lead_minutes", "video_retention_hours", "name_json", "tagline_json", "about_json", "bio_json", "site_timezone_json", "profiles_json", "default_targets_json", "updated_at" from "studio_profile" where "studio_profile"."id" = ?"#,
                [1],
                |row| {
                    let texts: [String; 7] = [
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                        row.get(9)?,
                        row.get(10)?,
                        row.get(11)?,
                        row.get(12)?,
                    ];
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, i64>(4)?,
                        row.get::<_, i64>(5)?,
                        texts,
                        row.get::<_, String>(13)?,
                    ))
                },
            )
            .optional()?;
        // A missing row means the file was hand-edited or restored from a
        // partial copy. Failing here is better than silently serving someone
        // a Studio with no identity.
        let Some((id, timezone, timezone_label, site_enabled, lead, retention, texts, updated_at)) = row else {
            return Err(Error::message(
                "studio_profile row 1 is missing; restore the database or re-run migrations",
            ));
        };
        let [name, tagline, about, bio, site_timezone, profiles, default_targets] = texts;
        Ok(StudioProfileRecord {
            id,
            timezone,
            timezone_label,
            site_enabled,
            video_prepare_lead_minutes: lead,
            video_retention_hours: retention,
            name_json: serde_json::from_str(&name)?,
            tagline_json: serde_json::from_str(&tagline)?,
            about_json: serde_json::from_str(&about)?,
            bio_json: serde_json::from_str(&bio)?,
            site_timezone_json: serde_json::from_str(&site_timezone)?,
            profiles_json: serde_json::from_str(&profiles)?,
            default_targets_json: serde_json::from_str(&default_targets)?,
            updated_at,
        })
    }

    pub fn save_profile(&self, input: &StudioProfilePatch) -> Result<()> {
        let mut columns: Vec<(&str, SqlValue)> = Vec::new();
        let mut text = |column, value: &Option<String>| {
            if let Some(value) = value {
                columns.push((column, SqlValue::Text(value.clone())));
            }
        };
        text("timezone", &input.timezone);
        text("timezone_label", &input.timezone_label);
        for (column, value) in [
            ("site_enabled", input.site_enabled),
            ("video_prepare_lead_minutes", input.video_prepare_lead_minutes),
            ("video_retention_hours", input.video_retention_hours),
        ] {
            if let Some(value) = value {
                columns.push((column, SqlValue::Integer(value)));
            }
        }
        for (column, value) in [
            ("name_json", &input.name_json),
            ("tagline_json", &input.tagline_json),
            ("about_json", &input.about_json),
            ("bio_json", &input.bio_json),
            ("site_timezone_json", &input.site_timezone_json),
        ] {
            if let Some(value) = value {
                columns.push((column, json_text(value)?));
            }
        }
        if let Some(profiles) = &input.profiles_json {
            columns.push(("profiles_json", json_text(profiles)?));
        }
        if let Some(targets) = &input.default_targets_json {
            columns.push(("default_targets_json", json_text(targets)?));
        }
        columns.push(("updated_at", SqlValue::Text(input.updated_at.clone())));
        let assignments = columns
            .iter()
            .map(|(column, _)| format!(r#""{column}" = ?"#))
            .collect::<Vec<_>>()
            .join(", ");
        let values = columns
            .into_iter()
            .map(|(_, value)| value)
            .chain([SqlValue::Integer(1)]);
        self.sqlite.execute(
            &format!(r#"update "studio_profile" set {assignments} where "studio_profile"."id" = ?"#),
            params_from_iter(values),
        )?;
        Ok(())
    }

    pub fn notifications(&self, actor_id: i64) -> Result<Option<StudioNotificationSettingsRecord>> {
        Ok(self
            .sqlite
            .query_row(
                r#"select "actor_id", "video_reminders_enabled", "post_reminders_enabled", "reminder_minutes", "completion_enabled", "updated_at" from "studio_notification_settings" where "studio_notification_settings"."actor_id" = ?"#,
                [actor_id],
                |row| {
                    Ok(StudioNotificationSettingsRecord {
                        actor_id: row.get(0)?,
                        video_reminders_enabled: row.get(1)?,
                        post_reminders_enabled: row.get(2)?,
                        reminder_minutes: row.get(3)?,
                        completion_enabled: row.get(4)?,
                        updated_at: row.get(5)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn locale(&self, actor_id: i64) -> Result<Option<String>> {
        Ok(self
            .sqlite
            .query_row(
                r#"select "locale" from "bot_ui_settings" where "bot_ui_settings"."actor_id" = ?"#,
                [actor_id],
                |row| row.get(0),
            )
            .optional()?)
    }

    pub fn timezone(&self, actor_id: i64) -> Result<Option<String>> {
        Ok(self
            .sqlite
            .query_row(
                r#"select "timezone" from "bot_ui_settings" where "bot_ui_settings"."actor_id" = ?"#,
                [actor_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()?
            .flatten())
    }

    pub fn backup(&self) -> Result<Option<StudioBackupSettingsRecord>> {
        Ok(self
            .sqlite
            .query_row(
                r#"select "id", "enabled", "updated_at" from "studio_backup_settings" where "studio_backup_settings"."id" = ?"#,
                [1],
                |row| {
                    Ok(StudioBackupSettingsRecord {
                        id: row.get(0)?,
                        enabled: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn save_backup(&self, enabled: i64, updated_at: &str) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "studio_backup_settings" ("id", "enabled", "updated_at") values (?, ?, ?) on conflict ("studio_backup_settings"."id") do update set "enabled" = ?, "updated_at" = ?"#,
            params![1, enabled, updated_at, enabled, updated_at],
        )?;
        Ok(())
    }

    pub fn save_notifications(&self, input: &StudioNotificationSettingsRecord) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "studio_notification_settings" ("actor_id", "video_reminders_enabled", "post_reminders_enabled", "reminder_minutes", "completion_enabled", "updated_at") values (?, ?, ?, ?, ?, ?) on conflict ("studio_notification_settings"."actor_id") do update set "video_reminders_enabled" = ?, "post_reminders_enabled" = ?, "reminder_minutes" = ?, "completion_enabled" = ?, "updated_at" = ?"#,
            params![
                input.actor_id,
                input.video_reminders_enabled,
                input.post_reminders_enabled,
                input.reminder_minutes,
                input.completion_enabled,
                input.updated_at,
                input.video_reminders_enabled,
                input.post_reminders_enabled,
                input.reminder_minutes,
                input.completion_enabled,
                input.updated_at
            ],
        )?;
        Ok(())
    }

    /// Cancels the actor's queued reminders of one publication kind; returns
    /// how many it cancelled.
    pub fn cancel_queued_reminders(
        &self,
        actor_id: i64,
        publication_kind: PublicationKind,
        now: &str,
    ) -> Result<usize> {
        let mut statement = self.sqlite.prepare(
            r#"update "studio_notification_jobs" set "status" = ?, "updated_at" = ? where ("studio_notification_jobs"."actor_id" = ? and "studio_notification_jobs"."status" = ? and "studio_notification_jobs"."kind" like ?) returning "id""#,
        )?;
        let cancelled = statement
            .query_map(
                params![
                    "cancelled",
                    now,
                    actor_id,
                    "queued",
                    format!("{}.%", publication_kind.as_str())
                ],
                |row| row.get::<_, i64>(0),
            )?
            .collect::<db::rusqlite::Result<Vec<_>>>()?;
        Ok(cancelled.len())
    }

    pub fn youtube_settings(&self) -> Result<Option<StudioYoutubeSettingsRecord>> {
        Ok(self
            .sqlite
            .query_row(
                r#"select "id", "signature", "updated_at" from "studio_youtube_settings" where "studio_youtube_settings"."id" = ?"#,
                [1],
                |row| {
                    Ok(StudioYoutubeSettingsRecord {
                        id: row.get(0)?,
                        signature: row.get(1)?,
                        updated_at: row.get(2)?,
                    })
                },
            )
            .optional()?)
    }

    pub fn save_youtube_settings(&self, signature: &str, updated_at: &str) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "studio_youtube_settings" ("id", "signature", "updated_at") values (?, ?, ?) on conflict ("studio_youtube_settings"."id") do update set "signature" = ?, "updated_at" = ?"#,
            params![1, signature, updated_at, signature, updated_at],
        )?;
        Ok(())
    }

    pub fn save_locale(&self, actor_id: i64, locale: &str, updated_at: &str) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "bot_ui_settings" ("actor_id", "locale", "timezone", "updated_at") values (?, ?, null, ?) on conflict ("bot_ui_settings"."actor_id") do update set "locale" = ?, "updated_at" = ?"#,
            params![actor_id, locale, updated_at, locale, updated_at],
        )?;
        Ok(())
    }

    /// A first row for the actor starts with the schema's default locale.
    pub fn save_timezone(&self, actor_id: i64, timezone: &str, updated_at: &str) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "bot_ui_settings" ("actor_id", "locale", "timezone", "updated_at") values (?, ?, ?, ?) on conflict ("bot_ui_settings"."actor_id") do update set "timezone" = ?, "updated_at" = ?"#,
            params![actor_id, "en", timezone, updated_at, timezone, updated_at],
        )?;
        Ok(())
    }
}
