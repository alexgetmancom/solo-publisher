//! The configuration .env determines, validated the way the TypeScript zod
//! schema validated it — same defaults, same "blank is unset", same messages —
//! plus the platform credentials whose one home is the database.
//!
//! A `Config` is immutable. The running process holds it in a `SharedConfig`
//! and swaps in a new one when a stored credential changes, so a reader always
//! sees one consistent configuration.

use std::collections::HashMap;
use std::fmt;
use std::path::PathBuf;
use std::sync::Arc;

use arc_swap::ArcSwap;

use crate::js;
use crate::logger::LogLevel;

/// How long a publish lock outlives the worker holding it before the watchdog
/// may reclaim the job. It has to exceed PUBLISH_JOB_TIMEOUT_SECONDS or the same
/// job is picked up twice, and outlast two heartbeats or a working job is reclaimed.
pub const PUBLISH_LOCK_TIMEOUT_SECONDS: u64 = 900;
/// Ceiling on exponential publish retry backoff.
pub const PUBLISH_BACKOFF_MAX_SECONDS: u64 = 3600;
/// Social publish jobs touch their lock this often while a slow provider call is
/// in flight; two missed beats must still fit inside the lock window.
pub const PUBLISH_HEARTBEAT_INTERVAL_SECONDS: u64 = 180;
/// Initial delivery plus three exponential-backoff retries.
pub const PUBLISH_MAX_ATTEMPTS: u32 = 4;
pub const PUBLISH_BACKOFF_BASE_SECONDS: u64 = 60;
/// A publication that got part of the way out is a delivery in progress, not a
/// failure: twelve attempts reach roughly six hours on the backoff curve, where
/// an ordinary failure gets seven minutes. Nothing in the draft can fix a
/// half-published post; the remedy is waiting for the platform.
pub const PUBLISH_PARTIAL_MAX_ATTEMPTS: u32 = 12;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "lowercase"))]
pub enum Environment {
    Development,
    Test,
    Production,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "kebab-case"))]
pub enum TrustedClientIpHeader {
    XRealIp,
    CfConnectingIp,
}

impl TrustedClientIpHeader {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::XRealIp => "x-real-ip",
            Self::CfConnectingIp => "cf-connecting-ip",
        }
    }
}

/// Where optional heavy media transforms execute. Remote workers are opt-in so
/// a stock self-hosted Studio keeps working.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "snake_case"))]
pub enum MediaProcessorProvider {
    Local,
    RemoteHttp,
}

impl MediaProcessorProvider {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Local => "local",
            Self::RemoteHttp => "remote_http",
        }
    }
}

/// What .env said each renewable Meta token was, captured before any renewal
/// replaced it, so a later comparison is against the operator's value and not
/// against the renewal.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "SCREAMING_SNAKE_CASE"))]
pub struct MetaTokenSeeds {
    pub threads_ru_access_token: Option<String>,
    pub threads_en_access_token: Option<String>,
    pub instagram_ru_access_token: Option<String>,
    pub instagram_en_access_token: Option<String>,
}

