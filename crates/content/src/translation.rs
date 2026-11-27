//! The model-independent half of machine translation into English: when a
//! text is worth translating, what the model is told, and which answers are
//! refused. The DeepSeek call itself is an adapter; it trims the answer.

use std::sync::LazyLock;
use std::time::Duration;

use foundation::errors::StudioError;
use foundation::text::TrimText;
use regex::Regex;

pub const SYSTEM_PROMPT: &str = "\
Translate the user message into English, adapted for Twitter: informal and natural, the way someone who knows the subject writes for an audience that follows it.
Translate only. Keep the author's structure, order, length, facts and numbers. Do not rewrite, reorder, shorten, expand, or add anything of your own.
Output only the translation. No explanations, no hashtags, no commentary, no asking for more input.
Preserve product names, version numbers, commands, URLs, emojis, paragraph breaks, and the bullet character •.
Keep lowercase list items lowercase. Avoid em dashes and word-for-word phrasing that reads translated.
For every term, use the established English word that people in that subject already use, whatever the subject is. Never invent a term and never translate a term literally when the field has its own name for it.";

pub const TEMPERATURE: f64 = 0.1;
pub const TIMEOUT: Duration = Duration::from_secs(40);

/// What translating one text comes to.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TranslationStep<'a> {
    /// Nothing to translate: blank, not Russian, or no translator configured.
    /// The trimmed text is its own English.
    Unchanged(&'a str),
    /// Ask the model, with [`SYSTEM_PROMPT`] and this trimmed text as the user message.
    Ask(&'a str),
}

pub fn translation_step(text: &str, has_translator: bool) -> TranslationStep<'_> {
    let source = text.trim_text();
    if source.is_empty() || !has_translator || !has_cyrillic(source) {
        TranslationStep::Unchanged(source)
    } else {
        TranslationStep::Ask(source)
    }
}

static REFUSAL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i-u:please provide|i'd be happy to help)").unwrap());

/// The model's trimmed answer, unless it is empty or the model answered as a
/// chat assistant instead of translating.
pub fn checked_translation(answer: &str) -> Result<&str, StudioError> {
    if answer.is_empty() || REFUSAL.is_match(answer) {
        return Err(StudioError::new("translation returned an invalid response"));
    }
    Ok(answer)
}

/// Whether this Studio would translate this text at all: it publishes English,
/// there is a translator to ask, and the text is Russian. The queue is only
/// written when the answer is yes, so a row waiting to be worked is exactly the
/// drafts whose English is still coming.
pub fn translation_wanted(text: &str, has_translator: bool, publishes_english: bool) -> bool {
    !text.trim_text().is_empty() && has_translator && has_cyrillic(text) && publishes_english
}

fn has_cyrillic(value: &str) -> bool {
    value.chars().any(|c| ('\u{400}'..='\u{4ff}').contains(&c))
}
