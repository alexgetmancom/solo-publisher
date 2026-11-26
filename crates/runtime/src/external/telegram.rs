//! The Telegram Bot API: one bot's method calls and its file endpoint, over
//! the process's [`HttpClient`].
//!
//! What stays with each caller is its policy: how parameters are encoded
//! (grammY's JSON and multipart for the bot, Bun's `FormData` for the channel
//! adapter), what is retried, and which reading of an answer it takes —
//! [`BotApi::request_json`] reads it as any provider's JSON, [`BotApi::answer`]
//! as the Bot API words it whatever the status.

use std::time::Duration;

use serde_json::{Map, Value};

use crate::http::{Body, BodyPart, ExternalError, HttpClient, HttpRequest, Response, TransportFailure};

/// How long a Telegram file download may take, body included.
pub const TELEGRAM_DOWNLOAD_TIMEOUT: Duration = Duration::from_secs(300);

/// A method call's parameters as they go on the wire.
pub struct BotParams {
    content_type: String,
    body: Body,
}

impl BotParams {
    /// A JSON body the caller already serialized.
    pub fn json(text: impl Into<String>) -> Self {
        Self {
            content_type: "application/json".into(),
            body: Body(vec![BodyPart::Bytes(text.into().into_bytes())]),
        }
    }

    /// A `multipart/form-data` body the caller already framed with `boundary`.
    pub fn multipart(boundary: &str, body: Body) -> Self {
        Self {
            content_type: format!("multipart/form-data; boundary={boundary}"),
            body,
        }
    }
}

/// A Bot API answer: `ok` with its `result`, or the refusal's code,
/// description and `parameters` (`retry_after`, `migrate_to_chat_id`).
#[derive(Clone, Debug, PartialEq)]
pub struct BotResponse {
    pub ok: bool,
    pub result: Value,
    pub error_code: i64,
    pub description: String,
    pub parameters: Map<String, Value>,
}

impl BotResponse {
    pub fn success(result: Value) -> Self {
        Self {
            ok: true,
            result,
            error_code: 0,
            description: String::new(),
            parameters: Map::new(),
        }
    }

    /// The answer's JSON, or why it is not a Bot API answer.
    fn parse(bytes: &[u8]) -> Result<Self, String> {
        let value: Value = serde_json::from_slice(bytes).map_err(|error| error.to_string())?;
        let ok = value.get("ok").and_then(Value::as_bool).ok_or("no `ok`")?;
        Ok(Self {
            ok,
            result: value.get("result").cloned().unwrap_or(Value::Null),
            error_code: value.get("error_code").and_then(Value::as_i64).unwrap_or(0),
            description: value
                .get("description")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned(),
            parameters: value
                .get("parameters")
                .and_then(Value::as_object)
                .cloned()
                .unwrap_or_default(),
        })
    }
}

/// Why [`BotApi::answer`] has no Bot API answer.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum BotCallError {
    /// The request got no answer, or its body stopped arriving.
    Network(String),
    /// What answered is not a Bot API response.
    Malformed(String),
}

/// One bot's Bot API: the API root and the token it calls with.
#[derive(Clone)]
pub struct BotApi {
    http: HttpClient,
    root: String,
    token: String,
}

impl BotApi {
    /// `root` is `TELEGRAM_API_BASE_URL`: the cloud Bot API or a local server.
    pub fn new(http: HttpClient, root: &str, token: &str) -> Self {
        Self {
            http,
            root: root.trim_end_matches('/').to_owned(),
            token: token.to_owned(),
        }
    }

    fn method_url(&self, method: &str) -> String {
        format!("{}/bot{}/{method}", self.root, self.token)
    }

    fn post(&self, method: &str, params: BotParams) -> HttpRequest {
        HttpRequest::post(self.method_url(method))
            .header("content-type", params.content_type)
            .body(params.body)
    }

    /// A call read as every provider's JSON is ([`HttpClient::request_json`]):
    /// under the default ceiling, a non-2xx answer is an
    /// [`ExternalHttpError`](crate::http::ExternalHttpError), and a 2xx one is
    /// returned whole, its `ok` for the caller to read.
    pub async fn request_json(&self, method: &str, params: BotParams) -> Result<Value, ExternalError> {
        self.http.request_json(self.post(method, params)).await
    }

    /// `getMe` as a plain GET, read as [`Self::request_json`] reads: the
    /// cheapest proof the token is still accepted.
    pub async fn get_me(&self) -> Result<Value, ExternalError> {
        self.http.request_json(HttpRequest::get(self.method_url("getMe"))).await
    }

    /// A call read as the Bot API answers it, whatever the HTTP status
    /// (Telegram words its refusals as JSON too), under `deadline` alone.
    pub async fn answer(
        &self,
        method: &str,
        params: BotParams,
        deadline: Duration,
    ) -> Result<BotResponse, BotCallError> {
        let lost = |failure: TransportFailure| BotCallError::Network(failure.message);
        let mut response = self
            .http
            .exchange(self.post(method, params).deadline(deadline))
            .await
            .map_err(lost)?;
        let mut bytes = Vec::new();
        while let Some(chunk) = response.chunk().await.map_err(lost)? {
            bytes.extend_from_slice(&chunk);
        }
        BotResponse::parse(&bytes).map_err(BotCallError::Malformed)
    }

    /// `GET <root>/file/bot<token>/<file_path>` under `deadline` alone: a file
    /// `getFile` named by a relative path (a local Bot API server answers
    /// absolute paths, which are read from disk instead).
    pub async fn download(&self, file_path: &str, deadline: Duration) -> Result<Response, TransportFailure> {
        let url = format!("{}/file/bot{}/{file_path}", self.root, self.token);
        self.http.exchange(HttpRequest::get(url).deadline(deadline)).await
    }
}
