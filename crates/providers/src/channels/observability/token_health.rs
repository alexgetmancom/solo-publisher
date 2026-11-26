//! Each configured credential's cheapest
//! "am I still authenticated" call, on its own hourly cadence, fed into the
//! breaker publish failures use — so a token that died between posts pauses
//! publishing before the next real attempt burns a retry on a certain 401.

use crate::external::instagram::{instagram_credentials_for_locale, instagram_graph_host};
use crate::external::telegram::BotApi;
use crate::external::threads::threads_credentials;
use crate::external::youtube::{youtube_access_token, youtube_credentials};
use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::{Clock, DomainEventInput, Severity};
use domain::channels::list_channels;
use domain::observability::auth_circuit::AuthCircuitBreaker;
use domain::publishing::boundaries::AuthCircuit;
use domain::repositories::record_event;
use domain::studio::boundaries::MetaOauthPlatform;
use foundation::config::Config;
use foundation::logger::{LogLevel, log};
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use runtime::http::{ExternalError, HttpClient, HttpRequest};
use serde_json::{Map, Value, json};

use crate::channels::meta::meta_provider;

const PING_INTERVAL_SECONDS: i64 = 60 * 60;
/// After an inconclusive probe (a network error, an unrelated 5xx): short
/// enough that a blip does not buy a dead token another hour.
const PING_RETRY_SECONDS: i64 = 5 * 60;
/// Warn once a Graph token's reported expiry is this close.
const EXPIRY_WARNING_WINDOW_MS: i64 = 7 * 24 * 60 * 60 * 1000;
const WARNING_COOLDOWN_SECONDS: u64 = 24 * 60 * 60;

/// What one probe learned. `missing_scopes` is `None` when the provider will
/// not say, and empty when the grant is complete.
#[derive(Default)]
struct ProbeResult {
    expires_at: Option<String>,
    missing_scopes: Option<Vec<String>>,
}

enum Probe {
    ControllerBot,
    X,
    Threads(&'static str, Locale),
    Instagram(String, Locale),
    Youtube(String, Locale),
}

fn present(value: Option<&str>) -> bool {
    value.is_some_and(|value| !value.is_empty())
}

impl Probe {
    fn target(&self) -> &str {
        match self {
            Self::ControllerBot => "controller_bot",
            Self::X => "x",
            Self::Threads(target, _) => target,
            Self::Instagram(target, _) | Self::Youtube(target, _) => target,
        }
    }

    fn configured(&self, config: &Config) -> bool {
        match self {
            Self::ControllerBot => present(config.controller_bot_token.as_deref()),
            Self::X => [
                &config.x_client_id,
                &config.x_client_secret,
                &config.x_access_token,
                &config.x_refresh_token,
            ]
            .iter()
            .all(|value| present(value.as_deref())),
            Self::Threads(_, locale) => present(threads_credentials(config, *locale).access_token),
            Self::Instagram(_, locale) => {
                let credentials = instagram_credentials_for_locale(config, *locale);
                present(credentials.access_token) && present(credentials.user_id)
            }
            Self::Youtube(_, locale) => {
                let credentials = youtube_credentials(config, *locale);
                present(credentials.client_id)
                    && present(credentials.client_secret)
                    && present(credentials.refresh_token)
            }
        }
    }

