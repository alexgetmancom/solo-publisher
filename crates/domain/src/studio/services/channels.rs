//! Channel administration shared by Studio interfaces, with the registry writes
//! and the route options. Telegram renders the connection wizard, operations
//! drives the same service: two implementations of "is this
//! channel connected" is two answers, and only one of them can be right.

use content::Locale;
use serde::{Deserialize, Serialize};

use crate::application::ports::{ChannelConnection, ChannelConnectionRecord};
use crate::channels::list_channels;
use crate::publishing::video_types::{ACCOUNT_PLATFORMS, VIDEO_TARGETS};
use crate::studio::Studio;
use crate::studio::boundaries::{
    CapabilityStatus, ConnectPlatform, ConnectStart, MetaOauthPlatform, ZernioAccount, ZernioDirectory,
};
use crate::targets::target_definition;
use crate::{Error, Result};

/// A connection as an interface asks for it.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelInput {
    pub platform: String,
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    pub provider: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub provider_account_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub target_id: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub label: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub source: Option<String>,
}

/// What the publish path's breaker holds for a channel's credential. `ready`
/// describes what is stored; this describes whether it still works.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelCredential {
    /// Publishing to this target is paused until the breaker closes.
    pub blocked: bool,
    pub blocked_until: Option<String>,
    pub auth_failure_streak: i64,
    pub last_auth_failure_at: Option<String>,
    pub token_expires_at: Option<String>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ChannelStatus {
    Ready,
    Missing,
    Disabled,
}

/// What a channel looks like to every surface that shows one. Credentials
/// are only ever reported by name.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChannelReport {
    pub id: String,
    pub platform: String,
    pub locale: String,
    pub provider: String,
    pub provider_account_id: Option<String>,
    pub label: String,
    pub enabled: bool,
    pub source: String,
    pub publishable: bool,
    pub status: ChannelStatus,
    pub missing: Vec<String>,
    pub credential: ChannelCredential,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum ZernioConnectionKey {
    Threads,
    InstagramReels,
    InstagramStories,
}

/// One publication route a provider account can serve.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ZernioConnectionOption {
    pub key: ZernioConnectionKey,
    pub account_id: String,
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    pub label: String,
    pub input: ChannelInput,
}

fn display_platform(platform: &str) -> String {
    match platform {
        "youtube" => "YouTube".into(),
        "instagram" => "Instagram".into(),
        _ => {
            let mut chars = platform.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().chain(chars).collect(),
                None => "undefined".into(),
            }
        }
    }
}

/// Platforms the video pipeline can publish to, by the registry's name.
fn is_publishable_video_platform(platform: &str) -> bool {
    VIDEO_TARGETS.iter().any(|target| target.platform() == platform)
}

/// A channel is either a text target this Studio publishes to or a platform
/// the video pipeline can reach. Anything else is a row that can never
/// publish, and nothing downstream would say so.
pub fn register_channel(studio: &Studio<'_>, input: &ChannelInput) -> Result<ChannelConnectionRecord> {
    if input.target_id.is_none() && !ACCOUNT_PLATFORMS.contains(&input.platform.as_str()) {
        return Err(Error::message(format!(
            "Unknown platform: {}. Account platforms are {}; a text channel names its target instead.",
            input.platform,
            ACCOUNT_PLATFORMS.join(", ")
        )));
    }
    let id = input
        .target_id
        .clone()
        .unwrap_or_else(|| format!("{}_{}", input.platform, input.locale.as_str()));
    let channels = studio.ports().channels();
    channels.upsert(
        &ChannelConnection {
            id: id.clone(),
            platform: input.platform.clone(),
            locale: input.locale.as_str().into(),
            provider: input.provider.clone(),
            provider_account_id: input.provider_account_id.clone(),
            target_id: input.target_id.clone(),
            label: input.label.clone().unwrap_or_else(|| {
                format!(
                    "{} {}",
                    display_platform(&input.platform),
                    input.locale.as_str().to_uppercase()
                )
            }),
            enabled: 1,
            source: input.source.clone().unwrap_or_else(|| "interface".into()),
        },
        &foundation::time::to_iso_string(studio.now()),
    )?;
    channels
        .get(&id)?
        .ok_or_else(|| Error::message(format!("Channel registration did not persist: {id}")))
}

/// Registers a text or Story route from the target that already owns its
/// platform identity and language, so no surface can persist a target under
/// a conflicting locale.
pub fn register_target_channel(
    studio: &Studio<'_>,
    target_id: &str,
    provider: &str,
    provider_account_id: Option<&str>,
    label: Option<&str>,
    source: Option<&str>,
) -> Result<ChannelConnectionRecord> {
    let target = target_definition(target_id)
        .ok_or_else(|| Error::message(format!("Unknown publication target: {target_id}")))?;
    register_channel(
        studio,
        &ChannelInput {
            platform: target_id.into(),
            locale: target.locale,
            provider: provider.into(),
            provider_account_id: provider_account_id.filter(|id| !id.is_empty()).map(str::to_owned),
            target_id: Some(target_id.into()),
            label: Some(label.unwrap_or(target.label).into()),
            source: source.filter(|source| !source.is_empty()).map(str::to_owned),
        },
    )
}

