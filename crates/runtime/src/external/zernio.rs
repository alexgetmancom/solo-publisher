//! The posting aggregator's API.

use domain::studio::boundaries::ZernioAccount;
use foundation::config::Config;
use serde_json::Value;

use crate::http::{ExternalError, HttpClient, HttpRequest, Method};

/// A request to `https://zernio.com/api/v1/<path>`
/// authorized with the configured key; the caller adds headers and a body.
pub fn zernio_request(config: &Config, method: Method, path: &str) -> Result<HttpRequest, ExternalError> {
    let Some(key) = config.zernio_api_key.as_deref().filter(|key| !key.is_empty()) else {
        return Err(ExternalError::message("ZERNIO_API_KEY is missing"));
    };
    Ok(HttpRequest::new(method, format!("https://zernio.com/api/v1/{path}"))
        .header("Authorization", format!("Bearer {key}")))
}

/// The account list; the API answers either a bare list or `{accounts}`.
pub async fn list_zernio_accounts(client: &HttpClient, config: &Config) -> Result<Vec<ZernioAccount>, ExternalError> {
    let response = client
        .request_json(zernio_request(config, Method::Get, "accounts")?)
        .await?;
    let accounts = match &response {
        Value::Array(accounts) => accounts.as_slice(),
        other => other
            .get("accounts")
            .and_then(Value::as_array)
            .map_or(&[][..], Vec::as_slice),
    };
    Ok(accounts.iter().map(account).collect())
}

/// One account by its id.
pub async fn zernio_account(
    client: &HttpClient,
    config: &Config,
    account_id: &str,
) -> Result<ZernioAccount, ExternalError> {
    list_zernio_accounts(client, config)
        .await?
        .into_iter()
        .find(|account| account.id.as_deref() == Some(account_id))
        .ok_or_else(|| ExternalError::message("Zernio account was not found"))
}

/// The fields Studio reads, each kept only when it has the type it is read as.
fn account(value: &Value) -> ZernioAccount {
    let text = |key: &str| value.get(key).and_then(Value::as_str).map(str::to_owned);
    ZernioAccount {
        id: text("_id"),
        username: text("username"),
        display_name: text("displayName"),
        platform: text("platform"),
        followers_count: value.get("followersCount").and_then(Value::as_f64),
    }
}
