//! What a failed publish attempt was, and what a provider's answer means for
//! the job that made it.

use std::sync::LazyLock;

use foundation::json::id_text;
use foundation::time::iso_at;
use regex::Regex;
use serde_json::{Map, Value};

use super::boundaries::Jitter;
use crate::json;

const TRANSIENT_STATUS_CODES: [u16; 7] = [408, 425, 429, 500, 502, 503, 504];
/// 401/403 are split out of the permanent bucket: they mean "this credential
/// is dead", which the credential breaker needs to tell apart.
const AUTH_STATUS_CODES: [u16; 2] = [401, 403];
const PERMANENT_STATUS_CODES: [u16; 5] = [400, 404, 409, 410, 422];
/// The platform refused what the post contains. Repeating the call repeats
/// the refusal exactly; only editing the post changes the outcome.
const CONTENT_STATUS_CODES: [u16; 2] = [413, 415];

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PublishErrorClass {
    Transient,
    Permanent,
    Content,
    Auth,
    Unknown,
}

impl PublishErrorClass {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Transient => "transient",
            Self::Permanent => "permanent",
            Self::Content => "content",
            Self::Auth => "auth",
            Self::Unknown => "unknown",
        }
    }
}

/// A failed attempt as the queue sees it: the message, the provider's HTTP
/// status when there was one, and the delay it asked for.
#[derive(Clone, Debug, PartialEq)]
pub struct PublishFailure {
    pub message: String,
    pub status: Option<u16>,
    pub retry_after_seconds: Option<f64>,
}

impl PublishFailure {
    pub fn new(message: impl Into<String>) -> Self {
        Self {
            message: message.into(),
            status: None,
            retry_after_seconds: None,
        }
    }

    /// A provider's failed HTTP response (`HttpPublishError`).
    pub fn http(message: impl Into<String>, status: u16, retry_after_seconds: Option<f64>) -> Self {
        Self {
            message: message.into(),
            status: Some(status),
            retry_after_seconds,
        }
    }
}

pub fn classify_publish_error(error: &PublishFailure) -> PublishErrorClass {
    classify(error.status, &error.message)
}

/// The class of an error known only by its text (`classifyPublishError(string | null)`).
pub fn classify_message(text: Option<&str>) -> PublishErrorClass {
    classify(None, text.unwrap_or(""))
}

/// `classifyPublishError` of a value a provider result carried.
fn classify_value(value: &Value) -> PublishErrorClass {
    match value {
        Value::Null => classify(None, ""),
        Value::Object(object) => classify(
            object
                .get("status")
                .and_then(Value::as_f64)
                .filter(|status| status.fract() == 0.0 && (0.0..=f64::from(u16::MAX)).contains(status))
                .map(|status| status as u16),
            "",
        ),
        other => classify(None, &error_text(other)),
    }
}

/// A flag of an adapter's answer, read as the queue has always read it: any
/// truthy JSON value (`true`, a non-zero number, a non-empty string, an
/// array or object). A publication an answer calls done must never read as
/// undone, because undone is retried and a second post is worse than an
/// unclear status.
pub fn result_flag(value: Option<&Value>) -> bool {
    match value {
        None | Some(Value::Null) => false,
        Some(Value::Bool(flag)) => *flag,
        Some(Value::Number(number)) => number.as_f64().is_some_and(|number| number != 0.0),
        Some(Value::String(text)) => !text.is_empty(),
        Some(Value::Array(_) | Value::Object(_)) => true,
    }
}

