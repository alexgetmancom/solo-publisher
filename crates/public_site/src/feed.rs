//! The published-site read model (`public/site-read-model.ts`): the posts the
//! public site shows, read only from stable publication data and cached per
//! database connection until a publication input changes or a scheduled
//! locale's moment arrives.

use std::cell::RefCell;
use std::collections::HashMap;
use std::rc::Rc;

use db::rusqlite::types::ValueRef;
use db::rusqlite::{Connection, Row, params_from_iter};
use db::{BackendDb, unsafe_db};
use domain::application::ports::{Clock, DomainEventInput, Severity};
use domain::repositories::record_event;
use foundation::js::{MAX_SAFE_INTEGER, number_to_string};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

/// A media entry of a published locale: the stored manifest object, with
/// every field the worker wrote (the HTTP layer picks the public ones).
pub type SiteMedia = Map<String, Value>;

/// The feed in archive order. The same `Rc` comes back while nothing in it
/// changed, which is what lets the HTTP layer reuse its serialised answer.
pub type Feed = Rc<Vec<Rc<FeedItem>>>;

#[derive(Clone, Debug, PartialEq)]
pub struct FeedEntity {
    pub kind: &'static str,
    pub slug: String,
    pub title_ru: String,
    pub title_en: Option<String>,
    pub link_role: &'static str,
}

/// One post as the strict `feedItemSchema` admits it; field order is the
/// public JSON's. `audio_url_*`/`spotify_url_*` are declared there but never
/// produced, so they have no field here.
#[derive(Clone, Debug, PartialEq)]
pub struct FeedItem {
    pub id: String,
    pub post_id: f64,
    pub date: String,
    pub updated_at_ru: Option<String>,
    pub updated_at_en: Option<String>,
    pub text: String,
    pub text_ru: String,
    pub text_en: String,
    pub html: String,
    pub html_en: String,
    pub slug_ru: Option<String>,
    pub slug_en: Option<String>,
    pub seo_title_ru: Option<String>,
    pub seo_title_en: Option<String>,
    pub has_ru: bool,
    pub has_en: bool,
    pub media: Vec<SiteMedia>,
    pub media_en: Vec<SiteMedia>,
    pub image: Option<String>,
    pub image_en: Option<String>,
    pub entities: Vec<FeedEntity>,
    pub views: f64,
}

const SITE_STATUSES: [&str; 3] = ["published", "failed", "scheduled"];
const ENTITY_KINDS: [&str; 5] = ["company", "model", "person", "product", "topic"];

/// A SQLite value as `bun:sqlite` hands it to JavaScript.
#[derive(Clone, Debug, PartialEq)]
enum Cell {
    Null,
    Number(f64),
    Text(String),
    Blob(Vec<u8>),
}

impl Cell {
    fn read(row: &Row<'_>, index: usize) -> db::rusqlite::Result<Self> {
        Ok(match row.get_ref(index)? {
            ValueRef::Null => Self::Null,
            ValueRef::Integer(value) => Self::Number(value as f64),
            ValueRef::Real(value) => Self::Number(value),
            ValueRef::Text(text) => Self::Text(String::from_utf8_lossy(text).into_owned()),
            ValueRef::Blob(bytes) => Self::Blob(bytes.to_vec()),
        })
    }

    fn is_null(&self) -> bool {
        matches!(self, Self::Null)
    }

    /// JavaScript truthiness.
    fn truthy(&self) -> bool {
        match self {
            Self::Null => false,
            Self::Number(value) => *value != 0.0 && !value.is_nan(),
            Self::Text(text) => !text.is_empty(),
            Self::Blob(_) => true,
        }
    }

    /// `value ?? fallback`.
    fn or(self, fallback: Self) -> Self {
        if self.is_null() { fallback } else { self }
    }

    fn text(&self) -> Option<&str> {
        match self {
            Self::Text(text) => Some(text),
            _ => None,
        }
    }

