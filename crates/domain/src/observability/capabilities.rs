//! The readiness report (`observability/capabilities.ts`, `capabilityReport`
//! over the channel registry): which settings each connected capability needs
//! and which of them this configuration lacks, by name only.

use db::rusqlite::Connection;
use foundation::config::{Config, MediaProcessorProvider, SharedConfig};

use crate::Result;
use crate::channels::list_channels;
use crate::publishing::platform_profiles::platform_profile;
use crate::studio::boundaries::{CapabilityReportEntry, CapabilityStatus, Readiness};

const CONTROLLER_REQUIREMENTS: &[&str] = &["CONTROLLER_BOT_TOKEN", "CONTROLLER_ADMIN_IDS"];
const MEDIA_PROCESSOR_REQUIREMENTS: &[&str] = &["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"];

/// The report over the process's live configuration.
#[derive(Clone)]
pub struct CapabilityReadiness {
    config: SharedConfig,
}

impl CapabilityReadiness {
    pub fn new(config: SharedConfig) -> Self {
        Self { config }
    }
}

impl Readiness for CapabilityReadiness {
    fn capability_report(&self, sqlite: &Connection) -> Result<Vec<CapabilityReportEntry>> {
        capability_report(&self.config.load(), sqlite)
    }
}

/// `capabilityReport(config, backendDb)`: one entry per registered
/// capability, in the order the registry first names it.
pub fn capability_report(config: &Config, sqlite: &Connection) -> Result<Vec<CapabilityReportEntry>> {
    Ok(registered_requirements(config, sqlite)?
        .into_iter()
        .map(|(target, required)| {
            let missing: Vec<String> = required
                .iter()
                .filter(|name| !configured(config, name))
                .cloned()
                .collect();
            CapabilityReportEntry {
                status: if missing.is_empty() {
                    CapabilityStatus::Ready
                } else {
                    CapabilityStatus::Missing
                },
                target,
                required,
                missing,
            }
        })
        .collect())
}

/// `registeredRequirements`: a `Map`, so setting a key again keeps its place.
fn registered_requirements(config: &Config, sqlite: &Connection) -> Result<Vec<(String, Vec<String>)>> {
    let mut requirements: Vec<(String, Vec<String>)> = Vec::new();
    let mut set = |target: String, required: &[&str]| {
        let required = required.iter().map(|name| (*name).to_owned()).collect();
        match requirements.iter_mut().find(|(key, _)| *key == target) {
            Some(entry) => entry.1 = required,
            None => requirements.push((target, required)),
        }
    };
    if config.controller_bot_token.is_some() || !config.controller_admin_ids.is_empty() {
        set("controller_bot".into(), CONTROLLER_REQUIREMENTS);
    }
    for channel in list_channels(sqlite, true)? {
        let channel = channel.connection;
        // A target delivered through a provider needs the provider key, not
        // the platform tokens it would have needed natively.
        if let Some(target) = channel.target_id {
            let required = if channel.provider == "zernio" {
                &["ZERNIO_API_KEY"][..]
            } else {
                platform_profile(&target).map_or(&[][..], |profile| profile.requirements)
            };
            set(target, required);
        } else if channel.platform == "youtube" || channel.platform == "instagram" {
            let required = video_channel_requirements(&channel.platform, &channel.locale, &channel.provider);
            set(channel.id, required);
        }
    }
    if config.media_processor_provider == MediaProcessorProvider::RemoteHttp {
        set("media_processor".into(), MEDIA_PROCESSOR_REQUIREMENTS);
    }
    Ok(requirements)
}

fn video_channel_requirements(platform: &str, locale: &str, provider: &str) -> &'static [&'static str] {
    if provider == "zernio" {
        return &["ZERNIO_API_KEY"];
    }
    match (platform == "youtube", locale == "en") {
        (true, true) => &[
            "YOUTUBE_EN_CLIENT_ID",
            "YOUTUBE_EN_CLIENT_SECRET",
            "YOUTUBE_EN_REFRESH_TOKEN",
        ],
        (true, false) => &[
            "YOUTUBE_RU_CLIENT_ID",
            "YOUTUBE_RU_CLIENT_SECRET",
            "YOUTUBE_RU_REFRESH_TOKEN",
        ],
        (false, true) => &["INSTAGRAM_EN_ACCESS_TOKEN", "INSTAGRAM_EN_USER_ID"],
        (false, false) => &["INSTAGRAM_RU_ACCESS_TOKEN", "INSTAGRAM_RU_USER_ID"],
    }
}

