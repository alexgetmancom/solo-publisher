//! YouTube: a consent
//! redirect per language's channel, and the refresh token it yields stored as
//! the channel's credential. Access tokens are minted per call from it
//! (`crate::external::youtube::youtube_access_token`).

use crate::external::youtube::youtube_credentials;
use content::Locale;
use db::rusqlite::Connection;
use foundation::config::{Config, SharedConfig};
use foundation::logger::{LogLevel, log};
use foundation::secret_box::{SecretKey, open, seal};
use foundation::time::to_iso_string;
use jiff::Timestamp;
use runtime::http::{HttpClient, HttpRequest};
use serde_json::{Value, json};

use crate::channels::credentials::{ConfigPatch, Setting, assign, encryption_key};
use crate::channels::encode::{base_url, base64url, hex, pkce_challenge, search_params};
use crate::channels::entropy::{Entropy, random_bytes};
use crate::channels::registry::channel_identity;
use crate::channels::token_store::{TokenWrite, platform_token, store_platform_token};
use crate::channels::{Error, Result};

const AUTHORIZE_URL: &str = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN_URL: &str = "https://oauth2.googleapis.com/token";
const STATE_TTL_MS: i64 = 10 * 60 * 1000;

/// Publishing and reading comments take `force-ssl`; reporting is a second
/// grant. With `force-ssl` alone YouTube Analytics answers
/// ACCESS_TOKEN_SCOPE_INSUFFICIENT while publishing keeps working. A channel
/// connected before the second scope keeps a token that cannot report until
/// it reconnects: Google does not widen a grant already given.
const YOUTUBE_SCOPES: [&str; 2] = [
    "https://www.googleapis.com/auth/youtube.force-ssl",
    "https://www.googleapis.com/auth/yt-analytics.readonly",
];

fn youtube_scope() -> String {
    YOUTUBE_SCOPES.join(" ")
}

fn redirect_uri(config: &Config) -> String {
    format!("{}/oauth/youtube", base_url(config))
}

fn required_key(config: &Config) -> Result<SecretKey> {
    encryption_key(config)?.ok_or_else(|| Error::message("TOKEN_ENCRYPTION_KEY is required to connect an account"))
}

fn suffix(locale: Locale) -> &'static str {
    match locale {
        Locale::En => "EN",
        Locale::Ru => "RU",
    }
}

/// `youtubeOauthAuthorizeUrl`: the consent link for one language's channel.
/// `access_type=offline` with `prompt=consent` every time is what makes Google
/// hand over a refresh token; it omits one on a re-authorization it considers
/// already granted.
pub fn youtube_oauth_authorize_url(
    config: &Config,
    locale: Locale,
    now: Timestamp,
    entropy: &dyn Entropy,
) -> Result<String> {
    let key = required_key(config)?;
    let Some(client_id) = youtube_credentials(config, locale)
        .client_id
        .filter(|id| !id.is_empty())
    else {
        return Err(Error::message(format!(
            "YOUTUBE_{}_CLIENT_ID is required to connect YouTube",
            suffix(locale)
        )));
    };
    let verifier = base64url(&random_bytes::<32>(entropy));
    let state = json!({
        "locale": locale.as_str(),
        "verifier": verifier,
        "expiresAt": now.as_millisecond() + STATE_TTL_MS,
        "nonce": hex(&random_bytes::<16>(entropy)),
    });
    let redirect_uri = redirect_uri(config);
    let scope = youtube_scope();
    let sealed = seal(&state.to_string(), &key);
    let challenge = pkce_challenge(&verifier);
    let query = search_params(&[
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", &redirect_uri),
        ("scope", &scope),
        ("state", &sealed),
        ("access_type", "offline"),
        ("prompt", "consent"),
        ("include_granted_scopes", "false"),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
    ]);
    Ok(format!("{AUTHORIZE_URL}?{query}"))
}

struct YoutubeState {
    locale: Locale,
    verifier: String,
}

fn read_state(config: &Config, state: &str, now: Timestamp) -> Result<YoutubeState> {
    let parsed = required_key(config)
        .ok()
        .and_then(|key| open(state, &key).ok())
        .and_then(|opened| serde_json::from_str::<Value>(&opened).ok())
        .ok_or_else(|| Error::message("YouTube connection link is not valid for this Studio"))?;
    let verifier = parsed
        .get("verifier")
        .and_then(Value::as_str)
        .filter(|verifier| !verifier.is_empty());
    let locale = match parsed.get("locale").and_then(Value::as_str) {
        Some("ru") => Some(Locale::Ru),
        Some("en") => Some(Locale::En),
        _ => None,
    };
    let (Some(verifier), Some(locale)) = (verifier, locale) else {
        return Err(Error::message("YouTube connection link is malformed"));
    };
    if parsed
        .get("expiresAt")
        .and_then(Value::as_f64)
        .is_some_and(|expires_at| expires_at <= now.as_millisecond() as f64)
    {
        return Err(Error::message(
            "YouTube connection link has expired. Start the connection again.",
        ));
    }
    Ok(YoutubeState {
        locale,
        verifier: verifier.to_owned(),
    })
}

