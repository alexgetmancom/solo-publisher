//! Calls to other providers: a fetch with its 30 s ceiling, the JSON request
//! helper, the two error kinds callers tell apart, and the redaction that keeps
//! tokens out of every message they carry.
//!
//! Every platform adapter goes through an [`HttpClient`] built over a
//! [`Transport`]: production hands it [`ReqwestTransport`], a test a transport
//! that records the request and answers it.

mod transport;

use std::fmt;
use std::path::Path;
use std::rc::Rc;
use std::sync::LazyLock;
use std::time::{Duration, Instant};

use foundation::js;
use foundation::redact::redact_external_secrets;
use jiff::Timestamp;
use regex::Regex;
use serde_json::{Map, Value};
use tokio::io::AsyncWriteExt as _;
pub use transport::{
    Body, BodyPart, BufferedBody, Fut, Headers, HttpRequest, HttpResponse, Method, ReqwestTransport, ResponseBody,
    Transport, TransportFailure,
};

/// The default ceiling on a fetch.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(30);

/// The provider answered, and the answer is a failure: a non-2xx status, or a
/// 2xx whose body is not the JSON asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct ExternalHttpError {
    pub message: String,
    pub status: u16,
    /// Redacted.
    pub body: Option<String>,
    /// How long the provider asked to wait (`Retry-After`, `X-RateLimit-Reset`).
    pub retry_after_seconds: Option<f64>,
}

/// A request was sent but no authoritative HTTP response was received. After a
/// publishing call this is the ambiguous case: the provider may have acted.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ExternalTransportError {
    pub message: String,
    /// What the transport said, unredacted text never placed in `message`.
    pub cause: String,
}

#[derive(Clone, Debug, PartialEq)]
pub enum ExternalError {
    Http(ExternalHttpError),
    Transport(ExternalTransportError),
    /// A refusal that is a plain error with this message.
    Message(String),
}

impl ExternalError {
    pub fn message(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }
}

impl fmt::Display for ExternalError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::Http(error) => &error.message,
            Self::Transport(error) => &error.message,
            Self::Message(message) => message,
        })
    }
}

impl std::error::Error for ExternalError {}

/// Where the wait on other providers is accounted (the bot's tap
/// measurement). Work outside an update has no account, and a client built
/// without one counts nothing.
pub trait CallTiming {
    /// One finished provider call, failed ones included.
    fn provider_call(&self, duration_ms: f64);
    /// The body of a call already counted.
    fn provider_body_read(&self, duration_ms: f64);
    /// A Telegram call no Bot API client sees.
    fn telegram_call(&self, method: &str, duration_ms: f64);
}

/// The one way out of the process to another provider.
#[derive(Clone)]
pub struct HttpClient {
    transport: Rc<dyn Transport>,
    timing: Option<Rc<dyn CallTiming>>,
}

impl HttpClient {
    pub fn new(transport: Rc<dyn Transport>) -> Self {
        Self {
            transport,
            timing: None,
        }
    }

    /// The same client, its calls billed to `timing`.
    pub fn timed_by(&self, timing: Rc<dyn CallTiming>) -> Self {
        Self {
            transport: Rc::clone(&self.transport),
            timing: Some(timing),
        }
    }

    pub(crate) fn timing(&self) -> Option<&dyn CallTiming> {
        self.timing.as_deref()
    }

    /// A fetch under the 30 s default ceiling.
    pub async fn fetch(&self, request: HttpRequest) -> Result<Response, ExternalError> {
        self.fetch_within(request, DEFAULT_TIMEOUT).await
    }

    /// A fetch under `ceiling`. The ceiling ends at
    /// the response headers, so a body is read at the caller's pace; the
    /// request's own `deadline` keeps holding over both.
    pub async fn fetch_within(&self, request: HttpRequest, ceiling: Duration) -> Result<Response, ExternalError> {
        let label = label(&request);
        let started = Instant::now();
        let outcome = tokio::time::timeout(ceiling, self.transport.send(request)).await;
        // Every provider this process calls comes through here, so a tap that
        // waits on one can say so. A failed request is still a wait.
        if let Some(timing) = &self.timing {
            timing.provider_call(elapsed_ms(started));
        }
        match outcome {
            Err(_) => Err(ExternalError::Transport(ExternalTransportError {
                message: format!("{label} timed out after {}s", ceiling.as_millis().div_ceil(1000)),
                cause: "the request was aborted".into(),
            })),
            Ok(Err(failure)) => Err(ExternalError::Transport(ExternalTransportError {
                message: format!("{label} failed before receiving an HTTP response"),
                cause: failure.message,
            })),
            Ok(Ok(response)) => Ok(Response::new(response, label, self.timing.clone())),
        }
    }

