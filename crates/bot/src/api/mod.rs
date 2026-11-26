//! The Telegram Bot API client: grammY's `Api` with the transformer stack
//! the bot installs, in this order:
//!
//! 1. the unchanged-edit guard (outermost),
//! 2. `@grammyjs/auto-retry` with `{ maxRetryAttempts: 3, maxDelaySeconds: 30,
//!    rethrowInternalServerErrors: true }`,
//! 3. the API timing, around every attempt,
//!
//! and then the encoding grammY does (JSON, or multipart when a file is
//! attached) onto a [`Transport`].

pub mod payload;
pub mod transport;
pub mod types;

use std::cell::RefCell;
use std::fmt;
use std::rc::Rc;
use std::time::{Duration, Instant};

use indexmap::IndexMap;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};

use crate::tap;
use payload::{Payload, multipart_value, upload_filename, wire_json};
use transport::{BodyChunk, HttpRequest, Transport};
use types::{File, Message, Update, User};

/// How many messages the guard remembers the contents of.
const REMEMBERED_MESSAGES: usize = 200;
const MAX_RETRY_ATTEMPTS: u32 = 3;
const MAX_RETRY_DELAY_SECONDS: f64 = 30.0;
const INITIAL_BACKOFF_SECONDS: f64 = 3.0;
const MAX_BACKOFF_SECONDS: f64 = 3600.0;

/// A failed call, worded as grammY words it: these texts reach the operator
/// through `describeError` and the logs through `String(error)`.
#[derive(Clone, Debug, PartialEq)]
pub enum ApiError {
    /// `GrammyError`: Telegram answered `ok: false`.
    Telegram(Box<TelegramFailure>),
    /// `HttpError`: the request got no answer.
    Network { method: String, detail: String },
    /// The answer was not a Bot API response.
    Malformed { method: String, detail: String },
    /// A `reply_markup` menu nobody rendered: a bug of the caller.
    UnrenderedMenu { method: String, menu: &'static str },
}

/// What Telegram said when it refused a call.
#[derive(Clone, Debug, PartialEq)]
pub struct TelegramFailure {
    pub method: String,
    pub error_code: i64,
    pub description: String,
    pub parameters: Map<String, Value>,
}

impl ApiError {
    /// `String(error)`: the class name, then the message.
    pub fn js_string(&self) -> String {
        let name = match self {
            Self::Telegram(_) => "GrammyError",
            Self::Network { .. } => "HttpError",
            Self::Malformed { .. } => "SyntaxError",
            Self::UnrenderedMenu { .. } => "Error",
        };
        format!("{name}: {self}")
    }

    pub fn error_code(&self) -> Option<i64> {
        match self {
            Self::Telegram(failure) => Some(failure.error_code),
            _ => None,
        }
    }

    pub fn retry_after(&self) -> Option<f64> {
        match self {
            Self::Telegram(failure) => failure.parameters.get("retry_after").and_then(Value::as_f64),
            _ => None,
        }
    }
}

impl fmt::Display for ApiError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Telegram(failure) => write!(
                f,
                "Call to '{}' failed! ({}: {})",
                failure.method, failure.error_code, failure.description
            ),
            Self::Network { method, .. } => write!(f, "Network request for '{method}' failed!"),
            Self::Malformed { method, detail } => write!(f, "Malformed answer to '{method}': {detail}"),
            Self::UnrenderedMenu { menu, .. } => write!(
                f,
                "Cannot send menu '{menu}'! Did you forget to use bot.use() for it or try to send it through bot.api?"
            ),
        }
    }
}

impl std::error::Error for ApiError {}

