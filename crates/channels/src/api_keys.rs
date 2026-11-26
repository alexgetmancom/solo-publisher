//! The services this Studio reaches with a key it is
//! handed rather than one it negotiates. The operator pastes it once, it is
//! verified against the service, and it lives sealed in the database.

use db::rusqlite::Connection;
use foundation::config::{Config, SharedConfig};
use foundation::js;
use foundation::logger::{LogLevel, log};
use foundation::secret_box::{open, seal};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use runtime::http::{HttpClient, HttpRequest};
use serde::Serialize;
use serde_json::{Value, json};

use crate::credentials::{ConfigPatch, Setting, assign, encryption_key};
use crate::encode::encode_uri_component;
use crate::meta::id_text;
use crate::token_store::{TokenWrite, platform_token, store_platform_token};
use crate::{Error, Result};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ApiKeyTarget {
    Zernio,
    Discord,
}

pub const API_KEY_TARGETS: [ApiKeyTarget; 2] = [ApiKeyTarget::Zernio, ApiKeyTarget::Discord];

impl ApiKeyTarget {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Zernio => "zernio",
            Self::Discord => "discord",
        }
    }

    pub fn parse(name: &str) -> Option<Self> {
        API_KEY_TARGETS.into_iter().find(|target| target.as_str() == name)
    }

    fn setting(self) -> Setting {
        match self {
            Self::Zernio => Setting::ZernioApiKey,
            Self::Discord => Setting::DiscordBotToken,
        }
    }
}

/// `applyStoredApiKeys`: each stored key under the name the process reads.
pub fn stored_api_keys(config: &Config, sqlite: &Connection, patch: &mut ConfigPatch) -> Result<()> {
    let Some(key) = encryption_key(config)? else {
        return Ok(());
    };
    for target in API_KEY_TARGETS {
        let Some(row) = platform_token(sqlite, target.as_str())? else {
            continue;
        };
        match open(&row.sealed_token, &key) {
            Ok(value) => patch.set(target.setting(), value),
            Err(error) => log(
                LogLevel::Warn,
                "stored API key could not be opened",
                Some(json!({"target": target.as_str(), "error": format!("Error: {error}")})),
            ),
        }
    }
    Ok(())
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct StoredApiKey {
    pub target: ApiKeyTarget,
    pub account: String,
}

/// `storeApiKey`: verified against the service, then stored sealed. A key the
/// service rejects is a paste error, and the moment to say so is now.
pub async fn store_api_key(
    config: &SharedConfig,
    sqlite: &Connection,
    http: &HttpClient,
    target: ApiKeyTarget,
    value: &str,
    now: Timestamp,
) -> Result<StoredApiKey> {
    let current = config.load();
    let Some(key) = encryption_key(&current)? else {
        return Err(Error::message("TOKEN_ENCRYPTION_KEY is required to store a credential"));
    };
    let trimmed = js::trim(value);
    if trimmed.is_empty() {
        return Err(Error::message(format!("no {} key was given", target.as_str())));
    }
    let account = match target {
        ApiKeyTarget::Zernio => verify_zernio_key(http, trimmed).await?,
        ApiKeyTarget::Discord => verify_discord_token(http, trimmed).await?,
    };
    let stamp = to_iso_string(now);
    let sealed_token = seal(trimmed, &key);
    let upload_limit_bytes = upload_limit_bytes(http, &current, target, trimmed).await;
    store_platform_token(
        sqlite,
        target.as_str(),
        &TokenWrite {
            sealed_token,
            seed_fingerprint: None,
            account_id: Some(account.clone()),
            sealed_refresh_token: Some(None),
            expires_at: Some(None),
            refreshed_at: stamp.clone(),
            upload_limit_bytes: Some(upload_limit_bytes),
            updated_at: stamp,
        },
    )?;
    assign(config, &[(target.setting(), trimmed)]);
    Ok(StoredApiKey { target, account })
}

async fn verify_zernio_key(http: &HttpClient, value: &str) -> Result<String> {
    let response = http
        .request_json(
            HttpRequest::get("https://zernio.com/api/v1/accounts").header("Authorization", format!("Bearer {value}")),
        )
        .await?;
    let count = match &response {
        Value::Array(accounts) => accounts.len(),
        other => other.get("accounts").and_then(Value::as_array).map_or(0, Vec::len),
    };
    Ok(format!("{count} connected accounts"))
}

async fn verify_discord_token(http: &HttpClient, value: &str) -> Result<String> {
    let bot = http
        .request_json(
            HttpRequest::get("https://discord.com/api/v10/users/@me").header("Authorization", format!("Bot {value}")),
        )
        .await?;
    Ok(bot
        .get("username")
        .filter(|name| !name.is_null())
        .or_else(|| bot.get("id").filter(|id| !id.is_null()))
        .and_then(id_text)
        .unwrap_or_default())
}

/// Discord's published per-boost-tier attachment caps, tier 0 through 3.
const DISCORD_BOOST_UPLOAD_BYTES: [i64; 4] = [10_485_760, 10_485_760, 52_428_800, 104_857_600];

/// Discord's cap moves with the server's boost level, so it is asked once,
/// here; a server that cannot be read leaves it unset and the platform's own
/// floor applies.
async fn upload_limit_bytes(http: &HttpClient, config: &Config, target: ApiKeyTarget, token: &str) -> Option<i64> {
    let guild_id = config.discord_guild_id.as_deref().filter(|id| !id.is_empty());
    let (ApiKeyTarget::Discord, Some(guild_id)) = (target, guild_id) else {
        return None;
    };
    let guild = http
        .request_json(
            HttpRequest::get(format!(
                "https://discord.com/api/v10/guilds/{}",
                encode_uri_component(guild_id)
            ))
            .header("Authorization", format!("Bot {token}")),
        )
        .await;
    match guild {
        Ok(guild) => {
            let tier = match guild.get("premium_tier") {
                None | Some(Value::Null) => Some(0),
                Some(tier) => tier
                    .as_f64()
                    .filter(|tier| tier.fract() == 0.0 && *tier >= 0.0 && *tier < 4.0)
                    .map(|tier| tier as usize),
            };
            Some(tier.map_or(DISCORD_BOOST_UPLOAD_BYTES[0], |tier| DISCORD_BOOST_UPLOAD_BYTES[tier]))
        }
        Err(error) => {
            log(
                LogLevel::Warn,
                "Discord upload limit could not be read",
                Some(json!({"error": format!("Error: {error}")})),
            );
            None
        }
    }
}