    /// The bare call a few callers make: no ceiling but the
    /// request's own deadline, no provider accounting, the failure as the
    /// transport reported it.
    pub async fn exchange(&self, request: HttpRequest) -> Result<Response, TransportFailure> {
        let label = label(&request);
        let response = self.transport.send(request).await?;
        Ok(Response::new(response, label, None))
    }

    /// The body of a 2xx as JSON (an empty body is `{}`);
    /// anything else is an [`ExternalHttpError`] with the body redacted.
    pub async fn request_json(&self, request: HttpRequest) -> Result<Value, ExternalError> {
        let response = self.fetch(request).await?;
        let status = response.status;
        let ok = response.ok();
        let headers = response.headers.clone();
        let label = response.label.clone();
        let body = response.text().await?;
        if !ok {
            let redacted = redact_external_secrets(&body);
            return Err(ExternalError::Http(ExternalHttpError {
                message: format!("{label} failed: {status} {redacted}"),
                status,
                body: Some(redacted),
                retry_after_seconds: retry_after_seconds(&headers, Timestamp::now()),
            }));
        }
        if body.is_empty() {
            return Ok(Value::Object(Map::new()));
        }
        serde_json::from_str(&body).map_err(|_| {
            // A proxy error page reaches here as HTML. The raw parse error
            // would carry the unredacted body into logs.
            let redacted = redact_external_secrets(&body);
            ExternalError::Http(ExternalHttpError {
                message: format!("{label} returned a non-JSON body: {}", js::slice_utf16(&redacted, 200)),
                status,
                body: Some(redacted),
                retry_after_seconds: None,
            })
        })
    }
}

fn label(request: &HttpRequest) -> String {
    format!("{} {}", request.method.as_str(), safe_url(&request.url))
}

fn elapsed_ms(started: Instant) -> f64 {
    started.elapsed().as_secs_f64() * 1000.0
}

/// A response whose body is still to be read.
pub struct Response {
    pub status: u16,
    pub headers: Headers,
    body: Box<dyn ResponseBody>,
    /// `<METHOD> <redacted url>`, for the messages of failed reads.
    label: String,
    timing: Option<Rc<dyn CallTiming>>,
}

impl Response {
    fn new(response: HttpResponse, label: String, timing: Option<Rc<dyn CallTiming>>) -> Self {
        Self {
            status: response.status,
            headers: response.headers,
            body: response.body,
            label,
            timing,
        }
    }

    /// `response.ok`.
    pub fn ok(&self) -> bool {
        (200..300).contains(&self.status)
    }

    pub async fn bytes(mut self) -> Result<Vec<u8>, ExternalError> {
        let started = Instant::now();
        let mut bytes = Vec::new();
        let read = loop {
            match self.body.next_chunk().await {
                Ok(Some(chunk)) => bytes.extend_from_slice(&chunk),
                Ok(None) => break Ok(()),
                Err(failure) => break Err(failure),
            }
        };
        self.read_finished(started, read)?;
        Ok(bytes)
    }

    /// `response.text()`: UTF-8 with replacement. Bun keeps a leading BOM.
    pub async fn text(self) -> Result<String, ExternalError> {
        Ok(String::from_utf8_lossy(&self.bytes().await?).into_owned())
    }

    /// Streams the body into a new file at `path` (`Bun.write(path, response)`).
    pub async fn save(mut self, path: &Path) -> Result<(), ExternalError> {
        let started = Instant::now();
        let written = async {
            let mut file = tokio::fs::File::create(path)
                .await
                .map_err(|error| ExternalError::message(error.to_string()))?;
            loop {
                match self.body.next_chunk().await {
                    Ok(Some(chunk)) => file
                        .write_all(&chunk)
                        .await
                        .map_err(|error| ExternalError::message(error.to_string()))?,
                    Ok(None) => break,
                    Err(failure) => return Err(self.read_failed(failure)),
                }
            }
            file.flush()
                .await
                .map_err(|error| ExternalError::message(error.to_string()))
        }
        .await;
        if let Some(timing) = &self.timing {
            timing.provider_body_read(elapsed_ms(started));
        }
        written
    }

