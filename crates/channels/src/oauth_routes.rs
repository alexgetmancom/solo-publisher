//! The browser side of connecting an account, framework-free: each route is a function
//! from the query, the command-token verdict and the Studio's state to the
//! response it answers. The HTTP slice mounts them at
//!
//! | Route | Function |
//! |---|---|
//! | `GET /oauth/{threads,instagram}/start` | [`meta_start`] |
//! | `GET /oauth/{threads,instagram}` | [`meta_callback`] |
//! | `GET /oauth/x/start` | [`x_start`] |
//! | `GET /oauth/x` | [`x_callback`] |
//! | `GET /oauth/youtube/start` | [`youtube_start`] |
//! | `GET /oauth/youtube` | [`youtube_callback`] |
//!
//! and adds what the `/oauth/*` middleware adds to every answer.

use content::Locale;
use db::rusqlite::Connection;
use domain::application::ports::{ChannelConnectionRecord, Clock};
use domain::studio::boundaries::{MetaOauthPlatform, ZernioDirectory};
use domain::studio::services::channels::{ChannelInput, ChannelService};
use foundation::config::SharedConfig;
use foundation::html::escape_html;
use foundation::logger::{LogLevel, log};
use runtime::http::HttpClient;
use serde_json::json;

use crate::entropy::Entropy;
use crate::meta::{
    exchange_meta_code, install_meta_token, meta_oauth_authorize_url, meta_oauth_state, meta_provider,
    verify_meta_oauth_state,
};
use crate::x::{exchange_x_code, x_oauth_authorize_url};
use crate::youtube::{exchange_youtube_code, youtube_oauth_authorize_url};
use crate::{Error, Result};

/// What a route answers: a redirect (`location` set, no body) or an HTML page.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct OauthResponse {
    pub status: u16,
    /// In the order the response sets them.
    pub headers: Vec<(&'static str, String)>,
    pub body: Option<String>,
}

impl OauthResponse {
    fn redirect(location: String) -> Self {
        Self {
            status: 302,
            headers: vec![("location", location), ("cache-control", "no-store".into())],
            body: None,
        }
    }

    fn page(title: &str, message: &str, status: u16) -> Self {
        let title = escape_html(title);
        Self {
            status,
            headers: vec![
                ("content-type", "text/html; charset=utf-8".into()),
                ("cache-control", "no-store".into()),
                ("x-robots-tag", "noindex, nofollow".into()),
            ],
            body: Some(format!(
                r#"<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>{title}</title><body><main><h1>{title}</h1><p>{}</p><p>You can close this page and return to the publishing bot.</p></main></body></html>"#,
                escape_html(message)
            )),
        }
    }

    /// The page a failed step answers with: `String(error)`.
    fn failure(title: &str, error: &Error) -> Self {
        Self::page(title, &format!("Error: {error}"), 400)
    }
}

/// The query parameters as the route reads them (`c.req.query(name)`): the
/// first occurrence of a name, already percent- and `+`-decoded.
#[derive(Clone, Copy, Debug)]
pub struct Query<'a>(pub &'a [(String, String)]);

impl Query<'_> {
    fn get(&self, name: &str) -> Option<&str> {
        self.0
            .iter()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.as_str())
    }

    /// `query("error_description") ?? query("error")`, read for truthiness.
    fn refusal(&self) -> Option<&str> {
        self.get("error_description")
            .or_else(|| self.get("error"))
            .filter(|refused| !refused.is_empty())
    }

    fn present(&self, name: &str) -> Option<&str> {
        self.get(name).filter(|value| !value.is_empty())
    }
}

/// Registers the account a callback connected (`studio.channels.connect`).
pub trait ChannelRegistrar {
    fn connect(&self, input: &ChannelInput) -> domain::Result<ChannelConnectionRecord>;
}

impl<Z: ZernioDirectory> ChannelRegistrar for ChannelService<'_, Z> {
    fn connect(&self, input: &ChannelInput) -> domain::Result<ChannelConnectionRecord> {
        ChannelService::connect(self, input, None)
    }
}

/// What the routes reach beyond the request.
#[derive(Clone, Copy)]
pub struct OauthContext<'a> {
    pub config: &'a SharedConfig,
    pub sqlite: &'a Connection,
    pub http: &'a HttpClient,
    pub clock: &'a dyn Clock,
    pub entropy: &'a dyn Entropy,
    pub channels: &'a dyn ChannelRegistrar,
}

const UNAUTHORIZED: &str = "Open an authorized Studio connection link";

/// `GET /oauth/{platform}/start`: a signed link redirects to the consent
/// screen; without one, an authorized operator gets a fresh state.
pub fn meta_start(
    context: OauthContext<'_>,
    platform: MetaOauthPlatform,
    query: Query<'_>,
    command_allowed: bool,
) -> OauthResponse {
    let config = context.config.load();
    let now = context.clock.now();
    let started = (|| -> Result<String> {
        let state = match query.present("state") {
            Some(state) => state.to_owned(),
            None => {
                if !command_allowed {
                    return Err(Error::message(UNAUTHORIZED));
                }
                let locale = match query.get("locale") {
                    Some("ru") => Locale::Ru,
                    Some("en") => Locale::En,
                    _ => return Err(Error::message("OAuth link has no valid locale")),
                };
                meta_oauth_state(&config, platform, locale, now, context.entropy)?
            }
        };
        let parsed = verify_meta_oauth_state(&config, &state, now)?;
        if parsed.platform != platform {
            return Err(Error::message("OAuth link names a different platform"));
        }
        meta_oauth_authorize_url(&config, &state, now)
    })();
    match started {
        Ok(location) => OauthResponse::redirect(location),
        Err(error) => OauthResponse::failure("Connection link is invalid", &error),
    }
}