/// A result's `error` as the text a row records: a string as it is, anything
/// else as its JSON.
pub fn error_text(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

fn classify(status: Option<u16>, message: &str) -> PublishErrorClass {
    if let Some(status) = status {
        if TRANSIENT_STATUS_CODES.contains(&status) {
            return PublishErrorClass::Transient;
        }
        if AUTH_STATUS_CODES.contains(&status) {
            return PublishErrorClass::Auth;
        }
        if CONTENT_STATUS_CODES.contains(&status) {
            return PublishErrorClass::Content;
        }
        if PERMANENT_STATUS_CODES.contains(&status) {
            return PublishErrorClass::Permanent;
        }
    }
    let text = message.to_lowercase();
    // The worker stopped waiting for an external call. A late provider success
    // must never create a duplicate publication, so it is not retried.
    if text.contains("delivery_execution_timeout") {
        return PublishErrorClass::Permanent;
    }
    // The breaker short-circuited a call to a known-dead credential: keep the
    // job on its normal backoff until the breaker clears.
    if text.contains("auth_circuit_open") {
        return PublishErrorClass::Transient;
    }
    if matches_markers(
        &text,
        &["timeout", "timed out", "temporarily", "connection reset", "network"],
        &STATUS_502_503_504_429,
    ) {
        return PublishErrorClass::Transient;
    }
    if matches_markers(&text, &["unauthorized", "forbidden", "invalid token"], &STATUS_401_403) {
        return PublishErrorClass::Auth;
    }
    if matches_markers(
        &text,
        &[
            "_too_long",
            "too large",
            "request entity too large",
            "payload too large",
            "not_translated",
        ],
        &[],
    ) {
        return PublishErrorClass::Content;
    }
    if matches_markers(&text, &["permission", "unsupported", "validation"], &STATUS_400) {
        return PublishErrorClass::Permanent;
    }
    PublishErrorClass::Unknown
}

/// A bare status code matches only as a standalone number (`(?<!\d)code(?!\d)`).
fn standalone(code: &str) -> Regex {
    Regex::new(&format!(r"(?:^|[^0-9]){code}(?:[^0-9]|$)")).unwrap()
}

static STATUS_502_503_504_429: LazyLock<Vec<Regex>> =
    LazyLock::new(|| ["502", "503", "504", "429"].map(standalone).to_vec());
static STATUS_401_403: LazyLock<Vec<Regex>> = LazyLock::new(|| ["401", "403"].map(standalone).to_vec());
static STATUS_400: LazyLock<Vec<Regex>> = LazyLock::new(|| vec![standalone("400")]);

/// Phrases match anywhere, but bare status codes only as standalone numbers:
/// an error message that embeds 429 in an id must not reclassify the failure.
fn matches_markers(text: &str, phrases: &[&str], codes: &[Regex]) -> bool {
    phrases.iter().any(|phrase| text.contains(phrase)) || codes.iter().any(|code| code.is_match(text))
}

/// When the next attempt is due. A provider that said how long it wants
/// silence is honoured, capped by the same ceiling; otherwise the exponential
/// curve with full jitter, so retries scheduled by one failure event do not all
/// land on the provider in the same instant.
pub fn next_retry_at(
    attempt_count: u32,
    base_seconds: u64,
    max_seconds: u64,
    now_ms: i64,
    retry_after_seconds: Option<f64>,
    jitter: &dyn Jitter,
) -> String {
    if let Some(seconds) = retry_after_seconds {
        return iso_at(now_ms + (seconds.min(max_seconds as f64) * 1000.0) as i64);
    }
    let delay = (max_seconds as f64).min(base_seconds as f64 * 2f64.powi(attempt_count.saturating_sub(1) as i32));
    let jittered = delay * (0.5 + jitter.unit() * 0.5);
    iso_at(now_ms + (jittered * 1000.0) as i64)
}

/// What a delivery adapter answers about one attempt: an open record, kept as
/// the adapter wrote it because it is journalled and stored verbatim.
///
/// Fields the queue reads: `ok`, `skipped`, `id`, `ids`, `url`, `error`,
/// `reason`, `retryable`, `partial` with `resumeKey`, `deferred` with
/// `progressKey`/`progressValue`/`retryAfterMs`/`resumeKey`/`resumeValue`/
/// `state`, `verification.status` and `raw.existingPost`.
pub type PublishResult = Map<String, Value>;

/// A provider answer reduced to what the target row records.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct NormalizedResult {
    pub status: &'static str,
    pub external_id: Option<String>,
    pub external_ids: Option<Vec<String>>,
    pub url: Option<String>,
    pub error: Option<String>,
    pub skipped: i64,
    pub raw_json: String,
}

pub fn normalize_publish_result(record: &PublishResult) -> NormalizedResult {
    let mut result = record.clone();
    let ok = result_flag(result.get("ok"));
    let skipped = result_flag(result.get("skipped"));
    let status = if ok {
        "published"
    } else if skipped {
        "skipped"
    } else {
        "failed"
    };
    let ids: Option<Vec<String>> = result
        .get("ids")
        .and_then(Value::as_array)
        .map(|ids| ids.iter().filter_map(id_text).collect());
    let mut external_id = result.get("id").and_then(id_text);
    let url = result.get("url").and_then(Value::as_str).map(str::to_owned);
    if external_id.as_deref().is_none_or(str::is_empty)
        && let Some(first) = ids.as_ref().and_then(|ids| ids.first())
    {
        external_id = Some(first.clone());
    }
    if external_id.as_deref().is_none_or(str::is_empty)
        && let Some(url) = url.as_ref().filter(|url| !url.is_empty())
    {
        external_id = Some(url.clone());
    }
    let error = result
        .get("error")
        .filter(|error| !error.is_null())
        .or_else(|| result.get("reason").filter(|reason| !reason.is_null()))
        .cloned();
    if !ok && !skipped && result.get("retryable").is_none_or(Value::is_null) {
        let transient = classify_value(error.as_ref().unwrap_or(&Value::Null)) == PublishErrorClass::Transient;
        result.insert("retryable".into(), Value::Bool(transient));
    }
    NormalizedResult {
        status,
        url: url.or_else(|| external_id.clone().filter(|id| id.starts_with("http"))),
        external_id,
        external_ids: ids,
        error: error.as_ref().map(error_text),
        skipped: i64::from(skipped),
        raw_json: json::stringify_object(&result),
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn a_truthy_ok_settles_as_published() {
        for ok in [json!(true), json!(1), json!("true"), json!("yes"), json!({}), json!([])] {
            let result = json!({"ok": ok, "id": "7"}).as_object().unwrap().clone();
            assert_eq!(normalize_publish_result(&result).status, "published", "{ok}");
        }
        for ok in [json!(false), json!(0), json!(""), Value::Null] {
            assert!(!result_flag(Some(&ok)), "{ok}");
        }
        assert!(!result_flag(None));
    }
}
