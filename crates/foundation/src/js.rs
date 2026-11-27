//! The JavaScript semantics the code not yet converted still relies on: the
//! environment loader (`config`), the operations schema DSL (`ops::schema`),
//! the public feed's row coercion, the menu plugin, the credential seal's key
//! and the schedule clock.
//! `trim` and `Number` of a string accept a different set of inputs than
//! Rust's own `trim` and `f64::from_str`; `String(number)` and
//! `JSON.stringify` print a double without its fraction.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::Value;

use crate::text::TrimText;

/// `String.prototype.trim`, which trims what [`crate::text::is_text_blank`] calls blank.
pub fn trim(value: &str) -> &str {
    value.trim_text()
}

/// `String.prototype.trimStart`.
pub fn trim_start(value: &str) -> &str {
    value.trim_text_start()
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

/// A number as `JSON.stringify` writes it: an integer without a fraction,
/// NaN and the infinities as `null`.
pub fn json_number(value: f64) -> Value {
    if is_safe_integer(value) {
        Value::from(value as i64)
    } else {
        serde_json::Number::from_f64(value).map_or(Value::Null, Value::Number)
    }
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
}