    /// `String(value)`.
    fn js_string(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Number(value) => number_to_string(*value),
            Self::Text(text) => text.clone(),
            Self::Blob(bytes) => bytes.iter().map(u8::to_string).collect::<Vec<_>>().join(","),
        }
    }

    /// `JSON.stringify(value)`: non-finite numbers are `null`, a byte array an
    /// object of indexes.
    fn json(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Number(value) if !value.is_finite() => "null".into(),
            Self::Number(value) => number_to_string(*value),
            Self::Text(text) => domain::json::stringify(&Value::String(text.clone())),
            Self::Blob(bytes) => {
                let entries: Vec<String> = bytes.iter().enumerate().map(|(i, b)| format!("\"{i}\":{b}")).collect();
                format!("{{{}}}", entries.join(","))
            }
        }
    }

    /// `new Date(value).getTime()` of a truthy value; NaN for anything that is
    /// not an instant. Stored instants are read as ISO strings with an offset.
    fn instant_ms(&self) -> f64 {
        match self {
            Self::Text(text) => {
                foundation::time::parse_iso_instant(text).map_or(f64::NAN, |at| at.as_millisecond() as f64)
            }
            Self::Number(value) if value.abs() <= 8.64e15 => value.trunc(),
            _ => f64::NAN,
        }
    }

    /// zod's name for the received type (`util.parsedType` + `getTypeName`).
    fn type_name(&self) -> String {
        match self {
            Self::Null => "null".into(),
            Self::Number(value) if !value.is_finite() => number_to_string(*value),
            Self::Number(_) => "number".into(),
            Self::Text(_) => "string".into(),
            Self::Blob(_) => "Uint8Array".into(),
        }
    }
}

struct LocaleRow {
    slug: Cell,
    seo_title: Cell,
    text: Cell,
    html: Cell,
    media: Option<Value>,
    enabled: Cell,
    published_at: Cell,
    site_updated_at: Cell,
}

struct FeedRow {
    draft_id: i64,
    post_id: Cell,
    scheduled_at: Cell,
    scheduled_en_at: Cell,
    created_at: Cell,
    ru: LocaleRow,
    en: LocaleRow,
    views: Cell,
}

/// A JSON column as drizzle maps it: `JSON.parse` of whatever SQLite holds,
/// `null` left alone. A value that does not parse fails the whole read.
fn json_column(cell: Cell) -> domain::Result<Option<Value>> {
    let text = match cell {
        Cell::Null => return Ok(None),
        Cell::Text(text) => text,
        other => other.js_string(),
    };
    Ok(Some(serde_json::from_str(&text)?))
}

/// A candidate entity before validation: SQLite does not promise the types.
struct EntityRow {
    kind: &'static str,
    slug: Cell,
    title_ru: Cell,
    title_en: Cell,
    link_role: &'static str,
}

struct CachedItem {
    fingerprint: [u8; 32],
    item: Rc<FeedItem>,
    next_publication_at: f64,
}

struct FeedState {
    items: Feed,
    next_publication_at: f64,
    by_draft: HashMap<i64, CachedItem>,
}

struct CachedFeed {
    /// The connection it was read from: another handle's feed is not this one's.
    connection: usize,
    database_version: (i64, i64),
    state: FeedState,
}

/// The read model's per-connection cache. One reader serves one database
/// handle at a time; handing it another handle rebuilds from scratch.
#[derive(Default)]
pub struct FeedReader {
    cache: RefCell<Option<CachedFeed>>,
}

const SCHEMA: &str = "public_site_cache";