/// Field names are the environment variables, lower-cased.
#[derive(Clone, Debug, PartialEq, Eq)]
#[cfg_attr(test, derive(serde::Serialize), serde(rename_all = "SCREAMING_SNAKE_CASE"))]
pub struct Config {
    pub node_env: Environment,
    pub deployment_env: Environment,
    pub log_level: LogLevel,
    pub port: u64,
    pub bind_host: String,
    /// The one mounted volume; every pipeline path below is derived from it.
    pub data_dir: String,
    /// Telegram's Bot API, or a local Bot API server that lifts the 50 MB
    /// download limit for video.
    pub telegram_api_base_url: String,
    pub controller_bot_token: Option<String>,
    pub client_ip_hash_salt: String,
    pub trusted_client_ip_header: TrustedClientIpHeader,
    pub command_center_token: Option<String>,
    pub mcp_studio_token: Option<String>,
    pub mcp_studio_actor_id: Option<i64>,
    pub deepseek_api_key: Option<String>,
    pub grok_cli_path: String,
    pub controller_admin_ids: Vec<i64>,
    /// Empty uses the Telegram controller roster.
    pub studio_actor_ids: Vec<i64>,
    /// Empty means this Studio has no Telegram channel.
    pub telegram_channel_username: String,
    /// Timeouts are terminal and need an explicit retry: the provider may have
    /// accepted a request whose response was lost.
    pub publish_job_timeout_seconds: u64,
    pub metrics_refresh_interval_seconds: u64,
    pub creator_profile_refresh_interval_seconds: u64,
    pub observability_interval_seconds: u64,
    pub idle_poll_interval_seconds: u64,
    pub media_processor_provider: MediaProcessorProvider,
    pub media_processor_url: Option<String>,
    pub media_processor_token: Option<String>,
    pub media_processor_timeout_seconds: u64,
    pub story_card_assets_dir: String,
    pub story_card_renderer_entry: String,
    pub threads_ru_access_token: Option<String>,
    pub threads_en_access_token: Option<String>,
    pub threads_container_timeout_seconds: u64,
    /// The Threads app's own id and secret (not the Meta app's); only
    /// `threads-authorize` uses them, to mint the tokens above.
    pub threads_app_id: Option<String>,
    pub threads_app_secret: Option<String>,
    pub x_client_id: Option<String>,
    pub x_client_secret: Option<String>,
    pub enable_x_metrics: bool,
    pub discord_channel_id: Option<String>,
    /// Only builds the message permalink: the create-message response carries
    /// the channel but not its guild.
    pub discord_guild_id: Option<String>,
    pub enable_x_profile_metrics: bool,
    pub instagram_en_access_token: Option<String>,
    pub instagram_en_user_id: Option<String>,
    pub instagram_ru_access_token: Option<String>,
    pub instagram_ru_user_id: Option<String>,
    pub instagram_app_id: Option<String>,
    pub instagram_app_secret: Option<String>,
    pub instagram_graph_api_version: String,
    pub youtube_ru_client_id: Option<String>,
    pub youtube_ru_client_secret: Option<String>,
    pub youtube_ru_refresh_token: Option<String>,
    pub youtube_en_client_id: Option<String>,
    pub youtube_en_client_secret: Option<String>,
    pub youtube_en_refresh_token: Option<String>,
    pub telegram_stories_channel: Option<String>,
    pub telegram_channel_stories_api_id: Option<u64>,
    pub telegram_channel_stories_api_hash: Option<String>,
    pub telegram_channel_stories_session: Option<String>,
    /// Where platforms fetch staged media: the setting, or this Studio's own
    /// `PUBLIC_BASE_URL` + `/media/staging`.
    pub public_media_base_url: String,
    /// Production refuses to start without an explicit value; the default is
    /// this machine.
    pub public_base_url: String,
    /// Seals the platform tokens this Studio renews; absent means it renews none.
    pub token_encryption_key: Option<String>,
    pub deploy_agent_url: Option<String>,
    pub deploy_agent_token: Option<String>,
    /// The Stories sidecar Telegram channel Stories go out through, and the
    /// bearer token it answers to (Rust only: TypeScript ran mtcute in
    /// process). Without them a Telegram Stories target skips as not configured.
    pub stories_sidecar_url: Option<String>,
    pub stories_sidecar_token: Option<String>,
    pub indexnow_enabled: bool,
    pub pipeline_db: PathBuf,
    /// All media the Studio owns: ingress staging, uploads, delivery's video files.
    pub studio_media_dir: PathBuf,
    pub media_cache_dir: PathBuf,
    /// The opening frame of every published video, kept after the video is gone.
    pub video_frame_dir: PathBuf,
    pub story_card_dir: PathBuf,
    pub site_public_dir: PathBuf,
    /// Temporary public staging for platforms that fetch media by URL.
    pub remote_media_path: PathBuf,
    /// `PUBLIC_BASE_URL` + `/command-center`; derived, never configured.
    pub command_center_url: String,
    #[cfg_attr(test, serde(rename = "metaTokenSeeds"))]
    pub meta_token_seeds: MetaTokenSeeds,
    // Platform credentials whose one home is the `platform_tokens` table. They
    // reach a configuration only when stored credentials are applied; .env never
    // carries them.
    #[cfg_attr(test, serde(skip))]
    pub x_access_token: Option<String>,
    #[cfg_attr(test, serde(skip))]
    pub x_refresh_token: Option<String>,
    #[cfg_attr(test, serde(skip))]
    pub zernio_api_key: Option<String>,
    #[cfg_attr(test, serde(skip))]
    pub discord_bot_token: Option<String>,
}