    async fn run(&self, config: &Config, http: &HttpClient) -> Result<ProbeResult, ExternalError> {
        match self {
            Self::ControllerBot => {
                let token = config.controller_bot_token.as_deref().unwrap_or_default();
                BotApi::new(http.clone(), &config.telegram_api_base_url, token)
                    .get_me()
                    .await?;
                Ok(ProbeResult::default())
            }
            Self::X => {
                let token = config.x_access_token.as_deref().unwrap_or("undefined");
                http.request_json(
                    HttpRequest::get("https://api.x.com/2/users/me").header("Authorization", format!("Bearer {token}")),
                )
                .await?;
                Ok(ProbeResult::default())
            }
            Self::Threads(target, locale) => {
                let Some(token) = threads_credentials(config, *locale)
                    .access_token
                    .filter(|token| !token.is_empty())
                else {
                    return Err(ExternalError::message(format!("{target} credentials are missing")));
                };
                graph_me_check(
                    http,
                    target,
                    MetaOauthPlatform::Threads,
                    "graph.threads.net",
                    "v1.0",
                    "me",
                    token,
                )
                .await
            }
            Self::Instagram(target, locale) => {
                let credentials = instagram_credentials_for_locale(config, *locale);
                let (Some(token), Some(user_id)) = (
                    credentials.access_token.filter(|token| !token.is_empty()),
                    credentials.user_id.filter(|id| !id.is_empty()),
                ) else {
                    return Err(ExternalError::message(format!("{target} credentials are missing")));
                };
                graph_me_check(
                    http,
                    target,
                    MetaOauthPlatform::Instagram,
                    instagram_graph_host(token),
                    &config.instagram_graph_api_version,
                    user_id,
                    token,
                )
                .await
            }
            Self::Youtube(_, locale) => {
                let token = youtube_access_token(http, config, *locale).await?;
                http.request_json(
                    HttpRequest::get("https://www.googleapis.com/youtube/v3/channels?part=id&mine=true")
                        .header("Authorization", format!("Bearer {token}")),
                )
                .await?;
                Ok(ProbeResult::default())
            }
        }
    }
}

/// Best-effort expiry and grant lookup; its failure never turns a healthy
/// probe into a reported auth failure. Meta reports a non-expiring token as
/// `expires_at: 0`, which is not a failed lookup.
async fn debug_token(
    http: &HttpClient,
    target: &str,
    host: &str,
    version: &str,
    token: &str,
) -> (Option<String>, Option<Vec<String>>) {
    let token = foundation::js::encode_uri_component(token);
    let looked_up = async {
        let data = http
            .request_json(HttpRequest::get(format!(
                "https://{host}/{version}/debug_token?input_token={token}&access_token={token}"
            )))
            .await?;
        let expires_at = match data.pointer("/data/expires_at").and_then(Value::as_f64) {
            Some(seconds) if seconds > 0.0 => Some(
                Timestamp::from_millisecond((seconds * 1000.0).trunc() as i64)
                    .map(to_iso_string)
                    .map_err(|_| ExternalError::message("Invalid time value"))?,
            ),
            _ => None,
        };
        let scopes = data
            .pointer("/data/scopes")
            .and_then(Value::as_array)
            .map(|granted| granted.iter().filter_map(Value::as_str).map(str::to_owned).collect());
        Ok::<_, ExternalError>((expires_at, scopes))
    }
    .await;
    looked_up.unwrap_or_else(|error| {
        // graph.instagram.com refuses debug_token for Instagram Login tokens
        // without an app token: expected, and worth a breadcrumb only.
        log(
            LogLevel::Debug,
            "token debug lookup failed",
            Some(json!({"target": target, "host": host, "error": error.to_string()})),
        );
        (None, None)
    })
}

/// The permissions the connect flow asks for that the token was not granted.
fn missing_meta_scopes(platform: MetaOauthPlatform, granted: Option<Vec<String>>) -> Option<Vec<String>> {
    let granted = granted?;
    Some(
        meta_provider(platform)
            .scope
            .split(',')
            .map(str::trim)
            .filter(|scope| !scope.is_empty())
            .filter(|scope| !granted.iter().any(|granted| granted == scope))
            .map(str::to_owned)
            .collect(),
    )
}

async fn graph_me_check(
    http: &HttpClient,
    target: &str,
    platform: MetaOauthPlatform,
    host: &str,
    version: &str,
    id: &str,
    token: &str,
) -> Result<ProbeResult, ExternalError> {
    http.request_json(HttpRequest::get(format!(
        "https://{host}/{version}/{id}?fields=id&access_token={}",
        foundation::js::encode_uri_component(token)
    )))
    .await?;
    let (expires_at, scopes) = debug_token(http, target, host, version, token).await;
    Ok(ProbeResult {
        expires_at,
        missing_scopes: missing_meta_scopes(platform, scopes),
    })
}

fn probes(sqlite: &Connection) -> domain::Result<Vec<Probe>> {
    let mut probes = vec![
        Probe::ControllerBot,
        Probe::X,
        Probe::Threads("threads_ru", Locale::Ru),
        Probe::Threads("threads_en", Locale::En),
        Probe::Instagram("instagram_stories".into(), Locale::En),
        Probe::Instagram("instagram_stories_ru".into(), Locale::Ru),
    ];
    for channel in list_channels(sqlite, true)? {
        let channel = channel.connection;
        if channel.provider == "zernio" {
            continue;
        }
        let locale = if channel.locale == "en" { Locale::En } else { Locale::Ru };
        match channel.platform.as_str() {
            "youtube" => probes.push(Probe::Youtube(channel.id, locale)),
            "instagram" => probes.push(Probe::Instagram(channel.id, locale)),
            _ => {}
        }
    }
    Ok(probes)
}

fn object(value: Value) -> Map<String, Value> {
    let Value::Object(object) = value else {
        unreachable!("built as an object")
    };
    object
}

/// `checkTokenHealth`: runs the probes that are due and feeds their outcome
/// into the breaker and the expiry warnings; how many ran.
pub async fn check_token_health(
    config: &Config,
    sqlite: &Connection,
    http: &HttpClient,
    clock: &dyn Clock,
) -> domain::Result<usize> {
    let breaker = AuthCircuitBreaker::new(clock);
    let mut checked = 0;
    for probe in probes(sqlite)? {
        let target = probe.target();
        if !probe.configured(config) || !breaker.should_ping_token(sqlite, target, PING_INTERVAL_SECONDS)? {
            continue;
        }
        checked += 1;
        match probe.run(config, http).await {
            Ok(result) => {
                breaker.record_token_ping(sqlite, target, result.expires_at.as_deref(), None)?;
                breaker.record_success(sqlite, target)?;
                // A token can authenticate and still be unable to do the job;
                // the grant is checked here, not at a publish in front of an audience.
                if let Some(missing) = result.missing_scopes.filter(|missing| !missing.is_empty()) {
                    record_event(
                        sqlite,
                        clock,
                        &DomainEventInput {
                            publication_ref: None,
                            event_type: "credential.token_missing_scope".into(),
                            severity: Severity::Warn,
                            target: Some(target.into()),
                            message: format!(
                                "{target}: token is missing {}; reconnect it from Studio > Channels",
                                missing.join(", ")
                            ),
                            details: Some(object(json!({"target": target, "missingScopes": missing}))),
                            cooldown_seconds: Some(WARNING_COOLDOWN_SECONDS),
                        },
                    )?;
                }
                if let Some(expires_at) = result.expires_at
                    && parse_iso_instant(&expires_at)
                        .is_ok_and(|at| at.as_millisecond() - clock.now().as_millisecond() < EXPIRY_WARNING_WINDOW_MS)
                {
                    record_event(
                        sqlite,
                        clock,
                        &DomainEventInput {
                            publication_ref: None,
                            event_type: "credential.token_expiring_soon".into(),
                            severity: Severity::Warn,
                            target: Some(target.into()),
                            message: format!(
                                "{target}: access token expires {expires_at}; rotate it before it starts failing publishes"
                            ),
                            details: Some(object(json!({"target": target, "expiresAt": expires_at}))),
                            cooldown_seconds: Some(WARNING_COOLDOWN_SECONDS),
                        },
                    )?;
                }
            }
            Err(error) => {
                // Only 401/403 say the credential itself is dead; a network
                // hiccup or an unrelated 5xx must not pause real publishes,
                // nor consume the whole hour.
                let conclusive =
                    matches!(&error, ExternalError::Http(error) if error.status == 401 || error.status == 403);
                let backdate = (!conclusive).then_some(PING_INTERVAL_SECONDS - PING_RETRY_SECONDS);
                breaker.record_token_ping(sqlite, target, None, backdate)?;
                if conclusive {
                    breaker.record_failure(sqlite, target)?;
                }
            }
        }
    }
    Ok(checked)
}
