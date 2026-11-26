//! The JavaScript value semantics the adapters' requests depend on: `Number`
//! of a JSON value, `encodeURIComponent`, and strings measured and cut in
//! UTF-16 code units, which is what every offset a platform sends counts.

use foundation::js::{is_safe_integer, number};
use serde_json::{Map, Value};

/// `Number(value)` of a JSON value; `undefined` (absent) is NaN.
pub(crate) fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => number(text),
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [item] => js_number(Some(item)),
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

/// A number as `JSON.stringify` writes it: an integer without a fraction,
/// NaN and the infinities as `null`.
pub(crate) fn json_number(value: f64) -> Value {
    if is_safe_integer(value) {
        Value::from(value as i64)
    } else if value.is_finite() {
        Value::from(value)
    } else {
        Value::Null
    }
}

/// `encodeURIComponent`.
pub(crate) fn encode_uri_component(value: &str) -> String {
    let mut encoded = String::with_capacity(value.len());
    for byte in value.bytes() {
        if byte.is_ascii_alphanumeric() || b"-_.!~*'()".contains(&byte) {
            encoded.push(byte as char);
        } else {
            encoded.push_str(&format!("%{byte:02X}"));
        }
    }
    encoded
}

/// `value.length`.
pub(crate) fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, units)`, never splitting a character: a pair the cut
/// would halve is left out, as the callers that cut on purpose do.
pub(crate) fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, character) in value.char_indices() {
        count += character.len_utf16();
        if count > units {
            return &value[..index];
        }
    }
    value
}

/// `value.slice(start, end)` by UTF-16 units; a half pair at either edge
/// becomes U+FFFD, as `String.fromCharCode` of the orphan would print.
pub(crate) fn utf16_slice(units: &[u16], start: usize, end: usize) -> String {
    String::from_utf16_lossy(&units[start.min(units.len())..end.min(units.len())])
}

/// `value && typeof value === "object" && !Array.isArray(value)`.
pub(crate) fn as_record(value: &Value) -> Option<&Map<String, Value>> {
    value.as_object()
}

/// A string field that is present and not empty (`if (value.x)`).
pub(crate) fn non_empty<'a>(record: &'a Map<String, Value>, key: &str) -> Option<&'a str> {
    record.get(key).and_then(Value::as_str).filter(|text| !text.is_empty())
}

/// `a ?? b` over JSON: `null` and absent fall through.
pub(crate) fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}
