//! How loosely typed entity JSON is read and strings are measured, JavaScript-style:
//! `Number(value)` over whatever a field held, and `String.length` in UTF-16
//! code units.

use foundation::js;
use serde_json::Value;

/// `Number(value)`, with a missing field as `undefined`. Arrays and objects read
/// as NaN; JavaScript would coerce a one-element array through its element.
pub(crate) fn number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => js::number(text),
        Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
    }
}

/// A computed offset as JSON: integral values stay integers, as `JSON.stringify` writes them.
pub(crate) fn number_value(value: f64) -> Value {
    if js::is_safe_integer(value) {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

pub(crate) fn utf16_len(value: &str) -> usize {
    value.chars().map(char::len_utf16).sum()
}

/// The byte index of UTF-16 position `unit`, or None when it falls inside a
/// surrogate pair or past the end.
pub(crate) fn utf16_to_byte(value: &str, unit: usize) -> Option<usize> {
    let mut units = 0;
    for (byte, c) in value.char_indices() {
        if units == unit {
            return Some(byte);
        }
        units += c.len_utf16();
        if units > unit {
            return None;
        }
    }
    (units == unit).then_some(value.len())
}

/// The longest prefix of at most `units` UTF-16 code units that ends on a character boundary.
pub(crate) fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (byte, c) in value.char_indices() {
        count += c.len_utf16();
        if count > units {
            return &value[..byte];
        }
    }
    value
}

/// JavaScript whitespace (`\s`) for use inside a regex character class.
pub(crate) const WHITESPACE_CLASS: &str =
    r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";