/// The settings of `names` this configuration has no value for, in order:
/// what `validatePlatformTarget` names when a target is not configured.
pub fn missing_settings<'a>(config: &Config, names: &[&'a str]) -> Vec<&'a str> {
    names.iter().copied().filter(|name| !configured(config, name)).collect()
}

/// `!values[name]` turned around: whether the configuration holds a value
/// for the setting, the admin list counted by its length. A name the
/// configuration does not carry reads as missing, as an absent key does.
fn configured(config: &Config, name: &str) -> bool {
    match setting(config, name) {
        Some(Setting::Text(value)) => value.is_some_and(|value| !value.is_empty()),
        Some(Setting::Present(present)) => present,
        None => false,
    }
}

enum Setting<'a> {
    Text(Option<&'a str>),
    Present(bool),
}

/// Every setting a requirement above can name.
fn setting<'a>(config: &'a Config, name: &str) -> Option<Setting<'a>> {
    let text = |value: &'a Option<String>| Some(Setting::Text(value.as_deref()));
    match name {
        "CONTROLLER_ADMIN_IDS" => Some(Setting::Present(!config.controller_admin_ids.is_empty())),
        "TELEGRAM_CHANNEL_STORIES_API_ID" => Some(Setting::Present(
            config.telegram_channel_stories_api_id.is_some_and(|id| id != 0),
        )),
        "CONTROLLER_BOT_TOKEN" => text(&config.controller_bot_token),
        "ZERNIO_API_KEY" => text(&config.zernio_api_key),
        "THREADS_RU_ACCESS_TOKEN" => text(&config.threads_ru_access_token),
        "THREADS_EN_ACCESS_TOKEN" => text(&config.threads_en_access_token),
        "X_CLIENT_ID" => text(&config.x_client_id),
        "X_CLIENT_SECRET" => text(&config.x_client_secret),
        "X_ACCESS_TOKEN" => text(&config.x_access_token),
        "X_REFRESH_TOKEN" => text(&config.x_refresh_token),
        "DISCORD_BOT_TOKEN" => text(&config.discord_bot_token),
        "DISCORD_CHANNEL_ID" => text(&config.discord_channel_id),
        "TELEGRAM_CHANNEL_STORIES_API_HASH" => text(&config.telegram_channel_stories_api_hash),
        "TELEGRAM_CHANNEL_STORIES_SESSION" => text(&config.telegram_channel_stories_session),
        "INSTAGRAM_RU_ACCESS_TOKEN" => text(&config.instagram_ru_access_token),
        "INSTAGRAM_RU_USER_ID" => text(&config.instagram_ru_user_id),
        "INSTAGRAM_EN_ACCESS_TOKEN" => text(&config.instagram_en_access_token),
        "INSTAGRAM_EN_USER_ID" => text(&config.instagram_en_user_id),
        "YOUTUBE_RU_CLIENT_ID" => text(&config.youtube_ru_client_id),
        "YOUTUBE_RU_CLIENT_SECRET" => text(&config.youtube_ru_client_secret),
        "YOUTUBE_RU_REFRESH_TOKEN" => text(&config.youtube_ru_refresh_token),
        "YOUTUBE_EN_CLIENT_ID" => text(&config.youtube_en_client_id),
        "YOUTUBE_EN_CLIENT_SECRET" => text(&config.youtube_en_client_secret),
        "YOUTUBE_EN_REFRESH_TOKEN" => text(&config.youtube_en_refresh_token),
        "MEDIA_PROCESSOR_URL" => text(&config.media_processor_url),
        "MEDIA_PROCESSOR_TOKEN" => text(&config.media_processor_token),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::publishing::platform_profiles::PLATFORM_PROFILES;

    /// A requirement the configuration map does not know would read as
    /// missing forever; every name the report can produce must be mapped.
    #[test]
    fn every_requirement_names_a_setting() {
        let config = foundation::config::load_config([("DATA_DIR".to_owned(), "/tmp".to_owned())]).unwrap();
        let mut names: Vec<&str> = PLATFORM_PROFILES
            .iter()
            .flat_map(|profile| profile.requirements.iter().copied())
            .collect();
        names.extend(CONTROLLER_REQUIREMENTS);
        names.extend(MEDIA_PROCESSOR_REQUIREMENTS);
        names.push("ZERNIO_API_KEY");
        for (platform, locale) in [
            ("youtube", "en"),
            ("youtube", "ru"),
            ("instagram", "en"),
            ("instagram", "ru"),
        ] {
            names.extend(video_channel_requirements(platform, locale, "native"));
        }
        for name in names {
            assert!(setting(&config, name).is_some(), "{name} is not mapped to a setting");
        }
    }
}
