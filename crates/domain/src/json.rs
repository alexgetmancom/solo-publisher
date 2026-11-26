//! JSON exactly as JavaScript writes it. JSON columns are produced by
//! `JSON.stringify`, and serde's own output differs from it in ways a byte
//! comparison sees: `1.0` against `1`, `1e21` against `1e+21`, and object keys
//! that look like array indexes, which JavaScript always lists first.

use std::fmt::Write as _;

use foundation::js::number_to_string;
use serde::{Deserialize, Deserializer};
use serde_json::{Map, Value};

/// `JSON.stringify(value)`.
pub fn stringify(value: &Value) -> String {
    let mut out = String::new();
    write_value(&mut out, value);
    out
}

/// `JSON.stringify` of an object.
pub fn stringify_object(object: &Map<String, Value>) -> String {
    let mut out = String::new();
    write_object(&mut out, object);
    out
}

fn write_value(out: &mut String, value: &Value) {
    match value {
        Value::Null => out.push_str("null"),
        Value::Bool(flag) => out.push_str(if *flag { "true" } else { "false" }),
        // `JSON.stringify` writes what `String(number)` does for finite numbers.
        Value::Number(number) => out.push_str(&number_to_string(number.as_f64().unwrap_or(f64::NAN))),
        Value::String(text) => write_string(out, text),
        Value::Array(items) => {
            out.push('[');
            for (index, item) in items.iter().enumerate() {
                if index > 0 {
                    out.push(',');
                }
                write_value(out, item);
            }
            out.push(']');
        }
        Value::Object(object) => write_object(out, object),
    }
}

fn write_object(out: &mut String, object: &Map<String, Value>) {
    let mut indexes: Vec<(u32, &String, &Value)> = object
        .iter()
        .filter_map(|(key, value)| array_index(key).map(|index| (index, key, value)))
        .collect();
    indexes.sort_by_key(|(index, _, _)| *index);
    let named = object.iter().filter(|(key, _)| array_index(key).is_none());
    out.push('{');
    for (position, (key, value)) in indexes
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(named)
        .enumerate()
    {
        if position > 0 {
            out.push(',');
        }
        write_string(out, key);
        out.push(':');
        write_value(out, value);
    }
    out.push('}');
}

/// A key JavaScript orders as an array index: the canonical decimal form of an
/// integer below 2^32 - 1.
fn array_index(key: &str) -> Option<u32> {
    if key.is_empty() || (key.len() > 1 && key.starts_with('0')) || !key.bytes().all(|b| b.is_ascii_digit()) {
        return None;
    }
    key.parse::<u32>().ok().filter(|index| *index != u32::MAX)
}

fn write_string(out: &mut String, text: &str) {
    out.push('"');
    for c in text.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\u{8}' => out.push_str("\\b"),
            '\u{c}' => out.push_str("\\f"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            c if (c as u32) < 0x20 => write!(out, "\\u{:04x}", c as u32).unwrap(),
            c => out.push(c),
        }
    }
    out.push('"');
}

/// `Object.entries(object)`: keys JavaScript orders as array indexes first,
/// ascending, then the rest in insertion order.
pub fn object_entries(object: &Map<String, Value>) -> impl Iterator<Item = (&String, &Value)> {
    let mut indexes: Vec<(u32, &String, &Value)> = object
        .iter()
        .filter_map(|(key, value)| array_index(key).map(|index| (index, key, value)))
        .collect();
    indexes.sort_by_key(|(index, _, _)| *index);
    indexes
        .into_iter()
        .map(|(_, key, value)| (key, value))
        .chain(object.iter().filter(|(key, _)| array_index(key).is_none()))
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

/// `String(value)`.
pub fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(flag) => flag.to_string(),
        Value::Number(number) => number_to_string(number.as_f64().unwrap_or(f64::NAN)),
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}

/// For patch fields where an absent key (leave the column) and `null` (clear
/// it) mean different things.
pub fn double_option<'de, T: Deserialize<'de>, D: Deserializer<'de>>(
    deserializer: D,
) -> Result<Option<Option<T>>, D::Error> {
    Option::<T>::deserialize(deserializer).map(Some)
}

/// A content locale as its code (`"ru"`, `"en"`), for `#[serde(with)]`.
pub mod locale {
    use content::Locale;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(locale: &Locale, serializer: S) -> Result<S::Ok, S::Error> {
        serializer.serialize_str(locale.as_str())
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Locale, D::Error> {
        match String::deserialize(deserializer)?.as_str() {
            "ru" => Ok(Locale::Ru),
            "en" => Ok(Locale::En),
            other => Err(serde::de::Error::custom(format!("unknown locale {other}"))),
        }
    }
}

/// An optional content locale, absent or its code.
pub mod optional_locale {
    use content::Locale;
    use serde::{Deserialize, Deserializer, Serializer};

    pub fn serialize<S: Serializer>(locale: &Option<Locale>, serializer: S) -> Result<S::Ok, S::Error> {
        match locale {
            Some(locale) => serializer.serialize_str(locale.as_str()),
            None => serializer.serialize_none(),
        }
    }

    pub fn deserialize<'de, D: Deserializer<'de>>(deserializer: D) -> Result<Option<Locale>, D::Error> {
        Option::<String>::deserialize(deserializer)?
            .map(|code| match code.as_str() {
                "ru" => Ok(Locale::Ru),
                "en" => Ok(Locale::En),
                other => Err(serde::de::Error::custom(format!("unknown locale {other}"))),
            })
            .transpose()
    }
}

#[cfg(test)]
mod tests {
    use serde_json::json;

    use super::*;

    #[test]
    fn numbers_print_as_javascript_does() {
        let value: Value = serde_json::from_str(
            "[1.0, -0.0, 12.5, 1e21, 123456789012345680000, 1.5e-7, 0.000001, -2.5e30, 9007199254740993]",
        )
        .unwrap();
        assert_eq!(
            stringify(&value),
            "[1,0,12.5,1e+21,123456789012345680000,1.5e-7,0.000001,-2.5e+30,9007199254740992]"
        );
    }

    #[test]
    fn index_keys_come_first_and_strings_escape_like_javascript() {
        let value: Value = serde_json::from_str(r#"{"b":1,"10":2,"2":3,"01":4,"a":"x\u0001\"\n/ "}"#).unwrap();
        assert_eq!(
            stringify(&value),
            "{\"2\":3,\"10\":2,\"b\":1,\"01\":4,\"a\":\"x\\u0001\\\"\\n/\u{2028}\"}"
        );
        assert_eq!(stringify(&json!([1.0, null, true])), "[1,null,true]");
    }
}
