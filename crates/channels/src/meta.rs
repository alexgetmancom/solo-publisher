//! Threads and Instagram: the same road for both — signed state, consent screen,
//! code for a short-lived token, short-lived for a long-lived one, the profile
//! behind it — and the renewal of the long-lived token before it lapses.

use content::Locale;
use db::rusqlite::Connection;
use domain::studio::boundaries::MetaOauthPlatform;
use domain::studio::services::channels::ChannelInput;
use foundation::config::{Config, SharedConfig};
use foundation::js;
use foundation::logger::{LogLevel, log};
use foundation::secret_box::{fingerprint, open, seal};
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use runtime::http::{HttpClient, HttpRequest};
use serde::Serialize;
use serde_json::{Value, json};

use crate::credentials::{ConfigPatch, Setting, assign, encryption_key};
use crate::encode::{base_url, base64url, encode_uri_component, hmac_sha256, search_params};
use crate::entropy::{Entropy, random_bytes};
use crate::registry::channel_identity;
use crate::token_store::{TokenWrite, platform_token, store_platform_token};
use crate::{Error, Result};

const STATE_TTL_MS: i64 = 10 * 60 * 1000;

/// What one Meta platform is, as data: a new platform is an entry, not
/// another branch in the flow both share.
pub struct MetaProvider {
    pub label: &'static str,
    pub authorize_url: &'static str,
    pub token_url: &'static str,
    /// Trades the short-lived token for the long-lived one this Studio keeps.
    pub exchange_url: &'static str,
    pub exchange_grant: &'static str,
    pub profile_url: &'static str,
    pub scope: &'static str,
    /// Query the consent screen needs beyond the shared five.
    pub authorize_extras: &'static [(&'static str, &'static str)],
    app_id: fn(&Config) -> Option<&str>,
    app_secret: fn(&Config) -> Option<&str>,
    pub app_id_name: &'static str,
    pub app_secret_name: &'static str,
    platform: &'static str,
}

impl MetaProvider {
    pub fn app_id<'a>(&self, config: &'a Config) -> Option<&'a str> {
        (self.app_id)(config)
    }

    pub fn app_secret<'a>(&self, config: &'a Config) -> Option<&'a str> {
        (self.app_secret)(config)
    }

    /// Where the renewable token is stored, by the name `platform_tokens` uses.
    pub fn token_target(&self, locale: Locale) -> String {
        channel_identity(self.platform, locale)
    }

    /// What a connected account becomes in the channel registry: Threads is a
    /// text target, Instagram a Reels account. A Story route is connected
    /// independently because enabling it changes the post screens and queue.
    pub fn registry_row(&self, locale: Locale, account_id: &str, account: &str) -> ChannelInput {
        let code = locale.as_str().to_uppercase();
        let threads = self.platform == "threads";
        ChannelInput {
            platform: if threads {
                channel_identity("threads", locale)
            } else {
                "instagram".into()
            },
            locale,
            provider: "native".into(),
            provider_account_id: Some(account_id.into()),
            target_id: threads.then(|| channel_identity("threads", locale)),
            label: Some(format!("{} {code} · {account}", self.label)),
            source: None,
        }
    }
}

// Insights is not optional for Threads: a token minted without it is accepted
// everywhere except the insights call. Replies are the same trap: a chain
// continues with `reply_to_id`, which needs `threads_manage_replies`, and a
// token without it is refused with an empty HTTP 500 that reads as an outage.
// Reading replies is a second permission (`threads_read_replies`).
static THREADS: MetaProvider = MetaProvider {
    label: "Threads",
    authorize_url: "https://threads.net/oauth/authorize",
    token_url: "https://graph.threads.net/oauth/access_token",
    exchange_url: "https://graph.threads.net/access_token",
    exchange_grant: "th_exchange_token",
    profile_url: "https://graph.threads.net/v1.0/me",
    scope: "threads_basic,threads_content_publish,threads_manage_replies,threads_read_replies,threads_manage_insights",
    authorize_extras: &[],
    app_id: |config| config.threads_app_id.as_deref(),
    app_secret: |config| config.threads_app_secret.as_deref(),
    app_id_name: "THREADS_APP_ID",
    app_secret_name: "THREADS_APP_SECRET",
    platform: "threads",
};

