//! What one Bot API call carries, built the way grammY builds it.
//!
//! A payload is an ordered list of fields, because grammY's own payloads are
//! JavaScript objects: `{ chat_id, text, ...other }`. Telegram ignores the order,
//! but the unchanged-edit guard compares the serialised payload, so two payloads
//! that grammY would serialise differently must serialise differently here too.
//! Build options in the order the call site spells them.

use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Map, Value};

use crate::menu::MenuId;

/// One field's value: JSON, or a menu the update renders before sending
/// (`reply_markup: menu` in grammY, rendered by the menu plugin's transformer).
#[derive(Clone, Debug, PartialEq)]
pub enum Field {
    Json(Value),
    Menu(MenuId),
}

impl<T: Into<Value>> From<T> for Field {
    fn from(value: T) -> Self {
        Self::Json(value.into())
    }
}

/// A file to upload (`InputFile`): a local path, or bytes with an optional name.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum InputFile {
    Path(PathBuf),
    Bytes { data: Vec<u8>, filename: Option<String> },
}

impl InputFile {
    pub fn path(path: impl Into<PathBuf>) -> Self {
        Self::Path(path.into())
    }

    /// grammY's `guessFilename`: a path names itself, bare bytes name nothing.
    pub fn filename(&self) -> Option<String> {
        match self {
            Self::Path(path) => path.file_name().map(|name| name.to_string_lossy().into_owned()),
            Self::Bytes { filename, .. } => filename.clone(),
        }
    }
}

/// A file attached to a payload, referenced from it as `attach://<id>`.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Upload {
    pub id: String,
    /// The property the file sits under (`photo`, `document`), or the media
    /// type for an item of a media group: grammY names an unnamed file after it.
    pub origin: String,
    pub file: InputFile,
}

#[derive(Clone, Debug, Default, PartialEq)]
pub struct Payload {
    entries: Vec<(String, Field)>,
    uploads: Vec<Upload>,
}

static ATTACH_IDS: AtomicU64 = AtomicU64::new(0);

impl Payload {
    pub fn new() -> Self {
        Self::default()
    }

    /// Sets a field. An existing field keeps its position, as a later key of a
    /// JavaScript object spread does.
    pub fn set(mut self, key: &str, value: impl Into<Field>) -> Self {
        self.insert(key, value.into());
        self
    }

    pub fn insert(&mut self, key: &str, value: Field) {
        match self.entries.iter_mut().find(|(name, _)| name == key) {
            Some((_, slot)) => *slot = value,
            None => self.entries.push((key.to_owned(), value)),
        }
    }

    /// `parse_mode: "Markdown"` (legacy Markdown, the only mode the bot uses).
    pub fn markdown(self) -> Self {
        self.set("parse_mode", "Markdown")
    }

    pub fn reply_markup(self, markup: impl Into<Field>) -> Self {
        self.set("reply_markup", markup)
    }

    /// A file as a top-level field (`photo`, `document`, `video`).
    pub fn file(mut self, key: &str, file: InputFile) -> Self {
        let reference = self.attach(key, file);
        self.set(key, reference)
    }

    /// Registers a file and returns the `attach://` reference to embed in a
    /// JSON field (the items of `sendMediaGroup`).
    pub fn attach(&mut self, origin: &str, file: InputFile) -> String {
        let id = format!("f{}", ATTACH_IDS.fetch_add(1, Ordering::Relaxed));
        let reference = format!("attach://{id}");
        self.uploads.push(Upload {
            id,
            origin: origin.to_owned(),
            file,
        });
        reference
    }

    /// `{ ...this, ...other }`.
    pub fn extend(mut self, other: Payload) -> Self {
        for (key, value) in other.entries {
            self.insert(&key, value);
        }
        self.uploads.extend(other.uploads);
        self
    }

    pub fn get(&self, key: &str) -> Option<&Field> {
        self.entries
            .iter()
            .find(|(name, _)| name == key)
            .map(|(_, value)| value)
    }

    pub fn get_json(&self, key: &str) -> Option<&Value> {
        match self.get(key) {
            Some(Field::Json(value)) => Some(value),
            _ => None,
        }
    }

    pub fn contains(&self, key: &str) -> bool {
        self.get(key).is_some()
    }

    pub fn entries(&self) -> &[(String, Field)] {
        &self.entries
    }

    pub fn entries_mut(&mut self) -> impl Iterator<Item = &mut Field> {
        self.entries.iter_mut().map(|(_, value)| value)
    }

    pub fn uploads(&self) -> &[Upload] {
        &self.uploads
    }

    /// The payload as one JSON object; a menu left unrendered is a bug of the
    /// caller, reported by its id.
    pub fn to_json(&self) -> Result<Map<String, Value>, MenuId> {
        let mut map = Map::new();
        for (key, value) in &self.entries {
            match value {
                Field::Json(value) => {
                    map.insert(key.clone(), value.clone());
                }
                Field::Menu(id) => return Err(*id),
            }
        }
        Ok(map)
    }
}

/// grammY's `InlineKeyboard`: rows of buttons, a button added to the last row.
#[derive(Clone, Debug, PartialEq)]
pub struct InlineKeyboard {
    rows: Vec<Vec<Value>>,
}

impl Default for InlineKeyboard {
    fn default() -> Self {
        Self { rows: vec![Vec::new()] }
    }
}

impl InlineKeyboard {
    pub fn new() -> Self {
        Self::default()
    }

    /// `text(label, data)`: `{ text, callback_data }`.
    pub fn text(mut self, label: impl Into<String>, data: impl Into<String>) -> Self {
        self.add(button(label.into(), "callback_data", data.into()));
        self
    }

