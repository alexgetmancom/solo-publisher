//! The live configuration's platform credentials: what the database holds,
//! put under the names the rest of the process reads.
//!
//! Each change is a [`ConfigPatch`] swapped into the [`SharedConfig`] at one
//! point, so a reader sees either all of one change or none of it.

use db::rusqlite::Connection;
use foundation::config::{Config, SharedConfig};

use crate::{Result, api_keys, meta, x, youtube};

/// A credential setting the channels write, by its environment name.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Setting {
    ThreadsRuAccessToken,
    ThreadsEnAccessToken,
    InstagramRuAccessToken,
    InstagramEnAccessToken,
    InstagramRuUserId,
    InstagramEnUserId,
    XAccessToken,
    XRefreshToken,
    ZernioApiKey,
    DiscordBotToken,
    YoutubeRuRefreshToken,
    YoutubeEnRefreshToken,
}

impl Setting {
    pub const ALL: [Setting; 12] = [
        Self::ThreadsRuAccessToken,
        Self::ThreadsEnAccessToken,
        Self::InstagramRuAccessToken,
        Self::InstagramEnAccessToken,
        Self::InstagramRuUserId,
        Self::InstagramEnUserId,
        Self::XAccessToken,
        Self::XRefreshToken,
        Self::ZernioApiKey,
        Self::DiscordBotToken,
        Self::YoutubeRuRefreshToken,
        Self::YoutubeEnRefreshToken,
    ];

    pub fn name(self) -> &'static str {
        match self {
            Self::ThreadsRuAccessToken => "THREADS_RU_ACCESS_TOKEN",
            Self::ThreadsEnAccessToken => "THREADS_EN_ACCESS_TOKEN",
            Self::InstagramRuAccessToken => "INSTAGRAM_RU_ACCESS_TOKEN",
            Self::InstagramEnAccessToken => "INSTAGRAM_EN_ACCESS_TOKEN",
            Self::InstagramRuUserId => "INSTAGRAM_RU_USER_ID",
            Self::InstagramEnUserId => "INSTAGRAM_EN_USER_ID",
            Self::XAccessToken => "X_ACCESS_TOKEN",
            Self::XRefreshToken => "X_REFRESH_TOKEN",
            Self::ZernioApiKey => "ZERNIO_API_KEY",
            Self::DiscordBotToken => "DISCORD_BOT_TOKEN",
            Self::YoutubeRuRefreshToken => "YOUTUBE_RU_REFRESH_TOKEN",
            Self::YoutubeEnRefreshToken => "YOUTUBE_EN_REFRESH_TOKEN",
        }
    }

    fn slot(self, config: &mut Config) -> &mut Option<String> {
        match self {
            Self::ThreadsRuAccessToken => &mut config.threads_ru_access_token,
            Self::ThreadsEnAccessToken => &mut config.threads_en_access_token,
            Self::InstagramRuAccessToken => &mut config.instagram_ru_access_token,
            Self::InstagramEnAccessToken => &mut config.instagram_en_access_token,
            Self::InstagramRuUserId => &mut config.instagram_ru_user_id,
            Self::InstagramEnUserId => &mut config.instagram_en_user_id,
            Self::XAccessToken => &mut config.x_access_token,
            Self::XRefreshToken => &mut config.x_refresh_token,
            Self::ZernioApiKey => &mut config.zernio_api_key,
            Self::DiscordBotToken => &mut config.discord_bot_token,
            Self::YoutubeRuRefreshToken => &mut config.youtube_ru_refresh_token,
            Self::YoutubeEnRefreshToken => &mut config.youtube_en_refresh_token,
        }
    }

    pub fn get(self, config: &Config) -> Option<&str> {
        match self {
            Self::ThreadsRuAccessToken => config.threads_ru_access_token.as_deref(),
            Self::ThreadsEnAccessToken => config.threads_en_access_token.as_deref(),
            Self::InstagramRuAccessToken => config.instagram_ru_access_token.as_deref(),
            Self::InstagramEnAccessToken => config.instagram_en_access_token.as_deref(),
            Self::InstagramRuUserId => config.instagram_ru_user_id.as_deref(),
            Self::InstagramEnUserId => config.instagram_en_user_id.as_deref(),
            Self::XAccessToken => config.x_access_token.as_deref(),
            Self::XRefreshToken => config.x_refresh_token.as_deref(),
            Self::ZernioApiKey => config.zernio_api_key.as_deref(),
            Self::DiscordBotToken => config.discord_bot_token.as_deref(),
            Self::YoutubeRuRefreshToken => config.youtube_ru_refresh_token.as_deref(),
            Self::YoutubeEnRefreshToken => config.youtube_en_refresh_token.as_deref(),
        }
    }
}

/// Assignments to credential settings, in the order they were made.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct ConfigPatch(Vec<(Setting, String)>);

impl ConfigPatch {
    pub fn set(&mut self, setting: Setting, value: impl Into<String>) {
        self.0.push((setting, value.into()));
    }

    pub fn is_empty(&self) -> bool {
        self.0.is_empty()
    }

    pub fn apply_to(&self, config: &mut Config) {
        for (setting, value) in &self.0 {
            *setting.slot(config) = Some(value.clone());
        }
    }

    /// Swaps the patched configuration in; nothing when it changes nothing.
    pub fn commit(&self, config: &SharedConfig) {
        let current = config.load();
        if self
            .0
            .iter()
            .all(|(setting, value)| setting.get(&current) == Some(value))
        {
            return;
        }
        config.update(|current| {
            let mut next = current.clone();
            self.apply_to(&mut next);
            next
        });
    }
}

/// One setting written to the live configuration.
pub(crate) fn assign(config: &SharedConfig, assignments: &[(Setting, &str)]) {
    let mut patch = ConfigPatch::default();
    for (setting, value) in assignments {
        patch.set(*setting, *value);
    }
    patch.commit(config);
}

/// `applyStoredCredentials`: makes the running process's credentials equal to
/// what the database holds — the renewed Meta tokens, the connected X pair,
/// the stored API keys, the connected YouTube channels — in that order. A
/// store that fails stops the rest, and what was applied before it stays applied.
pub fn apply_stored_credentials(config: &SharedConfig, sqlite: &Connection) -> Result<()> {
    let current = config.load();
    let mut patch = ConfigPatch::default();
    let applied = stored_credentials(&current, sqlite, &mut patch);
    patch.commit(config);
    applied
}

fn stored_credentials(config: &Config, sqlite: &Connection, patch: &mut ConfigPatch) -> Result<()> {
    meta::stored_meta_tokens(config, sqlite, patch)?;
    x::stored_x_tokens(config, sqlite, patch)?;
    api_keys::stored_api_keys(config, sqlite, patch)?;
    youtube::stored_youtube_tokens(config, sqlite, patch)
}

/// The encryption key, or `None` when this Studio stores no credentials.
pub(crate) fn encryption_key(config: &Config) -> Result<Option<foundation::secret_box::SecretKey>> {
    Ok(foundation::secret_box::encryption_key(
        config.token_encryption_key.as_deref(),
    )?)
}