// Instagram offers the Facebook login beside its own and remembers the last
// account: both would connect an account the operator did not mean to.
static INSTAGRAM: MetaProvider = MetaProvider {
    label: "Instagram",
    authorize_url: "https://www.instagram.com/oauth/authorize",
    token_url: "https://api.instagram.com/oauth/access_token",
    exchange_url: "https://graph.instagram.com/access_token",
    exchange_grant: "ig_exchange_token",
    profile_url: "https://graph.instagram.com/me",
    scope: "instagram_business_basic,instagram_business_content_publish,instagram_business_manage_insights,instagram_business_manage_comments",
    authorize_extras: &[("enable_fb_login", "0"), ("force_reauth", "true")],
    app_id: |config| config.instagram_app_id.as_deref(),
    app_secret: |config| config.instagram_app_secret.as_deref(),
    app_id_name: "INSTAGRAM_APP_ID",
    app_secret_name: "INSTAGRAM_APP_SECRET",
    platform: "instagram",
};

/// `META_PROVIDERS[platform]`.
pub fn meta_provider(platform: MetaOauthPlatform) -> &'static MetaProvider {
    match platform {
        MetaOauthPlatform::Threads => &THREADS,
        MetaOauthPlatform::Instagram => &INSTAGRAM,
    }
}

pub fn meta_platform_name(platform: MetaOauthPlatform) -> &'static str {
    meta_provider(platform).platform
}

/// What a verified state names.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MetaOauthState {
    pub platform: MetaOauthPlatform,
    pub locale: Locale,
}

/// `required(value, name)`: the trimmed value, or the refusal browser OAuth gives.
pub(crate) fn required<'a>(value: Option<&'a str>, name: &str) -> Result<&'a str> {
    match value.map(js::trim).filter(|value| !value.is_empty()) {
        Some(value) => Ok(value),
        None => Err(Error::message(format!("{name} is required for browser OAuth"))),
    }
}

fn assert_configured(config: &Config, platform: MetaOauthPlatform) -> Result<()> {
    let provider = meta_provider(platform);
    required(config.token_encryption_key.as_deref(), "TOKEN_ENCRYPTION_KEY")?;
    required(provider.app_id(config), provider.app_id_name)?;
    required(provider.app_secret(config), provider.app_secret_name)?;
    Ok(())
}

/// `metaOauthConnectUrl`: the Studio's own start link, carrying a signed state.
pub fn meta_oauth_connect_url(
    config: &Config,
    platform: MetaOauthPlatform,
    locale: Locale,
    now: Timestamp,
    entropy: &dyn Entropy,
) -> Result<String> {
    Ok(format!(
        "{}/oauth/{}/start?state={}",
        base_url(config),
        meta_platform_name(platform),
        encode_uri_component(&meta_oauth_state(config, platform, locale, now, entropy)?)
    ))
}

/// The signed state a connect link carries.
pub(crate) fn meta_oauth_state(
    config: &Config,
    platform: MetaOauthPlatform,
    locale: Locale,
    now: Timestamp,
    entropy: &dyn Entropy,
) -> Result<String> {
    assert_configured(config, platform)?;
    let payload = json!({
        "platform": meta_platform_name(platform),
        "locale": locale.as_str(),
        "expiresAt": now.as_millisecond() + STATE_TTL_MS,
        "nonce": base64url(&random_bytes::<16>(entropy)),
    });
    let encoded = base64url(payload.to_string().as_bytes());
    let signature = state_signature(config, &encoded)?;
    Ok(format!("{encoded}.{signature}"))
}

/// `metaOauthConnectPath`.
pub fn meta_oauth_connect_path(config: &Config, platform: MetaOauthPlatform, locale: Locale) -> Result<String> {
    assert_configured(config, platform)?;
    Ok(format!(
        "/oauth/{}/start?locale={}",
        meta_platform_name(platform),
        locale.as_str()
    ))
}

