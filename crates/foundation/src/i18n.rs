//! The Russian interface catalog (`locales/ru.json`, edited by hand) and the functions
//! that render it.

use std::error::Error;
use std::fmt::Display;

use crate::errors::StudioError;

include!(concat!(env!("OUT_DIR"), "/catalog.rs"));

impl Key {
    /// The catalog key, e.g. `common.cancel`.
    pub fn name(self) -> &'static str {
        NAMES[self as usize]
    }

    pub fn from_name(name: &str) -> Option<Self> {
        NAMES
            .iter()
            .position(|candidate| *candidate == name)
            .map(|index| ALL[index])
    }

    /// The template, placeholders not interpolated.
    pub fn text(self) -> &'static str {
        TEXTS[self as usize]
    }
}

/// Renders one message, interpolating `{name}` placeholders (`name` is ASCII
/// `\w+`). A placeholder without a value stays in the text literally.
pub fn t(key: Key, params: &[(&str, &dyn Display)]) -> String {
    interpolate(key.text(), params)
}

fn interpolate(template: &str, params: &[(&str, &dyn Display)]) -> String {
    let mut out = String::with_capacity(template.len());
    let mut rest = template;
    while let Some(start) = rest.find('{') {
        out.push_str(&rest[..start]);
        let after = &rest[start + 1..];
        let name_len = after
            .find(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .unwrap_or(after.len());
        let name = &after[..name_len];
        if name_len > 0 && after[name_len..].starts_with('}') {
            match params.iter().find(|(candidate, _)| *candidate == name) {
                Some((_, value)) => out.push_str(&value.to_string()),
                None => {
                    out.push('{');
                    out.push_str(name);
                    out.push('}');
                }
            }
            rest = &after[name_len + 1..];
        } else {
            out.push('{');
            rest = after;
        }
    }
    out.push_str(rest);
    out
}

/// Russian CLDR plural selection (what `Intl.PluralRules("ru-RU")` picks) for
/// a count; each form carries its own `{n}` placeholder.
pub fn plural(n: u64, one: &str, few: &str, many: &str) -> String {
    let form = match (n % 10, n % 100) {
        (1, rem) if rem != 11 => one,
        (2..=4, rem) if !(12..=14).contains(&rem) => few,
        _ => many,
    };
    form.replace("{n}", &n.to_string())
}

/// Renders an error for the owner: a `StudioError` whose code is a catalog key
/// is translated, anything else keeps its raw message.
pub fn describe_error(error: &(dyn Error + 'static)) -> String {
    if let Some(studio) = error.downcast_ref::<StudioError>()
        && let Some(key) = Key::from_name(&studio.code)
    {
        let params: Vec<(&str, &dyn Display)> = studio
            .params
            .iter()
            .map(|(name, value)| (name.as_str(), value as &dyn Display))
            .collect();
        return t(key, &params);
    }
    error.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalog_matches_the_exported_json() {
        let exported: serde_json::Map<String, serde_json::Value> =
            serde_json::from_str(include_str!("../locales/ru.json")).unwrap();
        assert_eq!(exported.len(), ALL.len());
        for ((name, text), key) in exported.iter().zip(ALL) {
            assert_eq!((key.name(), key.text()), (name.as_str(), text.as_str().unwrap()));
            assert_eq!(Key::from_name(name), Some(key));
        }
    }

    #[test]
    fn interpolates_like_the_typescript_replace() {
        let params: [(&str, &dyn Display); 2] = [("a", &"A"), ("n", &5)];
        for (template, expected) in [
            ("{{a}", "{A"),
            ("{a b}", "{a b}"),
            ("{}", "{}"),
            ("{ä}", "{ä}"),
            ("{a}{b}{n}", "A{b}5"),
            ("x{a}}y", "xA}y"),
            ("{a", "{a"),
            ("{_1}", "{_1}"),
        ] {
            assert_eq!(interpolate(template, &params), expected, "{template:?}");
        }
    }

    #[test]
    fn describes_studio_errors_through_the_catalog() {
        let error = StudioError::new("common.schedule-parse-error").with_param("timezone", "MSK");
        assert_eq!(
            describe_error(&error),
            t(Key::CommonScheduleParseError, &[("timezone", &"MSK")])
        );
        assert_eq!(describe_error(&StudioError::new("err.not-yours")), "err.not-yours");
    }
}
