//! The terminal fallback that trades a
//! Threads consent code for the long-lived token, when the browser callback
//! is unavailable. The code is single-use and lives an hour, so it is
//! exchanged at once.

use channels::meta::{exchange_meta_code, meta_authorize_url, meta_oauth_redirect_uri};
use content::Locale;
use domain::studio::boundaries::MetaOauthPlatform;
use foundation::config::Config;
use runtime::http::HttpClient;
use serde_json::{Value, json};

use crate::context::{OpError, Terminal};

/// `authorizationCode`: whatever the operator copied out of the browser —
/// the bare code or the whole address, with or without Meta's trailing `#_`.
pub(super) fn authorization_code(pasted: &str) -> Result<String, OpError> {
    let trimmed = foundation::js::trim(pasted);
    let trimmed = trimmed.strip_suffix("#_").unwrap_or(trimmed);
    if trimmed.is_empty() {
        return Err(OpError::failed(
            "Nothing was pasted. Approve the consent screen and copy the address it lands on.",
        ));
    }
    if !trimmed.contains("://") {
        return Ok(trimmed.to_owned());
    }
    let url = url::Url::parse(trimmed).map_err(|_| OpError::failed("Invalid URL"))?;
    let param = |name: &str| {
        url.query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    };
    // Cancelling redirects to the same place with an explanation.
    if let Some(denied) = param("error_description").or_else(|| param("error")) {
        return Err(OpError::failed(format!(
            "Threads refused the authorization: {}",
            denied.replace('+', " ")
        )));
    }
    param("code").ok_or_else(|| {
        OpError::failed("That URL carries no code parameter. Copy the address the consent screen redirected to.")
    })
}

pub(super) async fn authorize_threads(
    config: &Config,
    locale: Locale,
    terminal: &dyn Terminal,
    http: &HttpClient,
) -> Result<Value, OpError> {
    let present = |value: &Option<String>| value.as_deref().is_some_and(|value| !value.is_empty());
    if !present(&config.threads_app_id) || !present(&config.threads_app_secret) {
        return Err(OpError::failed(
            "Set THREADS_APP_ID and THREADS_APP_SECRET first. Both are in App Dashboard > App settings > Basic, under Threads App ID and Threads App secret — not the Meta app's own id and secret.",
        ));
    }
    let channel_error = |error: channels::error::Error| OpError::failed(error.to_string());
    let redirect_uri = meta_oauth_redirect_uri(config, MetaOauthPlatform::Threads);
    let authorize_url = meta_authorize_url(config, MetaOauthPlatform::Threads, None).map_err(channel_error)?;
    // This link deliberately carries no signed state, so the callback refuses
    // it and leaves the single-use code unspent for the exchange below.
    terminal.print_line(&format!(
        "Open this and approve it as the account you publish from:\n{authorize_url}\n\nIt redirects to {redirect_uri}, which will report that the connection failed — that is expected on this path and the code is still good. Copy the whole address from the address bar.\n"
    ))?;
    let code = authorization_code(&terminal.ask("Address the consent screen redirected to: "))?;
    let authorization = exchange_meta_code(http, config, MetaOauthPlatform::Threads, &code)
        .await
        .map_err(channel_error)?;
    let suffix = if locale == Locale::En { "EN" } else { "RU" };
    Ok(json!({
        "locale": locale.as_str(),
        "variable": format!("THREADS_{suffix}_ACCESS_TOKEN"),
        "accessToken": authorization.access_token,
        "userId": authorization.user_id,
        "note": "Terminal fallback: put this in .env and restart. The normal browser callback stores and activates it automatically.",
    }))
}