    fn read_finished(&self, started: Instant, read: Result<(), TransportFailure>) -> Result<(), ExternalError> {
        // The read is where the wait for the body is, so that is where it is
        // measured, against the call that fetched it.
        if let Some(timing) = &self.timing {
            timing.provider_body_read(elapsed_ms(started));
        }
        read.map_err(|failure| self.read_failed(failure))
    }

    /// A body that stopped arriving is a response that never fully came: the
    /// provider may have acted, so it is a transport error. (The reader's own
    /// error must not pass through: nothing could tell it apart from a refusal.)
    fn read_failed(&self, failure: TransportFailure) -> ExternalError {
        ExternalError::Transport(ExternalTransportError {
            message: format!("{} failed while reading the HTTP response", self.label),
            cause: failure.message,
        })
    }
}

/// Reads `Retry-After` (seconds or an HTTP date) or `X-RateLimit-Reset` (unix
/// seconds), so a 429/503 retry waits exactly as long as the provider asked
/// instead of guessing with a fixed backoff.
pub fn retry_after_seconds(headers: &Headers, now: Timestamp) -> Option<f64> {
    let now_ms = now.as_millisecond() as f64;
    if let Some(retry_after) = headers.get("retry-after").filter(|value| !value.is_empty()) {
        let seconds = js::number(&retry_after);
        if seconds.is_finite() {
            return Some(non_negative(seconds));
        }
        if let Some(date_ms) = parse_date(&retry_after) {
            return Some(non_negative(js_round((date_ms - now_ms) / 1000.0)));
        }
    }
    // `Number(null)` is 0: an absent header is no reset.
    let reset = headers.get("x-ratelimit-reset").map_or(0.0, |value| js::number(&value));
    (reset.is_finite() && reset > 0.0).then(|| non_negative(js_round(reset - now_ms / 1000.0)))
}

/// `Math.max(0, value)`, with JavaScript's `-0` read as the `0` it prints.
fn non_negative(value: f64) -> f64 {
    if value > 0.0 { value } else { 0.0 }
}

/// `Math.round`: halves round up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// The `Date.parse` forms a `Retry-After` date takes: the HTTP date
/// (RFC 7231's IMF-fixdate, an RFC 2822 date) or an ISO instant.
fn parse_date(value: &str) -> Option<f64> {
    let value = js::trim(value);
    let parsed = jiff::fmt::rfc2822::parse(value)
        .map(|zoned| zoned.timestamp())
        .or_else(|_| value.parse::<Timestamp>());
    parsed.ok().map(|at| at.as_millisecond() as f64)
}

static BOT_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/bot[^/]+").unwrap());

/// The URL as messages may show it: credential query values and a Bot API
/// token path segment replaced. Setting a query value re-serializes the whole
/// query, as `URLSearchParams.set` does.
fn safe_url(value: &str) -> String {
    let Ok(mut url) = url::Url::parse(value) else {
        return redact_external_secrets(value);
    };
    let mut pairs: Vec<(String, String)> = url.query_pairs().into_owned().collect();
    let mut changed = false;
    for key in ["access_token", "token", "api_key", "api-key", "password"] {
        let Some(first) = pairs.iter().position(|(name, _)| name == key) else {
            continue;
        };
        pairs[first].1 = "[REDACTED]".into();
        let mut index = 0;
        pairs.retain(|(name, _)| {
            index += 1;
            index - 1 == first || name != key
        });
        changed = true;
    }
    if changed {
        url.query_pairs_mut().clear().extend_pairs(&pairs);
    }
    // An opaque path (`mailto:`) has no segments; `pathname =` leaves it.
    if !url.cannot_be_a_base() {
        let path = url.path().to_owned();
        let redacted = BOT_PATH.replacen(&path, 1, "/bot[REDACTED]");
        if redacted != path {
            url.set_path(&redacted);
        }
    }
    url.into()
}

/// Absent values skipped, the rest encoded as
/// `application/x-www-form-urlencoded`.
pub fn form_body(fields: &[(&str, Option<&str>)]) -> String {
    let mut body = url::form_urlencoded::Serializer::new(String::new());
    for (key, value) in fields {
        if let Some(value) = value {
            body.append_pair(key, value);
        }
    }
    body.finish()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn safe_url_keeps_unrelated_queries_untouched() {
        assert_eq!(
            safe_url("https://example.com/a?b=c%20d&e"),
            "https://example.com/a?b=c%20d&e"
        );
        assert_eq!(
            safe_url("https://example.com/a?token=x&b=c%20d"),
            "https://example.com/a?token=%5BREDACTED%5D&b=c+d"
        );
    }
}
