//! What a failed adapter call was (an HTTP publish error, an ambiguous
//! publication, the Instagram container errors), and the helpers every
//! adapter reads a provider's answer through.

use std::fmt;
use std::sync::LazyLock;

use domain::publishing::errors::{PublishErrorClass, PublishFailure, classify_publish_error};
use foundation::redact::redact_external_secrets;
use jiff::Timestamp;
use regex::Regex;
use runtime::http::{ExternalError, ExternalHttpError, ExternalTransportError, Headers, Response, retry_after_seconds};
use runtime::timeout::OperationTimeoutError;
use serde_json::{Map, Value};

#[derive(Clone, Debug, PartialEq)]
pub enum AdapterError {
    /// The provider answered with a refusal (`ExternalHttpError`, and the
    /// `HttpPublishError` the publishers raise from a non-2xx response).
    Http(ExternalHttpError),
    /// Sent, no answer. Outside a publishing mutation it is an ordinary
    /// failure; inside one it becomes [`AdapterError::Ambiguous`].
    Transport(ExternalTransportError),
    /// `AmbiguousPublicationError`: a publishing call lost its answer, so the
    /// provider may have published. Never retried blindly.
    Ambiguous { provider: String, message: String },
    /// `InstagramContainerInvalidError`: the container can never be published.
    ContainerInvalid(String),
    /// `InstagramContainerProcessingError`: the container is not ready yet.
    ContainerProcessing(String),
    /// `OperationTimeoutError`.
    Timeout(String),
    /// A plain `Error` with this message.
    Message(String),
}

impl AdapterError {
    pub fn message_text(text: impl Into<String>) -> Self {
        Self::Message(text.into())
    }

    pub fn message(&self) -> &str {
        match self {
            Self::Http(error) => &error.message,
            Self::Transport(error) => &error.message,
            Self::Ambiguous { message, .. }
            | Self::ContainerInvalid(message)
            | Self::ContainerProcessing(message)
            | Self::Timeout(message)
            | Self::Message(message) => message,
        }
    }

    /// The provider's HTTP status, when the failure is its answer.
    pub fn status(&self) -> Option<u16> {
        match self {
            Self::Http(error) => Some(error.status),
            _ => None,
        }
    }

    pub fn retry_after_seconds(&self) -> Option<f64> {
        match self {
            Self::Http(error) => error.retry_after_seconds,
            _ => None,
        }
    }

    pub fn is_ambiguous(&self) -> bool {
        matches!(self, Self::Ambiguous { .. })
    }

    /// `isAmbiguousTransportFailure`: no authoritative answer arrived.
    pub fn is_transport_failure(&self) -> bool {
        matches!(self, Self::Transport(_) | Self::Timeout(_))
    }

    /// The failure as the queue records it.
    pub fn to_publish_failure(&self) -> PublishFailure {
        PublishFailure {
            message: self.message().to_owned(),
            status: self.status(),
            retry_after_seconds: self.retry_after_seconds(),
        }
    }

    /// `classifyPublishError(error)`.
    pub fn class(&self) -> PublishErrorClass {
        classify_publish_error(&self.to_publish_failure())
    }
}

impl fmt::Display for AdapterError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.message())
    }
}

impl std::error::Error for AdapterError {}

impl From<ExternalError> for AdapterError {
    fn from(error: ExternalError) -> Self {
        match error {
            ExternalError::Http(error) => Self::Http(error),
            ExternalError::Transport(error) => Self::Transport(error),
            ExternalError::Message(message) => Self::Message(message),
        }
    }
}

impl From<OperationTimeoutError> for AdapterError {
    fn from(error: OperationTimeoutError) -> Self {
        Self::Timeout(error.0)
    }
}

pub type Result<T, E = AdapterError> = std::result::Result<T, E>;

/// `new AmbiguousPublicationError(provider, cause)`.
pub fn ambiguous_error(provider: &str, cause: &str) -> AdapterError {
    AdapterError::Ambiguous {
        provider: provider.to_owned(),
        message: format!("verification_required: {provider} may have published before confirmation was lost: {cause}"),
    }
}

/// `ambiguousExternalMutation(provider, mutation)`: a lost answer to a call
/// that can reach an audience is ambiguous; any other failure stays itself.
pub async fn ambiguous_mutation<T>(provider: &str, mutation: impl Future<Output = Result<T>>) -> Result<T> {
    mutation.await.map_err(|error| {
        if error.is_transport_failure() {
            ambiguous_error(provider, error.message())
        } else {
            error
        }
    })
}

/// `httpPublishError(response, body, label)`.
pub fn http_publish_error(status: u16, headers: &Headers, body: &str, label: &str) -> AdapterError {
    let safe = redact_external_secrets(body);
    AdapterError::Http(ExternalHttpError {
        message: format!("{label} {status}: {safe}"),
        status,
        body: Some(safe),
        retry_after_seconds: retry_after_seconds(headers, Timestamp::now()),
    })
}

/// `publishJson(response, label)`: a 2xx body as JSON (empty is `{}`), any
/// other status as [`http_publish_error`].
pub async fn publish_json(response: Response, label: &str) -> Result<Value> {
    let status = response.status;
    let ok = response.ok();
    let headers = response.headers.clone();
    let body = response.text().await?;
    if !ok {
        return Err(http_publish_error(status, &headers, &body, label));
    }
    parse_json(&body)
}

/// `body ? JSON.parse(body) : {}`.
pub fn parse_json(body: &str) -> Result<Value> {
    if body.is_empty() {
        return Ok(Value::Object(Map::new()));
    }
    serde_json::from_str(body).map_err(|error| AdapterError::Message(format!("JSON Parse error: {error}")))
}

/// A non-2xx response read through `httpPublishError`, the body consumed.
pub async fn refused(response: Response, label: &str) -> AdapterError {
    let status = response.status;
    let headers = response.headers.clone();
    match response.text().await {
        Ok(body) => http_publish_error(status, &headers, &body, label),
        Err(error) => error.into(),
    }
}

static MISSING: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?i)does not exist|error_subcode\D*33|(?-u:\b)404(?-u:\b)|did not find the expected video").unwrap()
});

/// `absentIfMissing`: only the platform saying the object is gone counts as
/// absence; any other failure leaves the question unanswered.
pub fn absent_if_missing<T>(asked: Result<T>) -> Result<bool> {
    match asked {
        Ok(_) => Ok(false),
        Err(error) if MISSING.is_match(error.message()) => Ok(true),
        Err(error) => Err(AdapterError::Message(format!(
            "cannot prove the publication is absent: {}",
            error.message()
        ))),
    }
}