/// Only publication inputs invalidate this connection's feed. A private
/// in-memory counter and TEMP triggers leave the stored database untouched;
/// the counter participates in commit/rollback with the rows it observes.
fn track_feed_changes(sqlite: &Connection) -> domain::Result<()> {
    let attached: bool = sqlite.query_row(
        "SELECT EXISTS (SELECT 1 FROM pragma_database_list WHERE name = ?)",
        [SCHEMA],
        |row| row.get(0),
    )?;
    if attached {
        return Ok(());
    }
    sqlite.execute_batch(
        "ATTACH DATABASE ':memory:' AS public_site_cache;
    CREATE TABLE public_site_cache._public_site_revision (revision INTEGER NOT NULL);
    INSERT INTO public_site_cache._public_site_revision VALUES (0);",
    )?;
    let statuses = SITE_STATUSES.map(|status| format!("'{status}'")).join(",");
    for table in [
        "drafts",
        "post_locales",
        "knowledge_entities",
        "draft_entity_links",
        "post_metrics",
    ] {
        for operation in ["INSERT", "UPDATE", "DELETE"] {
            // Autosaves and private entity edits cannot affect the published query.
            // Both sides matter when a row enters or leaves that query's scope.
            let references: &[&str] = match operation {
                "INSERT" => &["NEW"],
                "DELETE" => &["OLD"],
                _ => &["OLD", "NEW"],
            };
            let ids = |column: &str| {
                references
                    .iter()
                    .map(|row| format!("{row}.{column}"))
                    .collect::<Vec<_>>()
                    .join(",")
            };
            let relevant = match table {
                "drafts" => references
                    .iter()
                    .map(|row| format!("{row}.status IN ({statuses})"))
                    .collect::<Vec<_>>()
                    .join(" OR "),
                "post_locales" | "draft_entity_links" => format!(
                    "EXISTS (SELECT 1 FROM main.drafts WHERE id IN ({}) AND status IN ({statuses}))",
                    ids("draft_id")
                ),
                "knowledge_entities" => format!(
                    "EXISTS (SELECT 1 FROM main.draft_entity_links AS links JOIN main.drafts AS post ON post.id = links.draft_id WHERE links.entity_id IN ({}) AND post.status IN ({statuses}))",
                    ids("id")
                ),
                _ => references
                    .iter()
                    .map(|row| format!("({row}.target = 'telegram' AND {row}.metric_name = 'views')"))
                    .collect::<Vec<_>>()
                    .join(" OR "),
            };
            sqlite.execute_batch(&format!(
                "CREATE TEMP TRIGGER public_site_{table}_{operation}
        AFTER {operation} ON main.{table} WHEN {relevant}
        BEGIN UPDATE _public_site_revision SET revision = revision + 1; END;"
            ))?;
        }
    }
    Ok(())
}

impl FeedReader {
    /// `loadPublicSiteFeed`.
    pub fn load(&self, db: &BackendDb, clock: &dyn Clock) -> domain::Result<Feed> {
        let now = clock.now().as_millisecond() as f64;
        let sqlite = unsafe_db(db);
        // A caller inside a write transaction may read its pending changes, but must
        // not publish them into a cache that survives a rollback.
        if !sqlite.is_autocommit() {
            return Ok(build_feed(sqlite, clock, now, None)?.items);
        }
        let connection = std::ptr::from_ref(sqlite) as usize;
        let mut slot = self.cache.borrow_mut();
        let cached = slot.take().filter(|cached| cached.connection == connection);
        track_feed_changes(sqlite)?;
        // data_version also observes external connections, whose writes do not run
        // our TEMP triggers. Scheduled locales still advance on the clock alone.
        let database_version = sqlite.query_row(
            "SELECT data_version, revision FROM pragma_data_version, public_site_cache._public_site_revision",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )?;
        let state = match cached {
            Some(cached) if cached.database_version == database_version && now < cached.state.next_publication_at => {
                cached.state
            }
            cached => build_feed(sqlite, clock, now, cached.map(|cached| cached.state))?,
        };
        let items = Rc::clone(&state.items);
        *slot = Some(CachedFeed {
            connection,
            database_version,
            state,
        });
        Ok(items)
    }
}

const FEED_SQL: &str = r#"select "drafts"."id", "drafts"."post_id", "drafts"."scheduled_at", "drafts"."scheduled_en_at", "drafts"."created_at", "site_locale_ru"."slug", "site_locale_ru"."seo_title", coalesce("site_locale_ru"."approved_text", "site_locale_ru"."source_text", ''), "site_locale_ru"."html", "site_locale_ru"."site_media_json", "site_locale_ru"."site_enabled", "site_locale_ru"."published_at", "site_locale_ru"."site_updated_at", "site_locale_en"."slug", "site_locale_en"."seo_title", coalesce("site_locale_en"."approved_text", "site_locale_en"."source_text", ''), "site_locale_en"."html", "site_locale_en"."site_media_json", "site_locale_en"."site_enabled", "site_locale_en"."published_at", "site_locale_en"."site_updated_at", "post_metrics"."value" from "drafts" left join "post_locales" "site_locale_ru" on ("site_locale_ru"."draft_id" = "drafts"."id" and "site_locale_ru"."locale" = ?) left join "post_locales" "site_locale_en" on ("site_locale_en"."draft_id" = "drafts"."id" and "site_locale_en"."locale" = ?) left join "post_metrics" on ("post_metrics"."publication_key" = 'post:' || "drafts"."post_id" and "post_metrics"."target" = ? and "post_metrics"."metric_name" = ?) where "drafts"."status" in (?, ?, ?) order by "drafts"."updated_at" desc, "drafts"."post_id" desc"#;

