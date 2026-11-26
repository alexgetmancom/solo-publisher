//! Owner and Studio-wide settings commands.

use foundation::errors::StudioError;
use foundation::time::{Zone, is_valid_time_zone, time_zone_offset_label};
use serde::{Deserialize, Serialize};

use crate::Result;
use crate::application::conversation_flow::PublicationKind;
use crate::application::ports::{
    ApplicationPorts, LocalizedProfiles, LocalizedText, StudioNotificationSettingsRecord, StudioProfilePatch,
};
use crate::targets::{PublicationForm, TargetMap, is_known_target, targets_record};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct NotificationSettings {
    pub video_reminders_enabled: bool,
    pub post_reminders_enabled: bool,
    pub reminder_minutes: i64,
    pub completion_enabled: bool,
}

/// The fields to change; `reminder_minutes` is a number as a transport sent
/// it, so a fraction is refused rather than rounded.
#[derive(Clone, Copy, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct NotificationSettingsInput {
    pub video_reminders_enabled: Option<bool>,
    pub post_reminders_enabled: Option<bool>,
    pub reminder_minutes: Option<f64>,
    pub completion_enabled: Option<bool>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct BackupSettings {
    pub enabled: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoProfile {
    pub prepare_lead_minutes: i64,
    pub retention_hours: i64,
}

/// What this Studio is and how its deployment behaves, as an operator sees it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StudioProfileView {
    pub timezone: String,
    pub timezone_label: String,
    pub site_enabled: bool,
    /// The platforms the default-targets screen has ticked: what every new
    /// draft goes to and what preparation is worth doing.
    pub default_targets: Vec<String>,
    pub video: VideoProfile,
    pub name: LocalizedText,
    pub tagline: LocalizedText,
    pub about: LocalizedText,
    pub bio: LocalizedText,
    pub site_timezone: LocalizedText,
    pub profiles: LocalizedProfiles,
}

#[derive(Clone, Debug, Default, PartialEq, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct StudioProfileInput {
    pub timezone: Option<String>,
    pub timezone_label: Option<String>,
    pub site_enabled: Option<bool>,
    pub prepare_lead_minutes: Option<f64>,
    pub retention_hours: Option<f64>,
    pub name: Option<LocalizedText>,
    pub tagline: Option<LocalizedText>,
    pub about: Option<LocalizedText>,
    pub bio: Option<LocalizedText>,
    pub site_timezone: Option<LocalizedText>,
    pub profiles: Option<LocalizedProfiles>,
}

/// The zone schedules are read in, and how it is labelled.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct TimeConfig {
    #[serde(rename = "TIMEZONE")]
    pub timezone: String,
    #[serde(rename = "TIMEZONE_LABEL")]
    pub timezone_label: String,
}

fn integer_in(value: f64, range: std::ops::RangeInclusive<i64>) -> Option<i64> {
    (value.fract() == 0.0 && value >= *range.start() as f64 && value <= *range.end() as f64).then_some(value as i64)
}

#[derive(Clone, Copy)]
pub struct SettingsService<'a> {
    ports: ApplicationPorts<'a>,
}

impl<'a> SettingsService<'a> {
    pub fn new(ports: ApplicationPorts<'a>) -> Self {
        Self { ports }
    }

    fn now(&self) -> String {
        foundation::time::to_iso_string(self.ports.clock().now())
    }

    pub fn studio_profile(&self) -> Result<StudioProfileView> {
        let row = self.ports.studio_settings().profile()?;
        Ok(StudioProfileView {
            timezone: row.timezone,
            timezone_label: row.timezone_label,
            site_enabled: row.site_enabled != 0,
            default_targets: row.default_targets_json,
            video: VideoProfile {
                prepare_lead_minutes: row.video_prepare_lead_minutes,
                retention_hours: row.video_retention_hours,
            },
            name: row.name_json,
            tagline: row.tagline_json,
            about: row.about_json,
            bio: row.bio_json,
            site_timezone: row.site_timezone_json,
            profiles: row.profiles_json,
        })
    }

