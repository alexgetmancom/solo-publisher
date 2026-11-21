//! The fake Telegram beneath the whole client: the Rust twin of `FakeTelegram`
//! in scripts/rust/bot-goldens/harness.ts. It records every call exactly as
//! the recorder normalises it and answers like Telegram (message ids per chat,
//! "message is not modified", no text to edit on a media message, wrong
//! file_id).

use std::cell::RefCell;
use std::collections::{BTreeMap, HashMap, VecDeque};
use std::rc::Rc;
use std::sync::LazyLock;

use bot::Fut;
use bot::api::transport::{BodyChunk, HttpRequest, Transport, TransportError};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::sync::Semaphore;

static RANDOM_QUERY: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r#"([?&](?:state|code_challenge)=)[^&\s"]+"#).unwrap());

/// The recorder's `sortKeys`: keys sorted recursively, the run's temporary
/// directory written as `<tmp>`, OAuth randomness as `<random>`.
pub fn sort_keys(value: &Value, tmp: &str) -> Value {
    match value {
        Value::Array(items) => Value::Array(items.iter().map(|item| sort_keys(item, tmp)).collect()),
        Value::Object(object) => {
            let mut keys: Vec<&String> = object.keys().collect();
            keys.sort();
            Value::Object(
                keys.into_iter()
                    .map(|key| (key.clone(), sort_keys(&object[key], tmp)))
                    .collect(),
            )
        }
        Value::String(text) => Value::String(
            RANDOM_QUERY
                .replace_all(&text.replace(tmp, "<tmp>"), "${1}<random>")
                .into_owned(),
        ),
        other => other.clone(),
    }
}

#[derive(Clone, Debug)]
struct Stored {
    message_id: i64,
    chat_id: i64,
    text: Option<String>,
    caption: Option<String>,
    media: Option<String>,
    reply_markup: Option<Value>,
    content: String,
}

/// What Telegram compares to decide an edit changes nothing.
fn content_key(message: &Stored, payload: Option<&Map<String, Value>>) -> String {
    let field = |name: &str| {
        payload
            .and_then(|payload| payload.get(name))
            .cloned()
            .unwrap_or(Value::Null)
    };
    let mut key = Map::new();
    key.insert("text".into(), message.text.clone().map_or(Value::Null, Value::String));
    key.insert("parse_mode".into(), field("parse_mode"));
    key.insert("entities".into(), field("entities"));
    key.insert(
        "reply_markup".into(),
        message.reply_markup.clone().unwrap_or(Value::Null),
    );
    Value::Object(key).to_string()
}

fn inline_markup(markup: Option<&Value>) -> Option<Value> {
    let rows = markup?.as_object()?.get("inline_keyboard")?.as_array()?;
    (!rows.is_empty()).then(|| json!({"inline_keyboard": rows}))
}

#[derive(Default)]
struct State {
    calls: Vec<Value>,
    messages: BTreeMap<(i64, i64), Stored>,
    next_id: HashMap<i64, i64>,
    files: HashMap<String, String>,
    failures: HashMap<String, VecDeque<Value>>,
    opaque_uploads: bool,
    hold: Option<String>,
    now_seconds: i64,
}

pub struct FakeTelegram {
    state: RefCell<State>,
    release: Rc<Semaphore>,
    tmp: String,
    bot_user: Value,
}

impl FakeTelegram {
    pub fn new(tmp: &str, bot_user: Value) -> Self {
        Self {
            state: RefCell::default(),
            release: Rc::new(Semaphore::new(0)),
            tmp: tmp.to_owned(),
            bot_user,
        }
    }

    /// What the recorder had in place before one step.
    pub fn prepare(&self, meta: &Value, now_seconds: i64) {
        let mut state = self.state.borrow_mut();
        state.now_seconds = now_seconds;
        state.files = meta["files"]
            .as_object()
            .map(|files| {
                files
                    .iter()
                    .map(|(id, path)| (id.clone(), path.as_str().unwrap_or_default().to_owned()))
                    .collect()
            })
            .unwrap_or_default();
        state.failures = meta["failures"]
            .as_object()
            .map(|failures| {
                failures
                    .iter()
                    .map(|(method, list)| (method.clone(), list.as_array().cloned().unwrap_or_default().into()))
                    .collect()
            })
            .unwrap_or_default();
        state.hold = meta["hold"].as_str().map(str::to_owned);
        state.opaque_uploads = meta["opaqueUploads"] == Value::Bool(true);
    }

