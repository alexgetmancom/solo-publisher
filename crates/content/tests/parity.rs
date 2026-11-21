//! Parity with the TypeScript content modules, against outputs recorded by
//! `bun scripts/rust/content-fixtures.ts`.

use std::path::Path;

use content::Locale;
use content::draft_content::{DraftContentSource, draft_locale_content};
use content::entity_enrichment::*;
use content::markdown::parse_markdown_article;
use content::media_size_advice::media_size_advice;
use content::message::{Entity, MediaItem, first_line, first_non_empty_line, fix_url_slashes, slugify};
use content::site_media_naming::*;
use content::text::{entities_to_html, first_text_link_url, split_text};
use content::text_locale::text_locale;
use content::thread::{LocalizedThreadPart, ThreadPart, chain_posts, joined_thread, localized_thread};
use content::title_emphasis::emphasize_title;
use content::translation::*;
use foundation::html::escape_html;
use foundation::js::trim;
use foundation::url::is_http_url;
use serde_json::{Value, json};

fn fixture(name: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures").join(name);
    serde_json::from_str(&std::fs::read_to_string(&path).unwrap()).unwrap()
}

fn rows<'a>(value: &'a Value, key: &str) -> &'a Vec<Value> {
    let rows = value[key].as_array().unwrap();
    assert!(!rows.is_empty(), "fixture section {key} is empty");
    rows
}

fn text(value: &Value) -> &str {
    value
        .as_str()
        .unwrap_or_else(|| panic!("expected a string, got {value}"))
}

fn objects(value: &Value) -> Vec<Entity> {
    serde_json::from_value(value.clone()).unwrap()
}

fn locale(value: &Value) -> Locale {
    match text(value) {
        "ru" => Locale::Ru,
        "en" => Locale::En,
        other => panic!("unknown locale {other}"),
    }
}

fn localized_part<M: serde::de::DeserializeOwned>(value: &Value) -> LocalizedThreadPart<M> {
    LocalizedThreadPart {
        text: text(&value["text"]).to_owned(),
        entities: objects(&value["entities"]),
        media: serde_json::from_value(value["media"].clone()).unwrap(),
    }
}

fn localized_json<M: serde::Serialize>(part: &LocalizedThreadPart<M>) -> Value {
    json!({ "text": part.text, "entities": part.entities, "media": part.media })
}

#[test]
fn split_text_cuts_where_typescript_cuts() {
    let fixture = fixture("text.json");
    for case in rows(&fixture, "split") {
        let limit = case["limit"].as_u64().unwrap() as usize;
        assert_eq!(json!(split_text(text(&case["text"]), limit)), case["parts"], "{case}");
    }
}

#[test]
fn entities_render_to_the_same_html() {
    let fixture = fixture("text.json");
    for case in rows(&fixture, "html") {
        assert_eq!(
            entities_to_html(text(&case["text"]), &objects(&case["entities"])),
            text(&case["html"]),
            "{case}"
        );
    }
    for case in rows(&fixture, "first_text_link") {
        assert_eq!(
            json!(first_text_link_url(&objects(&case["entities"]))),
            case["url"],
            "{case}"
        );
    }
    for case in rows(&fixture, "is_http_url") {
        assert_eq!(
            is_http_url(text(&case["value"])),
            case["ok"].as_bool().unwrap(),
            "{case}"
        );
    }
    for case in rows(&fixture, "escape_html") {
        assert_eq!(escape_html(text(&case["value"])), text(&case["html"]), "{case}");
    }
}

#[test]
fn markdown_articles_parse_to_the_same_text_and_entities() {
    let fixture = fixture("markdown.json");
    for case in rows(&fixture, "articles") {
        let parsed = parse_markdown_article(text(&case["source"]));
        let actual = json!({
            "title": parsed.title,
            "body": { "text": parsed.body.text, "media": parsed.body.media, "entities": parsed.body.entities },
        });
        assert_eq!(actual, case["parsed"], "{case}");
    }
}

