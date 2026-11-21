use std::sync::LazyLock;

use foundation::js::trim;
use regex::Regex;
use serde_json::{Map, Value};
use unicode_normalization::UnicodeNormalization;

use crate::js::WHITESPACE_CLASS;

/// A Telegram-shaped formatting entity: `type`, `offset`, `length` (UTF-16) and
/// whatever else its type carries (`url`, `level`, `language`, ...), kept as
/// received so it round-trips to storage untouched.
pub type Entity = Map<String, Value>;

/// One attached media item as captured, in the shape it is stored in.
pub type MediaItem = Map<String, Value>;

/// Transport-neutral content captured from any interface before it becomes a draft.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct DraftMessage {
    pub text: String,
    /// Absent when the translator could not produce one; never the Russian text.
    pub text_en: Option<String>,
    /// Explicit human approval is separate from the machine translation.
    pub text_en_approved: Option<String>,
    pub media: Vec<MediaItem>,
    pub entities: Vec<Entity>,
}

/// The fallback is explicit at every call site: there is no generic name for a
/// post that would not be one installation's name on another's permanent URL.
pub fn first_line<'a>(text: Option<&'a str>, fallback: &'a str) -> &'a str {
    let line = text.map_or("", |text| trim(text.split('\n').next().unwrap_or("")));
    if line.is_empty() { fallback } else { line }
}

pub fn first_non_empty_line<'a>(text: Option<&'a str>, fallback: &'a str) -> &'a str {
    text.and_then(|text| text.split('\n').map(trim).find(|line| !line.is_empty()))
        .unwrap_or(fallback)
}

static URL_WITH_SLASHES: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!(r"(?i-u:https?:)[\\/]{{1,2}}[^{WHITESPACE_CLASS}]*")).unwrap());

/// Mobile keyboards occasionally autocorrect "/" to "\" inside a pasted URL.
/// Straighten only the slashes inside recognized http(s) links, so unrelated
/// backslashes elsewhere in free text (captions, signatures) are untouched.
pub fn fix_url_slashes(text: &str) -> String {
    URL_WITH_SLASHES
        .replace_all(text, |url: &regex::Captures| url[0].replace('\\', "/"))
        .into_owned()
}

static NOT_SLUG: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[^a-z0-9\x{400}-\x{4FF}]+").unwrap());

pub fn slugify(text: &str, post_id: i64) -> String {
    // NFC keeps Cyrillic letters such as "й" and "ё" intact. NFKD splits
    // "й" into "и" plus a combining breve, which was then discarded below.
    let lowered = text.nfc().collect::<String>().to_lowercase();
    let replaced = NOT_SLUG.replace_all(&lowered, "-");
    // Only ASCII and Cyrillic letters remain, all one UTF-16 unit each.
    let slug: String = replaced.trim_matches('-').chars().take(80).collect();
    if slug.is_empty() {
        format!("post-{post_id}")
    } else {
        slug
    }
}