/// `exchangeYouTubeCode`: the code Google sent back becomes the stored
/// channel credential. The language rides in the sealed state: a query
/// parameter a browser can edit must not decide which channel a token is
/// filed under.
pub async fn exchange_youtube_code(
    config: &SharedConfig,
    sqlite: &Connection,
    http: &HttpClient,
    code: &str,
    state: &str,
    now: Timestamp,
) -> Result<Locale> {
    let current = config.load();
    let parsed = read_state(&current, state, now)?;
    let credentials = youtube_credentials(&current, parsed.locale);
    let redirect_uri = redirect_uri(&current);
    let answer = http
        .request_json(HttpRequest::post(TOKEN_URL).form(&[
            ("grant_type", Some("authorization_code")),
            ("code", Some(code)),
            ("client_id", Some(credentials.client_id.unwrap_or_default())),
            ("client_secret", Some(credentials.client_secret.unwrap_or_default())),
            ("redirect_uri", Some(&redirect_uri)),
            ("code_verifier", Some(&parsed.verifier)),
        ]))
        .await?;
    let Some(refresh_token) = answer
        .get("refresh_token")
        .and_then(Value::as_str)
        .filter(|token| !token.is_empty())
    else {
        return Err(Error::message(
            "Google returned no refresh token. Re-run the connection so the consent screen is shown again.",
        ));
    };
    // A grant short of a scope is silent everywhere else: publishing keeps
    // working while comments come back empty and reports refuse.
    if let Some(scope) = answer
        .get("scope")
        .and_then(Value::as_str)
        .filter(|scope| !scope.is_empty())
    {
        let granted: Vec<&str> = scope.split(' ').collect();
        let missing: Vec<&str> = YOUTUBE_SCOPES
            .into_iter()
            .filter(|required| !granted.contains(required))
            .collect();
        if !missing.is_empty() {
            return Err(Error::message(format!(
                "Google granted {scope}, which is missing {}. All of {} has to be granted.",
                missing.join(" "),
                youtube_scope()
            )));
        }
    }
    install_youtube_token(config, sqlite, parsed.locale, refresh_token, now)?;
    Ok(parsed.locale)
}

fn token_target(locale: Locale) -> String {
    channel_identity("youtube", locale)
}

fn refresh_token_setting(locale: Locale) -> Setting {
    match locale {
        Locale::En => Setting::YoutubeEnRefreshToken,
        Locale::Ru => Setting::YoutubeRuRefreshToken,
    }
}

/// `applyStoredYouTubeTokens`: a connected channel's refresh token under the
/// name the uploader reads; .env keeps working for an install that has not
/// reconnected.
pub fn stored_youtube_tokens(config: &Config, sqlite: &Connection, patch: &mut ConfigPatch) -> Result<()> {
    let Some(key) = encryption_key(config)? else {
        return Ok(());
    };
    for locale in [Locale::Ru, Locale::En] {
        let Some(row) = platform_token(sqlite, &token_target(locale))? else {
            continue;
        };
        match open(&row.sealed_token, &key) {
            Ok(token) => patch.set(refresh_token_setting(locale), token),
            Err(error) => log(
                LogLevel::Warn,
                "stored YouTube token could not be opened",
                Some(json!({"target": token_target(locale), "error": format!("Error: {error}")})),
            ),
        }
    }
    Ok(())
}

/// `installYouTubeToken`.
pub fn install_youtube_token(
    config: &SharedConfig,
    sqlite: &Connection,
    locale: Locale,
    refresh_token: &str,
    now: Timestamp,
) -> Result<()> {
    let Some(key) = encryption_key(&config.load())? else {
        return Err(Error::message(
            "TOKEN_ENCRYPTION_KEY is required to store a connected account",
        ));
    };
    let stamp = to_iso_string(now);
    store_platform_token(
        sqlite,
        &token_target(locale),
        &TokenWrite {
            sealed_token: seal(refresh_token, &key),
            seed_fingerprint: None,
            account_id: None,
            sealed_refresh_token: Some(None),
            // A YouTube refresh token does not expire unless the grant is revoked.
            expires_at: Some(None),
            refreshed_at: stamp.clone(),
            upload_limit_bytes: None,
            updated_at: stamp,
        },
    )?;
    assign(config, &[(refresh_token_setting(locale), refresh_token)]);
    Ok(())
}