fn zernio_platform(account: &ZernioAccount) -> String {
    let value = account
        .platform
        .as_deref()
        .map(|platform| platform.trim().to_lowercase())
        .unwrap_or_default();
    for known in ["threads", "instagram", "youtube", "tiktok"] {
        if value.contains(known) {
            return known.into();
        }
    }
    value
}

/// Turns one provider account into only the publication routes this
/// pipeline can actually deliver through Zernio. TikTok remains
/// analytics-only, and YouTube remains native because its worker has no
/// Zernio publisher.
pub fn zernio_connection_options(account: &ZernioAccount, locale: Locale) -> Vec<ZernioConnectionOption> {
    let Some(account_id) = account.id.as_deref().filter(|id| !id.is_empty()) else {
        return Vec::new();
    };
    let handle = account
        .username
        .as_deref()
        .or(account.display_name.as_deref())
        .unwrap_or(account_id);
    let code = locale.as_str().to_uppercase();
    let target_option = |key, target_id: String, label: String| ZernioConnectionOption {
        key,
        account_id: account_id.into(),
        locale,
        label: label.clone(),
        input: ChannelInput {
            platform: target_id.clone(),
            locale,
            provider: "zernio".into(),
            provider_account_id: Some(account_id.into()),
            target_id: Some(target_id),
            label: Some(label),
            source: None,
        },
    };
    match zernio_platform(account).as_str() {
        "threads" => vec![target_option(
            ZernioConnectionKey::Threads,
            format!("threads_{}", locale.as_str()),
            format!("Threads {code} · @{handle}"),
        )],
        "instagram" => vec![
            ZernioConnectionOption {
                key: ZernioConnectionKey::InstagramReels,
                account_id: account_id.into(),
                locale,
                label: format!("Instagram Reels {code} · @{handle}"),
                input: ChannelInput {
                    platform: "instagram".into(),
                    locale,
                    provider: "zernio".into(),
                    provider_account_id: Some(account_id.into()),
                    target_id: None,
                    label: Some(format!("Instagram {code} · @{handle}")),
                    source: None,
                },
            },
            target_option(
                ZernioConnectionKey::InstagramStories,
                if locale == Locale::Ru {
                    "instagram_stories_ru".into()
                } else {
                    "instagram_stories".into()
                },
                format!("Instagram Stories {code} · @{handle}"),
            ),
        ],
        _ => Vec::new(),
    }
}

#[derive(Clone, Copy)]
pub struct ChannelService<'a, Z> {
    studio: Studio<'a>,
    directory: &'a Z,
}

impl<'a, Z: ZernioDirectory> ChannelService<'a, Z> {
    pub fn new(studio: Studio<'a>, directory: &'a Z) -> Self {
        Self { studio, directory }
    }

    pub fn list(&self, enabled_only: bool) -> Result<Vec<ChannelConnectionRecord>> {
        self.studio.track("studio.channel.list", || {
            list_channels(self.studio.sqlite(), enabled_only)
        })
    }

    pub fn report(&self, enabled_only: bool) -> Result<Vec<ChannelReport>> {
        self.studio.track("studio.channel.list", || {
            let studio = &self.studio;
            let readiness = studio.boundaries.readiness.capability_report(studio.sqlite())?;
            let circuits = studio.publishing.boundaries.auth_circuit.states(studio.sqlite())?;
            Ok(list_channels(studio.sqlite(), enabled_only)?
                .into_iter()
                .map(|record| {
                    let channel = record.connection;
                    let key = channel.target_id.clone().unwrap_or_else(|| channel.id.clone());
                    let state = readiness.iter().find(|entry| entry.target == key);
                    let credential = circuits
                        .iter()
                        .find(|circuit| circuit.target == key)
                        .map(|circuit| ChannelCredential {
                            blocked: circuit.blocked,
                            blocked_until: circuit.blocked_until.clone(),
                            auth_failure_streak: circuit.auth_failure_streak,
                            last_auth_failure_at: circuit.last_auth_failure_at.clone(),
                            token_expires_at: circuit.token_expires_at.clone(),
                        })
                        .unwrap_or_default();
                    ChannelReport {
                        // A text channel has no video target and is not expected to have one.
                        publishable: channel.target_id.is_some() || is_publishable_video_platform(&channel.platform),
                        status: if channel.enabled == 0 {
                            ChannelStatus::Disabled
                        } else if state.is_some_and(|state| state.status == CapabilityStatus::Missing) {
                            ChannelStatus::Missing
                        } else {
                            ChannelStatus::Ready
                        },
                        missing: state.map(|state| state.missing.clone()).unwrap_or_default(),
                        enabled: channel.enabled == 1,
                        credential,
                        id: channel.id,
                        platform: channel.platform,
                        locale: channel.locale,
                        provider: channel.provider,
                        provider_account_id: channel.provider_account_id,
                        label: channel.label,
                        source: channel.source,
                    }
                })
                .collect())
        })
    }