/// `isUnchangedMessageEdit`: Telegram refused an edit that changes nothing.
/// The match is on Telegram's prose, so it lives in one place.
pub fn is_unchanged_message_edit(error: &(dyn std::error::Error + 'static)) -> bool {
    error.to_string().contains("message is not modified")
}

/// A Bot API response before grammY turns `ok: false` into an error.
#[derive(Clone, Debug, PartialEq)]
struct Response {
    ok: bool,
    result: Value,
    error_code: i64,
    description: String,
    parameters: Map<String, Value>,
}

impl Response {
    fn success(result: Value) -> Self {
        Self {
            ok: true,
            result,
            error_code: 0,
            description: String::new(),
            parameters: Map::new(),
        }
    }

    fn parse(method: &str, bytes: &[u8]) -> Result<Self, ApiError> {
        let malformed = |detail: String| ApiError::Malformed {
            method: method.to_owned(),
            detail,
        };
        let value: Value = serde_json::from_slice(bytes).map_err(|error| malformed(error.to_string()))?;
        let ok = value
            .get("ok")
            .and_then(Value::as_bool)
            .ok_or_else(|| malformed("no `ok`".into()))?;
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

/// The guard's memory: what each recently written message shows.
#[derive(Default)]
struct EditMemory {
    contents: IndexMap<String, String>,
}

impl EditMemory {
    fn remember(&mut self, key: String, content: String) {
        self.contents.shift_remove(&key);
        self.contents.insert(key, content);
        while self.contents.len() > REMEMBERED_MESSAGES {
            self.contents.shift_remove_index(0);
        }
    }
}

/// The message a payload writes to, or none when it names no single one.
fn message_key(payload: &Map<String, Value>) -> Option<String> {
    let chat = match payload.get("chat_id")? {
        Value::Number(number) => number.to_string(),
        Value::String(text) => text.clone(),
        _ => return None,
    };
    let message = payload.get("message_id")?.as_i64()?;
    Some(format!("{chat}:{message}"))
}

/// What a message will show, addressed apart from where it lives
/// (`JSON.stringify` of the payload without `chat_id` and `message_id`).
fn content_of(payload: &Map<String, Value>) -> String {
    let rest: Map<String, Value> = payload
        .iter()
        .filter(|(key, _)| *key != "chat_id" && *key != "message_id")
        .map(|(key, value)| (key.clone(), value.clone()))
        .collect();
    Value::Object(rest).to_string()
}

struct Inner {
    transport: Rc<dyn Transport>,
    memory: RefCell<EditMemory>,
}

/// One bot's API handle; clones share the transport and the guard's memory.
#[derive(Clone)]
pub struct Api {
    inner: Rc<Inner>,
}

impl Api {
    pub fn new(transport: Rc<dyn Transport>) -> Self {
        Self {
            inner: Rc::new(Inner {
                transport,
                memory: RefCell::default(),
            }),
        }
    }

    /// One call through the whole stack. A menu in the payload must already be
    /// rendered (the update context does that).
    pub async fn call(&self, method: &str, payload: Payload) -> Result<Value, ApiError> {
        let json = payload.to_json().map_err(|menu| ApiError::UnrenderedMenu {
            method: method.to_owned(),
            menu,
        })?;
        let response = self.guarded(method, &payload, &json).await?;
        if response.ok {
            Ok(response.result)
        } else {
            Err(ApiError::Telegram(Box::new(TelegramFailure {
                method: method.to_owned(),
                error_code: response.error_code,
                description: response.description,
                parameters: response.parameters,
            })))
        }
    }

    pub async fn call_as<T: DeserializeOwned>(&self, method: &str, payload: Payload) -> Result<T, ApiError> {
        let value = self.call(method, payload).await?;
        serde_json::from_value(value).map_err(|error| ApiError::Malformed {
            method: method.to_owned(),
            detail: error.to_string(),
        })
    }

    /// The unchanged-edit guard (`installUnchangedEditGuard`).
    async fn guarded(&self, method: &str, payload: &Payload, json: &Map<String, Value>) -> Result<Response, ApiError> {
        let key = message_key(json);
        if let Some(key) = key.as_ref()
            && method == "editMessageText"
        {
            let content = content_of(json);
            if self.inner.memory.borrow().contents.get(key) == Some(&content) {
                tap::record_unchanged_edit();
                return Ok(Response::success(Value::Bool(true)));
            }
            let response = self.retried(method, payload, json).await?;
            if response.ok {
                self.inner.memory.borrow_mut().remember(key.clone(), content);
            }
            return Ok(response);
        }
        if let Some(key) = key.as_ref() {
            self.inner.memory.borrow_mut().contents.shift_remove(key);
        }
        let response = self.retried(method, payload, json).await?;
        if method == "sendMessage" && response.ok {
            let chat = response.result.get("chat").and_then(|chat| chat.get("id"));
            let message = response.result.get("message_id");
            if let (Some(chat), Some(message)) = (chat, message) {
                let chat = chat.as_str().map_or_else(|| chat.to_string(), str::to_owned);
                self.inner
                    .memory
                    .borrow_mut()
                    .remember(format!("{chat}:{message}"), content_of(json));
            }
        }
        Ok(response)
    }

    /// `@grammyjs/auto-retry`: a network failure is retried with backoff for as
    /// long as it lasts; a `retry_after` of at most 30 s is waited out, up to
    /// three more attempts; a 5xx is returned as it is (a retried 500 can send
    /// the same message twice).
    async fn retried(&self, method: &str, payload: &Payload, json: &Map<String, Value>) -> Result<Response, ApiError> {
        let mut remaining = MAX_RETRY_ATTEMPTS;
        let mut next_delay = INITIAL_BACKOFF_SECONDS;
        loop {
            let response = loop {
                match self.timed(method, payload, json).await {
                    Ok(response) => break response,
                    Err(ApiError::Network { .. }) => {
                        tokio::time::sleep(Duration::from_secs_f64(next_delay)).await;
                        next_delay = MAX_BACKOFF_SECONDS.min(next_delay + next_delay);
                    }
                    Err(other) => return Err(other),
                }
            };
            let retry_after = response.parameters.get("retry_after").and_then(Value::as_f64);
            let Some(retry_after) = retry_after.filter(|seconds| *seconds <= MAX_RETRY_DELAY_SECONDS) else {
                return Ok(response);
            };
            tokio::time::sleep(Duration::from_secs_f64(retry_after.max(0.0))).await;
            next_delay = INITIAL_BACKOFF_SECONDS;
            if response.ok || remaining == 0 {
                return Ok(response);
            }
            remaining -= 1;
        }
    }

    /// `installApiTiming`: every attempt is billed to the update making it.
    async fn timed(&self, method: &str, payload: &Payload, json: &Map<String, Value>) -> Result<Response, ApiError> {
        let started = Instant::now();
        let response = self.raw(method, payload, json).await;
        tap::record_api_call(method, started.elapsed().as_secs_f64() * 1000.0);
        response
    }

    async fn raw(&self, method: &str, payload: &Payload, json: &Map<String, Value>) -> Result<Response, ApiError> {
        let request = encode(method, payload, json);
        let bytes = self
            .inner
            .transport
            .send(request)
            .await
            .map_err(|error| ApiError::Network {
                method: method.to_owned(),
                detail: error.0,
            })?;
        Response::parse(method, &bytes)
    }

    // ---- the methods the bot calls, shaped as grammY's `Api` shapes them ----

    pub async fn get_me(&self) -> Result<User, ApiError> {
        self.call_as("getMe", Payload::new()).await
    }

    /// The runner's long poll: `{ timeout: 30, offset, limit }`.
    pub async fn get_updates(&self, offset: i64, limit: u32, timeout_seconds: u32) -> Result<Vec<Update>, ApiError> {
        let payload = Payload::new()
            .set("timeout", timeout_seconds)
            .set("offset", offset)
            .set("limit", limit);
        self.call_as("getUpdates", payload).await
    }

    pub async fn set_my_commands(&self, commands: &[(&str, &str)]) -> Result<Value, ApiError> {
        let commands: Vec<Value> = commands
            .iter()
            .map(|(command, description)| json!({"command": command, "description": description}))
            .collect();
        self.call("setMyCommands", Payload::new().set("commands", commands))
            .await
    }

    /// `{ chat_id, text, ...other }`.
    pub async fn send_message(&self, chat_id: i64, text: &str, other: Payload) -> Result<Message, ApiError> {
        let payload = Payload::new().set("chat_id", chat_id).set("text", text).extend(other);
        self.call_as("sendMessage", payload).await
    }

    /// `{ chat_id, message_id, text, ...other }`; the answer is the edited
    /// message, or `true` when the guard answered from memory.
    pub async fn edit_message_text(
        &self,
        chat_id: i64,
        message_id: i64,
        text: &str,
        other: Payload,
    ) -> Result<Value, ApiError> {
        let payload = Payload::new()
            .set("chat_id", chat_id)
            .set("message_id", message_id)
            .set("text", text)
            .extend(other);
        self.call("editMessageText", payload).await
    }

    pub async fn answer_callback_query(&self, callback_query_id: &str, other: Payload) -> Result<Value, ApiError> {
        let payload = Payload::new().set("callback_query_id", callback_query_id).extend(other);
        self.call("answerCallbackQuery", payload).await
    }

    pub async fn get_file(&self, file_id: &str) -> Result<File, ApiError> {
        self.call_as("getFile", Payload::new().set("file_id", file_id)).await
    }

    /// The bytes of a file `getFile` named by a relative path, past no
    /// transformer: it is the file endpoint, not a method.
    pub async fn download_file(
        &self,
        file_path: &str,
        max_bytes: u64,
        timeout: Duration,
    ) -> Result<transport::Downloaded, transport::TransportError> {
        self.inner.transport.download(file_path, max_bytes, timeout).await
    }

    /// `{ chat_id, <key>: file, ...other }` for `sendPhoto`, `sendVideo`,
    /// `sendDocument` and `sendAnimation`.
    pub async fn send_file(
        &self,
        method: &str,
        chat_id: i64,
        key: &str,
        file: FileSource,
        other: Payload,
    ) -> Result<Message, ApiError> {
        let payload = file.into_field(Payload::new().set("chat_id", chat_id), key);
        self.call_as(method, payload.extend(other)).await
    }
}

/// A file to send: uploaded from here, or one Telegram already holds.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum FileSource {
    Upload(payload::InputFile),
    Id(String),
}

impl FileSource {
    /// Sets `key` on `payload` to this file.
    pub fn into_field(self, payload: Payload, key: &str) -> Payload {
        match self {
            Self::Upload(file) => payload.file(key, file),
            Self::Id(id) => payload.set(key, id),
        }
    }
}

/// A random-enough multipart boundary (`"----------" + randomId(32)`).
fn boundary() -> String {
    const ALPHABET: &[u8] = b"0123456789abcdefghijklmnopqrstuvwxyz";
    let mut bytes = [0u8; 32];
    getrandom::getrandom(&mut bytes).expect("the system has randomness");
    let id: String = bytes
        .iter()
        .map(|byte| ALPHABET[usize::from(*byte) % ALPHABET.len()] as char)
        .collect();
    format!("----------{id}")
}

/// grammY's `createJsonPayload` / `createFormDataPayload`.
fn encode(method: &str, payload: &Payload, json: &Map<String, Value>) -> HttpRequest {
    if payload.uploads().is_empty() {
        return HttpRequest {
            method: method.to_owned(),
            content_type: "application/json".into(),
            body: vec![BodyChunk::Bytes(wire_json(&Value::Object(json.clone())).into_bytes())],
        };
    }
    let boundary = boundary();
    let mut body = vec![BodyChunk::Bytes(format!("--{boundary}\r\n").into_bytes())];
    let separator = format!("\r\n--{boundary}\r\n");
    let mut first = true;
    for (key, value) in json {
        let Some(text) = multipart_value(value) else { continue };
        if !first {
            body.push(BodyChunk::Bytes(separator.clone().into_bytes()));
        }
        body.push(BodyChunk::Bytes(
            format!("content-disposition:form-data;name=\"{key}\"\r\n\r\n{text}").into_bytes(),
        ));
        first = false;
    }
    for upload in payload.uploads() {
        if !first {
            body.push(BodyChunk::Bytes(separator.clone().into_bytes()));
        }
        body.push(BodyChunk::Bytes(
            format!(
                "content-disposition:form-data;name=\"{}\";filename={}\r\ncontent-type:application/octet-stream\r\n\r\n",
                upload.id,
                upload_filename(upload)
            )
            .into_bytes(),
        ));
        body.push(match &upload.file {
            payload::InputFile::Path(path) => BodyChunk::File(path.clone()),
            payload::InputFile::Bytes { data, .. } => BodyChunk::Bytes(data.clone()),
        });
        first = false;
    }
    body.push(BodyChunk::Bytes(format!("\r\n--{boundary}--\r\n").into_bytes()));
    HttpRequest {
        method: method.to_owned(),
        content_type: format!("multipart/form-data; boundary={boundary}"),
        body,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Fut;
    use transport::TransportError;

    /// Answers from a script and records what it was asked.
    struct Scripted {
        answers: RefCell<Vec<Value>>,
        seen: RefCell<Vec<(String, String)>>,
    }

    impl Transport for Scripted {
        fn send(&self, request: HttpRequest) -> Fut<'_, Result<Vec<u8>, TransportError>> {
            let body: Vec<u8> = request
                .body
                .iter()
                .flat_map(|chunk| match chunk {
                    BodyChunk::Bytes(bytes) => bytes.clone(),
                    BodyChunk::File(_) => b"<file>".to_vec(),
                })
                .collect();
            self.seen
                .borrow_mut()
                .push((request.method, String::from_utf8_lossy(&body).into_owned()));
            let answer = self.answers.borrow_mut().remove(0);
            Box::pin(async move { Ok(answer.to_string().into_bytes()) })
        }

        fn download(&self, _: &str, _: u64, _: Duration) -> Fut<'_, Result<transport::Downloaded, TransportError>> {
            unreachable!("the client tests download nothing")
        }
    }

    fn scripted(answers: Vec<Value>) -> (Api, Rc<Scripted>) {
        let transport = Rc::new(Scripted {
            answers: RefCell::new(answers),
            seen: RefCell::default(),
        });
        (Api::new(transport.clone()), transport)
    }

    fn run<F: Future>(future: F) -> F::Output {
        tokio::runtime::Builder::new_current_thread()
            .enable_time()
            .start_paused(true)
            .build()
            .unwrap()
            .block_on(future)
    }

    fn sent(message_id: i64) -> Value {
        json!({"ok": true, "result": {"message_id": message_id, "date": 0, "chat": {"id": 1, "type": "private"}}})
    }

    #[test]
    fn the_guard_skips_an_edit_the_message_already_shows() {
        let not_modified =
            json!({"ok": false, "error_code": 400, "description": "Bad Request: message is not modified"});
        let (api, transport) = scripted(vec![sent(5), json!({"ok": true, "result": true}), not_modified]);
        run(async {
            api.send_message(1, "a", Payload::new()).await.unwrap();
            // Identical to what was sent: answered from memory.
            assert_eq!(
                api.edit_message_text(1, 5, "a", Payload::new()).await.unwrap(),
                Value::Bool(true)
            );
            api.edit_message_text(1, 5, "b", Payload::new()).await.unwrap();
            // Another write to the message makes the memory unusable.
            let error = api
                .call(
                    "editMessageReplyMarkup",
                    Payload::new().set("chat_id", 1).set("message_id", 5),
                )
                .await
                .unwrap_err();
            assert!(is_unchanged_message_edit(&error));
            assert_eq!(
                error.js_string(),
                "GrammyError: Call to 'editMessageReplyMarkup' failed! (400: Bad Request: message is not modified)"
            );
        });
        let methods: Vec<String> = transport
            .seen
            .borrow()
            .iter()
            .map(|(method, _)| method.clone())
            .collect();
        assert_eq!(methods, ["sendMessage", "editMessageText", "editMessageReplyMarkup"]);
        assert_eq!(transport.seen.borrow()[0].1, r#"{"chat_id":1,"text":"a"}"#);
    }

    #[test]
    fn a_short_rate_limit_is_waited_out_three_times_at_most() {
        let limited = json!({"ok": false, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 2}});
        let (api, transport) = scripted(vec![limited.clone(); 4]);
        let error = run(api.send_message(1, "a", Payload::new())).unwrap_err();
        assert_eq!(error.error_code(), Some(429));
        assert_eq!(transport.seen.borrow().len(), 4);

        let long = json!({"ok": false, "error_code": 429, "description": "Too Many Requests", "parameters": {"retry_after": 31}});
        let (api, transport) = scripted(vec![long]);
        run(api.send_message(1, "a", Payload::new())).unwrap_err();
        assert_eq!(transport.seen.borrow().len(), 1);

        let internal = json!({"ok": false, "error_code": 500, "description": "Internal Server Error"});
        let (api, transport) = scripted(vec![internal]);
        run(api.send_message(1, "a", Payload::new())).unwrap_err();
        assert_eq!(transport.seen.borrow().len(), 1);
    }

    #[test]
    fn files_go_as_multipart_with_grammy_parts() {
        let (api, transport) = scripted(vec![sent(1)]);
        let photo = payload::InputFile::Bytes {
            data: b"JPEG".to_vec(),
            filename: None,
        };
        run(api.send_file(
            "sendPhoto",
            1,
            "photo",
            FileSource::Upload(photo),
            Payload::new().set("caption", "c"),
        ))
        .unwrap();
        let body = transport.seen.borrow()[0].1.clone();
        let id = body
            .split("attach://")
            .nth(1)
            .unwrap()
            .split('\r')
            .next()
            .unwrap()
            .to_owned();
        let boundary = body.lines().next().unwrap().to_owned();
        assert_eq!(
            body,
            format!(
                "{boundary}\r\ncontent-disposition:form-data;name=\"chat_id\"\r\n\r\n1\r\n{boundary}\r\ncontent-disposition:form-data;name=\"photo\"\r\n\r\nattach://{id}\r\n{boundary}\r\ncontent-disposition:form-data;name=\"caption\"\r\n\r\nc\r\n{boundary}\r\ncontent-disposition:form-data;name=\"{id}\";filename=photo.jpg\r\ncontent-type:application/octet-stream\r\n\r\nJPEG\r\n{boundary}--\r\n"
            )
        );
    }
}
