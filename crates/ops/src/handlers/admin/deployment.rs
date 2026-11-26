//! What every target
//! the deploy agent drives is running, and what it would roll back to. A read,
//! so it is not retried: a deployment question asked twice during a rollout
//! answers differently. Promote and rollback are `bot::deployment`.

use std::time::Duration;

use foundation::config::Config;
use runtime::http::{HttpClient, HttpRequest};
use serde_json::{Value, json};

fn failed(message: impl Into<String>) -> Value {
    json!({"ok": false, "message": message.into()})
}

pub async fn read_deployment_releases(config: &Config, http: &HttpClient) -> Value {
    let url = config.deploy_agent_url.as_deref().filter(|url| !url.is_empty());
    let token = config.deploy_agent_token.as_deref().filter(|token| !token.is_empty());
    let (Some(url), Some(token)) = (url, token) else {
        return failed("Deployment agent is not configured.");
    };
    let base = url.strip_suffix('/').unwrap_or(url);
    let request = HttpRequest::get(format!("{base}/v1/releases"))
        .header("authorization", format!("Bearer {token}"))
        .deadline(Duration::from_secs(10));
    let Ok(response) = http.exchange(request).await else {
        return failed("Deployment agent is unavailable.");
    };
    let status = response.status;
    let ok = response.ok();
    // `response.json().catch(() => null)`.
    let body: Value = match response.bytes().await {
        Ok(bytes) => serde_json::from_slice(&bytes).unwrap_or(Value::Null),
        Err(_) => Value::Null,
    };
    if ok && body.get("ok") == Some(&Value::Bool(true)) {
        return body;
    }
    match body.get("message").and_then(Value::as_str) {
        Some(message) if body.get("ok") == Some(&Value::Bool(false)) => failed(message),
        _ => failed(format!("Request failed ({status}).")),
    }
}
