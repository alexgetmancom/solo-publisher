//! The test cases that pinned real bugs in content logic, kept as
//! named assertions: the parity corpus covers them too, but a failure here says
//! which bug came back.

use content::Locale;
use content::draft_content::{DraftContentSource, draft_locale_content};
use content::entity_enrichment::*;
use content::markdown::parse_markdown_article;
use content::message::{Entity, slugify};
use content::text::{entities_to_html, split_text};
use content::text_locale::text_locale;
use content::thread::{LocalizedThreadPart, chain_posts};
use content::title_emphasis::emphasize_title;
use serde_json::{Value, json};

fn entities(value: Value) -> Vec<Entity> {
    serde_json::from_value(value).unwrap()
}

// Telegram entity HTML
#[test]
fn nested_entities_sharing_a_range_do_not_tear_the_markup() {
    let html = entities_to_html(
        "click here",
        &entities(json!([
            { "type": "text_link", "offset": 0, "length": 10, "url": "https://example.com/" },
            { "type": "bold", "offset": 0, "length": 5 },
        ])),
    );
    assert_eq!(
        html,
        r#"<a href="https://example.com/" rel="noopener noreferrer"><strong>click</strong> here</a>"#
    );
}

#[test]
fn an_entity_past_the_text_is_dropped_and_a_schemeless_url_links_https() {
    assert_eq!(
        entities_to_html(
            "short",
            &entities(json!([{ "type": "bold", "offset": 2, "length": 99 }]))
        ),
        "short"
    );
    assert_eq!(
        entities_to_html(
            "go example.com now",
            &entities(json!([{ "type": "url", "offset": 3, "length": 11 }]))
        ),
        r#"go <a href="https://example.com" rel="noopener noreferrer">example.com</a> now"#
    );
}

// Never cuts a surrogate pair in half
#[test]
fn an_unbroken_run_is_never_cut_inside_a_character() {
    let text = format!("{}👨🏽‍🚀{}", "a".repeat(9), "b".repeat(9));
    let parts = split_text(&text, 10);
    assert!(parts.iter().all(|part| part.encode_utf16().count() <= 10));
    assert_eq!(parts.concat(), text);
}

// Splitting a post into a chain
#[test]
fn a_chain_cuts_where_a_sentence_ends() {
    let first = "Мы починили разбивку тредов, и это заняло больше времени, чем хотелось.";
    let second = "Теперь английский режется так же, как русский!";
    let text = format!("{first} {second} {}", "хвост ".repeat(20));
    let limit = first.encode_utf16().count() + 20;
    assert_eq!(split_text(text.trim(), limit)[0], first);
}

#[test]
fn chain_pieces_after_the_first_carry_no_media_and_no_entities() {
    let post = LocalizedThreadPart {
        text: format!("{} tail", "a".repeat(500)),
        entities: entities(json!([{ "type": "bold", "offset": 0, "length": 4 }])),
        media: vec!["photo"],
    };
    let chain = chain_posts(&[post], 500);
    assert_eq!(
        chain.iter().map(|post| post.text.as_str()).collect::<Vec<_>>(),
        ["a".repeat(500), "tail".into()]
    );
    assert_eq!(chain[0].media, ["photo"]);
    assert!(chain[1].media.is_empty() && chain[1].entities.is_empty());
}

// Markdown article
#[test]
fn markdown_offsets_are_measured_against_the_stripped_text() {
    let body = parse_markdown_article("**one** and *two*").body;
    assert_eq!(body.text, "one and two");
    assert_eq!(
        json!(body.entities),
        json!([{ "type": "bold", "offset": 0, "length": 3 }, { "type": "italic", "offset": 8, "length": 3 }])
    );
    let body = parse_markdown_article("[click](javascript:alert)").body;
    assert_eq!((body.text.as_str(), body.entities.len()), ("click", 0));
}

// Preserves Cyrillic letters with diacritics (NFKD dropped the breve of "й")
#[test]
fn slugs_keep_cyrillic_letters_with_diacritics() {
    assert_eq!(
        slugify("Claude Code получил встроенный браузер", 54),
        "claude-code-получил-встроенный-браузер"
    );
    assert_eq!(slugify("Ёлки и йога", 55), "ёлки-и-йога");
}

// Does not bold a title twice
#[test]
fn an_already_bold_title_is_not_bolded_again() {
    let bold = entities(json!([{ "type": "bold", "offset": 0, "length": 9 }]));
    assert_eq!(emphasize_title("Заголовок\n\nТело", &bold), bold);
}

// A list of names is not English
#[test]
fn a_list_of_names_is_not_english() {
    assert_eq!(
        text_locale("Astra: Bun, Drizzle, SQLite, Hono, Astro, Biome, Lefthook, GitHub Actions"),
        None
    );
    assert_eq!(
        text_locale("Сегодня разобрал, как мы используем React, TypeScript и Bun в проде — вышло короче, чем ожидал"),
        Some(Locale::Ru)
    );
}

// The English locale used to borrow `text_ru` and publish Russian on English targets.
#[test]
fn english_content_never_borrows_the_russian_text() {
    let draft = DraftContentSource {
        text_ru: Some("Привет"),
        ..DraftContentSource::default()
    };
    assert_eq!(draft_locale_content(&draft, Locale::En).text, "");
}

struct Links(Vec<(i64, LinkRole)>, &'static str);

impl EntityEnrichmentStore for Links {
    type Error = std::convert::Infallible;
    fn locales(&mut self, _draft_id: i64) -> Result<Vec<LocaleText>, Self::Error> {
        Ok(vec![LocaleText {
            locale: "ru".into(),
            text: Some(self.1.into()),
        }])
    }
    fn entities(&mut self) -> Result<Vec<CatalogEntity>, Self::Error> {
        let entity = |id, kind: &str, parent, slug: &str, title: &str| CatalogEntity {
            id,
            kind: kind.into(),
            parent_entity_id: parent,
            slug: slug.into(),
            title_ru: title.into(),
            title_en: None,
        };
        Ok(vec![
            entity(1, "model", Some(2), "gpt", "GPT"),
            entity(2, "model", None, "meta", "Meta"),
            entity(3, "model", Some(1), "gpt-5", "GPT-5"),
        ])
    }
    fn aliases(&mut self) -> Result<Vec<EntityAlias>, Self::Error> {
        Ok(Vec::new())
    }
    fn link(&mut self, _draft_id: i64, entity_id: i64, role: LinkRole, _created_at: &str) -> Result<(), Self::Error> {
        self.0.push((entity_id, role));
        Ok(())
    }
}

// Substring matching linked "gpt" inside "chatgpt" and "meta" inside "метаданные",
// and writing focus before mention let a parent's mention overwrite its focus.
#[test]
fn enrichment_matches_whole_names_and_writes_focus_last() {
    let mut store = Links(Vec::new(), "ChatGPT читает метаданные");
    assert_eq!(enrich_published_post_entities(&mut store, 1, "now"), Ok(0));

    let mut store = Links(Vec::new(), "GPT и GPT-5 вышли\n\nтело");
    assert_eq!(enrich_published_post_entities(&mut store, 1, "now"), Ok(3));
    assert_eq!(
        store.0,
        [
            (2, LinkRole::Mention),
            (1, LinkRole::Mention),
            (1, LinkRole::Focus),
            (3, LinkRole::Focus)
        ]
    );
}
