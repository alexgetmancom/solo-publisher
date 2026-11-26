//! The input schemas of the operations and the Studio MCP tools, as one Rust
//! type that both parses an input the way zod's `safeParse` does (coercion,
//! checks in declaration order, the first issue with its path, the
//! transforms) and emits the JSON Schema `z.toJSONSchema(schema, { io: "input" })`
//! produces, key for key and in zod's key order, as the goldens record it.
//!
//! zod's emission order, which the builders reproduce: a wrapper
//! (`.optional()`, `.default()`) contributes its own keys (`default`, then any
//! metadata given to the wrapper) before the inner schema's; metadata given to
//! the bare schema follows its type keys. Metadata is inherited by a clone, so
//! a second `.describe()` keeps the first one's position.

use std::collections::HashSet;

use foundation::js;
use serde_json::{Map, Value, json};

pub const MAX_SAFE_INTEGER: f64 = js::MAX_SAFE_INTEGER;

/// The first problem `safeParse` reported.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Issue {
    pub path: Vec<String>,
    pub message: String,
}

impl Issue {
    fn at(path: &[String], message: impl Into<String>) -> Self {
        Self {
            path: path.to_vec(),
            message: message.into(),
        }
    }

    /// `path: message`, or the message alone at the root.
    pub fn describe(&self) -> String {
        if self.path.is_empty() {
            self.message.clone()
        } else {
            format!("{}: {}", self.path.join("."), self.message)
        }
    }
}

/// How a parse fails: a zod issue, or an exception a transform threw
/// (`JSON.parse`, `splitList`), which `safeParse` did not catch.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ParseError {
    Issue(Issue),
    Thrown(String),
}

#[derive(Clone, Debug)]
enum Core {
    Str {
        trim: bool,
        checks: Vec<StrCheck>,
    },
    Num {
        coerce: bool,
        int: bool,
        checks: Vec<NumCheck>,
    },
    Bool,
    Enum(&'static [&'static str]),
    Array {
        item: Box<Core>,
        min: Option<usize>,
        max: Option<usize>,
    },
    /// `z.record(z.string(), z.unknown())`.
    Record,
}

