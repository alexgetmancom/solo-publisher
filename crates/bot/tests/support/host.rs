//! The golden host: the boundaries and adapters Studio calls but the bot does
//! not own. Only what the ported areas reach is implemented; anything else
//! panics with its name, so a case that reaches it fails loudly instead of
//! diverging quietly. An area that needs one implements it here, the way the
//! TypeScript bot behaved under the recorder.

use std::cell::Cell;
use std::rc::Rc;

use bot::{Adapters, Fut, Host};
use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::Clock;
use domain::publishing::Boundaries;
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, Jitter, MediaMetadata, ProviderOutcome, UsageMeter, VideoCompletion, WorkerBell,
};
use domain::publishing::platform_profiles::platform_profile;
use domain::studio::boundaries::{
    CapabilityReportEntry, CapabilityStatus, ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform,
    Readiness, StoryDerivatives, StudioBoundaries, ZernioAccount,
};
use foundation::config::{Config, MediaProcessorProvider, SharedConfig};
use jiff::Timestamp;
use serde_json::Value;

use super::zernio::GoldenZernio;

pub struct FixedClock(pub Cell<Timestamp>);

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        self.0.get()
    }
}

fn not_in_host(what: &str) -> ! {
    panic!(
        "{what} is not implemented in the golden host (crates/bot/tests/support/host.rs); the area that reaches it adds it"
    )
}

pub struct GoldenHost {
    /// The bot's configuration, which the readiness report reads as
    /// `capabilityReport(config, backendDb)` does.
    pub config: SharedConfig,
    /// The case's clock, for the timestamps the Story-card store writes
    /// (`support/story_cards.rs`).
    pub clock: Rc<FixedClock>,
}

impl Jitter for GoldenHost {
    fn unit(&self) -> f64 {
        not_in_host("retry jitter")
    }
}

/// Ringing the publish worker has no visible effect in a golden.
impl WorkerBell for GoldenHost {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _: u64) {}
}

impl AuthCircuit for GoldenHost {
    fn record_failure(&self, _: &Connection, _: &str) -> domain::Result<()> {
        not_in_host("the credential breaker")
    }
    fn record_success(&self, _: &Connection, _: &str) -> domain::Result<()> {
        not_in_host("the credential breaker")
    }
    /// `authCircuitStates`: the `credential_checks` rows. No golden seeds one,
    /// so a row would mean a case this host does not reproduce.
    fn states(&self, sqlite: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        let rows: i64 = sqlite.query_row("select count(*) from credential_checks", [], |row| row.get(0))?;
        if rows > 0 {
            not_in_host("credential checks with rows");
        }
        Ok(Vec::new())
    }
}

/// Usage counters are observability rows no golden shows.
impl UsageMeter for GoldenHost {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}

impl VideoCompletion for GoldenHost {
    fn record_if_final(&self, _: &Connection, _: i64) -> domain::Result<()> {
        not_in_host("video completion")
    }
}

impl StoryDerivatives for GoldenHost {
    fn ensure(&self, _: &str, _: bool, _: i64) {
        not_in_host("Story derivatives")
    }
}