    /// `source` defaults to `interface`.
    pub fn connect(&self, input: &ChannelInput, source: Option<&str>) -> Result<ChannelConnectionRecord> {
        self.studio.track("studio.channel.connect", || {
            register_channel(
                &self.studio,
                &ChannelInput {
                    source: Some(source.unwrap_or("interface").into()),
                    ..input.clone()
                },
            )
        })
    }

    /// `provider` defaults to `native`, `source` to `interface`.
    pub fn connect_target(
        &self,
        target_id: &str,
        provider: Option<&str>,
        provider_account_id: Option<&str>,
        label: Option<&str>,
        source: Option<&str>,
    ) -> Result<ChannelConnectionRecord> {
        self.studio.track("studio.channel.connect", || {
            register_target_channel(
                &self.studio,
                target_id,
                provider.unwrap_or("native"),
                provider_account_id,
                label.filter(|label| !label.is_empty()),
                Some(source.unwrap_or("interface")),
            )
        })
    }

    /// Returns the channel as it was before it was disabled.
    pub fn disable(&self, channel_id: &str) -> Result<ChannelConnectionRecord> {
        self.studio.track("studio.channel.disable", || {
            let channels = self.studio.ports().channels();
            let channel = channels
                .get(channel_id)?
                .ok_or_else(|| Error::message(format!("Unknown channel: {channel_id}")))?;
            channels.disable(channel_id, &foundation::time::to_iso_string(self.studio.now()))?;
            Ok(channel)
        })
    }

    pub fn native_connect_url(&self, platform: MetaOauthPlatform, locale: Locale) -> Option<String> {
        let links = self.studio.boundaries.connect_links;
        links.meta_oauth_connect_url(self.studio.config, platform, locale).ok()
    }

    pub fn native_connect_path(&self, platform: MetaOauthPlatform, locale: Locale) -> Option<String> {
        let links = self.studio.boundaries.connect_links;
        links.meta_oauth_connect_path(self.studio.config, platform, locale).ok()
    }

    /// Starts a connection the way the CLI and the dashboard do; the bot
    /// needs it for platforms whose flow is a code rather than a link.
    pub fn start_connect(&self, platform: ConnectPlatform, locale: Locale) -> Result<ConnectStart> {
        let links = self.studio.boundaries.connect_links;
        links.start_connect(self.studio.config, platform, locale, self.studio.now())
    }

    pub fn x_connect_url(&self) -> Option<String> {
        self.studio
            .boundaries
            .connect_links
            .x_oauth_connect_url(self.studio.config)
            .ok()
    }

    pub fn x_connect_path(&self) -> Option<String> {
        self.studio
            .boundaries
            .connect_links
            .x_oauth_connect_path(self.studio.config)
            .ok()
    }

    pub async fn discover_zernio_accounts(&self) -> Result<Vec<ZernioAccount>> {
        self.studio
            .track_async("studio.channel.discover", self.directory.accounts(self.studio.config))
            .await
    }

    pub async fn discover_zernio_connections(&self, locale: Locale) -> Result<Vec<ZernioConnectionOption>> {
        self.studio
            .track_async("studio.channel.discover", async {
                Ok(self
                    .directory
                    .accounts(self.studio.config)
                    .await?
                    .iter()
                    .flat_map(|account| zernio_connection_options(account, locale))
                    .collect())
            })
            .await
    }

    pub async fn connect_zernio(
        &self,
        account_id: &str,
        locale: Locale,
        key: ZernioConnectionKey,
    ) -> Result<ChannelConnectionRecord> {
        self.studio
            .track_async("studio.channel.connect", async {
                let account = self
                    .directory
                    .accounts(self.studio.config)
                    .await?
                    .into_iter()
                    .find(|account| account.id.as_deref() == Some(account_id))
                    .ok_or_else(|| Error::message("Zernio account was not found"))?;
                let option = zernio_connection_options(&account, locale)
                    .into_iter()
                    .find(|candidate| candidate.key == key)
                    .ok_or_else(|| Error::message("Zernio account does not serve that publication route"))?;
                register_channel(
                    &self.studio,
                    &ChannelInput {
                        source: Some("interface".into()),
                        ..option.input
                    },
                )
            })
            .await
    }
}
