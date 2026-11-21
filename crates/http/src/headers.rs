//! Request headers as `request.headers.get(name)` returns them.

use axum::http::HeaderMap;

/// Every value of `name`, each byte read as Latin-1 (a WHATWG `ByteString`),
/// joined with `", "`; `None` when the request has none.
pub(crate) fn header(headers: &HeaderMap, name: &str) -> Option<String> {
    let values: Vec<String> = headers
        .get_all(name)
        .iter()
        .map(|value| value.as_bytes().iter().map(|&byte| char::from(byte)).collect())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}