impl Readiness for GoldenHost {
    /// `capabilityReport(config, backendDb)` over the registered channels.
    fn capability_report(&self, sqlite: &Connection) -> domain::Result<Vec<CapabilityReportEntry>> {
        let config = self.config.load();
        let mut requirements: Vec<(String, Vec<String>)> = Vec::new();
        let mut set =
            |target: String, required: Vec<String>| match requirements.iter_mut().find(|(key, _)| *key == target) {
                Some(entry) => entry.1 = required,
                None => requirements.push((target, required)),
            };
        let names = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        if config.controller_bot_token.is_some() || !config.controller_admin_ids.is_empty() {
            set(
                "controller_bot".into(),
                names(&["CONTROLLER_BOT_TOKEN", "CONTROLLER_ADMIN_IDS"]),
            );
        }
        for channel in domain::channels::list_channels(sqlite, true)? {
            let channel = channel.connection;
            if let Some(target) = channel.target_id {
                let required = if channel.provider == "zernio" {
                    names(&["ZERNIO_API_KEY"])
                } else {
                    platform_profile(&target)
                        .map(|profile| names(profile.requirements))
                        .unwrap_or_default()
                };
                set(target, required);
            } else if channel.platform == "youtube" || channel.platform == "instagram" {
                let suffix = if channel.locale == "en" { "EN" } else { "RU" };
                let required = if channel.provider == "zernio" {
                    names(&["ZERNIO_API_KEY"])
                } else if channel.platform == "youtube" {
                    ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"]
                        .map(|name| format!("YOUTUBE_{suffix}_{name}"))
                        .to_vec()
                } else {
                    ["ACCESS_TOKEN", "USER_ID"]
                        .map(|name| format!("INSTAGRAM_{suffix}_{name}"))
                        .to_vec()
                };
                set(channel.id, required);
            }
        }
        if config.media_processor_provider == MediaProcessorProvider::RemoteHttp {
            set(
                "media_processor".into(),
                names(&["MEDIA_PROCESSOR_URL", "MEDIA_PROCESSOR_TOKEN"]),
            );
        }
        Ok(requirements
            .into_iter()
            .map(|(target, required)| {
                let missing: Vec<String> = required
                    .iter()
                    .filter(|name| !configured(&config, name))
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
}

/// Whether the configuration holds a value for the variable `name`
/// (`!values[name]`, with the admin list counted by its length).
fn configured(config: &Config, name: &str) -> bool {
    let value = match name {
        "CONTROLLER_ADMIN_IDS" => return !config.controller_admin_ids.is_empty(),
        "TELEGRAM_CHANNEL_STORIES_API_ID" => return config.telegram_channel_stories_api_id.is_some_and(|id| id != 0),
        "CONTROLLER_BOT_TOKEN" => &config.controller_bot_token,
        "ZERNIO_API_KEY" => &config.zernio_api_key,
        "THREADS_RU_ACCESS_TOKEN" => &config.threads_ru_access_token,
        "THREADS_EN_ACCESS_TOKEN" => &config.threads_en_access_token,
        "X_CLIENT_ID" => &config.x_client_id,
        "X_CLIENT_SECRET" => &config.x_client_secret,
        "X_ACCESS_TOKEN" => &config.x_access_token,
        "X_REFRESH_TOKEN" => &config.x_refresh_token,
        "DISCORD_BOT_TOKEN" => &config.discord_bot_token,
        "DISCORD_CHANNEL_ID" => &config.discord_channel_id,
        "TELEGRAM_CHANNEL_STORIES_API_HASH" => &config.telegram_channel_stories_api_hash,
        "TELEGRAM_CHANNEL_STORIES_SESSION" => &config.telegram_channel_stories_session,
        "INSTAGRAM_RU_ACCESS_TOKEN" => &config.instagram_ru_access_token,
        "INSTAGRAM_RU_USER_ID" => &config.instagram_ru_user_id,
        "INSTAGRAM_EN_ACCESS_TOKEN" => &config.instagram_en_access_token,
        "INSTAGRAM_EN_USER_ID" => &config.instagram_en_user_id,
        "YOUTUBE_RU_CLIENT_ID" => &config.youtube_ru_client_id,
        "YOUTUBE_RU_CLIENT_SECRET" => &config.youtube_ru_client_secret,
        "YOUTUBE_RU_REFRESH_TOKEN" => &config.youtube_ru_refresh_token,
        "YOUTUBE_EN_CLIENT_ID" => &config.youtube_en_client_id,
        "YOUTUBE_EN_CLIENT_SECRET" => &config.youtube_en_client_secret,
        "YOUTUBE_EN_REFRESH_TOKEN" => &config.youtube_en_refresh_token,
        "MEDIA_PROCESSOR_URL" => &config.media_processor_url,
        "MEDIA_PROCESSOR_TOKEN" => &config.media_processor_token,
        other => not_in_host(&format!("the configuration variable {other}")),
    };
    value.as_deref().is_some_and(|value| !value.is_empty())
}

/// `required(value, name)` of the OAuth links: a trimmed, non-blank value.
fn required(value: &Option<String>, name: &str) -> domain::Result<()> {
    match value.as_deref().map(foundation::js::trim) {
        Some(value) if !value.is_empty() => Ok(()),
        _ => Err(domain::Error::message(format!("{name} is required for browser OAuth"))),
    }
}

fn encryption_key_set(config: &Config) -> bool {
    matches!(
        foundation::secret_box::encryption_key(config.token_encryption_key.as_deref()),
        Ok(Some(_))
    )
}

fn meta_app(
    config: &Config,
    platform: MetaOauthPlatform,
) -> (&Option<String>, &'static str, &Option<String>, &'static str) {
    match platform {
        MetaOauthPlatform::Threads => (
            &config.threads_app_id,
            "THREADS_APP_ID",
            &config.threads_app_secret,
            "THREADS_APP_SECRET",
        ),
        MetaOauthPlatform::Instagram => (
            &config.instagram_app_id,
            "INSTAGRAM_APP_ID",
            &config.instagram_app_secret,
            "INSTAGRAM_APP_SECRET",
        ),
    }
}

fn meta_platform(platform: MetaOauthPlatform) -> &'static str {
    match platform {
        MetaOauthPlatform::Threads => "threads",
        MetaOauthPlatform::Instagram => "instagram",
    }
}

fn assert_meta_configured(config: &Config, platform: MetaOauthPlatform) -> domain::Result<()> {
    let (id, id_name, secret, secret_name) = meta_app(config, platform);
    required(&config.token_encryption_key, "TOKEN_ENCRYPTION_KEY")?;
    required(id, id_name)?;
    required(secret, secret_name)
}

fn base_url(config: &Config) -> &str {
    config
        .public_base_url
        .strip_suffix('/')
        .unwrap_or(&config.public_base_url)
}

/// `URLSearchParams` serialisation (application/x-www-form-urlencoded).
fn form_encode(pairs: &[(&str, &str)]) -> String {
    let encode = |text: &str| {
        text.bytes()
            .map(|byte| match byte {
                b'a'..=b'z' | b'A'..=b'Z' | b'0'..=b'9' | b'*' | b'-' | b'.' | b'_' => (byte as char).to_string(),
                b' ' => "+".to_owned(),
                other => format!("%{other:02X}"),
            })
            .collect::<String>()
    };
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", encode(key), encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The OAuth links as `channels/meta-oauth.ts`, `x-oauth.ts`, `youtube-oauth.ts`
/// and `connect.ts` build them. The sealed state and the PKCE challenge are
/// random there and recorded as `<random>`, so any value stands in for them.
impl ChannelConnectLinks for GoldenHost {
    fn meta_oauth_connect_url(
        &self,
        config: &Config,
        platform: MetaOauthPlatform,
        _: Locale,
    ) -> domain::Result<String> {
        assert_meta_configured(config, platform)?;
        Ok(format!(
            "{}/oauth/{}/start?state=sealed-state",
            base_url(config),
            meta_platform(platform)
        ))
    }
    fn meta_oauth_connect_path(
        &self,
        config: &Config,
        platform: MetaOauthPlatform,
        locale: Locale,
    ) -> domain::Result<String> {
        assert_meta_configured(config, platform)?;
        Ok(format!(
            "/oauth/{}/start?locale={}",
            meta_platform(platform),
            locale.as_str()
        ))
    }
    fn x_oauth_connect_url(&self, config: &Config) -> domain::Result<String> {
        Ok(format!("{}{}", base_url(config), self.x_oauth_connect_path(config)?))
    }
    fn x_oauth_connect_path(&self, config: &Config) -> domain::Result<String> {
        required(&config.x_client_id, "X_CLIENT_ID")?;
        required(&config.x_client_secret, "X_CLIENT_SECRET")?;
        if !encryption_key_set(config) {
            return Err(domain::Error::message(
                "TOKEN_ENCRYPTION_KEY is required for browser OAuth",
            ));
        }
        Ok("/oauth/x/start".into())
    }
    fn start_connect(
        &self,
        config: &Config,
        platform: ConnectPlatform,
        locale: Locale,
        _: Timestamp,
    ) -> domain::Result<ConnectStart> {
        let ConnectPlatform::Youtube = platform else {
            not_in_host("starting a Threads, Instagram or X connection");
        };
        let (client_id, client_secret, suffix) = match locale {
            Locale::En => (&config.youtube_en_client_id, &config.youtube_en_client_secret, "EN"),
            Locale::Ru => (&config.youtube_ru_client_id, &config.youtube_ru_client_secret, "RU"),
        };
        let set = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
        let missing: Vec<String> = [
            (!set(client_id)).then(|| format!("YOUTUBE_{suffix}_CLIENT_ID")),
            (!set(client_secret)).then(|| format!("YOUTUBE_{suffix}_CLIENT_SECRET")),
            (!set(&config.token_encryption_key)).then(|| "TOKEN_ENCRYPTION_KEY".to_owned()),
        ]
        .into_iter()
        .flatten()
        .collect();
        if !missing.is_empty() {
            return Err(domain::Error::message(format!(
                "YouTube is not configured: {}",
                missing.join(", ")
            )));
        }
        if !encryption_key_set(config) {
            return Err(domain::Error::message(
                "TOKEN_ENCRYPTION_KEY is required for browser OAuth",
            ));
        }
        let redirect_uri = format!("{}/oauth/youtube", base_url(config));
        let query = form_encode(&[
            ("response_type", "code"),
            ("client_id", client_id.as_deref().unwrap_or_default()),
            ("redirect_uri", &redirect_uri),
            (
                "scope",
                "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
            ),
            ("state", "sealed-state"),
            ("access_type", "offline"),
            ("prompt", "consent"),
            ("include_granted_scopes", "false"),
            ("code_challenge", "pkce-challenge"),
            ("code_challenge_method", "S256"),
        ]);
        Ok(ConnectStart {
            platform: "youtube",
            locale: Some(locale.as_str()),
            kind: "redirect",
            url: format!("https://accounts.google.com/o/oauth2/v2/auth?{query}"),
            expires_in_minutes: 10,
        })
    }
}

impl Host for GoldenHost {
    fn publishing(&self) -> Boundaries<'_> {
        Boundaries {
            jitter: self,
            bell: self,
            auth_circuit: self,
            usage: self,
            story_cards: self,
            video_completion: self,
        }
    }

    fn studio(&self) -> StudioBoundaries<'_> {
        StudioBoundaries {
            reminders: self,
            story_derivatives: self,
            readiness: self,
            connect_links: self,
        }
    }
}

pub struct GoldenAdapters {
    pub zernio: Rc<GoldenZernio>,
}

impl Adapters for GoldenAdapters {
    fn probe<'a>(&'a self, _: &'a str) -> Fut<'a, Result<MediaMetadata, String>> {
        not_in_host("ffprobe")
    }
    fn audio_stats<'a>(&'a self, _: &'a str) -> Fut<'a, Result<String, String>> {
        not_in_host("ffmpeg")
    }
    fn post_outcome<'a>(&'a self, _: &'a str, _: &'a str) -> Fut<'a, domain::Result<ProviderOutcome>> {
        not_in_host("the video provider")
    }
    fn publish_instagram_reel<'a>(
        &'a self,
        _: &'a str,
        _: &'a str,
        _: &'a Value,
        _: &'a str,
    ) -> Fut<'a, domain::Result<ProviderOutcome>> {
        not_in_host("the video provider")
    }
    fn keep_youtube_private<'a>(&'a self, _: &'a Config, _: &'a str, _: Locale) -> Fut<'a, domain::Result<()>> {
        not_in_host("YouTube uploads")
    }
    fn zernio_accounts<'a>(&'a self, config: &'a Config) -> Fut<'a, domain::Result<Vec<ZernioAccount>>> {
        Box::pin(async move { self.zernio.accounts(config) })
    }
}