/// The live configuration of a running process, shared by every worker.
#[derive(Clone, Debug)]
pub struct SharedConfig(Arc<ArcSwap<Config>>);

impl SharedConfig {
    pub fn new(config: Config) -> Self {
        Self(Arc::new(ArcSwap::from_pointee(config)))
    }

    /// The configuration as of now; it does not change under the caller.
    pub fn load(&self) -> Arc<Config> {
        self.0.load_full()
    }

    /// Replaces the configuration with `change` applied to the current one.
    /// `change` may run more than once if another update lands concurrently.
    pub fn update(&self, change: impl Fn(&Config) -> Config) {
        self.0.rcu(|current| change(current));
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ConfigError(String);

impl fmt::Display for ConfigError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(&self.0)
    }
}

impl std::error::Error for ConfigError {}

/// Reads the configuration from environment variables (`std::env::vars()` in a
/// process). A variable set to a blank value counts as unset: that is how an
/// .env file states a key it has no value for, and Docker passes it through.
pub fn load_config<K: AsRef<str>, V: AsRef<str>>(
    vars: impl IntoIterator<Item = (K, V)>,
) -> Result<Config, ConfigError> {
    let vars: Vec<(K, V)> = vars.into_iter().collect();
    let env: HashMap<&str, &str> = vars
        .iter()
        .map(|(key, value)| (key.as_ref(), value.as_ref()))
        .filter(|(_, value)| !js::trim(value).is_empty())
        .collect();
    let mut schema = Schema {
        env: &env,
        issues: Vec::new(),
    };
    let s = &mut schema;
    let environments = [
        ("development", Environment::Development),
        ("test", Environment::Test),
        ("production", Environment::Production),
    ];

    let node_env = s.choice("NODE_ENV", &environments, Environment::Development);
    let deployment_env = s.choice("DEPLOYMENT_ENV", &environments, Environment::Development);
    let log_level = s.choice(
        "LOG_LEVEL",
        &[
            ("debug", LogLevel::Debug),
            ("info", LogLevel::Info),
            ("warn", LogLevel::Warn),
            ("error", LogLevel::Error),
        ],
        LogLevel::Info,
    );
    let port = s.int("PORT", &[Bound::Positive]).unwrap_or(8788.0);
    let bind_host = s.string_or("BIND_HOST", "127.0.0.1");
    let data_dir = s.string_or("DATA_DIR", "/data");
    let telegram_api_base_url = s.string_or("TELEGRAM_API_BASE_URL", "https://api.telegram.org");
    let controller_bot_token = s.string("CONTROLLER_BOT_TOKEN");
    let client_ip_hash_salt = s
        .min_length("CLIENT_IP_HASH_SALT", 16)
        .unwrap_or_else(|| "development-only".into());
    let trusted_client_ip_header = s.choice(
        "TRUSTED_CLIENT_IP_HEADER",
        &[
            ("x-real-ip", TrustedClientIpHeader::XRealIp),
            ("cf-connecting-ip", TrustedClientIpHeader::CfConnectingIp),
        ],
        TrustedClientIpHeader::XRealIp,
    );
    let command_center_token = s.string("COMMAND_CENTER_TOKEN");
    let mcp_studio_token = s.min_length("MCP_STUDIO_TOKEN", 16);
    let mcp_studio_actor_id = s.int("MCP_STUDIO_ACTOR_ID", &[Bound::Positive]);
    let deepseek_api_key = s.string("DEEPSEEK_API_KEY");
    let grok_cli_path = s.string_or("GROK_CLI_PATH", "grok");
    let controller_admin_ids = s.id_list("CONTROLLER_ADMIN_IDS");
    let studio_actor_ids = s.id_list("STUDIO_ACTOR_IDS");
    let telegram_channel_username = s.string_or("TELEGRAM_CHANNEL_USERNAME", "");
    let publish_job_timeout_seconds = s
        .int(
            "PUBLISH_JOB_TIMEOUT_SECONDS",
            &[Bound::AtLeast(1.0), Bound::AtMost(3600.0)],
        )
        .unwrap_or(600.0);
    let metrics_refresh_interval_seconds = s
        .int("METRICS_REFRESH_INTERVAL_SECONDS", &[Bound::Positive])
        .unwrap_or(10.0);
    let creator_profile_refresh_interval_seconds = s
        .int("CREATOR_PROFILE_REFRESH_INTERVAL_SECONDS", &[Bound::AtLeast(60.0)])
        .unwrap_or(3600.0);
    let observability_interval_seconds = s
        .int("OBSERVABILITY_INTERVAL_SECONDS", &[Bound::Positive])
        .unwrap_or(300.0);
    let idle_poll_interval_seconds = s.int("IDLE_POLL_INTERVAL_SECONDS", &[Bound::Positive]).unwrap_or(5.0);
    let media_processor_provider = s.choice(
        "MEDIA_PROCESSOR_PROVIDER",
        &[
            ("local", MediaProcessorProvider::Local),
            ("remote_http", MediaProcessorProvider::RemoteHttp),
        ],
        MediaProcessorProvider::Local,
    );
    let media_processor_url = s.url("MEDIA_PROCESSOR_URL");
    let media_processor_token = s.min_length("MEDIA_PROCESSOR_TOKEN", 16);
    let media_processor_timeout_seconds = s
        .int(
            "MEDIA_PROCESSOR_TIMEOUT_SECONDS",
            &[Bound::AtLeast(10.0), Bound::AtMost(3600.0)],
        )
        .unwrap_or(900.0);
    let story_card_assets_dir = s.string_or("STORY_CARD_ASSETS_DIR", "/app/assets/story-card");
    let story_card_renderer_entry = s.string_or("STORY_CARD_RENDERER_ENTRY", "/app/story-renderer/renderer-process.js");
    let threads_ru_access_token = s.string("THREADS_RU_ACCESS_TOKEN");
    let threads_en_access_token = s.string("THREADS_EN_ACCESS_TOKEN");
    let threads_container_timeout_seconds = s
        .int("THREADS_CONTAINER_TIMEOUT_SECONDS", &[Bound::Positive])
        .unwrap_or(180.0);
    let threads_app_id = s.string("THREADS_APP_ID");
    let threads_app_secret = s.string("THREADS_APP_SECRET");
    let x_client_id = s.string("X_CLIENT_ID");
    let x_client_secret = s.string("X_CLIENT_SECRET");
    let enable_x_metrics = s.flag("ENABLE_X_METRICS", false);
    let discord_channel_id = s.string("DISCORD_CHANNEL_ID");
    let discord_guild_id = s.string("DISCORD_GUILD_ID");
    let enable_x_profile_metrics = s.flag("ENABLE_X_PROFILE_METRICS", true);
    let instagram_en_access_token = s.string("INSTAGRAM_EN_ACCESS_TOKEN");
    let instagram_en_user_id = s.string("INSTAGRAM_EN_USER_ID");
    let instagram_ru_access_token = s.string("INSTAGRAM_RU_ACCESS_TOKEN");
    let instagram_ru_user_id = s.string("INSTAGRAM_RU_USER_ID");
    let instagram_app_id = s.string("INSTAGRAM_APP_ID");
    let instagram_app_secret = s.string("INSTAGRAM_APP_SECRET");
    let instagram_graph_api_version = s.string_or("INSTAGRAM_GRAPH_API_VERSION", "v23.0");
    let youtube_ru_client_id = s.string("YOUTUBE_RU_CLIENT_ID");
    let youtube_ru_client_secret = s.string("YOUTUBE_RU_CLIENT_SECRET");
    let youtube_ru_refresh_token = s.string("YOUTUBE_RU_REFRESH_TOKEN");
    let youtube_en_client_id = s.string("YOUTUBE_EN_CLIENT_ID");
    let youtube_en_client_secret = s.string("YOUTUBE_EN_CLIENT_SECRET");
    let youtube_en_refresh_token = s.string("YOUTUBE_EN_REFRESH_TOKEN");
    let telegram_stories_channel = s.string("TELEGRAM_STORIES_CHANNEL");
    let telegram_channel_stories_api_id = s.int("TELEGRAM_CHANNEL_STORIES_API_ID", &[Bound::Positive]);
    let telegram_channel_stories_api_hash = s.string("TELEGRAM_CHANNEL_STORIES_API_HASH");
    let telegram_channel_stories_session = s.string("TELEGRAM_CHANNEL_STORIES_SESSION");
    let public_media_base_url = s.string("PUBLIC_MEDIA_BASE_URL");
    let public_base_url = s.string_or("PUBLIC_BASE_URL", "http://localhost:8788");
    let token_encryption_key = s.string("TOKEN_ENCRYPTION_KEY");
    let deploy_agent_url = s.url("DEPLOY_AGENT_URL");
    let deploy_agent_token = s.min_length("DEPLOY_AGENT_TOKEN", 16);
    let stories_sidecar_url = s.url("STORIES_SIDECAR_URL");
    let stories_sidecar_token = s.min_length("STORIES_SIDECAR_TOKEN", 32);
    let indexnow_enabled = s.flag("INDEXNOW_ENABLED", true);

    // zod runs the cross-field rules only when no field failed with a type
    // error; a value that parsed but broke a bound still reaches them.
    if !s.aborted() {
        for (id, secret) in [
            ("THREADS_APP_ID", "THREADS_APP_SECRET"),
            ("INSTAGRAM_APP_ID", "INSTAGRAM_APP_SECRET"),
        ] {
            s.pair(id, secret);
        }
        for suffix in ["RU", "EN"] {
            s.pair(
                &format!("YOUTUBE_{suffix}_CLIENT_ID"),
                &format!("YOUTUBE_{suffix}_CLIENT_SECRET"),
            );
        }
        s.pair("DEPLOY_AGENT_URL", "DEPLOY_AGENT_TOKEN");
        s.pair("STORIES_SIDECAR_URL", "STORIES_SIDECAR_TOKEN");
        if s.present("MCP_STUDIO_TOKEN") != mcp_studio_actor_id.is_some_and(|id| id != 0.0) {
            s.issue(
                "MCP_STUDIO_TOKEN",
                "MCP_STUDIO_TOKEN and MCP_STUDIO_ACTOR_ID must be configured together".into(),
                false,
            );
        }
        if publish_job_timeout_seconds >= PUBLISH_LOCK_TIMEOUT_SECONDS as f64 {
            s.issue(
                "PUBLISH_JOB_TIMEOUT_SECONDS",
                format!(
                    "PUBLISH_JOB_TIMEOUT_SECONDS ({}s) must be shorter than the {PUBLISH_LOCK_TIMEOUT_SECONDS}s publish lock window",
                    js::number_to_string(publish_job_timeout_seconds)
                ),
                false,
            );
        }
    }
    if !schema.issues.is_empty() {
        let lines: Vec<String> = schema
            .issues
            .iter()
            .map(|issue| format!("  {}: {}", issue.path, issue.message))
            .collect();
        return Err(ConfigError(format!(
            "Invalid environment configuration in .env:\n{}",
            lines.join("\n")
        )));
    }

    let fail = |message: &str| Err(ConfigError(message.into()));
    if node_env == Environment::Production && deployment_env != Environment::Production {
        return fail("DEPLOYMENT_ENV=production is required when NODE_ENV=production");
    }
    if deployment_env == Environment::Production && node_env != Environment::Production {
        return fail("NODE_ENV=production is required when DEPLOYMENT_ENV=production");
    }
    if deployment_env == Environment::Production {
        if command_center_token.is_none() {
            return fail("COMMAND_CENTER_TOKEN is required in production");
        }
        if !env.contains_key("CLIENT_IP_HASH_SALT") {
            return fail("CLIENT_IP_HASH_SALT is required in production");
        }
    }
    // The default is this machine; a production Studio that does not name its
    // own domain would put it in its feeds, sitemap and canonical URLs.
    if node_env == Environment::Production && !env.contains_key("PUBLIC_BASE_URL") {
        return fail("PUBLIC_BASE_URL must be set explicitly in production");
    }
    if media_processor_provider == MediaProcessorProvider::RemoteHttp
        && (media_processor_url.is_none() || media_processor_token.is_none())
    {
        return fail(
            "MEDIA_PROCESSOR_URL and MEDIA_PROCESSOR_TOKEN are required when MEDIA_PROCESSOR_PROVIDER=remote_http",
        );
    }

    let data_path = |name: &str| PathBuf::from(posix_join(&data_dir, name));
    let base = public_base_url.strip_suffix('/').unwrap_or(&public_base_url);
    // Issues are empty here, so every number passed its bounds: positive safe integers.
    let whole = |value: f64| value as u64;
    Ok(Config {
        pipeline_db: data_path("pipeline.db"),
        studio_media_dir: data_path("video-media"),
        media_cache_dir: data_path("media-cache"),
        video_frame_dir: data_path("video-frames"),
        story_card_dir: data_path("story-cards"),
        site_public_dir: data_path("site"),
        remote_media_path: data_path("media"),
        command_center_url: format!("{base}/command-center"),
        public_media_base_url: public_media_base_url.unwrap_or_else(|| format!("{base}/media/staging")),
        meta_token_seeds: MetaTokenSeeds {
            threads_ru_access_token: threads_ru_access_token.clone(),
            threads_en_access_token: threads_en_access_token.clone(),
            instagram_ru_access_token: instagram_ru_access_token.clone(),
            instagram_en_access_token: instagram_en_access_token.clone(),
        },
        node_env,
        deployment_env,
        log_level,
        port: whole(port),
        bind_host,
        data_dir,
        telegram_api_base_url,
        controller_bot_token,
        client_ip_hash_salt,
        trusted_client_ip_header,
        command_center_token,
        mcp_studio_token,
        mcp_studio_actor_id: mcp_studio_actor_id.map(|id| id as i64),
        deepseek_api_key,
        grok_cli_path,
        controller_admin_ids,
        studio_actor_ids,
        telegram_channel_username,
        publish_job_timeout_seconds: whole(publish_job_timeout_seconds),
        metrics_refresh_interval_seconds: whole(metrics_refresh_interval_seconds),
        creator_profile_refresh_interval_seconds: whole(creator_profile_refresh_interval_seconds),
        observability_interval_seconds: whole(observability_interval_seconds),
        idle_poll_interval_seconds: whole(idle_poll_interval_seconds),
        media_processor_provider,
        media_processor_url,
        media_processor_token,
        media_processor_timeout_seconds: whole(media_processor_timeout_seconds),
        story_card_assets_dir,
        story_card_renderer_entry,
        threads_ru_access_token,
        threads_en_access_token,
        threads_container_timeout_seconds: whole(threads_container_timeout_seconds),
        threads_app_id,
        threads_app_secret,
        x_client_id,
        x_client_secret,
        enable_x_metrics,
        discord_channel_id,
        discord_guild_id,
        enable_x_profile_metrics,
        instagram_en_access_token,
        instagram_en_user_id,
        instagram_ru_access_token,
        instagram_ru_user_id,
        instagram_app_id,
        instagram_app_secret,
        instagram_graph_api_version,
        youtube_ru_client_id,
        youtube_ru_client_secret,
        youtube_ru_refresh_token,
        youtube_en_client_id,
        youtube_en_client_secret,
        youtube_en_refresh_token,
        telegram_stories_channel,
        telegram_channel_stories_api_id: telegram_channel_stories_api_id.map(whole),
        telegram_channel_stories_api_hash,
        telegram_channel_stories_session,
        public_base_url,
        token_encryption_key,
        deploy_agent_url,
        deploy_agent_token,
        stories_sidecar_url,
        stories_sidecar_token,
        indexnow_enabled,
        x_access_token: None,
        x_refresh_token: None,
        zernio_api_key: None,
        discord_bot_token: None,
    })
}

