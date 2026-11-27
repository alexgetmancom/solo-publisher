//! The single place that decides what a Threads post contains. Preflight, the
//! Telegram preview and delivery all call it: when the counter on screen and
//! the text on the wire are computed twice, they eventually disagree, and that
//! disagreement is silent.

use content::message::Entity;
use content::text::first_text_link_url;
use foundation::text::{TrimText, utf16_len};

use super::platform_profiles::platform_profile;

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ThreadsBody {
    /// Exactly what will be sent, link included or not.
    pub text: String,
    pub url: Option<String>,
    /// Set when a link existed but had to be dropped, with how many characters
    /// short it was: "cut 68 characters and it stays".
    pub dropped_url: Option<String>,
    pub shortfall: usize,
}

const THREADS_TEXT_LIMIT: usize = 500;

pub fn threads_text_limit(target: &str) -> usize {
    platform_profile(target)
        .and_then(|profile| profile.limits.text)
        .unwrap_or(THREADS_TEXT_LIMIT)
}

/// A hidden Telegram text_link has no visible URL, so Threads would show a
/// word that links nowhere. Exactly one such link is appended, the first one,
/// and only if it fits — it is a postscript, not part of a sentence. URLs the
/// author typed stay untouched and count as text.
pub fn threads_body(target: &str, text: &str, entities: &[Entity]) -> ThreadsBody {
    let body = text.trim_text().to_owned();
    let Some(url) = first_text_link_url(entities) else {
        return ThreadsBody {
            text: body,
            url: None,
            dropped_url: None,
            shortfall: 0,
        };
    };
    let with_url = format!("{body}\n\n🔗 {url}");
    let limit = threads_text_limit(target);
    if utf16_len(&with_url) <= limit {
        return ThreadsBody {
            text: with_url,
            url: Some(url.to_owned()),
            dropped_url: None,
            shortfall: 0,
        };
    }
    ThreadsBody {
        shortfall: utf16_len(&with_url) - limit,
        text: body,
        url: None,
        dropped_url: Some(url.to_owned()),
    }
}

pub fn is_threads_target(target: &str) -> bool {
    target == "threads_ru" || target == "threads_en"
}