    pub fn holds(&self) -> bool {
        self.state.borrow().hold.is_some()
    }

    /// Lets the held call answer.
    pub fn release(&self) {
        self.release.add_permits(1);
    }

    pub fn take_calls(&self) -> Vec<Value> {
        std::mem::take(&mut self.state.borrow_mut().calls)
    }

    /// An update the harness feeds: the operator's message takes its id in the
    /// chat's sequence; a tapped message nobody stored (one the recorder
    /// injected) is stored as it arrives.
    pub fn observe(&self, update: &Value) {
        let mut state = self.state.borrow_mut();
        if let Some(message) = update.get("message") {
            let chat = message["chat"]["id"].as_i64().unwrap_or_default();
            let id = message["message_id"].as_i64().unwrap_or_default();
            let next = state.next_id.entry(chat).or_default();
            *next = (*next).max(id);
        }
        if let Some(message) = update.get("callback_query").and_then(|query| query.get("message")) {
            let chat = message["chat"]["id"].as_i64().unwrap_or_default();
            let id = message["message_id"].as_i64().unwrap_or_default();
            let next = state.next_id.entry(chat).or_default();
            *next = (*next).max(id);
            state.messages.entry((chat, id)).or_insert_with(|| {
                let mut stored = Stored {
                    message_id: id,
                    chat_id: chat,
                    text: message["text"].as_str().map(str::to_owned),
                    caption: None,
                    media: None,
                    reply_markup: message.get("reply_markup").cloned(),
                    content: String::new(),
                };
                stored.content = content_key(&stored, None);
                stored
            });
        }
    }

    fn new_message_id(state: &mut State, chat: i64) -> i64 {
        let next = state.next_id.entry(chat).or_default();
        *next += 1;
        *next
    }

    fn message_json(&self, state: &State, message: &Stored) -> Value {
        let mut out = Map::new();
        out.insert("message_id".into(), message.message_id.into());
        out.insert("date".into(), state.now_seconds.into());
        out.insert(
            "chat".into(),
            json!({"id": message.chat_id, "type": "private", "first_name": "Admin"}),
        );
        out.insert("from".into(), self.bot_user.clone());
        if let Some(text) = &message.text {
            out.insert("text".into(), text.clone().into());
        }
        if let Some(caption) = &message.caption {
            out.insert("caption".into(), caption.clone().into());
        }
        match message.media.as_deref() {
            Some("photo") => {
                out.insert(
                    "photo".into(),
                    json!([{"file_id": format!("sent-photo-{}", message.message_id), "file_unique_id": "p", "width": 1, "height": 1}]),
                );
            }
            Some("video") => {
                out.insert(
                    "video".into(),
                    json!({"file_id": format!("sent-video-{}", message.message_id), "file_unique_id": "v", "width": 1, "height": 1, "duration": 1}),
                );
            }
            Some("document") => {
                out.insert(
                    "document".into(),
                    json!({"file_id": format!("sent-doc-{}", message.message_id), "file_unique_id": "d"}),
                );
            }
            _ => {}
        }
        if let Some(markup) = &message.reply_markup {
            out.insert("reply_markup".into(), markup.clone());
        }
        sort_keys(&Value::Object(out), &self.tmp)
    }

    fn store(&self, state: &mut State, chat: i64, mut message: Stored) -> Value {
        message.message_id = Self::new_message_id(state, chat);
        message.chat_id = chat;
        message.content = content_key(&message, None);
        let json = self.message_json(state, &message);
        state.messages.insert((chat, message.message_id), message);
        json
    }

