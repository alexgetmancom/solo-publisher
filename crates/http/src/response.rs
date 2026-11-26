//! Response constructors every route shares
//! and the answer to a route that failed (Hono's default error handler).

use std::fmt::Display;
use std::future::Future;
use std::rc::Rc;

use axum::body::Body;
use axum::http::{HeaderValue, StatusCode, header};
use axum::response::{IntoResponse, Response};
use foundation::logger::{LogLevel, log};
use serde_json::{Value, json};

use crate::HttpState;
use crate::local::{Gone, Local};

/// A route's answer, or the failure Hono turns into a 500.
pub type HandlerResult = Result<Response, HandlerError>;

/// What a handler failed with.
#[derive(Debug)]
pub struct HandlerError(pub String);

impl<E: Display> From<E> for HandlerError {
    fn from(error: E) -> Self {
        Self(error.to_string())
    }
}

impl Display for Gone {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the request was not answered on the Studio thread")
    }
}

impl IntoResponse for HandlerError {
    fn into_response(self) -> Response {
        log(
            LogLevel::Error,
            "request handler failed",
            Some(json!({"error": self.0})),
        );
        let mut response = Response::new(Body::from("Internal Server Error"));
        *response.status_mut() = StatusCode::INTERNAL_SERVER_ERROR;
        response.headers_mut().insert(
            header::CONTENT_TYPE,
            HeaderValue::from_static("text/plain; charset=UTF-8"),
        );
        response
    }
}

/// Runs a route body on the Studio thread and answers with what it returned.
pub(crate) async fn on_local<F, W>(local: &Local, work: F) -> Response
where
    F: FnOnce(Rc<HttpState>) -> W + Send + 'static,
    W: Future<Output = HandlerResult> + 'static,
{
    match local.run(work).await {
        Ok(Ok(response)) => response,
        Ok(Err(error)) => error.into_response(),
        Err(gone) => HandlerError::from(gone).into_response(),
    }
}

/// `text(body, status)`.
pub(crate) fn text(body: impl Into<String>, status: u16) -> Response {
    with_type(Body::from(body.into()), status, "text/plain; charset=utf-8")
}

/// `json(body, status)`: `JSON.stringify` of the body.
pub(crate) fn json_response(body: &Value, status: u16) -> Response {
    with_type(
        Body::from(domain::json::stringify(body)),
        status,
        "application/json; charset=utf-8",
    )
}

pub(crate) fn not_found() -> Response {
    text("not found\n", 404)
}

pub(crate) fn with_type(body: Body, status: u16, content_type: &'static str) -> Response {
    let mut response = Response::new(body);
    *response.status_mut() = StatusCode::from_u16(status).expect("a status this crate writes");
    response
        .headers_mut()
        .insert(header::CONTENT_TYPE, HeaderValue::from_static(content_type));
    response
}

/// Sets a header whose value this crate built (ASCII).
pub(crate) fn set(response: &mut Response, name: &'static str, value: &str) {
    let value = HeaderValue::from_str(value).expect("an ASCII header value");
    response.headers_mut().insert(name, value);
}
