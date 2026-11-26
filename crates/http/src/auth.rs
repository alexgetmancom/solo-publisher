//! Who may call an operator route: the command
//! center token, and the Studio bearer token that names an actor.

use axum::http::{HeaderMap, Method, Uri};
use foundation::config::Config;
use subtle::ConstantTimeEq as _;

use crate::headers::header;
use crate::uri::{Target, decode_uri_component};

/// Whether the request carries the command center token from the payload, the
/// `X-Command-Token` or `X-Admin-Token` header, `?token=` (only on GET and
/// HEAD: a URL survives in proxy logs, Referer headers and history, so it may
/// open safe reads only) or the `command_token` cookie, compared in constant
/// time.
pub fn command_allowed(
    method: &Method,
    uri: &Uri,
    headers: &HeaderMap,
    config: &Config,
    payload_token: Option<&str>,
) -> bool {
    let Some(expected) = config.command_center_token.as_deref().filter(|token| !token.is_empty()) else {
        return false;
    };
    let safe = ["GET", "HEAD"]
        .iter()
        .any(|name| method.as_str().eq_ignore_ascii_case(name));
    let query = if safe {
        Target::of(uri).query_param("token")
    } else {
        None
    };
    let token = [
        payload_token.map(|token| foundation::js::trim(token).to_owned()),
        header(headers, "x-command-token"),
        header(headers, "x-admin-token"),
        query,
        Some(cookie_value(header(headers, "cookie").as_deref(), "command_token")),
    ]
    .into_iter()
    .flatten()
    .find(|token| !token.is_empty())
    .unwrap_or_default();
    safe_equal(&token, expected)
}

/// The first cookie called `name`, percent-decoded; a value that does not
/// decode (a truncated or hand-edited cookie) is compared as it is, so it fails
/// authorization rather than the request.
fn cookie_value(cookie_header: Option<&str>, name: &str) -> String {
    for chunk in cookie_header.unwrap_or_default().split(';') {
        let mut parts = foundation::js::trim(chunk).split('=');
        if parts.next() == Some(name) {
            let value = parts.collect::<Vec<_>>().join("=");
            return decode_uri_component(&value).unwrap_or(value);
        }
    }
    String::new()
}

/// The actor the request's `Bearer` token authorizes, when
/// Studio access is configured and the token matches.
pub fn mcp_studio_actor(headers: &HeaderMap, config: &Config) -> Option<i64> {
    let authorization = header(headers, "authorization").unwrap_or_default();
    let token = authorization.strip_prefix("Bearer ").unwrap_or_default();
    let expected = config.mcp_studio_token.as_deref()?;
    let actor = config.mcp_studio_actor_id?;
    safe_equal(token, expected).then_some(actor)
}

fn safe_equal(left: &str, right: &str) -> bool {
    !left.is_empty()
        && !right.is_empty()
        && left.len() == right.len()
        && bool::from(left.as_bytes().ct_eq(right.as_bytes()))
}