    pub fn set_studio_profile(&self, input: &StudioProfileInput) -> Result<StudioProfileView> {
        let invalid_zone = || StudioError::new("err.timezone-invalid");
        if let Some(zone) = &input.timezone
            && !is_valid_time_zone(foundation::js::trim(zone))
        {
            return Err(invalid_zone().into());
        }
        // A blank clears the override back to the operator's zone; anything
        // else has to be a real zone, or the public site renders every date
        // as a raw ISO string and nobody finds out until a reader says so.
        if let Some(zones) = &input.site_timezone {
            for zone in [&zones.en, &zones.ru] {
                let zone = foundation::js::trim(zone);
                if !zone.is_empty() && !is_valid_time_zone(zone) {
                    return Err(invalid_zone().into());
                }
            }
        }
        let prepare_lead_minutes = input
            .prepare_lead_minutes
            .map(|value| integer_in(value, 1..=120).ok_or_else(|| StudioError::new("err.video-prepare-lead-range")))
            .transpose()?;
        let retention_hours = input
            .retention_hours
            .map(|value| integer_in(value, 24..=720).ok_or_else(|| StudioError::new("err.video-retention-range")))
            .transpose()?;
        self.ports.studio_settings().save_profile(&StudioProfilePatch {
            timezone: input
                .timezone
                .as_deref()
                .map(|zone| foundation::js::trim(zone).to_owned()),
            timezone_label: input
                .timezone_label
                .as_deref()
                .map(|label| foundation::js::trim(label).to_owned()),
            site_enabled: input.site_enabled.map(i64::from),
            video_prepare_lead_minutes: prepare_lead_minutes,
            video_retention_hours: retention_hours,
            name_json: input.name.clone(),
            tagline_json: input.tagline.clone(),
            about_json: input.about.clone(),
            bio_json: input.bio.clone(),
            site_timezone_json: input.site_timezone.clone(),
            profiles_json: input.profiles.clone(),
            default_targets_json: None,
            updated_at: self.now(),
        })?;
        self.studio_profile()
    }

    pub fn timezone(&self, actor_id: i64, fallback: &str) -> Result<String> {
        let stored = self.ports.studio_settings().timezone(actor_id)?;
        Ok(match stored.as_deref().map(foundation::js::trim) {
            Some(zone) if !zone.is_empty() && is_valid_time_zone(zone) => zone.to_owned(),
            _ => fallback.to_owned(),
        })
    }

    /// The owner's zone over the Studio's, labelled the Studio's way when they
    /// agree and by its offset when the owner picked another. The Studio zone
    /// is read directly from the profile row, the one the configuration reads
    /// it from too.
    pub fn time_config(&self, actor_id: i64) -> Result<TimeConfig> {
        let profile = self.ports.studio_settings().profile()?;
        let timezone = self.timezone(actor_id, &profile.timezone)?;
        let timezone_label = if timezone == profile.timezone {
            profile.timezone_label
        } else {
            let zone = Zone::parse(&timezone).expect("a stored zone is checked valid on read");
            time_zone_offset_label(&zone, self.ports.clock().now())
        };
        Ok(TimeConfig {
            timezone,
            timezone_label,
        })
    }

    /// Absent means enabled for every kind, with reminders five minutes ahead.
    pub fn notifications(&self, actor_id: i64) -> Result<NotificationSettings> {
        let row = self.ports.studio_settings().notifications(actor_id)?;
        Ok(NotificationSettings {
            video_reminders_enabled: row.as_ref().is_none_or(|row| row.video_reminders_enabled != 0),
            post_reminders_enabled: row.as_ref().is_none_or(|row| row.post_reminders_enabled != 0),
            reminder_minutes: row.as_ref().map_or(5, |row| row.reminder_minutes),
            completion_enabled: row.as_ref().is_none_or(|row| row.completion_enabled != 0),
        })
    }