    /// `url(label, url)`: `{ text, url }`.
    pub fn url(mut self, label: impl Into<String>, url: impl Into<String>) -> Self {
        self.add(button(label.into(), "url", url.into()));
        self
    }

    /// `row()`: starts a new row (a trailing call leaves an empty one, as grammY does).
    pub fn row(mut self) -> Self {
        self.rows.push(Vec::new());
        self
    }

    pub fn add(&mut self, button: Value) {
        self.rows.last_mut().expect("a keyboard has a row").push(button);
    }

    pub fn rows(&self) -> &[Vec<Value>] {
        &self.rows
    }
}

fn button(text: String, key: &str, value: String) -> Value {
    let mut object = Map::new();
    object.insert("text".into(), text.into());
    object.insert(key.into(), value.into());
    Value::Object(object)
}

impl From<InlineKeyboard> for Value {
    fn from(keyboard: InlineKeyboard) -> Self {
        let mut object = Map::new();
        object.insert(
            "inline_keyboard".into(),
            Value::Array(keyboard.rows.into_iter().map(Value::Array).collect()),
        );
        Value::Object(object)
    }
}

/// grammY's `Keyboard` (a reply keyboard) as the bot builds it.
#[derive(Clone, Debug, PartialEq)]
pub struct Keyboard {
    rows: Vec<Vec<Value>>,
    resized: bool,
    persistent: bool,
}

impl Default for Keyboard {
    fn default() -> Self {
        Self {
            rows: vec![Vec::new()],
            resized: false,
            persistent: false,
        }
    }
}

impl Keyboard {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn text(mut self, label: impl Into<String>) -> Self {
        let mut object = Map::new();
        object.insert("text".into(), label.into().into());
        self.rows
            .last_mut()
            .expect("a keyboard has a row")
            .push(Value::Object(object));
        self
    }

    pub fn resized(mut self) -> Self {
        self.resized = true;
        self
    }

    pub fn persistent(mut self) -> Self {
        self.persistent = true;
        self
    }
}

impl From<Keyboard> for Value {
    fn from(keyboard: Keyboard) -> Self {
        let mut object = Map::new();
        object.insert(
            "keyboard".into(),
            Value::Array(keyboard.rows.into_iter().map(Value::Array).collect()),
        );
        if keyboard.resized {
            object.insert("resize_keyboard".into(), true.into());
        }
        if keyboard.persistent {
            object.insert("is_persistent".into(), true.into());
        }
        Value::Object(object)
    }
}

/// grammY's `str`: JSON with object members whose value is null left out
/// (array items stay), which is what goes on the wire.
pub fn wire_json(value: &Value) -> String {
    fn strip(value: &Value) -> Value {
        match value {
            Value::Object(map) => Value::Object(
                map.iter()
                    .filter(|(_, item)| !item.is_null())
                    .map(|(key, item)| (key.clone(), strip(item)))
                    .collect(),
            ),
            Value::Array(items) => Value::Array(items.iter().map(strip).collect()),
            other => other.clone(),
        }
    }
    strip(value).to_string()
}

/// A multipart field value as grammY writes it: strings raw, numbers and
/// booleans as JavaScript prints them, objects as wire JSON.
pub fn multipart_value(value: &Value) -> Option<String> {
    match value {
        Value::Null => None,
        Value::String(text) => Some(text.clone()),
        Value::Bool(flag) => Some(flag.to_string()),
        Value::Number(number) => Some(number.to_string()),
        other => Some(wire_json(other)),
    }
}

/// grammY's `getExt`: the extension of a file named after its property.
pub fn default_extension(origin: &str) -> &'static str {
    match origin {
        "certificate" => "pem",
        "photo" | "thumbnail" => "jpg",
        "voice" => "ogg",
        "audio" => "mp3",
        "animation" | "video" | "video_note" => "mp4",
        "sticker" => "webp",
        _ => "dat",
    }
}

/// The name an upload goes by in the form: its own, or `<origin>.<ext>`.
pub fn upload_filename(upload: &Upload) -> String {
    upload
        .file
        .filename()
        .filter(|name| !name.is_empty())
        .unwrap_or_else(|| format!("{}.{}", upload.origin, default_extension(&upload.origin)))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn set_keeps_the_position_of_an_existing_key() {
        let payload = Payload::new().set("a", 1).set("b", 2).set("a", 3);
        assert_eq!(
            Value::Object(payload.to_json().unwrap()).to_string(),
            r#"{"a":3,"b":2}"#
        );
    }

    #[test]
    fn keyboards_serialise_like_grammy() {
        let keyboard = InlineKeyboard::new()
            .text("A", "a")
            .text("B", "b")
            .row()
            .url("C", "https://c");
        assert_eq!(
            Value::from(keyboard),
            json!({"inline_keyboard": [[{"text": "A", "callback_data": "a"}, {"text": "B", "callback_data": "b"}], [{"text": "C", "url": "https://c"}]]})
        );
        assert_eq!(
            Value::from(InlineKeyboard::new().text("A", "a").row()),
            json!({"inline_keyboard": [[{"text": "A", "callback_data": "a"}], []]})
        );
    }

    #[test]
    fn wire_json_drops_object_nulls_only() {
        assert_eq!(
            wire_json(&json!({"a": null, "b": [null, 1], "c": {"d": null}})),
            r#"{"b":[null,1],"c":{}}"#
        );
    }

    #[test]
    fn uploads_are_named_like_grammy() {
        let mut payload = Payload::new();
        payload.attach(
            "photo",
            InputFile::Bytes {
                data: vec![1],
                filename: None,
            },
        );
        payload.attach("document", InputFile::path("/x/backup.db"));
        let names: Vec<String> = payload.uploads().iter().map(upload_filename).collect();
        assert_eq!(names, ["photo.jpg", "backup.db"]);
    }
}
