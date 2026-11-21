//! Which language a post is written in, or None when the text does not say.
//!
//! Alphabet, not vocabulary. A Russian post here is Cyrillic with Latin islands
//! — product names, code, handles, links — and an English post is Latin with no
//! Cyrillic at all. Counting letters by script and demanding a wide margin is
//! what keeps "используем React и Bun" from reading as English.
//!
//! Everything between the two margins is unknown, and unknown never blocks: a
//! wrong refusal costs a publication that was fine, a missed one costs nothing
//! but the check. The margins are set so no real post lands in the middle — a
//! translated post is above 0.9 Cyrillic or at 0.

use std::sync::LazyLock;

use regex::Regex;

use crate::Locale;
use crate::js::{WHITESPACE_CLASS, utf16_len};

/// Links, handles, hashtags and code are Latin in both languages, so they are
/// noise here: without this a short Russian post carrying a URL reads English.
static NOT_PROSE: LazyLock<Regex> = LazyLock::new(|| {
    let word = format!("[^{WHITESPACE_CLASS}]+");
    Regex::new(&format!(r"https?://{word}|www\.{word}|[@#]{word}|`[^`]*`")).unwrap()
});
static CYRILLIC: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Script=Cyrillic}").unwrap());
static LATIN: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{Script=Latin}").unwrap());
static LETTERS: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\p{L}+").unwrap());
static LOWERCASE_START: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^\p{Ll}").unwrap());
static NUMBER_OR_UNDERSCORE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^[\p{N}_]$").unwrap());

/// Under this there is no signal to read: a link, an emoji and a brand name are
/// not a language.
const MINIMUM_LETTERS: usize = 24;
const RUSSIAN_SHARE: f64 = 0.5;
const ENGLISH_SHARE: f64 = 0.1;

pub fn text_locale(value: &str) -> Option<Locale> {
    let prose = NOT_PROSE.replace_all(value, " ");
    let cyrillic = CYRILLIC.find_iter(&prose).count();
    let latin = LATIN.find_iter(&prose).count();
    let letters = cyrillic + latin;
    if letters < MINIMUM_LETTERS {
        return None;
    }
    let share = cyrillic as f64 / letters as f64;
    if share >= RUSSIAN_SHARE {
        return Some(Locale::Ru);
    }
    if share > ENGLISH_SHARE {
        return None;
    }
    // Absence of Cyrillic is not English. A Russian post can be a list of the
    // things it is about — "Astra, Bun, Threads API, YouTube Shorts" — and calling
    // that English would refuse it on the Russian channel it was written for.
    // English prose is carried by its lowercase words; a list of names has none.
    (lowercase_letters(&prose) >= MINIMUM_LETTERS).then_some(Locale::En)
}

/// UTF-16 length of the words a sentence is built from, as opposed to the
/// names it mentions: `(?<![\p{L}\p{N}_])\p{Ll}\p{L}*`, which is every run of
/// letters that starts lowercase and does not continue a number or identifier.
fn lowercase_letters(prose: &str) -> usize {
    LETTERS
        .find_iter(prose)
        .filter(|run| LOWERCASE_START.is_match(run.as_str()))
        .filter(|run| {
            !prose[..run.start()]
                .chars()
                .next_back()
                .is_some_and(|prev| NUMBER_OR_UNDERSCORE.is_match(prev.encode_utf8(&mut [0; 4])))
        })
        .map(|run| utf16_len(run.as_str()))
        .sum()
}
