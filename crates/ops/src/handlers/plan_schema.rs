//! The reviewed-plan schemas of `site-display-repair` and `site-metadata`,
//! parsed the way zod's `.parse()` did: every issue collected in zod's
//! order, and the thrown `ZodError` message (the issues as indented JSON).
//! Only the shapes those two schemas use.

use std::sync::LazyLock;

use regex::Regex;
use serde_json::{Map, Value, json};

use crate::context::OpError;

const MAX_SAFE_INTEGER: f64 = 9_007_199_254_740_991.0;

/// `z.string().datetime({ offset: true })`, zod's own pattern.
const DATETIME_PATTERN: &str = r"^(?:(?:\d\d[2468][048]|\d\d[13579][26]|\d\d0[48]|[02468][048]00|[13579][26]00)-02-29|\d{4}-(?:(?:0[13578]|1[02])-(?:0[1-9]|[12]\d|3[01])|(?:0[469]|11)-(?:0[1-9]|[12]\d|30)|(?:02)-(?:0[1-9]|1\d|2[0-8])))T(?:(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|([+-](?:[01]\d|2[0-3]):[0-5]\d)))$";
static DATETIME: LazyLock<Regex> = LazyLock::new(|| Regex::new(DATETIME_PATTERN).unwrap());
static SHA256: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[a-f0-9]{64}$").unwrap());

pub(crate) enum Kind {
    Literal(i64),
    /// `z.number().int().positive()`.
    PositiveInt,
    Enum(&'static [&'static str]),
    Str {
        trim: bool,
        min: Option<usize>,
        max: Option<usize>,
        sha256: bool,
        datetime: bool,
    },
    Nullable(Box<Kind>),
    Optional(Box<Kind>),
    /// `.default([])` of an array.
    DefaultEmpty(Box<Kind>),
    Array {
        item: Box<Kind>,
        min: Option<usize>,
    },
    /// `.strict()`.
    Object(Vec<(&'static str, Kind)>),
}

pub(crate) fn string() -> Kind {
    Kind::Str {
        trim: false,
        min: None,
        max: None,
        sha256: false,
        datetime: false,
    }
}

impl Kind {
    pub(crate) fn trim(self) -> Self {
        self.with(|trim, _, _, _, _| *trim = true)
    }
    pub(crate) fn min(self, bound: usize) -> Self {
        self.with(|_, min, _, _, _| *min = Some(bound))
    }
    pub(crate) fn max(self, bound: usize) -> Self {
        self.with(|_, _, max, _, _| *max = Some(bound))
    }
    pub(crate) fn sha256(self) -> Self {
        self.with(|_, _, _, sha256, _| *sha256 = true)
    }
    pub(crate) fn datetime(self) -> Self {
        self.with(|_, _, _, _, datetime| *datetime = true)
    }
    pub(crate) fn nullable(self) -> Self {
        Kind::Nullable(Box::new(self))
    }
    pub(crate) fn optional(self) -> Self {
        Kind::Optional(Box::new(self))
    }
    pub(crate) fn default_empty(self) -> Self {
        Kind::DefaultEmpty(Box::new(self))
    }

    fn with(
        mut self,
        edit: impl FnOnce(&mut bool, &mut Option<usize>, &mut Option<usize>, &mut bool, &mut bool),
    ) -> Self {
        if let Kind::Str {
            trim,
            min,
            max,
            sha256,
            datetime,
        } = &mut self
        {
            edit(trim, min, max, sha256, datetime);
        }
        self
    }
}

pub(crate) fn array(item: Kind) -> Kind {
    Kind::Array {
        item: Box::new(item),
        min: None,
    }
}

pub(crate) fn array_min(item: Kind, min: usize) -> Kind {
    Kind::Array {
        item: Box::new(item),
        min: Some(min),
    }
}

/// zod's name for what it received.
fn received(value: Option<&Value>) -> &'static str {
    match value {
        None => "undefined",
        Some(Value::Null) => "null",
        Some(Value::Bool(_)) => "boolean",
        Some(Value::Number(_)) => "number",
        Some(Value::String(_)) => "string",
        Some(Value::Array(_)) => "array",
        Some(Value::Object(_)) => "object",
    }
}