/// `GET /oauth/{platform}`: the consent code becomes the stored token and a
/// registered channel.
pub async fn meta_callback(context: OauthContext<'_>, platform: MetaOauthPlatform, query: Query<'_>) -> OauthResponse {
    let provider = meta_provider(platform);
    let connected = async {
        let config = context.config.load();
        let state = query.get("state").unwrap_or_default();
        let parsed = verify_meta_oauth_state(&config, state, context.clock.now())?;
        if parsed.platform != platform {
            return Err(Error::message("OAuth callback reached the wrong platform route"));
        }
        if let Some(refused) = query.refusal() {
            return Err(Error::message(format!(
                "{} refused the authorization: {refused}",
                provider.label
            )));
        }
        let Some(code) = query.present("code") else {
            return Err(Error::message("OAuth callback has no code"));
        };
        let identity = exchange_meta_code(context.http, &config, platform, code).await?;
        install_meta_token(
            context.config,
            context.sqlite,
            &provider.token_target(parsed.locale),
            &identity.access_token,
            &identity.user_id,
            context.clock.now(),
        )?;
        let account = if identity.username.is_empty() {
            identity.user_id.clone()
        } else {
            format!("@{}", identity.username)
        };
        context
            .channels
            .connect(&provider.registry_row(parsed.locale, &identity.user_id, &account))?;
        Ok((account, parsed.locale))
    }
    .await;
    match connected {
        Ok((account, locale)) => OauthResponse::page(
            &format!("{} connected", provider.label),
            &format!("{account} is ready for {} publishing.", locale.as_str().to_uppercase()),
            200,
        ),
        Err(error) => OauthResponse::failure(&format!("{} connection failed", provider.label), &error),
    }
}

/// `GET /oauth/x/start`.
pub fn x_start(context: OauthContext<'_>, command_allowed: bool) -> OauthResponse {
    let started = if command_allowed {
        x_oauth_authorize_url(&context.config.load(), context.clock.now(), context.entropy)
    } else {
        Err(Error::message(UNAUTHORIZED))
    };
    match started {
        Ok(location) => OauthResponse::redirect(location),
        Err(error) => OauthResponse::failure("X connection link is invalid", &error),
    }
}

/// `GET /oauth/x`.
pub async fn x_callback(context: OauthContext<'_>, query: Query<'_>) -> OauthResponse {
    let connected = async {
        if let Some(refused) = query.refusal() {
            return Err(Error::message(format!("X refused the authorization: {refused}")));
        }
        let (Some(code), Some(state)) = (query.present("code"), query.present("state")) else {
            return Err(Error::message("X OAuth callback has no code or state"));
        };
        let identity = exchange_x_code(
            context.config,
            context.sqlite,
            context.http,
            code,
            state,
            context.clock.now(),
        )
        .await?;
        let account = if identity.username.is_empty() {
            identity.id.clone()
        } else {
            format!("@{}", identity.username)
        };
        context.channels.connect(&ChannelInput {
            platform: "x".into(),
            locale: Locale::En,
            provider: "native".into(),
            provider_account_id: Some(identity.id),
            target_id: Some("x".into()),
            label: Some(format!("X EN · {account}")),
            source: None,
        })?;
        Ok(account)
    }
    .await;
    match connected {
        Ok(account) => OauthResponse::page("X connected", &format!("{account} is ready for publishing."), 200),
        Err(error) => OauthResponse::failure("X connection failed", &error),
    }
}

/// `GET /oauth/youtube/start`: `locale=en` connects the English channel,
/// anything else the Russian one.
pub fn youtube_start(context: OauthContext<'_>, query: Query<'_>, command_allowed: bool) -> OauthResponse {
    let started = if command_allowed {
        let locale = if query.get("locale") == Some("en") {
            Locale::En
        } else {
            Locale::Ru
        };
        youtube_oauth_authorize_url(&context.config.load(), locale, context.clock.now(), context.entropy)
    } else {
        Err(Error::message(UNAUTHORIZED))
    };
    match started {
        Ok(location) => OauthResponse::redirect(location),
        Err(error) => OauthResponse::failure("YouTube connection link is invalid", &error),
    }
}

/// `GET /oauth/youtube`.
pub async fn youtube_callback(context: OauthContext<'_>, query: Query<'_>) -> OauthResponse {
    let connected = async {
        if let Some(refused) = query.refusal() {
            return Err(Error::message(format!("Google refused the authorization: {refused}")));
        }
        let (Some(code), Some(state)) = (query.present("code"), query.present("state")) else {
            return Err(Error::message("YouTube OAuth callback has no code or state"));
        };
        let locale = exchange_youtube_code(
            context.config,
            context.sqlite,
            context.http,
            code,
            state,
            context.clock.now(),
        )
        .await?;
        context.channels.connect(&ChannelInput {
            platform: "youtube".into(),
            locale,
            provider: "native".into(),
            provider_account_id: None,
            target_id: None,
            label: None,
            source: None,
        })?;
        // Connecting is what every later question about a credential is
        // dated from; the journal records it.
        let code = locale.as_str().to_uppercase();
        log(
            LogLevel::Info,
            "channel connected",
            Some(json!({"target": format!("youtube_{}", locale.as_str()), "account": format!("YouTube {code}")})),
        );
        Ok(code)
    }
    .await;
    match connected {
        Ok(code) => OauthResponse::page(
            &format!("YouTube {code} connected"),
            "The channel is ready for publishing and comment collection.",
            200,
        ),
        Err(error) => OauthResponse::failure("YouTube connection failed", &error),
    }
}
