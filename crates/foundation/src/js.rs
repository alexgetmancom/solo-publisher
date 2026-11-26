//! The JavaScript semantics the recorded behaviour relies on implicitly:
//! `trim` and `Number` of a string (Rust's own `trim` and `f64::from_str`
//! accept a different set of inputs), coercions of loosely typed JSON
//! (`Number`, `String`, `Boolean`, `??`), `Math.round`, `encodeURIComponent`,
//! and strings measured and cut in UTF-16 code units, which is what every
//! offset and limit a platform states counts.

use std::sync::LazyLock;

use percent_encoding::{AsciiSet, NON_ALPHANUMERIC, utf8_percent_encode};
use regex::Regex;
use serde_json::Value;

/// ECMAScript WhiteSpace and LineTerminator: what `trim()` and `Number()` strip.
/// Unlike `char::is_whitespace` it includes U+FEFF and excludes U+0085.
pub fn is_whitespace(c: char) -> bool {
    matches!(
        c,
        '\t' | '\n' | '\u{b}' | '\u{c}' | '\r' | ' ' | '\u{a0}' | '\u{1680}' | '\u{2000}'
            ..='\u{200a}' | '\u{2028}' | '\u{2029}' | '\u{202f}' | '\u{205f}' | '\u{3000}' | '\u{feff}'
    )
}

/// [`is_whitespace`] (`\s`) for use inside a regex character class.
pub const WHITESPACE_CLASS: &str =
    r"\t\n\x0B\x0C\r \x{A0}\x{1680}\x{2000}-\x{200A}\x{2028}\x{2029}\x{202F}\x{205F}\x{3000}\x{FEFF}";

/// `String.prototype.trim`.
pub fn trim(value: &str) -> &str {
    value.trim_matches(is_whitespace)
}

/// `String.prototype.trimStart`.
pub fn trim_start(value: &str) -> &str {
    value.trim_start_matches(is_whitespace)
}

/// `String.prototype.trimEnd`.
pub fn trim_end(value: &str) -> &str {
    value.trim_end_matches(is_whitespace)
}

static DECIMAL: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^[+-]?(?:Infinity|(?:[0-9]+\.?[0-9]*|\.[0-9]+)(?:[eE][+-]?[0-9]+)?)$").unwrap());

/// `Number(string)`: blank is 0, `0x`/`0o`/`0b` prefixes, `Infinity`, and NaN
/// for anything else — including the `inf`/`nan` spellings Rust would accept.
pub fn number(value: &str) -> f64 {
    let value = trim(value);
    if value.is_empty() {
        return 0.0;
    }
    let radix = match value.get(..2) {
        Some("0x" | "0X") => 16,
        Some("0o" | "0O") => 8,
        Some("0b" | "0B") => 2,
        _ => 10,
    };
    if radix != 10 {
        let digits = &value[2..];
        if digits.is_empty() || !digits.chars().all(|c| c.is_digit(radix)) {
            return f64::NAN;
        }
        return match u128::from_str_radix(digits, radix) {
            Ok(exact) => exact as f64,
            Err(_) => digits
                .chars()
                .filter_map(|c| c.to_digit(radix))
                .fold(0.0, |sum, digit| sum * f64::from(radix) + f64::from(digit)),
        };
    }
    if !DECIMAL.is_match(value) {
        return f64::NAN;
    }
    match value.trim_start_matches(['+', '-']) {
        "Infinity" if value.starts_with('-') => f64::NEG_INFINITY,
        "Infinity" => f64::INFINITY,
        _ => value.parse().unwrap_or(f64::NAN),
    }
}

/// `Number.isInteger`.
pub fn is_integer(value: f64) -> bool {
    value.is_finite() && value.trunc() == value
}

pub const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `Number.isSafeInteger`.
pub fn is_safe_integer(value: f64) -> bool {
    is_integer(value) && value.abs() <= MAX_SAFE_INTEGER
}

/// `String(number)`.
pub fn number_to_string(value: f64) -> String {
    if value.is_nan() {
        return "NaN".into();
    }
    if value.is_infinite() {
        return if value > 0.0 { "Infinity" } else { "-Infinity" }.into();
    }
    if value == 0.0 {
        return "0".into();
    }
    if value.abs() < 1e21 && value.abs() >= 1e-6 {
        return value.to_string();
    }
    let formatted = format!("{value:e}");
    match formatted.split_once('e') {
        Some((mantissa, exponent)) if !exponent.starts_with('-') => format!("{mantissa}e+{exponent}"),
        _ => formatted,
    }
}

/// `Number(value)` of a JSON value, `undefined` (absent) being NaN. An empty
/// array is 0 and a one-element array reads through its element, nested
/// arrays included (JavaScript would read `[true]` as NaN, this reads 1).
pub fn number_of(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [item] => number_of(Some(item)),
            _ => f64::NAN,
        },
        _ => number_of_scalar(value),
    }
}

