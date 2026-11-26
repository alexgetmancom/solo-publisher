//! Secret redaction for free-form text: error bodies, URLs, exception messages.
//! The logger runs it over every serialized line, so it must stay total.

use std::sync::LazyLock;

use regex::Regex;

use crate::js::WHITESPACE_CLASS;

// `(?i-u:…)` is ASCII case folding, as JavaScript's `i` flag without `u`: it
// does not fold `ſ` into `s` or the Kelvin sign into `k`.
static ASSIGNMENT: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r#"((?i-u:access_token|api[_-]?key|password|token))=[^{WHITESPACE_CLASS}&"']+"#
    ))
    .unwrap()
});
static BOT_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"/bot[0-9]{6,}:[A-Za-z0-9_-]+").unwrap());
static BEARER: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i-u:bearer)[{WHITESPACE_CLASS}]+[A-Za-z0-9._-]+")).unwrap());

pub fn redact_external_secrets(value: &str) -> String {
    let value = ASSIGNMENT.replace_all(value, "${1}=[REDACTED]");
    let value = BOT_PATH.replace_all(&value, "/bot[REDACTED]");
    BEARER.replace_all(&value, "Bearer [REDACTED]").into_owned()
}