    fn answer(&self, method: &str, payload: &Map<String, Value>) -> Result<Value, (i64, String)> {
        let mut state = self.state.borrow_mut();
        let chat = js_number(payload.get("chat_id"));
        let message_id = js_number(payload.get("message_id"));
        let markup = inline_markup(payload.get("reply_markup"));
        let fresh = |text: Option<String>,
                     caption: Option<String>,
                     media: Option<String>,
                     reply_markup: Option<Value>| Stored {
            message_id: 0,
            chat_id: 0,
            text,
            caption,
            media,
            reply_markup,
            content: String::new(),
        };
        let string = |value: Option<&Value>| value.map(js_string);
        match method {
            "getMe" => Ok(self.bot_user.clone()),
            "sendMessage" => {
                let message = fresh(string(payload.get("text")), None, None, markup);
                Ok(self.store(&mut state, chat, message))
            }
            "sendPhoto" | "sendVideo" | "sendDocument" | "sendAnimation" => {
                let media = method[4..].to_lowercase();
                let caption = payload
                    .get("caption")
                    .filter(|caption| !caption.is_null())
                    .map(js_string);
                let message = fresh(None, caption, Some(media), markup);
                Ok(self.store(&mut state, chat, message))
            }
            "sendMediaGroup" => {
                let items = payload
                    .get("media")
                    .and_then(Value::as_array)
                    .cloned()
                    .unwrap_or_default();
                let sent: Vec<Value> = items
                    .iter()
                    .map(|item| {
                        let caption = item.get("caption").filter(|caption| !caption.is_null()).map(js_string);
                        let message = fresh(None, caption, item.get("type").map(js_string), None);
                        self.store(&mut state, chat, message)
                    })
                    .collect();
                Ok(Value::Array(sent))
            }
            "editMessageText" => {
                let Some(stored) = state.messages.get(&(chat, message_id)).cloned() else {
                    return Err((400, "Bad Request: message to edit not found".into()));
                };
                if stored.media.is_some() {
                    return Err((400, "Bad Request: there is no text in the message to edit".into()));
                }
                let mut next = stored.clone();
                next.text = string(payload.get("text"));
                next.reply_markup = markup;
                next.content = content_key(&next, Some(payload));
                if next.content == stored.content {
                    return Err((
                        400,
                        "Bad Request: message is not modified: specified new message content and reply markup are exactly the same as a current content and reply markup of the message".into(),
                    ));
                }
                let json = self.message_json(&state, &next);
                state.messages.insert((chat, message_id), next);
                Ok(json)
            }
            "editMessageReplyMarkup" => {
                let Some(mut next) = state.messages.get(&(chat, message_id)).cloned() else {
                    return Err((400, "Bad Request: message to edit not found".into()));
                };
                next.reply_markup = markup;
                let json = self.message_json(&state, &next);
                state.messages.insert((chat, message_id), next);
                Ok(json)
            }
            "deleteMessage" => {
                state.messages.remove(&(chat, message_id));
                Ok(Value::Bool(true))
            }
            "getFile" => {
                let file_id = string(payload.get("file_id")).unwrap_or_default();
                let Some(path) = state.files.get(&file_id) else {
                    return Err((
                        400,
                        "Bad Request: wrong file_id or the file is temporarily unavailable".into(),
                    ));
                };
                let size = std::fs::metadata(path).map(|meta| meta.len()).unwrap_or_default();
                Ok(
                    json!({"file_id": file_id, "file_unique_id": format!("u-{file_id}"), "file_size": size, "file_path": path}),
                )
            }
            _ => Ok(Value::Bool(true)),
        }
    }

    fn parse(&self, request: &HttpRequest) -> (Value, bool) {
        let mut bytes = Vec::new();
        for chunk in &request.body {
            match chunk {
                BodyChunk::Bytes(data) => bytes.extend_from_slice(data),
                BodyChunk::File(path) => {
                    bytes.extend(std::fs::read(path).unwrap_or_else(|error| panic!("{}: {error}", path.display())))
                }
            }
        }
        if request.content_type.starts_with("multipart/") {
            let opaque = self.state.borrow().opaque_uploads;
            (
                multipart_payload(&bytes, &request.content_type, opaque, &self.tmp),
                true,
            )
        } else {
            let text = String::from_utf8(bytes).expect("a JSON body is UTF-8");
            let value: Value = serde_json::from_str(if text.is_empty() { "{}" } else { &text }).expect("a JSON body");
            (sort_keys(&value, &self.tmp), false)
        }
    }
}

/// JavaScript's `Number(value)` for an id that may arrive as a string.
fn js_number(value: Option<&Value>) -> i64 {
    match value {
        Some(Value::Number(number)) => number.as_i64().unwrap_or_default(),
        Some(Value::String(text)) => text.parse().unwrap_or_default(),
        _ => 0,
    }
}

/// JavaScript's `String(value)`.
fn js_string(value: &Value) -> String {
    match value {
        Value::String(text) => text.clone(),
        other => other.to_string(),
    }
}