/// `metaOauthAuthorizeUrl`: the consent screen for a verified state.
pub fn meta_oauth_authorize_url(config: &Config, state: &str, now: Timestamp) -> Result<String> {
    let parsed = verify_meta_oauth_state(config, state, now)?;
    meta_authorize_url(config, parsed.platform, Some(state))
}

/// `metaAuthorizeUrl`: the consent screen itself. The terminal fallback opens
/// it without a state, because nothing comes back to verify one.
pub fn meta_authorize_url(config: &Config, platform: MetaOauthPlatform, state: Option<&str>) -> Result<String> {
    let provider = meta_provider(platform);
    let client_id = required(provider.app_id(config), provider.app_id_name)?;
    let redirect_uri = meta_oauth_redirect_uri(config, platform);
    let mut query = vec![
        ("client_id", client_id),
        ("redirect_uri", redirect_uri.as_str()),
        ("response_type", "code"),
        ("scope", provider.scope),
    ];
    query.extend(provider.authorize_extras.iter().copied());
    if let Some(state) = state.filter(|state| !state.is_empty()) {
        query.push(("state", state));
    }
    Ok(format!("{}?{}", provider.authorize_url, search_params(&query)))
}

/// `verifyMetaOauthState`.
pub fn verify_meta_oauth_state(config: &Config, state: &str, now: Timestamp) -> Result<MetaOauthState> {
    let mut parts = state.split('.');
    let (Some(encoded), Some(signature)) = (parts.next(), parts.next()) else {
        return Err(Error::message("OAuth state is malformed"));
    };
    if encoded.is_empty() || signature.is_empty() {
        return Err(Error::message("OAuth state is malformed"));
    }
    let expected = state_signature(config, encoded)?;
    // Equal lengths first, then a comparison that does not stop early.
    let matches = signature.len() == expected.len()
        && signature
            .bytes()
            .zip(expected.bytes())
            .fold(0u8, |difference, (left, right)| difference | (left ^ right))
            == 0;
    if !matches {
        return Err(Error::message("OAuth state is invalid"));
    }
    let payload = base64url_decode(encoded).ok_or_else(|| Error::message("OAuth state is invalid"))?;
    let payload: Value = serde_json::from_slice(&payload).map_err(|error| Error::message(error.to_string()))?;
    let platform = match payload.get("platform").and_then(Value::as_str) {
        Some("threads") => Some(MetaOauthPlatform::Threads),
        Some("instagram") => Some(MetaOauthPlatform::Instagram),
        _ => None,
    };
    let locale = match payload.get("locale").and_then(Value::as_str) {
        Some("ru") => Some(Locale::Ru),
        Some("en") => Some(Locale::En),
        _ => None,
    };
    let (Some(platform), Some(locale)) = (platform, locale) else {
        return Err(Error::message("OAuth state has an invalid destination"));
    };
    match payload.get("expiresAt").and_then(Value::as_f64) {
        Some(expires_at) if expires_at >= now.as_millisecond() as f64 => {}
        _ => return Err(Error::message("OAuth link has expired")),
    }
    // `.length` counts UTF-16 units.
    match payload.get("nonce").and_then(Value::as_str) {
        Some(nonce) if nonce.encode_utf16().count() >= 16 => {}
        _ => return Err(Error::message("OAuth state has no nonce")),
    }
    Ok(MetaOauthState { platform, locale })
}

/// Node's base64url decoder: padding optional, other characters skipped.
fn base64url_decode(encoded: &str) -> Option<Vec<u8>> {
    use base64::Engine as _;
    let cleaned: String = encoded
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '-' || *c == '_')
        .collect();
    base64::engine::GeneralPurpose::new(
        &base64::alphabet::URL_SAFE,
        base64::engine::GeneralPurposeConfig::new()
            .with_decode_padding_mode(base64::engine::DecodePaddingMode::Indifferent)
            .with_decode_allow_trailing_bits(true),
    )
    .decode(cleaned)
    .ok()
}