fn invalid_type(expected: &str, value: Option<&Value>, path: &[Value]) -> Value {
    json!({
        "expected": expected,
        "code": "invalid_type",
        "path": path,
        "message": format!("Invalid input: expected {expected}, received {}", received(value)),
    })
}

fn length(text: &str) -> usize {
    text.encode_utf16().count()
}

/// The parsed value, or `None` when it is absent from the output; issues
/// are appended in zod's order.
fn check(kind: &Kind, value: Option<&Value>, path: &[Value], issues: &mut Vec<Value>) -> Option<Value> {
    match kind {
        Kind::Optional(inner) => value.and_then(|value| check(inner, Some(value), path, issues)),
        Kind::DefaultEmpty(inner) => match value {
            None => Some(json!([])),
            Some(value) => check(inner, Some(value), path, issues),
        },
        Kind::Nullable(inner) => match value {
            Some(Value::Null) => Some(Value::Null),
            _ => check(inner, value, path, issues),
        },
        Kind::Literal(expected) => {
            if value.and_then(Value::as_f64) != Some(*expected as f64) {
                issues.push(json!({
                    "code": "invalid_value",
                    "values": [expected],
                    "path": path,
                    "message": format!("Invalid input: expected {expected}"),
                }));
            }
            value.cloned()
        }
        Kind::Enum(options) => {
            if !value
                .and_then(Value::as_str)
                .is_some_and(|text| options.contains(&text))
            {
                let listed: Vec<String> = options.iter().map(|option| format!("\"{option}\"")).collect();
                issues.push(json!({
                    "code": "invalid_value",
                    "values": options,
                    "path": path,
                    "message": format!("Invalid option: expected one of {}", listed.join("|")),
                }));
            }
            value.cloned()
        }
        Kind::PositiveInt => {
            let Some(number) = value.and_then(Value::as_f64) else {
                issues.push(invalid_type("number", value, path));
                return value.cloned();
            };
            if number.fract() != 0.0 {
                issues.push(json!({
                    "expected": "int",
                    "format": "safeint",
                    "code": "invalid_type",
                    "path": path,
                    "message": "Invalid input: expected int, received number",
                }));
                return value.cloned();
            }
            if number > MAX_SAFE_INTEGER {
                issues.push(json!({
                    "code": "too_big",
                    "maximum": 9_007_199_254_740_991_i64,
                    "note": "Integers must be within the safe integer range.",
                    "origin": "int",
                    "inclusive": true,
                    "path": path,
                    "message": "Too big: expected int to be <=9007199254740991",
                }));
                return value.cloned();
            }
            if number < -MAX_SAFE_INTEGER {
                issues.push(json!({
                    "code": "too_small",
                    "minimum": -9_007_199_254_740_991_i64,
                    "note": "Integers must be within the safe integer range.",
                    "origin": "int",
                    "inclusive": true,
                    "path": path,
                    "message": "Too small: expected int to be >=-9007199254740991",
                }));
                return value.cloned();
            }
            if number <= 0.0 {
                issues.push(json!({
                    "origin": "number",
                    "code": "too_small",
                    "minimum": 0,
                    "inclusive": false,
                    "path": path,
                    "message": "Too small: expected number to be >0",
                }));
            }
            value.cloned()
        }
        Kind::Str {
            trim,
            min,
            max,
            sha256,
            datetime,
        } => {
            let Some(text) = value.and_then(Value::as_str) else {
                issues.push(invalid_type("string", value, path));
                return value.cloned();
            };
            let text = if *trim { foundation::js::trim(text) } else { text };
            if let Some(min) = min
                && length(text) < *min
            {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_small",
                    "minimum": min,
                    "inclusive": true,
                    "path": path,
                    "message": format!("Too small: expected string to have >={min} characters"),
                }));
            }
            if let Some(max) = max
                && length(text) > *max
            {
                issues.push(json!({
                    "origin": "string",
                    "code": "too_big",
                    "maximum": max,
                    "inclusive": true,
                    "path": path,
                    "message": format!("Too big: expected string to have <={max} characters"),
                }));
            }
            if *sha256 && !SHA256.is_match(text) {
                issues.push(json!({
                    "origin": "string",
                    "code": "invalid_format",
                    "format": "regex",
                    "pattern": "/^[a-f0-9]{64}$/",
                    "path": path,
                    "message": "Invalid string: must match pattern /^[a-f0-9]{64}$/",
                }));
            }
            if *datetime && !DATETIME.is_match(text) {
                issues.push(json!({
                    "origin": "string",
                    "code": "invalid_format",
                    "format": "datetime",
                    "pattern": format!("/{DATETIME_PATTERN}/"),
                    "path": path,
                    "message": "Invalid ISO datetime",
                }));
            }
            Some(Value::from(text))
        }
        Kind::Array { item, min } => {
            let Some(items) = value.and_then(Value::as_array) else {
                issues.push(invalid_type("array", value, path));
                return value.cloned();
            };
            let parsed: Vec<Value> = items
                .iter()
                .enumerate()
                .map(|(index, element)| {
                    let mut at = path.to_vec();
                    at.push(json!(index));
                    check(item, Some(element), &at, issues).unwrap_or(Value::Null)
                })
                .collect();
            if let Some(min) = min
                && items.len() < *min
            {
                issues.push(json!({
                    "origin": "array",
                    "code": "too_small",
                    "minimum": min,
                    "inclusive": true,
                    "path": path,
                    "message": format!("Too small: expected array to have >={min} items"),
                }));
            }
            Some(Value::Array(parsed))
        }
        Kind::Object(fields) => {
            let Some(object) = value.and_then(Value::as_object) else {
                issues.push(invalid_type("object", value, path));
                return value.cloned();
            };
            let mut out = Map::new();
            for (name, field) in fields {
                let mut at = path.to_vec();
                at.push(json!(name));
                if let Some(parsed) = check(field, object.get(*name), &at, issues) {
                    out.insert((*name).to_owned(), parsed);
                }
            }
            let unknown: Vec<&String> = object
                .keys()
                .filter(|key| !fields.iter().any(|(name, _)| name == key))
                .collect();
            if !unknown.is_empty() {
                let quoted: Vec<String> = unknown.iter().map(|key| format!("\"{key}\"")).collect();
                issues.push(json!({
                    "code": "unrecognized_keys",
                    "keys": unknown,
                    "path": path,
                    "message": format!(
                        "Unrecognized key{}: {}",
                        if unknown.len() > 1 { "s" } else { "" },
                        quoted.join(", ")
                    ),
                }));
            }
            Some(Value::Object(out))
        }
    }
}

/// `schema.parse(value)`: the parsed value, or the `ZodError` thrown.
pub(crate) fn parse(kind: &Kind, value: &Value) -> Result<Value, OpError> {
    let mut issues = Vec::new();
    let parsed = check(kind, Some(value), &[], &mut issues);
    if issues.is_empty() {
        Ok(parsed.unwrap_or(Value::Null))
    } else {
        Err(OpError::Failed(serde_json::to_string_pretty(&issues)?))
    }
}

/// `z.object(shape).strict()`.
pub(crate) fn object(fields: Vec<(&'static str, Kind)>) -> Kind {
    Kind::Object(fields)
}

pub(crate) fn positive_int() -> Kind {
    Kind::PositiveInt
}

pub(crate) fn literal(value: i64) -> Kind {
    Kind::Literal(value)
}

pub(crate) fn locale() -> Kind {
    Kind::Enum(&["ru", "en"])
}
