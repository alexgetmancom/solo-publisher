//! X: OAuth 2 with PKCE, the sealed state carrying the
//! verifier, and the access token refreshed ahead of its two-hour expiry.

use db::rusqlite::Connection;
use foundation::config::{Config, SharedConfig};
use foundation::js;
use foundation::secret_box::{SecretKey, open, seal};
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use runtime::http::{HttpClient, HttpRequest};
use serde::Serialize;
use serde_json::{Value, json};

use crate::credentials::{ConfigPatch, Setting, assign, encryption_key};
use crate::encode::{base_url, base64, base64url, hex, pkce_challenge, search_params};
use crate::entropy::{Entropy, random_bytes};
use crate::meta::{id_text, required};
use crate::token_store::{
    PlatformToken, TokenWrite, platform_token, store_platform_token, store_platform_token_unless_changed,
};
use crate::{Error, Result};

const AUTHORIZE_URL: &str = "https://x.com/i/oauth2/authorize";
const TOKEN_URL: &str = "https://api.x.com/2/oauth2/token";
const STATE_TTL_MS: i64 = 10 * 60 * 1000;
const REFRESH_AHEAD_MS: i64 = 10 * 60 * 1000;
const SCOPES: &str = "tweet.read tweet.write users.read media.write offline.access";

fn required_key(config: &Config) -> Result<SecretKey> {
    encryption_key(config)?.ok_or_else(|| Error::message("TOKEN_ENCRYPTION_KEY is required for browser OAuth"))
}

fn assert_configured(config: &Config) -> Result<()> {
    required(config.x_client_id.as_deref(), "X_CLIENT_ID")?;
    required(config.x_client_secret.as_deref(), "X_CLIENT_SECRET")?;
    required_key(config)?;
    Ok(())
}

/// `xOauthConnectPath`.
pub fn x_oauth_connect_path(config: &Config) -> Result<String> {
    assert_configured(config)?;
    Ok("/oauth/x/start".into())
}

/// `xOauthConnectUrl`.
pub fn x_oauth_connect_url(config: &Config) -> Result<String> {
    Ok(format!("{}{}", base_url(config), x_oauth_connect_path(config)?))
}

fn x_oauth_redirect_uri(config: &Config) -> String {
    format!("{}/oauth/x", base_url(config))
}

/// `xOauthAuthorizeUrl`: the consent screen, the verifier sealed into the state.
pub fn x_oauth_authorize_url(config: &Config, now: Timestamp, entropy: &dyn Entropy) -> Result<String> {
    assert_configured(config)?;
    let key = required_key(config)?;
    let verifier = base64url(&random_bytes::<32>(entropy));
    let state = json!({
        "verifier": verifier,
        "expiresAt": now.as_millisecond() + STATE_TTL_MS,
        "nonce": hex(&random_bytes::<16>(entropy)),
    });
    let sealed = seal(&state.to_string(), &key);
    let client_id = required(config.x_client_id.as_deref(), "X_CLIENT_ID")?;
    let redirect_uri = x_oauth_redirect_uri(config);
    let challenge = pkce_challenge(&verifier);
    let query = search_params(&[
        ("response_type", "code"),
        ("client_id", client_id),
        ("redirect_uri", &redirect_uri),
        ("scope", SCOPES),
        ("state", &sealed),
        ("code_challenge", &challenge),
        ("code_challenge_method", "S256"),
    ]);
    Ok(format!("{AUTHORIZE_URL}?{query}"))
}

fn read_state(config: &Config, state: &str, now: Timestamp) -> Result<String> {
    let parsed = required_key(config)
        .ok()
        .and_then(|key| open(state, &key).ok())
        .and_then(|opened| serde_json::from_str::<Value>(&opened).ok())
        .ok_or_else(|| Error::message("X OAuth state is invalid"))?;
    let expired = !parsed.get("verifier").is_some_and(js::truthy)
        || !parsed.get("nonce").is_some_and(js::truthy)
        || !parsed.get("expiresAt").is_some_and(js::truthy)
        || parsed
            .get("expiresAt")
            .and_then(Value::as_f64)
            .is_some_and(|expires_at| expires_at < now.as_millisecond() as f64);
    if expired {
        return Err(Error::message("X OAuth link has expired"));
    }
    Ok(parsed
        .get("verifier")
        .and_then(Value::as_str)
        .unwrap_or_default()
        .to_owned())
}

/// The account a consent code connected.
#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
pub struct XIdentity {
    pub id: String,
    pub username: String,
}

/// `exchangeXCode`: the code and the sealed verifier for the token pair, and
/// the account they belong to.
pub async fn exchange_x_code(
    config: &SharedConfig,
    sqlite: &Connection,
    http: &HttpClient,
    code: &str,
    state: &str,
    now: Timestamp,
) -> Result<XIdentity> {
    let current = config.load();
    let verifier = read_state(&current, state, now)?;
    let redirect_uri = x_oauth_redirect_uri(&current);
    let tokens = token_request(
        http,
        &current,
        &[
            ("grant_type", Some("authorization_code")),
            ("code", Some(code)),
            ("redirect_uri", Some(&redirect_uri)),
            ("code_verifier", Some(&verifier)),
        ],
    )
    .await?;
    let bearer = tokens.get("access_token").and_then(id_text);
    let profile = http
        .request_json(HttpRequest::get("https://api.x.com/2/users/me").header(
            "Authorization",
            format!("Bearer {}", bearer.as_deref().unwrap_or("undefined")),
        ))
        .await?;
    let Some(id) = profile
        .pointer("/data/id")
        .filter(|id| js::truthy(id))
        .and_then(id_text)
    else {
        return Err(Error::message("X returned no account id"));
    };
    install_x_tokens(config, sqlite, &tokens, now, XWrite::Connect(&id))?;
    Ok(XIdentity {
        username: profile
            .pointer("/data/username")
            .and_then(Value::as_str)
            .map(|name| js::trim(name).to_owned())
            .unwrap_or_default(),
        id,
    })
}