struct Issue {
    path: String,
    message: String,
    /// A type error stops zod from running the cross-field rules.
    aborts: bool,
}

enum Bound {
    Positive,
    AtLeast(f64),
    AtMost(f64),
}

/// The subset of zod the environment schema used, issue for issue.
struct Schema<'a> {
    env: &'a HashMap<&'a str, &'a str>,
    issues: Vec<Issue>,
}

impl Schema<'_> {
    fn issue(&mut self, path: &str, message: String, aborts: bool) {
        self.issues.push(Issue {
            path: path.into(),
            message,
            aborts,
        });
    }

    fn aborted(&self) -> bool {
        self.issues.iter().any(|issue| issue.aborts)
    }

    fn present(&self, name: &str) -> bool {
        self.env.contains_key(name)
    }

    fn string(&self, name: &str) -> Option<String> {
        self.env.get(name).map(|value| (*value).to_owned())
    }

    fn string_or(&self, name: &str, default: &str) -> String {
        self.string(name).unwrap_or_else(|| default.into())
    }

    /// zod counts code points, not UTF-16 units.
    fn min_length(&mut self, name: &str, minimum: usize) -> Option<String> {
        let value = self.string(name)?;
        if value.chars().count() < minimum {
            self.issue(
                name,
                format!("Too small: expected string to have >={minimum} characters"),
                false,
            );
        }
        Some(value)
    }

    fn choice<T: Copy>(&mut self, name: &str, options: &[(&str, T)], default: T) -> T {
        let Some(value) = self.env.get(name) else {
            return default;
        };
        match options.iter().find(|(option, _)| option == value) {
            Some((_, choice)) => *choice,
            None => {
                let expected: Vec<String> = options.iter().map(|(option, _)| format!("\"{option}\"")).collect();
                self.issue(
                    name,
                    format!("Invalid option: expected one of {}", expected.join("|")),
                    true,
                );
                default
            }
        }
    }

    /// `z.coerce.number().int()` plus bounds. A failed bound keeps the value,
    /// as zod does, so the cross-field rules see it.
    fn int(&mut self, name: &str, bounds: &[Bound]) -> Option<f64> {
        let value = js::number(self.env.get(name)?);
        if !value.is_finite() {
            let received = js::number_to_string(value);
            self.issue(
                name,
                format!("Invalid input: expected number, received {received}"),
                true,
            );
            return Some(value);
        }
        if !js::is_integer(value) {
            self.issue(name, "Invalid input: expected int, received number".into(), true);
            return Some(value);
        }
        if !js::is_safe_integer(value) {
            let max = js::number_to_string(js::MAX_SAFE_INTEGER);
            let message = if value > 0.0 {
                format!("Too big: expected int to be <={max}")
            } else {
                format!("Too small: expected int to be >=-{max}")
            };
            self.issue(name, message, false);
        }
        for bound in bounds {
            let message = match *bound {
                Bound::Positive if value <= 0.0 => "Too small: expected number to be >0".to_owned(),
                Bound::AtLeast(minimum) if value < minimum => {
                    format!("Too small: expected number to be >={}", js::number_to_string(minimum))
                }
                Bound::AtMost(maximum) if value > maximum => {
                    format!("Too big: expected number to be <={}", js::number_to_string(maximum))
                }
                _ => continue,
            };
            self.issue(name, message, false);
        }
        Some(value)
    }

    /// `z.url()`: anything the WHATWG URL parser accepts, stored trimmed and
    /// without tabs or newlines.
    fn url(&mut self, name: &str) -> Option<String> {
        let raw = self.string(name)?;
        let trimmed = js::trim(&raw);
        if url::Url::parse(trimmed).is_err() {
            self.issue(name, "Invalid URL".into(), false);
            return Some(raw);
        }
        Some(trimmed.chars().filter(|c| !matches!(c, '\t' | '\n' | '\r')).collect())
    }

    /// Any value but `0`, `false`, `no` or `off` (any case) is on.
    fn flag(&self, name: &str, default: bool) -> bool {
        self.env.get(name).map_or(default, |value| {
            !["0", "false", "no", "off"].contains(&value.to_lowercase().as_str())
        })
    }

    /// Comma-separated positive safe integers; anything else is dropped.
    fn id_list(&self, name: &str) -> Vec<i64> {
        let raw = self.env.get(name).copied().unwrap_or("");
        raw.split(',')
            .map(|part| js::number(js::trim(part)))
            .filter(|value| js::is_safe_integer(*value) && *value > 0.0)
            .map(|value| value as i64)
            .collect()
    }

    fn pair(&mut self, id: &str, secret: &str) {
        if self.present(id) != self.present(secret) {
            self.issue(id, format!("{id} and {secret} must be configured together"), false);
        }
    }
}