fn read_rows(sqlite: &Connection) -> domain::Result<Vec<FeedRow>> {
    let mut statement = sqlite.prepare_cached(FEED_SQL)?;
    let params = ["ru", "en", "telegram", "views"].into_iter().chain(SITE_STATUSES);
    let raw = statement
        .query_map(params_from_iter(params), |row| {
            let cells = (0..22)
                .map(|index| Cell::read(row, index))
                .collect::<Result<Vec<_>, _>>()?;
            Ok((row.get::<_, i64>(0)?, cells))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    raw.into_iter()
        .map(|(draft_id, cells)| {
            let mut cells = cells.into_iter().skip(1);
            let mut next = || cells.next().unwrap_or(Cell::Null);
            let (post_id, scheduled_at, scheduled_en_at, created_at) = (next(), next(), next(), next());
            let mut locale = || -> domain::Result<LocaleRow> {
                Ok(LocaleRow {
                    slug: next(),
                    seo_title: next(),
                    text: next(),
                    html: next(),
                    media: json_column(next())?,
                    enabled: next(),
                    published_at: next(),
                    site_updated_at: next(),
                })
            };
            let ru = locale()?;
            let en = locale()?;
            Ok(FeedRow {
                draft_id,
                post_id,
                scheduled_at,
                scheduled_en_at,
                created_at,
                ru,
                en,
                views: next(),
            })
        })
        .collect()
}

fn read_entities(sqlite: &Connection, draft_ids: &[i64]) -> domain::Result<HashMap<i64, Vec<EntityRow>>> {
    let mut by_draft: HashMap<i64, Vec<EntityRow>> = HashMap::new();
    if draft_ids.is_empty() {
        return Ok(by_draft);
    }
    let sql = format!(
        r#"select "draft_entity_links"."draft_id", "knowledge_entities"."kind", "knowledge_entities"."slug", "knowledge_entities"."title_ru", "knowledge_entities"."title_en", "draft_entity_links"."link_role" from "draft_entity_links" inner join "knowledge_entities" on "knowledge_entities"."id" = "draft_entity_links"."entity_id" where "draft_entity_links"."draft_id" in ({}) order by "draft_entity_links"."draft_id" asc, "knowledge_entities"."kind" asc, "knowledge_entities"."title_ru" asc"#,
        vec!["?"; draft_ids.len()].join(", ")
    );
    let mut statement = sqlite.prepare(&sql)?;
    let rows = statement.query_map(params_from_iter(draft_ids), |row| {
        (0..6)
            .map(|index| Cell::read(row, index))
            .collect::<Result<Vec<_>, _>>()
    })?;
    for cells in rows {
        let [draft_id, kind, slug, title_ru, title_en, link_role]: [Cell; 6] =
            cells?.try_into().expect("six selected columns");
        let Some(kind) = kind
            .text()
            .and_then(|kind| ENTITY_KINDS.into_iter().find(|known| *known == kind))
        else {
            continue;
        };
        // Links are keyed by an integer draft id; the `in` filter admits no other.
        let Cell::Number(draft_id) = draft_id else { continue };
        by_draft.entry(draft_id as i64).or_default().push(EntityRow {
            kind,
            slug,
            title_ru,
            title_en,
            link_role: if link_role.text() == Some("focus") {
                "focus"
            } else {
                "mention"
            },
        });
    }
    Ok(by_draft)
}

/// What `JSON.stringify([row, entities])` would print, hashed: equal exactly
/// when the TypeScript fingerprint is.
fn fingerprint(row: &FeedRow, entities: &[EntityRow]) -> [u8; 32] {
    let media = |media: &Option<Value>| media.as_ref().map_or_else(|| "null".into(), domain::json::stringify);
    let mut parts = vec![
        row.draft_id.to_string(),
        row.post_id.json(),
        row.scheduled_at.json(),
        row.scheduled_en_at.json(),
        row.created_at.json(),
    ];
    for locale in [&row.ru, &row.en] {
        parts.extend([
            locale.slug.json(),
            locale.seo_title.json(),
            locale.text.json(),
            locale.html.json(),
            media(&locale.media),
            locale.enabled.json(),
            locale.published_at.json(),
            locale.site_updated_at.json(),
        ]);
    }
    parts.push(row.views.json());
    for entity in entities {
        parts.extend([
            entity.kind.to_owned(),
            entity.slug.json(),
            entity.title_ru.json(),
            entity.title_en.json(),
            entity.link_role.to_owned(),
        ]);
    }
    let mut hash = Sha256::new();
    for part in parts {
        hash.update(part.as_bytes());
        hash.update([0]);
    }
    hash.finalize().into()
}

struct LocaleView {
    enabled: bool,
    published_at: Cell,
    text: Cell,
    slug: Cell,
    html: Cell,
    media: Vec<SiteMedia>,
}

fn locale_view(row: &LocaleRow, now: f64) -> LocaleView {
    let published = if row.published_at.truthy() {
        row.published_at.instant_ms() <= now
    } else {
        true
    };
    let enabled = row.enabled == Cell::Number(1.0) && published;
    // A locale that is not published carries nothing. Every caller used to gate
    // on `has_ru`/`has_en` before reading the text, and `/feed.json` serialised
    // the whole item instead — handing out the other language's unpublished draft.
    // Withholding it here is the only place that cannot be forgotten.
    if !enabled {
        return LocaleView {
            enabled,
            published_at: row.published_at.clone(),
            text: Cell::Text(String::new()),
            slug: Cell::Null,
            html: Cell::Text(String::new()),
            media: Vec::new(),
        };
    }
    LocaleView {
        enabled,
        published_at: row.published_at.clone(),
        text: row.text.clone().or(Cell::Text(String::new())),
        slug: row.slug.clone(),
        html: row.html.clone().or(row.text.clone()).or(Cell::Text(String::new())),
        media: published_media(row.media.as_ref()),
    }
}

/// `z.array(siteMediaSchema).safeParse`: an array of objects whose `path` is a
/// non-empty string and whose `type`, `poster`, `alt` are strings when present;
/// any other shape is no media at all. Story-card renders never reach the site.
fn published_media(media: Option<&Value>) -> Vec<SiteMedia> {
    let Some(Value::Array(entries)) = media else {
        return Vec::new();
    };
    let valid = entries.iter().all(|entry| {
        let Value::Object(entry) = entry else { return false };
        let optional_string = |key: &str| entry.get(key).is_none_or(Value::is_string);
        entry
            .get("path")
            .and_then(Value::as_str)
            .is_some_and(|path| !path.is_empty())
            && optional_string("type")
            && optional_string("poster")
            && optional_string("alt")
    });
    if !valid {
        return Vec::new();
    }
    entries
        .iter()
        .filter_map(Value::as_object)
        .filter(|entry| entry.get("role").and_then(Value::as_str) != Some("text_story_card"))
        .cloned()
        .collect()
}

fn first_image(media: &[SiteMedia]) -> Option<String> {
    media
        .iter()
        .find(|entry| entry.get("type").and_then(Value::as_str) != Some("video"))
        .and_then(|entry| entry.get("path").and_then(Value::as_str))
        .map(str::to_owned)
}

/// `feedItemSchema.safeParse` over the values a row produced: zod v4's
/// issues, in field order, for the checks a SQLite value can fail.
struct Validation {
    issues: Vec<Value>,
}

impl Validation {
    fn invalid_type(&mut self, path: Value, expected: &str, received: &Cell) {
        let message = format!("Invalid input: expected {expected}, received {}", received.type_name());
        self.issues.push(match received {
            Cell::Number(value) if expected == "number" && !value.is_finite() => json!({
                "expected": expected, "code": "invalid_type", "received": number_to_string(*value),
                "path": path, "message": message,
            }),
            _ => json!({"expected": expected, "code": "invalid_type", "path": path, "message": message}),
        });
    }

    fn string(&mut self, path: Value, cell: Cell) -> String {
        match cell {
            Cell::Text(text) => text,
            other => {
                self.invalid_type(path, "string", &other);
                String::new()
            }
        }
    }

    fn nullable_string(&mut self, path: Value, cell: Cell) -> Option<String> {
        match cell {
            Cell::Null => None,
            other => Some(self.string(path, other)),
        }
    }

    fn number(&mut self, path: Value, cell: &Cell) -> f64 {
        match cell {
            Cell::Number(value) if value.is_finite() => *value,
            other => {
                self.invalid_type(path, "number", other);
                0.0
            }
        }
    }

    /// `z.number().int().positive()`.
    fn positive_int(&mut self, path: Value, cell: &Cell) -> f64 {
        let before = self.issues.len();
        let value = self.number(path.clone(), cell);
        if self.issues.len() > before {
            return value;
        }
        if value.trunc() != value {
            self.issues.push(json!({
                "expected": "int", "format": "safeint", "code": "invalid_type", "path": path,
                "message": "Invalid input: expected int, received number",
            }));
            return value;
        }
        let note = "Integers must be within the safe integer range.";
        if value > MAX_SAFE_INTEGER {
            self.issues.push(json!({
                "code": "too_big", "maximum": MAX_SAFE_INTEGER as i64, "note": note, "origin": "int",
                "inclusive": true, "path": path, "message": "Too big: expected int to be <=9007199254740991",
            }));
        } else if value < -MAX_SAFE_INTEGER {
            self.issues.push(json!({
                "code": "too_small", "minimum": -(MAX_SAFE_INTEGER as i64), "note": note, "origin": "int",
                "inclusive": true, "path": path, "message": "Too small: expected int to be >=-9007199254740991",
            }));
        }
        if value <= 0.0 {
            self.issues.push(json!({
                "origin": "number", "code": "too_small", "minimum": 0, "inclusive": false, "path": path,
                "message": "Too small: expected number to be >0",
            }));
        }
        value
    }
}

fn build_feed(
    sqlite: &Connection,
    clock: &dyn Clock,
    now: f64,
    cached: Option<FeedState>,
) -> domain::Result<FeedState> {
    let rows = read_rows(sqlite)?;
    let draft_ids: Vec<i64> = rows.iter().map(|row| row.draft_id).collect();
    let mut entities_by_draft = read_entities(sqlite, &draft_ids)?;
    let mut next_publication_at = f64::INFINITY;
    let mut by_draft = HashMap::new();
    let mut items = Vec::new();
    for row in rows {
        if row.post_id.is_null() {
            continue;
        }
        let mut next_item_publication_at = f64::INFINITY;
        for locale in [&row.ru, &row.en] {
            let when = if locale.published_at.truthy() {
                locale.published_at.instant_ms()
            } else {
                0.0
            };
            if locale.enabled == Cell::Number(1.0) && when > now {
                next_item_publication_at = next_item_publication_at.min(when);
            }
        }
        next_publication_at = next_publication_at.min(next_item_publication_at);
        let entities = entities_by_draft.remove(&row.draft_id).unwrap_or_default();
        // A view counter or one edited locale must not discard every other post's
        // validated media and the HTTP layer's cached file descriptions.
        let item_fingerprint = fingerprint(&row, &entities);
        if let Some(previous) = cached.as_ref().and_then(|cached| cached.by_draft.get(&row.draft_id))
            && previous.fingerprint == item_fingerprint
            && now < previous.next_publication_at
        {
            items.push(Rc::clone(&previous.item));
            by_draft.insert(
                row.draft_id,
                CachedItem {
                    fingerprint: item_fingerprint,
                    item: Rc::clone(&previous.item),
                    next_publication_at: previous.next_publication_at,
                },
            );
            continue;
        }
        let publication_key = format!("post:{}", row.post_id.js_string());
        let ru = locale_view(&row.ru, now);
        let en = locale_view(&row.en, now);
        if !ru.enabled && !en.enabled {
            continue;
        }
        let (item, issues) = validate_item(&row, ru, en, entities, &publication_key);
        // A single malformed row (a legacy shape, an unexpected null) must never take
        // down the whole public feed; drop it and keep every other post serving.
        if !issues.is_empty() {
            let message = issues[0]["message"].as_str().unwrap_or("invalid shape");
            let mut details = Map::new();
            details.insert("publication_key".into(), Value::String(publication_key.clone()));
            details.insert("issues".into(), Value::Array(issues.iter().take(5).cloned().collect()));
            record_event(
                sqlite,
                clock,
                &DomainEventInput {
                    publication_ref: Some(publication_key.clone()),
                    event_type: "site.feed.item_invalid".into(),
                    severity: Severity::Warn,
                    target: None,
                    message: format!("Post {publication_key} dropped from the public feed: {message}"),
                    details: Some(details),
                    cooldown_seconds: Some(60 * 60),
                },
            )?;
            continue;
        }
        let item = Rc::new(item);
        by_draft.insert(
            row.draft_id,
            CachedItem {
                fingerprint: item_fingerprint,
                item: Rc::clone(&item),
                next_publication_at: next_item_publication_at,
            },
        );
        items.push(item);
    }
    let items = match cached {
        Some(cached)
            if cached.items.len() == items.len()
                && cached
                    .items
                    .iter()
                    .zip(&items)
                    .all(|(left, right)| Rc::ptr_eq(left, right)) =>
        {
            cached.items
        }
        _ => Rc::new(items),
    };
    Ok(FeedState {
        items,
        next_publication_at,
        by_draft,
    })
}

/// The post's date is the date it was published, and only a published locale
/// has one. RU wins when both are published.
fn publication_date(ru: &LocaleView, en: &LocaleView) -> Cell {
    let ru_date = if ru.enabled {
        ru.published_at.clone()
    } else {
        Cell::Null
    };
    let en_date = if en.enabled {
        en.published_at.clone()
    } else {
        Cell::Null
    };
    ru_date.or(en_date)
}

fn validate_item(
    row: &FeedRow,
    ru: LocaleView,
    en: LocaleView,
    entities: Vec<EntityRow>,
    publication_key: &str,
) -> (FeedItem, Vec<Value>) {
    let mut check = Validation { issues: Vec::new() };
    let date = publication_date(&ru, &en)
        .or(row.scheduled_at.clone())
        .or(row.scheduled_en_at.clone())
        .or(row.created_at.clone());
    let media = ru.media;
    let media_en = if en.media.is_empty() { media.clone() } else { en.media };
    let post_id = check.positive_int(json!(["post_id"]), &row.post_id);
    let date = check.string(json!(["date"]), date);
    let updated_at_ru = check.nullable_string(
        json!(["updated_at_ru"]),
        if ru.enabled {
            row.ru.site_updated_at.clone()
        } else {
            Cell::Null
        },
    );
    let updated_at_en = check.nullable_string(
        json!(["updated_at_en"]),
        if en.enabled {
            row.en.site_updated_at.clone()
        } else {
            Cell::Null
        },
    );
    let text = check.string(json!(["text"]), ru.text.clone());
    let text_ru = check.string(json!(["text_ru"]), ru.text);
    let text_en = check.string(json!(["text_en"]), en.text);
    let html = check.string(json!(["html"]), ru.html);
    let html_en = check.string(json!(["html_en"]), en.html);
    let slug_ru = check.nullable_string(json!(["slug_ru"]), ru.slug);
    let slug_en = check.nullable_string(json!(["slug_en"]), en.slug);
    let seo_title_ru = check.nullable_string(
        json!(["seo_title_ru"]),
        if ru.enabled {
            row.ru.seo_title.clone()
        } else {
            Cell::Null
        },
    );
    let seo_title_en = check.nullable_string(
        json!(["seo_title_en"]),
        if en.enabled {
            row.en.seo_title.clone()
        } else {
            Cell::Null
        },
    );
    let entities = entities
        .into_iter()
        .enumerate()
        .map(|(index, entity)| FeedEntity {
            kind: entity.kind,
            slug: check.string(json!(["entities", index, "slug"]), entity.slug),
            title_ru: check.string(json!(["entities", index, "title_ru"]), entity.title_ru),
            title_en: check.nullable_string(json!(["entities", index, "title_en"]), entity.title_en),
            link_role: entity.link_role,
        })
        .collect();
    let views = check.number(json!(["views"]), &row.views.clone().or(Cell::Number(0.0)));
    let item = FeedItem {
        id: publication_key.to_owned(),
        post_id,
        date,
        updated_at_ru,
        updated_at_en,
        text,
        text_ru,
        text_en,
        html,
        html_en,
        slug_ru,
        slug_en,
        seo_title_ru,
        seo_title_en,
        has_ru: ru.enabled,
        has_en: en.enabled,
        image: first_image(&media),
        image_en: first_image(&media_en),
        media,
        media_en,
        entities,
        views,
    };
    (item, check.issues)
}