impl Transport for FakeTelegram {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<Vec<u8>, TransportError>> {
        let (payload, multipart) = self.parse(&request);
        let method = request.method.clone();
        let mut call = Map::new();
        call.insert("method".into(), method.clone().into());
        if multipart {
            call.insert("transport".into(), "multipart".into());
        }
        call.insert("payload".into(), payload.clone());
        let held = {
            let mut state = self.state.borrow_mut();
            state.calls.push(Value::Object(call));
            if state.hold.as_deref() == Some(method.as_str()) {
                state.hold = None;
                true
            } else {
                false
            }
        };
        Box::pin(async move {
            if held {
                self.release
                    .acquire()
                    .await
                    .expect("the release semaphore stays open")
                    .forget();
            }
            let failure = self
                .state
                .borrow_mut()
                .failures
                .get_mut(&method)
                .and_then(VecDeque::pop_front);
            let response = match failure {
                Some(Value::Object(mut failure)) => {
                    failure.insert("ok".into(), false.into());
                    Value::Object(failure)
                }
                _ => match self.answer(&method, payload.as_object().expect("payloads are objects")) {
                    Ok(result) => json!({"ok": true, "result": result}),
                    Err((code, description)) => json!({"ok": false, "error_code": code, "description": description}),
                },
            };
            Ok(response.to_string().into_bytes())
        })
    }
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| index + from)
}

static NAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"name="([^"]+)""#).unwrap());
static FILENAME: LazyLock<Regex> = LazyLock::new(|| Regex::new(r#"filename=("?)([^\r\n"]*)"?"#).unwrap());
static CONTENT_TYPE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)content-type:([^\r\n]+)").unwrap());

/// The recorder's `parseMultipart` + `multipartPayload`.
fn multipart_payload(bytes: &[u8], content_type: &str, opaque: bool, tmp: &str) -> Value {
    let boundary = content_type
        .split("boundary=")
        .nth(1)
        .expect("multipart without boundary");
    let marker = format!("--{boundary}").into_bytes();
    let mut fields: Vec<(String, String)> = Vec::new();
    let mut files: HashMap<String, Value> = HashMap::new();
    let mut start = find(bytes, &marker, 0).map(|index| index + marker.len());
    while let Some(from) = start {
        let Some(end) = find(bytes, &marker, from) else { break };
        let part = &bytes[from + 2..end - 2];
        let split = find(part, b"\r\n\r\n", 0).expect("a part has headers");
        let head = String::from_utf8_lossy(&part[..split]).into_owned();
        let content = &part[split + 4..];
        let name = NAME
            .captures(&head)
            .map(|captures| captures[1].to_owned())
            .unwrap_or_default();
        match FILENAME.captures(&head) {
            Some(filename) => {
                let (sha, size) = if opaque {
                    (json!("<sqlite backup>"), json!("<sqlite backup>"))
                } else {
                    (json!(format!("{:x}", Sha256::digest(content))), json!(content.len()))
                };
                let content_type = CONTENT_TYPE
                    .captures(&head)
                    .map(|captures| captures[1].trim().to_owned())
                    .unwrap_or_default();
                files.insert(
                    name,
                    json!({"file": {"name": filename[2].to_owned(), "contentType": content_type, "sha256": sha, "size": size}}),
                );
            }
            None => fields.push((name, String::from_utf8_lossy(content).into_owned())),
        }
        start = Some(end + marker.len());
    }
    fn attach(value: Value, files: &HashMap<String, Value>) -> Value {
        match value {
            Value::String(text) => match text.strip_prefix("attach://").and_then(|id| files.get(id)) {
                Some(file) => file.clone(),
                None => Value::String(text),
            },
            Value::Array(items) => Value::Array(items.into_iter().map(|item| attach(item, files)).collect()),
            Value::Object(object) => Value::Object(
                object
                    .into_iter()
                    .map(|(key, item)| (key, attach(item, files)))
                    .collect(),
            ),
            other => other,
        }
    }
    let mut payload = Map::new();
    for (name, value) in fields {
        let parsed = if value.starts_with("attach://") {
            attach(Value::String(value), &files)
        } else if value.starts_with('{') || value.starts_with('[') {
            attach(serde_json::from_str(&value).expect("a JSON field"), &files)
        } else {
            Value::String(value)
        };
        payload.insert(name, parsed);
    }
    sort_keys(&Value::Object(payload), tmp)
}