/// Node's `path.posix.join(dir, name)`, which normalizes `.`, `..` and
/// repeated separators.
fn posix_join(dir: &str, name: &str) -> String {
    let joined = format!("{dir}/{name}");
    let absolute = joined.starts_with('/');
    let mut segments: Vec<&str> = Vec::new();
    for segment in joined.split('/') {
        match segment {
            "" | "." => {}
            ".." if segments.last().is_some_and(|last| *last != "..") => {
                segments.pop();
            }
            ".." if absolute => {}
            _ => segments.push(segment),
        }
    }
    let path = segments.join("/");
    if absolute { format!("/{path}") } else { path }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_the_typescript_loader() {
        let cases: Vec<serde_json::Value> =
            serde_json::from_str(include_str!("../tests/fixtures/config.json")).unwrap();
        assert!(cases.len() > 50);
        for case in cases {
            let env: Vec<(String, String)> = case["env"]
                .as_object()
                .unwrap()
                .iter()
                .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
                .collect();
            let name = &case["name"];
            match (load_config(env), &case["result"]) {
                (Ok(config), expected) if expected.get("ok").is_some() => {
                    // zod leaves an unset optional out of its output entirely.
                    let mut actual = serde_json::to_value(&config).unwrap();
                    actual.as_object_mut().unwrap().retain(|_, value| !value.is_null());
                    assert_eq!(actual, expected["ok"], "{name}");
                }
                (Err(error), expected) if expected.get("error").is_some() => {
                    assert_eq!(error.to_string(), expected["error"].as_str().unwrap(), "{name}");
                }
                (actual, expected) => panic!("{name}: Rust gave {actual:?}, TypeScript gave {expected}"),
            }
        }
    }

    #[test]
    fn shared_config_swaps_whole_configurations() {
        let shared = SharedConfig::new(load_config([("PORT", "1")]).unwrap());
        let before = shared.load();
        shared.update(|config| Config {
            x_access_token: Some("renewed".into()),
            ..config.clone()
        });
        assert_eq!(before.x_access_token, None);
        assert_eq!(shared.load().x_access_token.as_deref(), Some("renewed"));
        assert_eq!(shared.load().port, 1);
    }
}