#[test]
fn threads_localize_join_and_chain_alike() {
    let fixture = fixture("thread.json");
    for case in rows(&fixture, "localized") {
        let thread: Vec<ThreadPart> = case["thread"]
            .as_array()
            .unwrap()
            .iter()
            .map(|part| ThreadPart {
                position: part["position"].as_i64().unwrap(),
                text_ru: text(&part["textRu"]).to_owned(),
                entities_ru: objects(&part["entitiesRu"]),
                text_en: part["textEn"].as_str().map(str::to_owned),
                text_en_approved: part["textEnApproved"].as_str().map(str::to_owned),
                media: objects(&part["media"]),
            })
            .collect();
        let parts: Vec<Value> = localized_thread(&thread, locale(&case["locale"]))
            .iter()
            .map(localized_json)
            .collect();
        assert_eq!(json!(parts), case["parts"], "{case}");
    }
    for case in rows(&fixture, "joined") {
        let rest: Vec<LocalizedThreadPart<MediaItem>> =
            case["rest"].as_array().unwrap().iter().map(localized_part).collect();
        let (joined, entities) = joined_thread(
            text(&case["first"]["text"]),
            &objects(&case["first"]["entities"]),
            &rest,
        );
        assert_eq!(
            json!({ "text": joined, "entities": entities }),
            case["joined"],
            "{case}"
        );
    }
    for case in rows(&fixture, "chains") {
        let posts: Vec<LocalizedThreadPart<Value>> =
            case["posts"].as_array().unwrap().iter().map(localized_part).collect();
        let limit = case["limit"].as_u64().unwrap() as usize;
        let chain: Vec<Value> = chain_posts(&posts, limit).iter().map(localized_json).collect();
        assert_eq!(json!(chain), case["chain"], "{case}");
    }
}

#[test]
fn message_helpers_match() {
    let fixture = fixture("message.json");
    for case in rows(&fixture, "first_line") {
        assert_eq!(
            first_line(case["text"].as_str(), "fallback"),
            text(&case["result"]),
            "{case}"
        );
    }
    for case in rows(&fixture, "first_non_empty_line") {
        assert_eq!(
            first_non_empty_line(case["text"].as_str(), "fallback"),
            text(&case["result"]),
            "{case}"
        );
        assert_eq!(
            first_non_empty_line(case["text"].as_str(), ""),
            text(&case["empty"]),
            "{case}"
        );
    }
    for case in rows(&fixture, "fix_url_slashes") {
        assert_eq!(fix_url_slashes(text(&case["text"])), text(&case["fixed"]), "{case}");
    }
    for case in rows(&fixture, "slugify") {
        assert_eq!(
            slugify(text(&case["text"]), case["post_id"].as_i64().unwrap()),
            text(&case["slug"]),
            "{case}"
        );
    }
}

#[test]
fn titles_are_emphasized_alike() {
    let fixture = fixture("title-emphasis.json");
    for case in rows(&fixture, "cases") {
        assert_eq!(
            json!(emphasize_title(text(&case["text"]), &objects(&case["entities"]))),
            case["result"],
            "{case}"
        );
    }
}

#[test]
fn text_locale_reads_the_same_language() {
    let fixture = fixture("text-locale.json");
    for case in rows(&fixture, "cases") {
        assert_eq!(
            json!(text_locale(text(&case["text"])).map(Locale::as_str)),
            case["locale"],
            "{case}"
        );
    }
}

/// The catalogue the fixture recorded, and every link enrichment wrote.
struct MemoryStore {
    locales: Vec<LocaleText>,
    entities: Vec<CatalogEntity>,
    aliases: Vec<EntityAlias>,
    links: Vec<Value>,
}

impl EntityEnrichmentStore for MemoryStore {
    type Error = std::convert::Infallible;
    fn locales(&mut self, _draft_id: i64) -> Result<Vec<LocaleText>, Self::Error> {
        Ok(self.locales.clone())
    }
    fn entities(&mut self) -> Result<Vec<CatalogEntity>, Self::Error> {
        Ok(self.entities.clone())
    }
    fn aliases(&mut self) -> Result<Vec<EntityAlias>, Self::Error> {
        Ok(self.aliases.clone())
    }
    fn link(&mut self, draft_id: i64, entity_id: i64, role: LinkRole, created_at: &str) -> Result<(), Self::Error> {
        let link =
            json!({ "draft_id": draft_id, "entity_id": entity_id, "role": role.as_str(), "created_at": created_at });
        self.links.push(link);
        Ok(())
    }
}