/// [`number_of`] where a one-element array reads through its element only
/// when that element is not itself an array or object.
pub fn number_of_flat(value: Option<&Value>) -> f64 {
    match value {
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [item] => number_of_scalar(Some(item)),
            _ => f64::NAN,
        },
        _ => number_of_scalar(value),
    }
}

/// [`number_of`] where every array and object is NaN.
pub fn number_of_scalar(value: Option<&Value>) -> f64 {
    match value {
        None | Some(Value::Array(_) | Value::Object(_)) => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => number(text),
    }
}

/// A number as `JSON.stringify` writes it: an integer without a fraction,
/// NaN and the infinities as `null`.
pub fn json_number(value: f64) -> Value {
    if is_safe_integer(value) {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
}

/// `Math.round`: halves round up.
pub fn round(value: f64) -> f64 {
    (value + 0.5).floor()
}

/// `String(value)`.
pub fn string_of(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { string_of(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// `Boolean(value)`.
pub fn truthy(value: &Value) -> bool {
    match value {
        Value::Null => false,
        Value::Bool(flag) => *flag,
        Value::Number(number) => number.as_f64().is_some_and(|number| number != 0.0 && !number.is_nan()),
        Value::String(text) => !text.is_empty(),
        Value::Array(_) | Value::Object(_) => true,
    }
}

/// `a ?? b` over JSON: `null` and absent fall through.
pub fn present(value: Option<&Value>) -> Option<&Value> {
    value.filter(|value| !value.is_null())
}

/// What `encodeURIComponent` leaves as it is: ASCII letters, digits and `-_.!~*'()`.
const URI_COMPONENT: &AsciiSet = &NON_ALPHANUMERIC
    .remove(b'-')
    .remove(b'_')
    .remove(b'.')
    .remove(b'!')
    .remove(b'~')
    .remove(b'*')
    .remove(b'\'')
    .remove(b'(')
    .remove(b')');

/// `encodeURIComponent`.
pub fn encode_uri_component(value: &str) -> String {
    utf8_percent_encode(value, URI_COMPONENT).to_string()
}

/// `value.length`.
pub fn utf16_len(value: &str) -> usize {
    value.encode_utf16().count()
}

/// `value.slice(0, units)`, never splitting a character: a surrogate pair the
/// cut would halve is dropped whole.
pub fn utf16_prefix(value: &str, units: usize) -> &str {
    let mut count = 0;
    for (index, c) in value.char_indices() {
        count += c.len_utf16();
        if count > units {
            return &value[..index];
        }
    }
    value
}

/// `value.slice(0, units)` keeping the half of a pair the cut splits, as
/// U+FFFD, which is what a lone surrogate becomes once it is stored or sent.
pub fn utf16_prefix_lossy(value: &str, units: usize) -> String {
    let units: Vec<u16> = value.encode_utf16().take(units).collect();
    String::from_utf16_lossy(&units)
}

/// `value.slice(units)`: from the first character that starts at or after
/// UTF-16 position `units`.
pub fn utf16_slice_from(value: &str, units: usize) -> &str {
    let mut seen = 0;
    for (index, c) in value.char_indices() {
        if seen >= units {
            return &value[index..];
        }
        seen += c.len_utf16();
    }
    ""
}

/// `value.slice(start, end)` over the string's UTF-16 units; a half pair at
/// either edge becomes U+FFFD, as `String.fromCharCode` of the orphan would print.
pub fn utf16_slice(units: &[u16], start: usize, end: usize) -> String {
    String::from_utf16_lossy(&units[start.min(units.len())..end.min(units.len())])
}

/// The byte index of UTF-16 position `unit`, or None when it falls inside a
/// surrogate pair or past the end.
pub fn utf16_to_byte(value: &str, unit: usize) -> Option<usize> {
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

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn number_follows_ecmascript_string_to_number() {
        for (input, expected) in [
            ("", 0.0),
            (" \u{feff}12\u{a0}", 12.0),
            ("0x1F", 31.0),
            ("0o17", 15.0),
            ("0b101", 5.0),
            ("1e3", 1000.0),
            ("80.", 80.0),
            (".5e1", 5.0),
            ("-Infinity", f64::NEG_INFINITY),
        ] {
            assert_eq!(number(input), expected, "{input:?}");
        }
        for input in ["inf", "nan", "-0x10", "8_000", "\u{85}80", "1e", "0x", "Infinityx"] {
            assert!(number(input).is_nan(), "{input:?}");
        }
    }

    #[test]
    fn number_to_string_matches_javascript() {
        for (input, expected) in [
            (900.0, "900"),
            (1e20, "100000000000000000000"),
            (1e21, "1e+21"),
            (2f64.powi(60), "1152921504606847000"),
            (-0.0, "0"),
            (1.5, "1.5"),
        ] {
            assert_eq!(number_to_string(input), expected);
        }
    }

    #[test]
    fn uri_component_keeps_what_javascript_keeps() {
        assert_eq!(encode_uri_component("a b+c/é!~*'()"), "a%20b%2Bc%2F%C3%A9!~*'()");
    }
}
