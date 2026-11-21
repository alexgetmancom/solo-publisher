use std::collections::HashMap;
use std::sync::LazyLock;

use foundation::js::trim;
use regex::Regex;

use crate::js::{WHITESPACE_CLASS, utf16_len};

#[derive(Clone, Debug, PartialEq)]
pub struct LocaleText {
    pub locale: String,
    pub text: Option<String>,
}

/// An entry of the reviewed catalogue: a company, a model or a topic.
#[derive(Clone, Debug, PartialEq)]
pub struct CatalogEntity {
    pub id: i64,
    pub kind: String,
    pub parent_entity_id: Option<i64>,
    pub slug: String,
    pub title_ru: String,
    pub title_en: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct EntityAlias {
    pub entity_id: i64,
    pub alias: String,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum LinkRole {
    Focus,
    Mention,
}

impl LinkRole {
    pub fn as_str(self) -> &'static str {
        match self {
            LinkRole::Focus => "focus",
            LinkRole::Mention => "mention",
        }
    }
}

/// What enrichment reads and writes. A caller inside a transaction passes a
/// store over that transaction, so the links land with the publication.
pub trait EntityEnrichmentStore {
    type Error;
    fn locales(&mut self, draft_id: i64) -> Result<Vec<LocaleText>, Self::Error>;
    fn entities(&mut self) -> Result<Vec<CatalogEntity>, Self::Error>;
    fn aliases(&mut self) -> Result<Vec<EntityAlias>, Self::Error>;
    fn link(&mut self, draft_id: i64, entity_id: i64, role: LinkRole, created_at: &str) -> Result<(), Self::Error>;
}

/// Deterministic, non-blocking enrichment for published stories. It only uses
/// a small reviewed catalogue; ambiguous AI guesses never become public links.
/// A focus is deliberately stricter than a mention: only focuses feed hubs.
/// Returns how many distinct entities were linked.
pub fn enrich_published_post_entities<S: EntityEnrichmentStore>(
    store: &mut S,
    draft_id: i64,
    now: &str,
) -> Result<usize, S::Error> {
    let locales = store.locales(draft_id)?;
    let text = locales
        .iter()
        .map(|locale| locale.text.as_deref().unwrap_or(""))
        .collect::<Vec<_>>()
        .join("\n")
        .to_lowercase();
    if trim(&text).is_empty() {
        return Ok(0);
    }
    let headlines: Vec<String> = locales
        .iter()
        .map(|locale| headline(locale.text.as_deref().unwrap_or("")))
        .filter(|headline| !headline.is_empty())
        .collect();

    let entities = store.entities()?;
    let mut aliases_by_entity: HashMap<i64, Vec<String>> = HashMap::new();
    for alias in store.aliases()? {
        aliases_by_entity.entry(alias.entity_id).or_default().push(alias.alias);
    }
    let aliases = |entity: &CatalogEntity| aliases_by_entity.get(&entity.id).map_or(&[][..], Vec::as_slice);
    // Insertion-ordered sets: the link writes happen in the order entities matched.
    let mut focus: Vec<i64> = Vec::new();
    let mut mentions: Vec<i64> = Vec::new();
    let add = |set: &mut Vec<i64>, id: i64| {
        if !set.contains(&id) {
            set.push(id);
        }
    };
    for entity in &entities {
        if !supports_automatic_matching(&entity.kind, &entity.slug) || !entity_matches(&text, entity, aliases(entity)) {
            continue;
        }
        if entity_is_focus(entity, aliases(entity), &headlines, &text) {
            add(&mut focus, entity.id);
        } else {
            add(&mut mentions, entity.id);
        }
        if let Some(parent) = entity.parent_entity_id {
            add(&mut mentions, parent);
        }
    }
    // An entity can land in both sets — a matched entity's parent is always a
    // mention — and the link write is an upsert on (draft, entity). Focus is
    // written last on purpose: it is the stronger role and must win the conflict.
    // Swap these two loops and matched focuses silently degrade to mentions.
    for &entity_id in &mentions {
        store.link(draft_id, entity_id, LinkRole::Mention, now)?;
    }
    for &entity_id in &focus {
        store.link(draft_id, entity_id, LinkRole::Focus, now)?;
    }
    Ok(mentions.len() + focus.iter().filter(|id| !mentions.contains(id)).count())
}

fn supports_automatic_matching(kind: &str, slug: &str) -> bool {
    kind == "company" || kind == "model" || (kind == "topic" && slug == "codex")
}

static CODEX_VIA: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(&format!("(?:с помощью|через)[{WHITESPACE_CLASS}]+codex")).unwrap());
// JavaScript's `\b` is an ASCII word boundary, so Cyrillic around a keyword
// still counts as a boundary. `[\s\S]{0,80}` counted UTF-16 units; this counts
// characters.
static BUILT_WITH_CODEX: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(&format!(
        r"(?-u:\b)(?:built|build|created|made|ported|developed)(?-u:\b)(?s:.){{0,80}}(?-u:\b)(?:with|using|via)[{WHITESPACE_CLASS}]+codex"
    ))
    .unwrap()
});
static COMPARISON: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(r"(?-u:\b)(?:vs|versus|competitor|competes)(?-u:\b)|конкурент|сравнен|против").unwrap()
});

fn entity_is_focus(entity: &CatalogEntity, aliases: &[String], headlines: &[String], text: &str) -> bool {
    if entity.kind == "topic" && entity.slug == "codex" {
        return headlines.iter().any(|value| contains_name(value, "codex"))
            || CODEX_VIA.is_match(text)
            || BUILT_WITH_CODEX.is_match(text);
    }
    if entity.kind != "model" {
        return false;
    }
    headlines
        .iter()
        .any(|value| !COMPARISON.is_match(value) && entity_matches(value, entity, aliases))
}

fn headline(value: &str) -> String {
    trim(value.split('\n').next().unwrap_or("")).to_lowercase()
}

fn entity_matches(text: &str, entity: &CatalogEntity, aliases: &[String]) -> bool {
    let slug = entity.slug.replace('-', " ");
    [
        slug.as_str(),
        &entity.title_ru,
        entity.title_en.as_deref().unwrap_or(""),
    ]
    .into_iter()
    .chain(aliases.iter().map(String::as_str))
    .map(|name| trim(name).to_lowercase())
    .filter(|name| utf16_len(name) >= 3)
    .any(|name| contains_name(text, &name))
}

/// Whole-name matching, never a substring: a plain `includes` linked "gpt" from
/// inside "chatgpt" and "meta" from inside "метаданные", and those wrong links
/// are public — they reach the article's JSON-LD `about` block. Boundaries are
/// defined over Unicode letters/digits so Cyrillic titles behave like Latin.
fn contains_name(value: &str, name: &str) -> bool {
    Regex::new(&format!(
        r"(?i)(?:^|[^\p{{L}}\p{{N}}]){}(?:$|[^\p{{L}}\p{{N}}])",
        regex::escape(name)
    ))
    .unwrap()
    .is_match(value)
}
