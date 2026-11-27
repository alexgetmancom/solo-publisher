//! The Studio's own settings, read from the
//! `studio_profile` row on every access rather than captured at boot: an
//! operator who changes the time zone or turns the public site on expects the
//! next request to reflect it, not the next deploy.
//!
//! The fresh-install values (`DEFAULT_STUDIO_PROFILE`,
//! `DEFAULT_MILESTONE_THRESHOLDS`) are the column defaults the migrations
//! carry, which is where this side reads them from.

use content::Locale;
use serde::Serialize;

use crate::Result;
use crate::application::ports::{ApplicationPorts, LocalizedText, StudioProfileRecord, StudioSocialProfile};

/// What this Studio says it is, in one language.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StudioSite {
    pub name: String,
    pub tagline: String,
    pub about: String,
    pub bio: String,
    pub profiles: Vec<StudioSocialProfile>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
pub struct StudioVideoSettings {
    pub prepare_lead_minutes: i64,
    pub retention_hours: i64,
}

/// A live view over the profile row; every method is one indexed read.
#[derive(Clone, Copy)]
pub struct StudioConfig<'a> {
    ports: ApplicationPorts<'a>,
}

pub fn studio_config<'a>(ports: ApplicationPorts<'a>) -> StudioConfig<'a> {
    StudioConfig { ports }
}

pub(crate) fn localized(text: &LocalizedText, locale: Locale) -> &str {
    match locale {
        Locale::Ru => &text.ru,
        Locale::En => &text.en,
    }
}

impl StudioConfig<'_> {
    fn read(&self) -> Result<StudioProfileRecord> {
        self.ports.studio_settings().profile()
    }

    /// The operator's zone: what the bot screens and every schedule are read in.
    pub fn timezone(&self) -> Result<String> {
        Ok(self.read()?.timezone)
    }

    pub fn timezone_label(&self) -> Result<String> {
        Ok(self.read()?.timezone_label)
    }

    pub fn site_enabled(&self) -> Result<bool> {
        Ok(self.read()?.site_enabled != 0)
    }

    pub fn site(&self, locale: Locale) -> Result<StudioSite> {
        let row = self.read()?;
        Ok(StudioSite {
            name: localized(&row.name_json, locale).to_owned(),
            tagline: localized(&row.tagline_json, locale).to_owned(),
            about: localized(&row.about_json, locale).to_owned(),
            bio: localized(&row.bio_json, locale).to_owned(),
            profiles: match locale {
                Locale::Ru => row.profiles_json.ru,
                Locale::En => row.profiles_json.en,
            },
        })
    }

    /// The zone the public site prints its timestamps in for one language.
    /// It is not `timezone`: a publication whose readers are somewhere else
    /// has to be able to date its posts for them without moving its own
    /// operator to that clock. Unset falls back to the operator's zone.
    pub fn site_timezone(&self, locale: Locale) -> Result<String> {
        let row = self.read()?;
        let zone = localized(&row.site_timezone_json, locale).trim();
        Ok(if zone.is_empty() { row.timezone } else { zone.to_owned() })
    }

    pub fn video(&self) -> Result<StudioVideoSettings> {
        let row = self.read()?;
        Ok(StudioVideoSettings {
            prepare_lead_minutes: row.video_prepare_lead_minutes,
            retention_hours: row.video_retention_hours,
        })
    }
}
