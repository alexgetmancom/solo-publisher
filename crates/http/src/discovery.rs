//! The documents an MCP client probes before connecting to `/api/mcp`
//! (`interfaces/http/discovery.ts`). They describe this Studio, so every
//! install serves them, with or without a public site.

use axum::Router;
use axum::extract::State;
use axum::response::Response;
use axum::routing::get;
use ops::mcp::{MCP_PROTOCOL_VERSION, MCP_SERVER_NAME, MCP_SERVER_VERSION};
use serde_json::{Value, json};
use url::Url;

use crate::local::Local;
use crate::response::{HandlerResult, json_response, on_local, set};

pub(crate) fn routes() -> Router<Local> {
    Router::new()
        .route("/.well-known/oauth-protected-resource", get(protected_resource))
        .route("/.well-known/mcp/server-card.json", get(server_card))
}

/// `PUBLIC_BASE_URL` without its trailing slash.
fn origin(public_base_url: &str) -> &str {
    public_base_url.strip_suffix('/').unwrap_or(public_base_url)
}

fn cached(body: &Value) -> Response {
    let mut response = json_response(body, 200);
    set(&mut response, "cache-control", "public, max-age=3600");
    response
}

/// An operator provisions the bearer token; this Studio issues no OAuth tokens
/// and advertises no authorization server.
async fn protected_resource(State(local): State<Local>) -> Response {
    on_local(&local, |state| async move {
        let config = state.backend.config().load();
        Ok(cached(&json!({
            "resource": format!("{}/api/mcp", origin(&config.public_base_url)),
            "bearer_methods_supported": ["header"],
        })))
    })
    .await
}

/// The endpoint is the MCP transport itself.
async fn server_card(State(local): State<Local>) -> Response {
    on_local(&local, |state| async move {
        let config = state.backend.config().load();
        let host = url_host(origin(&config.public_base_url))?;
        let body = json!({
            "version": "1.0",
            "protocolVersion": MCP_PROTOCOL_VERSION,
            "capabilities": {"tools": {}},
            "serverInfo": {"name": MCP_SERVER_NAME, "version": MCP_SERVER_VERSION},
            "description": format!(
                "Operator tools for the {host} Studio. Studio tools require an operator-provisioned bearer token. Read public site content through /feed-ai.json and /llms.txt."
            ),
            "transport": {"type": "streamable-http", "endpoint": "/api/mcp"},
            "authentication": {"required": true, "schemes": ["bearer"]},
        });
        HandlerResult::Ok(cached(&body))
    })
    .await
}

/// `new URL(value).host`: the host and a non-default port.
fn url_host(value: &str) -> Result<String, String> {
    let url = Url::parse(value).map_err(|_| format!("Invalid URL: {value}"))?;
    let host = url.host_str().unwrap_or_default();
    Ok(match url.port() {
        Some(port) => format!("{host}:{port}"),
        None => host.to_owned(),
    })
}