    /// Absent means enabled: a Studio that has never opened settings still
    /// gets a copy of its database, which is the case the backup exists for.
    pub fn backup(&self) -> Result<BackupSettings> {
        Ok(BackupSettings {
            enabled: self
                .ports
                .studio_settings()
                .backup()?
                .is_none_or(|row| row.enabled != 0),
        })
    }

    pub fn set_backup(&self, enabled: bool) -> Result<BackupSettings> {
        self.ports
            .studio_settings()
            .save_backup(i64::from(enabled), &self.now())?;
        Ok(BackupSettings { enabled })
    }

    pub fn set_notifications(&self, actor_id: i64, input: &NotificationSettingsInput) -> Result<NotificationSettings> {
        let reminder_minutes = input
            .reminder_minutes
            .map(|value| integer_in(value, 1..=60).ok_or_else(|| StudioError::new("err.reminder-range")))
            .transpose()?;
        let current = self.notifications(actor_id)?;
        let now = self.now();
        let next = NotificationSettings {
            video_reminders_enabled: input.video_reminders_enabled.unwrap_or(current.video_reminders_enabled),
            post_reminders_enabled: input.post_reminders_enabled.unwrap_or(current.post_reminders_enabled),
            reminder_minutes: reminder_minutes.unwrap_or(current.reminder_minutes),
            completion_enabled: input.completion_enabled.unwrap_or(current.completion_enabled),
        };
        let settings = self.ports.studio_settings();
        settings.save_notifications(&StudioNotificationSettingsRecord {
            actor_id,
            video_reminders_enabled: i64::from(next.video_reminders_enabled),
            post_reminders_enabled: i64::from(next.post_reminders_enabled),
            reminder_minutes: next.reminder_minutes,
            completion_enabled: i64::from(next.completion_enabled),
            updated_at: now.clone(),
        })?;
        if current.video_reminders_enabled && !next.video_reminders_enabled {
            settings.cancel_queued_reminders(actor_id, PublicationKind::Video, &now)?;
        }
        if current.post_reminders_enabled && !next.post_reminders_enabled {
            settings.cancel_queued_reminders(actor_id, PublicationKind::Post, &now)?;
        }
        Ok(next)
    }

    pub fn youtube_signature(&self) -> Result<String> {
        Ok(self
            .ports
            .studio_settings()
            .youtube_settings()?
            .map(|row| foundation::js::trim(&row.signature).to_owned())
            .unwrap_or_default())
    }

    /// `-` clears it; a pasted link has its slashes straightened.
    pub fn set_youtube_signature(&self, value: &str) -> Result<()> {
        let signature = if value == "-" {
            String::new()
        } else {
            content::message::fix_url_slashes(value)
        };
        self.ports
            .studio_settings()
            .save_youtube_settings(&signature, &self.now())
    }

    pub fn clear_youtube_signature(&self) -> Result<()> {
        self.set_youtube_signature("-")
    }

    /// The platforms a new draft starts with, as a full on/off record.
    pub fn default_targets(&self) -> Result<TargetMap> {
        let selected = self.ports.studio_settings().profile()?.default_targets_json;
        Ok(targets_record(
            &selected.iter().map(String::as_str).collect::<Vec<_>>(),
            PublicationForm::Post,
        ))
    }

    pub fn toggle_default_target(&self, target: &str) -> Result<TargetMap> {
        if !is_known_target(target) {
            return Err(StudioError::new("err.unknown-target").into());
        }
        let mut next = self.default_targets()?;
        let enabled = next.get(target);
        next.set(target, !enabled);
        self.ports.studio_settings().save_profile(&StudioProfilePatch {
            default_targets_json: Some(next.enabled().map(str::to_owned).collect()),
            updated_at: self.now(),
            ..StudioProfilePatch::default()
        })?;
        Ok(next)
    }

    pub fn set_timezone(&self, actor_id: i64, timezone: &str) -> Result<()> {
        let value = foundation::js::trim(timezone);
        if !is_valid_time_zone(value) {
            return Err(StudioError::new("err.timezone-invalid").into());
        }
        self.ports.studio_settings().save_timezone(actor_id, value, &self.now())
    }
}