#[test]
fn enrichment_links_the_same_entities_in_the_same_order() {
    let fixture = fixture("entity-enrichment.json");
    let catalog = &rows(&fixture, "catalog")[0];
    let entities: Vec<CatalogEntity> = catalog["entities"]
        .as_array()
        .unwrap()
        .iter()
        .map(|entity| CatalogEntity {
            id: entity["id"].as_i64().unwrap(),
            kind: text(&entity["kind"]).to_owned(),
            parent_entity_id: entity["parentEntityId"].as_i64(),
            slug: text(&entity["slug"]).to_owned(),
            title_ru: text(&entity["titleRu"]).to_owned(),
            title_en: entity["titleEn"].as_str().map(str::to_owned),
        })
        .collect();
    let aliases: Vec<EntityAlias> = catalog["aliases"]
        .as_array()
        .unwrap()
        .iter()
        .map(|alias| EntityAlias {
            entity_id: alias["entityId"].as_i64().unwrap(),
            alias: text(&alias["alias"]).to_owned(),
        })
        .collect();
    for case in rows(&fixture, "drafts") {
        let locales = case["locales"]
            .as_array()
            .unwrap()
            .iter()
            .map(|locale| LocaleText {
                locale: text(&locale["locale"]).to_owned(),
                text: locale["text"].as_str().map(str::to_owned),
            })
            .collect();
        let mut store = MemoryStore {
            locales,
            entities: entities.clone(),
            aliases: aliases.clone(),
            links: Vec::new(),
        };
        let draft_id = case["draft_id"].as_i64().unwrap();
        let linked = enrich_published_post_entities(&mut store, draft_id, "2026-11-21T10:00:00.000Z").unwrap();
        assert_eq!(linked as u64, case["linked"].as_u64().unwrap(), "{case}");
        assert_eq!(json!(store.links), case["links"], "{case}");
    }
}

#[test]
fn draft_locale_content_resolves_alike() {
    let fixture = fixture("draft-content.json");
    for case in rows(&fixture, "cases") {
        let field = |name: &str| case["source"][name].as_str();
        let source = DraftContentSource {
            text_ru: field("text_ru"),
            text_en_approved: field("text_en_approved"),
            text_en_machine: field("text_en_machine"),
            text_ru_entities_json: field("text_ru_entities_json"),
            text_en_entities_json: field("text_en_entities_json"),
            media_ru_json: field("media_ru_json"),
            media_en_json: field("media_en_json"),
        };
        let content = draft_locale_content(&source, locale(&case["locale"]));
        let actual = json!({
            "text": content.text, "entities": content.entities, "media": content.media, "ownMedia": content.own_media,
        });
        assert_eq!(actual, case["content"], "{case}");
    }
}

#[test]
fn media_advice_and_naming_match() {
    let fixture = fixture("media.json");
    for case in rows(&fixture, "size_advice") {
        let advice = media_size_advice(&objects(&case["media"])).map(
            |advice| json!({ "megabytes": advice.megabytes, "recommendedMegabytes": advice.recommended_megabytes }),
        );
        assert_eq!(json!(advice), case["advice"], "{case}");
    }
    for case in rows(&fixture, "naming") {
        let value = &case["value"];
        match text(&case["kind"]) {
            "url_prefix" => assert_eq!(SITE_MEDIA_URL_PREFIX, text(value)),
            "responsive_widths" => assert_eq!(json!(RESPONSIVE_WIDTHS), *value),
            "filenames" => {
                let (post_id, locale, index) = (
                    value[0].as_i64().unwrap(),
                    locale(&value[1]),
                    value[2].as_u64().unwrap(),
                );
                assert_eq!(
                    site_media_filename(post_id, locale, index as usize, text(&value[3])),
                    text(&value[4])
                );
                assert_eq!(
                    site_media_poster_filename(post_id, locale, index as usize),
                    text(&value[5])
                );
            }
            other => panic!("unknown naming case {other}"),
        }
    }
}

#[test]
fn translation_asks_and_accepts_alike() {
    let fixture = fixture("translation.json");
    for case in rows(&fixture, "wanted") {
        let wanted = translation_wanted(
            text(&case["text"]),
            case["has_translator"].as_bool().unwrap(),
            case["publishes_english"].as_bool().unwrap(),
        );
        assert_eq!(wanted, case["wanted"].as_bool().unwrap(), "{case}");
    }
    for case in rows(&fixture, "translations") {
        let (request, result) = match translation_step(text(&case["text"]), case["has_translator"].as_bool().unwrap()) {
            TranslationStep::Unchanged(source) => (Value::Null, json!(source)),
            TranslationStep::Ask(source) => (
                json!({
                    "model": "deepseek-chat",
                    "messages": [{ "role": "system", "content": SYSTEM_PROMPT }, { "role": "user", "content": source }],
                    "temperature": TEMPERATURE,
                }),
                json!(checked_translation(trim(text(&case["response"]))).ok()),
            ),
        };
        assert_eq!(request, case["request"], "{case}");
        assert_eq!(result, case["result"], "{case}");
    }
}