#[derive(Clone, Debug)]
enum StrCheck {
    Min(usize),
    Max(usize),
    Pattern(&'static str),
    /// `.refine(predicate, { message })`.
    Refine(fn(&str) -> bool, &'static str),
}

#[derive(Clone, Copy, Debug)]
enum NumCheck {
    Min(f64),
    /// `.positive()`.
    Positive,
    Max(f64),
}

/// What a field's `.transform` (or a refinement after the type) does to the
/// parsed value.
#[derive(Clone, Copy, Debug)]
pub enum Transform {
    /// `refSpelling`: a bare post number is `post:<n>`.
    RefSpelling,
    /// `splitList`: comma-separated, trimmed, none empty.
    SplitList,
    /// `JSON.parse`.
    JsonParse,
    /// `[...new Set(values)]`.
    Unique,
    /// `.refine(values => new Set(values).size === values.length, { message })`.
    NoDuplicates(&'static str),
    /// `isoDateOrNull`: absent or empty is `null`, otherwise one ISO instant
    /// (kept as `toISOString`).
    IsoDateOrNull,
}

/// One field of an object schema.
#[derive(Clone, Debug)]
pub struct Field {
    pub name: &'static str,
    core: Core,
    optional: bool,
    default: Option<Value>,
    transform: Option<Transform>,
    /// Keys a wrapper contributes, ahead of the inner schema's.
    outer: Vec<(&'static str, Value)>,
    /// Metadata of the bare schema, after its type keys.
    inner: Vec<(&'static str, Value)>,
}

fn base(core: Core) -> Field {
    Field {
        name: "",
        core,
        optional: false,
        default: None,
        transform: None,
        outer: Vec::new(),
        inner: Vec::new(),
    }
}

/// `z.string()`.
pub fn string() -> Field {
    base(Core::Str {
        trim: false,
        checks: Vec::new(),
    })
}

/// `z.number()`.
pub fn number() -> Field {
    base(Core::Num {
        coerce: false,
        int: false,
        checks: Vec::new(),
    })
}

/// `z.coerce.number()`.
pub fn coerce_number() -> Field {
    base(Core::Num {
        coerce: true,
        int: false,
        checks: Vec::new(),
    })
}

/// `z.boolean()`.
pub fn boolean() -> Field {
    base(Core::Bool)
}

/// `z.enum(values)`.
pub fn enumeration(values: &'static [&'static str]) -> Field {
    base(Core::Enum(values))
}

/// `z.array(item)`.
pub fn array(item: Field) -> Field {
    base(Core::Array {
        item: Box::new(item.core),
        min: None,
        max: None,
    })
}

/// `z.record(z.string(), z.unknown())`.
pub fn record() -> Field {
    base(Core::Record)
}

fn set(list: &mut Vec<(&'static str, Value)>, key: &'static str, value: Value) {
    match list.iter_mut().find(|(existing, _)| *existing == key) {
        Some(entry) => entry.1 = value,
        None => list.push((key, value)),
    }
}

impl Field {
    fn wrapped(&self) -> bool {
        self.optional || self.default.is_some()
    }

    fn meta(mut self, key: &'static str, value: Value) -> Self {
        if self.wrapped() {
            set(&mut self.outer, key, value);
        } else {
            set(&mut self.inner, key, value);
        }
        self
    }

    /// `.describe(text)`.
    pub fn describe(self, text: &'static str) -> Self {
        self.meta("description", Value::from(text))
    }

    /// `example(schema, placeholder)`: the CLI usage placeholder.
    pub fn example(self, placeholder: &'static str) -> Self {
        self.meta("placeholder", Value::from(placeholder))
    }

    /// `.optional()`.
    pub fn optional(mut self) -> Self {
        self.optional = true;
        self
    }

    /// `.default(value)`.
    pub fn default(mut self, value: Value) -> Self {
        self.outer.insert(0, ("default", value.clone()));
        self.default = Some(value);
        self
    }

    pub fn transform(mut self, transform: Transform) -> Self {
        self.transform = Some(transform);
        self
    }

    /// `.trim()`.
    pub fn trim(mut self) -> Self {
        if let Core::Str { trim, .. } = &mut self.core {
            *trim = true;
        }
        self
    }

    /// `.int()`.
    pub fn int(mut self) -> Self {
        if let Core::Num { int, .. } = &mut self.core {
            *int = true;
        }
        self
    }

    /// `.min(n)`: length, value or item count.
    pub fn min(mut self, bound: f64) -> Self {
        match &mut self.core {
            Core::Str { checks, .. } => checks.push(StrCheck::Min(bound as usize)),
            Core::Num { checks, .. } => checks.push(NumCheck::Min(bound)),
            Core::Array { min, .. } => *min = Some(bound as usize),
            _ => {}
        }
        self
    }

    /// `.max(n)`: length, value or item count.
    pub fn max(mut self, bound: f64) -> Self {
        match &mut self.core {
            Core::Str { checks, .. } => checks.push(StrCheck::Max(bound as usize)),
            Core::Num { checks, .. } => checks.push(NumCheck::Max(bound)),
            Core::Array { max, .. } => *max = Some(bound as usize),
            _ => {}
        }
        self
    }

    /// `.positive()`.
    pub fn positive(mut self) -> Self {
        if let Core::Num { checks, .. } = &mut self.core {
            checks.push(NumCheck::Positive);
        }
        self
    }

    /// `.regex(pattern)`; the pattern is the JavaScript source, which is also
    /// valid for the `regex` crate here.
    pub fn regex(mut self, pattern: &'static str) -> Self {
        if let Core::Str { checks, .. } = &mut self.core {
            checks.push(StrCheck::Pattern(pattern));
        }
        self
    }

    /// `.refine(predicate, { message })` on a string.
    pub fn refine(mut self, predicate: fn(&str) -> bool, message: &'static str) -> Self {
        if let Core::Str { checks, .. } = &mut self.core {
            checks.push(StrCheck::Refine(predicate, message));
        }
        self
    }

    pub fn is_boolean(&self) -> bool {
        matches!(self.core, Core::Bool)
    }

    pub fn is_required(&self) -> bool {
        !self.wrapped()
    }

    /// The property's JSON Schema.
    pub fn json_schema(&self) -> Value {
        let mut out = Map::new();
        for (key, value) in &self.outer {
            out.insert((*key).into(), value.clone());
        }
        for (key, value) in core_schema(&self.core) {
            out.entry(key).or_insert(value);
        }
        for (key, value) in &self.inner {
            out.insert((*key).into(), value.clone());
        }
        Value::Object(out)
    }

    /// `safeParse` of this field's value (`None` is absent). `Ok(None)`
    /// leaves the field out of the output.
    fn parse(&self, value: Option<&Value>, path: &[String]) -> Result<Option<Value>, ParseError> {
        let parsed = match value {
            None if self.default.is_some() => return Ok(self.default.clone()),
            None if self.optional => None,
            value => Some(parse_core(&self.core, value, path).map_err(ParseError::Issue)?),
        };
        match (self.transform, parsed) {
            (Some(Transform::IsoDateOrNull), parsed) => iso_date_or_null(parsed, path).map(Some),
            (Some(transform), Some(parsed)) => apply(transform, parsed, path).map(Some),
            (_, parsed) => Ok(parsed),
        }
    }
}

fn core_schema(core: &Core) -> Vec<(String, Value)> {
    let mut out: Vec<(String, Value)> = Vec::new();
    match core {
        Core::Str { checks, .. } => {
            out.push(("type".into(), json!("string")));
            for check in checks {
                match check {
                    StrCheck::Min(n) => out.push(("minLength".into(), json!(n))),
                    StrCheck::Max(n) => out.push(("maxLength".into(), json!(n))),
                    StrCheck::Pattern(pattern) => out.push(("pattern".into(), json!(pattern))),
                    StrCheck::Refine(..) => {}
                }
            }
        }
        Core::Num { int, checks, .. } => {
            out.push(("type".into(), json!(if *int { "integer" } else { "number" })));
            let mut minimum = int.then_some(-MAX_SAFE_INTEGER);
            let mut exclusive = None;
            let mut maximum = int.then_some(MAX_SAFE_INTEGER);
            for check in checks {
                match *check {
                    NumCheck::Min(n) => minimum = Some(minimum.map_or(n, |m: f64| m.max(n))),
                    NumCheck::Positive => exclusive = Some(0.0),
                    NumCheck::Max(n) => maximum = Some(maximum.map_or(n, |m: f64| m.min(n))),
                }
            }
            match (exclusive, minimum) {
                (Some(e), Some(m)) if e >= m => out.push(("exclusiveMinimum".into(), js::json_number(e))),
                (Some(e), None) => out.push(("exclusiveMinimum".into(), js::json_number(e))),
                (_, Some(m)) => out.push(("minimum".into(), js::json_number(m))),
                (None, None) => {}
            }
            if let Some(m) = maximum {
                out.push(("maximum".into(), js::json_number(m)));
            }
        }
        Core::Bool => out.push(("type".into(), json!("boolean"))),
        Core::Enum(values) => {
            out.push(("type".into(), json!("string")));
            out.push(("enum".into(), json!(values)));
        }
        Core::Array { item, min, max } => {
            if let Some(n) = min {
                out.push(("minItems".into(), json!(n)));
            }
            if let Some(n) = max {
                out.push(("maxItems".into(), json!(n)));
            }
            out.push(("type".into(), json!("array")));
            let items: Map<String, Value> = core_schema(item).into_iter().collect();
            out.push(("items".into(), Value::Object(items)));
        }
        Core::Record => {
            out.push(("type".into(), json!("object")));
            out.push(("propertyNames".into(), json!({"type": "string"})));
            out.push(("additionalProperties".into(), json!({})));
        }
    }
    out
}

/// zod's name for what it received.
fn received(value: Option<&Value>) -> String {
    match value {
        None => "undefined".into(),
        Some(Value::Null) => "null".into(),
        Some(Value::Bool(_)) => "boolean".into(),
        Some(Value::String(_)) => "string".into(),
        Some(Value::Array(_)) => "array".into(),
        Some(Value::Object(_)) => "object".into(),
        Some(Value::Number(n)) => match n.as_f64() {
            Some(f) if f.is_nan() => "NaN".into(),
            Some(f) if f.is_infinite() => "Infinity".into(),
            _ => "number".into(),
        },
    }
}

fn invalid_type(path: &[String], expected: &str, value: Option<&Value>) -> Issue {
    Issue::at(
        path,
        format!("Invalid input: expected {expected}, received {}", received(value)),
    )
}

/// `Number(value)` for a JSON value.
fn coerce(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(b)) => f64::from(u8::from(*b)),
        Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(s)) => js::number(s),
        // `Number([])` is 0 and `Number([x])` is `Number(String(x))`.
        Some(Value::Array(items)) => match items.as_slice() {
            [] => 0.0,
            [Value::String(s)] => js::number(s),
            [Value::Number(n)] => n.as_f64().unwrap_or(f64::NAN),
            [Value::Null] => 0.0,
            [Value::Array(inner)] if inner.is_empty() => 0.0,
            _ => f64::NAN,
        },
        Some(Value::Object(_)) => f64::NAN,
    }
}

fn number_received(value: f64) -> &'static str {
    if value.is_nan() {
        "NaN"
    } else if value.is_infinite() {
        "Infinity"
    } else {
        "number"
    }
}

fn parse_core(core: &Core, value: Option<&Value>, path: &[String]) -> Result<Value, Issue> {
    match core {
        Core::Str { trim, checks } => {
            let Some(Value::String(text)) = value else {
                return Err(invalid_type(path, "string", value));
            };
            let text = if *trim { js::trim(text) } else { text.as_str() };
            let length = text.encode_utf16().count();
            for check in checks {
                match check {
                    StrCheck::Min(n) if length < *n => {
                        return Err(Issue::at(
                            path,
                            format!("Too small: expected string to have >={n} characters"),
                        ));
                    }
                    StrCheck::Max(n) if length > *n => {
                        return Err(Issue::at(
                            path,
                            format!("Too big: expected string to have <={n} characters"),
                        ));
                    }
                    StrCheck::Pattern(pattern) if !regex::Regex::new(pattern).is_ok_and(|re| re.is_match(text)) => {
                        return Err(Issue::at(
                            path,
                            format!("Invalid string: must match pattern /{pattern}/"),
                        ));
                    }
                    StrCheck::Refine(predicate, message) if !predicate(text) => {
                        return Err(Issue::at(path, *message));
                    }
                    _ => {}
                }
            }
            Ok(Value::from(text))
        }
        Core::Num {
            coerce: coerced,
            int,
            checks,
        } => {
            let number = if *coerced {
                coerce(value)
            } else {
                match value {
                    Some(Value::Number(n)) => n.as_f64().unwrap_or(f64::NAN),
                    _ => return Err(invalid_type(path, "number", value)),
                }
            };
            if !number.is_finite() {
                return Err(Issue::at(
                    path,
                    format!("Invalid input: expected number, received {}", number_received(number)),
                ));
            }
            if *int {
                if !js::is_integer(number) {
                    return Err(Issue::at(path, "Invalid input: expected int, received number"));
                }
                if number > MAX_SAFE_INTEGER {
                    return Err(Issue::at(
                        path,
                        format!("Too big: expected int to be <={}", MAX_SAFE_INTEGER as i64),
                    ));
                }
                if number < -MAX_SAFE_INTEGER {
                    return Err(Issue::at(
                        path,
                        format!("Too small: expected int to be >=-{}", MAX_SAFE_INTEGER as i64),
                    ));
                }
            }
            for check in checks {
                match *check {
                    NumCheck::Min(n) if number < n => {
                        return Err(Issue::at(
                            path,
                            format!("Too small: expected number to be >={}", js::number_to_string(n)),
                        ));
                    }
                    NumCheck::Positive if number <= 0.0 => {
                        return Err(Issue::at(path, "Too small: expected number to be >0"));
                    }
                    NumCheck::Max(n) if number > n => {
                        return Err(Issue::at(
                            path,
                            format!("Too big: expected number to be <={}", js::number_to_string(n)),
                        ));
                    }
                    _ => {}
                }
            }
            Ok(js::json_number(number))
        }
        Core::Bool => match value {
            Some(Value::Bool(b)) => Ok(Value::Bool(*b)),
            _ => Err(invalid_type(path, "boolean", value)),
        },
        Core::Enum(values) => match value {
            Some(Value::String(text)) if values.contains(&text.as_str()) => Ok(Value::from(text.as_str())),
            _ if values.len() == 1 => Err(Issue::at(path, format!("Invalid input: expected {}", json!(values[0])))),
            _ => Err(Issue::at(
                path,
                format!(
                    "Invalid option: expected one of {}",
                    values
                        .iter()
                        .map(|v| json!(v).to_string())
                        .collect::<Vec<_>>()
                        .join("|")
                ),
            )),
        },
        Core::Array { item, min, max } => {
            let Some(Value::Array(items)) = value else {
                return Err(invalid_type(path, "array", value));
            };
            let mut out = Vec::with_capacity(items.len());
            for (index, element) in items.iter().enumerate() {
                let mut item_path = path.to_vec();
                item_path.push(index.to_string());
                out.push(parse_core(item, Some(element), &item_path)?);
            }
            if let Some(n) = min
                && items.len() < *n
            {
                return Err(Issue::at(
                    path,
                    format!("Too small: expected array to have >={n} items"),
                ));
            }
            if let Some(n) = max
                && items.len() > *n
            {
                return Err(Issue::at(path, format!("Too big: expected array to have <={n} items")));
            }
            Ok(Value::Array(out))
        }
        Core::Record => match value {
            Some(Value::Object(map)) => Ok(Value::Object(map.clone())),
            _ => Err(invalid_type(path, "record", value)),
        },
    }
}

fn apply(transform: Transform, value: Value, path: &[String]) -> Result<Value, ParseError> {
    match transform {
        Transform::RefSpelling => {
            let text = value.as_str().unwrap_or_default();
            Ok(Value::from(ref_spelling(text)))
        }
        Transform::SplitList => {
            let text = value.as_str().unwrap_or_default();
            let items: Vec<Value> = text
                .split(',')
                .map(js::trim)
                .filter(|item| !item.is_empty())
                .map(Value::from)
                .collect();
            if items.is_empty() {
                return Err(ParseError::Thrown(
                    "a comma-separated option must name at least one value".into(),
                ));
            }
            Ok(Value::Array(items))
        }
        Transform::JsonParse => {
            let text = value.as_str().unwrap_or_default();
            serde_json::from_str(text).map_err(|error| ParseError::Thrown(format!("JSON Parse error: {error}")))
        }
        Transform::Unique => {
            let mut seen = HashSet::new();
            let items = value.as_array().cloned().unwrap_or_default();
            Ok(Value::Array(
                items.into_iter().filter(|item| seen.insert(item.to_string())).collect(),
            ))
        }
        Transform::NoDuplicates(message) => {
            let items = value.as_array().cloned().unwrap_or_default();
            let unique: HashSet<String> = items.iter().map(Value::to_string).collect();
            if unique.len() != items.len() {
                return Err(ParseError::Issue(Issue::at(path, message)));
            }
            Ok(value)
        }
        Transform::IsoDateOrNull => iso_date_or_null(Some(value), path),
    }
}

fn iso_date_or_null(value: Option<Value>, path: &[String]) -> Result<Value, ParseError> {
    match value.as_ref().and_then(Value::as_str) {
        None | Some("") => Ok(Value::Null),
        Some(text) => foundation::time::parse_iso_instant(text)
            .map(|at| Value::from(foundation::time::to_iso_string(at)))
            .map_err(|error| ParseError::Issue(Issue::at(path, error.to_string()))),
    }
}

/// Callers reach for the bare post number — it is what every other surface
/// shows them — so it is a spelling of the ref, not a mistake to reject.
pub fn ref_spelling(value: &str) -> String {
    if !value.is_empty() && value.bytes().all(|b| b.is_ascii_digit()) {
        format!("post:{}", js::number_to_string(js::number(value)))
    } else {
        value.to_owned()
    }
}

/// An object-level `.refine` or `.transform` after the fields parsed.
pub type ObjectCheck = fn(&mut Map<String, Value>) -> Result<(), Issue>;

/// `z.object(shape)`, with an optional refinement over the parsed object.
#[derive(Clone, Debug)]
pub struct Schema {
    pub fields: Vec<Field>,
    pub check: Option<ObjectCheck>,
}

/// `z.object({ name: field, … })`.
pub fn object(fields: Vec<(&'static str, Field)>) -> Schema {
    Schema {
        fields: fields
            .into_iter()
            .map(|(name, mut field)| {
                field.name = name;
                field
            })
            .collect(),
        check: None,
    }
}

impl Schema {
    /// `.extend({ … })`: a field of the same name is replaced in place.
    pub fn extend(mut self, fields: Vec<(&'static str, Field)>) -> Self {
        for (name, mut field) in fields {
            field.name = name;
            match self.fields.iter_mut().find(|existing| existing.name == name) {
                Some(existing) => *existing = field,
                None => self.fields.push(field),
            }
        }
        self
    }

    pub fn refine(mut self, check: ObjectCheck) -> Self {
        self.check = Some(check);
        self
    }

    pub fn field(&self, name: &str) -> Option<&Field> {
        self.fields.iter().find(|field| field.name == name)
    }

    /// `inputJsonSchema`: the client-facing schema without `$schema`.
    pub fn json_schema(&self) -> Value {
        let properties: Map<String, Value> = self
            .fields
            .iter()
            .map(|field| (field.name.to_owned(), field.json_schema()))
            .collect();
        let required: Vec<&str> = self
            .fields
            .iter()
            .filter(|field| field.is_required())
            .map(|field| field.name)
            .collect();
        let mut out = Map::new();
        out.insert("type".into(), json!("object"));
        out.insert("properties".into(), Value::Object(properties));
        if !required.is_empty() {
            out.insert("required".into(), json!(required));
        }
        Value::Object(out)
    }

    /// `safeParse`: every field in shape order, the first issue reported.
    pub fn parse(&self, input: &Map<String, Value>) -> Result<Map<String, Value>, ParseError> {
        let mut out = Map::new();
        let mut first: Option<ParseError> = None;
        for field in &self.fields {
            let path = [field.name.to_owned()];
            match field.parse(input.get(field.name), &path) {
                Ok(Some(value)) => {
                    out.insert(field.name.to_owned(), value);
                }
                Ok(None) => {}
                // A transform's exception is not an issue: it ends the parse.
                Err(ParseError::Thrown(message)) => return Err(ParseError::Thrown(message)),
                Err(error) => {
                    first.get_or_insert(error);
                }
            }
        }
        if let Some(error) = first {
            return Err(error);
        }
        if let Some(check) = self.check {
            check(&mut out).map_err(ParseError::Issue)?;
        }
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ref_spelling_reads_a_bare_number_as_a_post() {
        assert_eq!(ref_spelling("160"), "post:160");
        assert_eq!(ref_spelling("0012"), "post:12");
        assert_eq!(ref_spelling("video:3"), "video:3");
        assert_eq!(ref_spelling("١٢"), "١٢");
    }

    #[test]
    fn coercion_follows_javascript_number() {
        let field = coerce_number().int().min(1.0);
        let parse = |value: Value| field.parse(Some(&value), &["n".into()]);
        assert_eq!(parse(json!("3")), Ok(Some(json!(3))));
        assert_eq!(parse(json!(true)), Ok(Some(json!(1))));
        assert!(
            matches!(parse(json!("")), Err(ParseError::Issue(issue)) if issue.message == "Too small: expected number to be >=1")
        );
        assert!(
            matches!(field.parse(None, &[]), Err(ParseError::Issue(issue)) if issue.message == "Invalid input: expected number, received NaN")
        );
    }
}