/// `applyStoredXTokens`: the connected pair, when there is one.
pub fn stored_x_tokens(config: &Config, sqlite: &Connection, patch: &mut ConfigPatch) -> Result<()> {
    let Some(key) = encryption_key(config)? else {
        return Ok(());
    };
    let Some(row) = platform_token(sqlite, "x")? else {
        return Ok(());
    };
    let Some(sealed_refresh) = row.sealed_refresh_token.filter(|sealed| !sealed.is_empty()) else {
        return Ok(());
    };
    patch.set(Setting::XAccessToken, open(&row.sealed_token, &key)?);
    patch.set(Setting::XRefreshToken, open(&sealed_refresh, &key)?);
    Ok(())
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum XRefresh {
    Fresh,
    Refreshed,
    /// The pair was replaced (an operator reconnected X) while the refresh
    /// was in flight; the newer pair stays and nothing was written.
    Superseded,
    Unconfigured,
}

/// `refreshXToken`: a new pair once the access token is within ten minutes
/// of its expiry.
pub async fn refresh_x_token(
    config: &SharedConfig,
    sqlite: &Connection,
    http: &HttpClient,
    now: Timestamp,
) -> Result<XRefresh> {
    let current = config.load();
    let set = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    if !set(&current.x_client_id) || !set(&current.x_client_secret) || !set(&current.x_refresh_token) {
        return Ok(XRefresh::Unconfigured);
    }
    let row = platform_token(sqlite, "x")?;
    if let Some(expires_at) = row
        .as_ref()
        .and_then(|row| row.expires_at.clone())
        .filter(|expires_at| !expires_at.is_empty())
        && parse_iso_instant(&expires_at).is_ok_and(|at| at.as_millisecond() - now.as_millisecond() > REFRESH_AHEAD_MS)
    {
        return Ok(XRefresh::Fresh);
    }
    let tokens = token_request(
        http,
        &current,
        &[
            ("grant_type", Some("refresh_token")),
            ("refresh_token", current.x_refresh_token.as_deref()),
        ],
    )
    .await?;
    Ok(
        if install_x_tokens(config, sqlite, &tokens, now, XWrite::Refresh(row.as_ref()))? {
            XRefresh::Refreshed
        } else {
            XRefresh::Superseded
        },
    )
}

/// Who is writing the pair. A connection is the operator's newest word and
/// writes unconditionally; a refresh answers the row it read before the
/// request and writes only if that row is still there.
enum XWrite<'a> {
    Connect(&'a str),
    Refresh(Option<&'a PlatformToken>),
}

/// `tokens.expires_in ?? 7200`, in milliseconds, as `Date` arithmetic reads it.
fn expires_in_ms(tokens: &Value) -> Result<i64> {
    let seconds = match tokens.get("expires_in") {
        None | Some(Value::Null) => 7200.0,
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js::number(text),
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(_) => f64::NAN,
    };
    let ms = seconds * 1000.0;
    if ms.is_finite() {
        Ok(ms.trunc() as i64)
    } else {
        Err(Error::message("Invalid time value"))
    }
}

fn install_x_tokens(
    config: &SharedConfig,
    sqlite: &Connection,
    tokens: &Value,
    now: Timestamp,
    write: XWrite<'_>,
) -> Result<bool> {
    let text = |key: &str| {
        tokens
            .get(key)
            .and_then(Value::as_str)
            .filter(|value| !value.is_empty())
    };
    let (Some(access_token), Some(refresh_token)) = (text("access_token"), text("refresh_token")) else {
        return Err(Error::message("X returned no renewable token pair"));
    };
    let key = required_key(&config.load())?;
    let expires_at = Timestamp::from_millisecond(now.as_millisecond() + expires_in_ms(tokens)?)
        .map(to_iso_string)
        .map_err(|_| Error::message("Invalid time value"))?;
    let stamp = to_iso_string(now);
    let account_id = match write {
        XWrite::Connect(id) => Some(id.to_owned()),
        XWrite::Refresh(read) => read.and_then(|row| row.account_id.clone()),
    };
    let row = TokenWrite {
        sealed_token: seal(access_token, &key),
        seed_fingerprint: None,
        account_id,
        sealed_refresh_token: Some(Some(seal(refresh_token, &key))),
        expires_at: Some(Some(expires_at)),
        refreshed_at: stamp.clone(),
        upload_limit_bytes: None,
        updated_at: stamp,
    };
    match write {
        XWrite::Connect(_) => store_platform_token(sqlite, "x", &row)?,
        XWrite::Refresh(read) => {
            if !store_platform_token_unless_changed(sqlite, "x", &row, read)? {
                return Ok(false);
            }
        }
    }
    assign(
        config,
        &[
            (Setting::XAccessToken, access_token),
            (Setting::XRefreshToken, refresh_token),
        ],
    );
    Ok(true)
}

async fn token_request(http: &HttpClient, config: &Config, fields: &[(&str, Option<&str>)]) -> Result<Value> {
    let client_id = required(config.x_client_id.as_deref(), "X_CLIENT_ID")?;
    let client_secret = required(config.x_client_secret.as_deref(), "X_CLIENT_SECRET")?;
    Ok(http
        .request_json(
            HttpRequest::post(TOKEN_URL)
                .header("Content-Type", "application/x-www-form-urlencoded")
                .header(
                    "Authorization",
                    format!("Basic {}", base64(format!("{client_id}:{client_secret}").as_bytes())),
                )
                .form(fields),
        )
        .await?)
}
