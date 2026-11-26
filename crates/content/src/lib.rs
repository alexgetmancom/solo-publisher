//! Content: what a post is made of before any platform sees it. Text and its
//! Telegram entities, Markdown articles, thread parts and the chains they are
//! cut into, a draft's per-locale content, media naming and limits, and the
//! pure half of machine translation.
//!
//! Entity offsets and lengths are UTF-16 code units, as Telegram measures them
//! and as `String.length` reports them; every function here converts at that
//! boundary rather than counting `char`s.

pub mod assets;
pub mod draft_content;
pub mod entity_enrichment;
mod js;
pub mod markdown;
pub mod media_size_advice;
pub mod message;
pub mod site_media_naming;
pub mod text;
pub mod text_locale;
pub mod thread;
pub mod title_emphasis;
pub mod translation;

/// A content language: the text a post carries, independent of the Russian-only interface.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Locale {
    Ru,
    En,
}

impl Locale {
    pub fn as_str(self) -> &'static str {
        match self {
            Locale::Ru => "ru",
            Locale::En => "en",
        }
    }
}