fn state_signature(config: &Config, encoded: &str) -> Result<String> {
    let raw = required(config.token_encryption_key.as_deref(), "TOKEN_ENCRYPTION_KEY")?;
    let key = foundation::secret_box::encryption_key(Some(raw))?
        .ok_or_else(|| Error::message("TOKEN_ENCRYPTION_KEY is required for browser OAuth"))?;
    Ok(base64url(&hmac_sha256(key.bytes(), encoded.as_bytes())))
}

/// `metaOauthRedirectUri`.
pub fn meta_oauth_redirect_uri(config: &Config, platform: MetaOauthPlatform) -> String {
    format!("{}/oauth/{}", base_url(config), meta_platform_name(platform))
}

/// The account a consent code was traded for.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MetaIdentity {
    pub access_token: String,
    pub user_id: String,
    pub username: String,
}

/// `String(value)` of an id a provider answered as a string or a number
/// (a number past 2^53 printed as JavaScript prints it).
pub(crate) fn id_text(value: &Value) -> Option<String> {
    match value {
        Value::String(text) => Some(text.clone()),
        Value::Number(number) => Some(js::number_to_string(number.as_f64().unwrap_or(f64::NAN))),
        Value::Bool(flag) => Some(flag.to_string()),
        _ => None,
    }
}

fn token_of(value: &Value) -> Option<&str> {
    value
        .get("access_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
}

/// `exchangeMetaCode`: the consent code for the long-lived token this Studio
/// publishes with, and the account behind it.
pub async fn exchange_meta_code(
    http: &HttpClient,
    config: &Config,
    platform: MetaOauthPlatform,
    code: &str,
) -> Result<MetaIdentity> {
    let provider = meta_provider(platform);
    let app_id = required(provider.app_id(config), provider.app_id_name)?;
    let app_secret = required(provider.app_secret(config), provider.app_secret_name)?;
    let redirect_uri = meta_oauth_redirect_uri(config, platform);
    let short_lived = http
        .request_json(HttpRequest::post(provider.token_url).form(&[
            ("client_id", Some(app_id)),
            ("client_secret", Some(app_secret)),
            ("grant_type", Some("authorization_code")),
            ("redirect_uri", Some(&redirect_uri)),
            ("code", Some(code)),
        ]))
        .await?;
    let Some(short_token) = token_of(&short_lived) else {
        return Err(Error::message(format!(
            "{} returned no access token for that code",
            provider.label
        )));
    };
    let exchange = search_params(&[
        ("grant_type", provider.exchange_grant),
        ("client_secret", app_secret),
        ("access_token", short_token),
    ]);
    let long_lived = http
        .request_json(HttpRequest::get(format!("{}?{exchange}", provider.exchange_url)))
        .await?;
    let Some(access_token) = token_of(&long_lived) else {
        return Err(Error::message(format!(
            "{} refused to issue a long-lived token",
            provider.label
        )));
    };
    let profile_query = search_params(&[("fields", "id,username"), ("access_token", access_token)]);
    let profile = http
        .request_json(HttpRequest::get(format!("{}?{profile_query}", provider.profile_url)))
        .await?;
    let user_id = profile
        .get("id")
        .filter(|id| !id.is_null())
        .or_else(|| short_lived.get("user_id").filter(|id| !id.is_null()))
        .and_then(id_text)
        .unwrap_or_default();
    if user_id.is_empty() {
        return Err(Error::message(format!("{} returned no account id", provider.label)));
    }
    Ok(MetaIdentity {
        access_token: access_token.to_owned(),
        user_id,
        username: profile
            .get("username")
            .and_then(Value::as_str)
            .map(|name| js::trim(name).to_owned())
            .unwrap_or_default(),
    })
}

// ---- long-lived tokens ----------------------------------------------------

/// Meta's long-lived tokens last 60 days and a lapsed one cannot be renewed,
/// so renewal happens far from the edge.
const RENEW_AFTER_DAYS: i64 = 30;
const DAY_MS: i64 = 24 * 60 * 60 * 1000;

/// A renewable Meta credential: the target it is stored under and the
/// setting the rest of the process reads it from.
struct MetaToken {
    target: &'static str,
    setting: Setting,
    refresh_host: &'static str,
    refresh_grant: &'static str,
}

const TOKENS: [MetaToken; 4] = [
    MetaToken {
        target: "threads_ru",
        setting: Setting::ThreadsRuAccessToken,
        refresh_host: "graph.threads.net",
        refresh_grant: "th_refresh_token",
    },
    MetaToken {
        target: "threads_en",
        setting: Setting::ThreadsEnAccessToken,
        refresh_host: "graph.threads.net",
        refresh_grant: "th_refresh_token",
    },
    MetaToken {
        target: "instagram_ru",
        setting: Setting::InstagramRuAccessToken,
        refresh_host: "graph.instagram.com",
        refresh_grant: "ig_refresh_token",
    },
    MetaToken {
        target: "instagram_en",
        setting: Setting::InstagramEnAccessToken,
        refresh_host: "graph.instagram.com",
        refresh_grant: "ig_refresh_token",
    },
];

impl MetaToken {
    fn refresh_url(&self, token: &str) -> String {
        format!(
            "https://{}/refresh_access_token?grant_type={}&access_token={}",
            self.refresh_host,
            self.refresh_grant,
            encode_uri_component(token)
        )
    }

    /// What .env said this token was before any renewal replaced it.
    fn seed<'a>(&self, config: &'a Config) -> Option<&'a str> {
        let seeds = &config.meta_token_seeds;
        match self.setting {
            Setting::ThreadsRuAccessToken => seeds.threads_ru_access_token.as_deref(),
            Setting::ThreadsEnAccessToken => seeds.threads_en_access_token.as_deref(),
            Setting::InstagramRuAccessToken => seeds.instagram_ru_access_token.as_deref(),
            _ => seeds.instagram_en_access_token.as_deref(),
        }
        .filter(|seed| !seed.is_empty())
    }

    fn user_id_setting(&self) -> Option<Setting> {
        match self.target {
            "instagram_ru" => Some(Setting::InstagramRuUserId),
            "instagram_en" => Some(Setting::InstagramEnUserId),
            _ => None,
        }
    }
}

/// `applyStoredMetaTokens`: each configured Meta token replaced with the
/// renewal this Studio last made, unless .env now holds a different value —
/// the operator replacing it by hand, which is newer than any renewal.
pub fn stored_meta_tokens(config: &Config, sqlite: &Connection, patch: &mut ConfigPatch) -> Result<()> {
    let Some(key) = encryption_key(config)? else {
        return Ok(());
    };
    for token in &TOKENS {
        let seed = token.seed(config);
        let Some(row) = platform_token(sqlite, token.target)? else {
            continue;
        };
        if let Some(stored_seed) = row.seed_fingerprint.as_deref().filter(|seed| !seed.is_empty())
            && seed.is_none_or(|seed| stored_seed != fingerprint(seed))
        {
            continue;
        }
        match open(&row.sealed_token, &key) {
            Ok(effective) => {
                // An account connected through the browser has no seed, so a
                // token sitting in .env is not the operator's newest intent.
                if row.seed_fingerprint.is_none()
                    && let Some(seed) = seed
                    && seed != effective
                {
                    log(
                        LogLevel::Warn,
                        "stored platform token overrides the one in .env",
                        Some(json!({
                            "target": token.target,
                            "setting": token.setting.name(),
                            "hint": "reconnect from Studio > Channels",
                        })),
                    );
                }
                patch.set(token.setting, effective);
                if let (Some(account), Some(setting)) = (row.account_id.as_deref(), token.user_id_setting())
                    && !account.is_empty()
                {
                    patch.set(setting, account);
                }
            }
            Err(error) => log(
                LogLevel::Warn,
                "stored platform token could not be opened",
                Some(json!({"target": token.target, "error": format!("Error: {error}")})),
            ),
        }
    }
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum RenewalStatus {
    Renewed,
    Fresh,
    Failed,
    Unsealed,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct RenewalOutcome {
    pub target: &'static str,
    pub status: RenewalStatus,
}

/// `renewMetaTokens`: renews what is a month old or older and stores it.
pub async fn renew_meta_tokens(
    config: &SharedConfig,
    sqlite: &Connection,
    http: &HttpClient,
    now: Timestamp,
) -> Result<Vec<RenewalOutcome>> {
    let Some(key) = encryption_key(&config.load())? else {
        return Ok(Vec::new());
    };
    let mut outcomes = Vec::new();
    for token in &TOKENS {
        let current = config.load();
        let Some(value) = token.setting.get(&current).filter(|value| !value.is_empty()) else {
            continue;
        };
        let env_seed = token.seed(&current);
        let row = platform_token(sqlite, token.target)?;
        // The stored renewal is this token's history only while .env still
        // holds the value it grew from.
        let seed = row.filter(|row| match &row.seed_fingerprint {
            None => true,
            Some(stored) => env_seed.is_some_and(|seed| *stored == fingerprint(seed)),
        });
        let age = seed.as_ref().map(|seed| {
            parse_iso_instant(&seed.refreshed_at)
                .ok()
                .map(|at| now.as_millisecond() - at.as_millisecond())
        });
        if let Some(Some(age)) = age
            && age < RENEW_AFTER_DAYS * DAY_MS
        {
            outcomes.push(RenewalOutcome {
                target: token.target,
                status: RenewalStatus::Fresh,
            });
            continue;
        }
        let renewed = async {
            let answer = http.request_json(HttpRequest::get(token.refresh_url(value))).await?;
            let Some(renewed) = token_of(&answer) else {
                return Err(Error::message("no access_token in the response"));
            };
            let stamp = to_iso_string(now);
            store_platform_token(
                sqlite,
                token.target,
                &TokenWrite {
                    sealed_token: seal(renewed, &key),
                    // The seed stays the .env value: it is what tells a later
                    // run whether the operator has since replaced it.
                    seed_fingerprint: seed
                        .as_ref()
                        .and_then(|seed| seed.seed_fingerprint.clone())
                        .or_else(|| env_seed.map(fingerprint)),
                    account_id: seed.as_ref().and_then(|seed| seed.account_id.clone()).or_else(|| {
                        token
                            .user_id_setting()
                            .and_then(|setting| setting.get(&current))
                            .map(str::to_owned)
                    }),
                    sealed_refresh_token: None,
                    expires_at: None,
                    refreshed_at: stamp.clone(),
                    upload_limit_bytes: None,
                    updated_at: stamp,
                },
            )?;
            assign(config, &[(token.setting, renewed)]);
            Ok(())
        }
        .await;
        outcomes.push(RenewalOutcome {
            target: token.target,
            status: match renewed {
                Ok(()) => RenewalStatus::Renewed,
                Err(error) => {
                    // A token that cannot be renewed stops publishing on its
                    // own, and only re-issuing it by hand brings it back.
                    log(
                        LogLevel::Warn,
                        "platform token renewal failed",
                        Some(json!({"target": token.target, "error": format!("Error: {error}")})),
                    );
                    RenewalStatus::Failed
                }
            },
        });
    }
    Ok(outcomes)
}

/// `installMetaToken`: a token this Studio's OAuth callback was issued
/// becomes the database-owned credential, now and on every restart.
pub fn install_meta_token(
    config: &SharedConfig,
    sqlite: &Connection,
    target: &str,
    access_token: &str,
    account_id: &str,
    now: Timestamp,
) -> Result<()> {
    let Some(key) = encryption_key(&config.load())? else {
        return Err(Error::message("TOKEN_ENCRYPTION_KEY is required for browser OAuth"));
    };
    let Some(token) = TOKENS.iter().find(|token| token.target == target) else {
        return Err(Error::message(format!("Unknown Meta token target: {target}")));
    };
    let stamp = to_iso_string(now);
    store_platform_token(
        sqlite,
        target,
        &TokenWrite {
            sealed_token: seal(access_token, &key),
            seed_fingerprint: None,
            account_id: Some(account_id.into()),
            sealed_refresh_token: None,
            expires_at: None,
            refreshed_at: stamp.clone(),
            upload_limit_bytes: None,
            updated_at: stamp,
        },
    )?;
    let mut assignments = vec![(token.setting, access_token)];
    if let Some(setting) = token.user_id_setting() {
        assignments.push((setting, account_id));
    }
    assign(config, &assignments);
    Ok(())
}
