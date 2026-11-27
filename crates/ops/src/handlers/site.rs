//! The public site's stored media and metadata: display repair, media and
//! responsive backfills, metadata and media deduplication. Every write after a
//! check carries that check in its `WHERE`.

use std::cell::Cell;
use std::collections::{BTreeSet, HashMap, HashSet};
use std::os::unix::fs::MetadataExt as _;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::LazyLock;

use content::Locale;
use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, params};
use delivery::site_content_index::site_urls_for_index_now;
use delivery::site_index_now::enqueue_index_now;
use delivery::site_media::{
    materialize_responsive_variants, materialize_site_media, responsive_variant_paths, site_media_source,
};
use delivery::site_media_storage::{deduplicate_site_media_file, extname, is_site_media_extension, sha256_file};
use domain::application::ports::FixedClock;
use foundation::time::{parse_iso_ms, to_iso_string};
use providers::adapters::AdapterContext;
use public_site::{FeedItem, FeedReader};
use regex::Regex;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::plan_schema::{array, array_min, literal, locale, object, parse, positive_int, string};
use crate::context::{Fut, Input, OpError, OpResult, OperationContext};

fn sha256_hex(text: &str) -> String {
    format!("{:x}", Sha256::digest(text.as_bytes()))
}

/// A `{ mode: "json" }` column as drizzle reads it.
fn json_column(text: Option<String>) -> Result<Value, OpError> {
    match text {
        None => Ok(Value::Null),
        Some(text) => Ok(serde_json::from_str(&text)?),
    }
}

/// Drizzle's synchronous `db.transaction(work)`: `BEGIN`, and a throw rolls
/// it back.
fn in_transaction<T>(sqlite: &Connection, work: impl FnOnce() -> Result<T, OpError>) -> Result<T, OpError> {
    sqlite.execute_batch("BEGIN")?;
    match work() {
        Ok(value) => {
            sqlite.execute_batch("COMMIT")?;
            Ok(value)
        }
        Err(error) => {
            let _ = sqlite.execute_batch("ROLLBACK");
            Err(error)
        }
    }
}

fn media_list(value: &Value) -> Option<&Vec<Value>> {
    value.as_array()
}

fn is_story_card(item: &Value) -> bool {
    item.get("role") == Some(&json!("text_story_card"))
}

/// `a ?? b`: the first value that is neither absent nor null.
fn first_present<'v>(item: &'v Value, keys: &[&str]) -> Option<&'v Value> {
    keys.iter()
        .find_map(|key| item.get(*key).filter(|value| !value.is_null()))
}

static VERTICAL_SUFFIX: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-vertical\.(jpg|mp4)$").unwrap());

/// One published locale as `site-display-repair` reads it.
struct DisplayRow {
    post_id: i64,
    draft_id: i64,
    locale: String,
    source_text: String,
    approved_text: Option<String>,
    html: Option<String>,
    slug: Option<String>,
    seo_title: Option<String>,
    site_media: Value,
    site_updated_at: Option<String>,
    published_at: Option<String>,
    updated_at: String,
}

/// `siteEditorialFingerprint`: editorial identity, excluding derivative
/// paths, dimensions and generated cards.
fn site_editorial_fingerprint(row: &DisplayRow) -> String {
    let media: Vec<Value> = media_list(&row.site_media)
        .into_iter()
        .flatten()
        .filter(|item| !is_story_card(item))
        .map(|item| {
            let identity = first_present(item, &["asset_id", "file_id", "fileId", "local_path", "localPath"])
                .cloned()
                .unwrap_or_else(|| {
                    let path = first_present(item, &["path"])
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    let path = path.split('?').next().unwrap_or_default();
                    json!(VERTICAL_SUFFIX.replace(path, ".$1"))
                });
            let kind = first_present(item, &["type"])
                .and_then(Value::as_str)
                .unwrap_or("image");
            json!([
                identity,
                if kind.to_lowercase() == "video" {
                    "video"
                } else {
                    "image"
                },
                first_present(item, &["alt"]).cloned().unwrap_or(json!("")),
            ])
        })
        .collect();
    let text = row.approved_text.clone().unwrap_or_else(|| row.source_text.clone());
    sha256_hex(&domain::json::stringify(&json!([
        text,
        row.html,
        row.slug,
        row.seo_title,
        media
    ])))
}

fn display_rows(sqlite: &Connection) -> Result<Vec<DisplayRow>, OpError> {
    let mut statement = sqlite.prepare(
        r#"select "drafts"."post_id", "post_locales"."draft_id", "post_locales"."locale", "post_locales"."source_text", "post_locales"."approved_text", "post_locales"."html", "post_locales"."slug", "post_locales"."seo_title", "post_locales"."site_media_json", "post_locales"."site_updated_at", "post_locales"."published_at", "post_locales"."updated_at" from "post_locales" inner join "drafts" on "drafts"."id" = "post_locales"."draft_id" where ("post_locales"."site_enabled" = ? and "drafts"."status" in (?, ?))"#,
    )?;
    let rows = statement.query_map(params![1, "published", "failed"], |row| {
        Ok((
            row.get::<_, Option<i64>>(0)?,
            DisplayRow {
                post_id: 0,
                draft_id: row.get(1)?,
                locale: row.get(2)?,
                source_text: row.get(3)?,
                approved_text: row.get(4)?,
                html: row.get(5)?,
                slug: row.get(6)?,
                seo_title: row.get(7)?,
                site_media: Value::Null,
                site_updated_at: row.get(9)?,
                published_at: row.get(10)?,
                updated_at: row.get(11)?,
            },
            row.get::<_, Option<String>>(8)?,
        ))
    })?;
    let mut out = Vec::new();
    for row in rows {
        let (post_id, mut display, media) = row?;
        display.site_media = json_column(media)?;
        let Some(post_id) = post_id.filter(|id| *id != 0) else {
            continue;
        };
        if display.locale != "ru" && display.locale != "en" {
            continue;
        }
        display.post_id = post_id;
        out.push(display);
    }
    Ok(out)
}

fn display_plan_schema() -> super::plan_schema::Kind {
    object(vec![
        ("version", literal(1)),
        (
            "dates",
            array(object(vec![
                ("post_id", positive_int()),
                ("locale", locale()),
                ("expected_updated_at", string().datetime()),
                ("restore_updated_at", string().datetime().nullable()),
                ("content_sha256", string().sha256()),
            ])),
        ),
    ])
}

/// `repairSiteDisplay`: a reviewed restoration is atomic and refuses
/// intervening editorial changes.
pub fn site_display_repair<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let apply = input.bool("apply");
        let sqlite = context.sqlite()?;
        let Some(file) = input.opt_str("file") else {
            if apply {
                return Err(OpError::failed(
                    "site-display-repair --apply requires a reviewed --file plan",
                ));
            }
            let rows = display_rows(sqlite)?;
            let dates: Vec<Value> = rows
                .iter()
                .map(|row| {
                    json!({
                        "post_id": row.post_id,
                        "locale": row.locale,
                        "updated_at": row.site_updated_at,
                        "content_sha256": site_editorial_fingerprint(row),
                    })
                })
                .collect();
            let cards = rows
                .iter()
                .filter(|row| media_list(&row.site_media).is_some_and(|media| media.iter().any(is_story_card)))
                .count();
            return Ok(json!({"ok": true, "apply": false, "dates": dates, "story_card_locales": cards}));
        };
        let raw: Value = serde_json::from_slice(&tokio::fs::read(file).await?)?;
        let plan = parse(&display_plan_schema(), &raw)?;
        let now = to_iso_string(context.now());
        in_transaction(sqlite, || {
            let rows = display_rows(sqlite)?;
            let by_key: HashMap<String, &DisplayRow> = rows
                .iter()
                .map(|row| (format!("{}:{}", row.post_id, row.locale), row))
                .collect();
            let mut seen = HashSet::new();
            let mut restored = 0;
            for item in plan["dates"].as_array().into_iter().flatten() {
                let key = format!("{}:{}", item["post_id"], item["locale"].as_str().unwrap_or_default());
                if !seen.insert(key.clone()) {
                    return Err(OpError::Failed(format!("Duplicate date restoration: {key}")));
                }
                let expected = item["expected_updated_at"].as_str().unwrap_or_default();
                let row = by_key.get(&key).copied().filter(|row| {
                    row.site_updated_at.as_deref() == Some(expected)
                        && site_editorial_fingerprint(row) == item["content_sha256"].as_str().unwrap_or_default()
                });
                let Some(row) = row else {
                    return Err(OpError::Failed(format!(
                        "Editorial content or modification date changed for {key}"
                    )));
                };
                let restore = item["restore_updated_at"].as_str();
                if let (Some(restore), Some(published)) = (
                    restore.filter(|text| !text.is_empty()),
                    row.published_at.as_deref().filter(|text| !text.is_empty()),
                ) && let (Some(restore), Some(published)) = (parse_iso_ms(restore), parse_iso_ms(published))
                    && restore < published
                {
                    return Err(OpError::Failed(format!("Restored date precedes publication for {key}")));
                }
                if apply {
                    let changed = sqlite.execute(
                        r#"update "post_locales" set "site_updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ? and "post_locales"."site_enabled" = ? and "post_locales"."updated_at" = ? and "post_locales"."site_updated_at" = ?)"#,
                        params![restore, row.draft_id, row.locale, 1, row.updated_at, expected],
                    )?;
                    if changed != 1 {
                        return Err(OpError::Failed(format!("Concurrent date change for {key}")));
                    }
                }
                restored += 1;
            }
            let mut cards = 0;
            for row in &rows {
                let Some(stored) = media_list(&row.site_media) else {
                    continue;
                };
                let media: Vec<Value> = stored.iter().filter(|item| !is_story_card(item)).cloned().collect();
                if media.len() == stored.len() {
                    continue;
                }
                if apply {
                    let changed = sqlite.execute(
                        r#"update "post_locales" set "site_media_json" = ?, "updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ? and "post_locales"."site_enabled" = ? and "post_locales"."updated_at" = ? and "post_locales"."site_media_json" IS ?)"#,
                        params![
                            domain::json::stringify(&Value::Array(media)),
                            now,
                            row.draft_id,
                            row.locale,
                            1,
                            row.updated_at,
                            domain::json::stringify(&row.site_media),
                        ],
                    )?;
                    if changed != 1 {
                        return Err(OpError::Failed(format!(
                            "Concurrent gallery change for {}:{}",
                            row.draft_id, row.locale
                        )));
                    }
                }
                cards += 1;
            }
            Ok(json!({"ok": true, "apply": apply, "restored_dates": restored, "removed_story_card_locales": cards}))
        })
    })
}

static VERTICAL_PATH: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"-vertical\.(jpg|mp4)(?:[?#]|$)").unwrap());

struct BackfillWork {
    draft_id: i64,
    post_id: i64,
    draft_updated_at: String,
    locale: Locale,
    updated_at: String,
    source: Vec<Map<String, Value>>,
}

/// `backfillSiteMedia`: the old viewer projections replaced, newest first.
/// Each locale changes only after its complete gallery exists.
pub fn site_media_backfill<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let (apply, limit) = (input.bool("apply"), input.int("limit").max(0) as usize);
        let sqlite = context.sqlite()?;
        let publishing = context.studio(&config)?.publishing;
        let mut statement = sqlite.prepare(
            r#"select "drafts"."id", "drafts"."post_id", "drafts"."updated_at", "post_locales"."locale", "post_locales"."updated_at", "post_locales"."published_at", "post_locales"."site_media_json" from "drafts" inner join "post_locales" on ("post_locales"."draft_id" = "drafts"."id" and "post_locales"."site_enabled" = ?) where "drafts"."status" in (?, ?) order by "drafts"."post_id" desc"#,
        )?;
        type Row = (i64, Option<i64>, String, String, String, Option<String>, Option<String>);
        let rows: Vec<Row> = statement
            .query_map(params![1, "published", "failed"], |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                    row.get(6)?,
                ))
            })?
            .collect::<Result<_, _>>()?;
        let now_ms = context.now().as_millisecond();
        let mut work: Vec<BackfillWork> = Vec::new();
        for (draft_id, post_id, draft_updated_at, locale_name, updated_at, published_at, media) in rows {
            let Some(post_id) = post_id.filter(|id| *id != 0) else {
                continue;
            };
            let locale = match locale_name.as_str() {
                "ru" => Locale::Ru,
                "en" => Locale::En,
                _ => continue,
            };
            if published_at
                .as_deref()
                .filter(|text| !text.is_empty())
                .and_then(parse_iso_ms)
                .is_some_and(|at| at > now_ms)
            {
                continue;
            }
            let media = json_column(media)?;
            let vertical = media_list(&media).is_some_and(|items| {
                items.iter().any(|item| {
                    let path = first_present(item, &["path"])
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    VERTICAL_PATH.is_match(path)
                })
            });
            if !vertical {
                continue;
            }
            let publication = publishing.publication_source_from_db(post_id)?;
            let source = publication.locale(locale);
            if source.media.is_empty() && !source.thread.iter().any(|part| !part.media.is_empty()) {
                continue;
            }
            work.push(BackfillWork {
                draft_id,
                post_id,
                draft_updated_at,
                locale,
                updated_at,
                source: site_media_source(source),
            });
        }
        let mut selected_posts: Vec<i64> = Vec::new();
        for item in &work {
            if selected_posts.len() < limit && !selected_posts.contains(&item.post_id) {
                selected_posts.push(item.post_id);
            }
        }
        let selected: Vec<&BackfillWork> = work
            .iter()
            .filter(|item| selected_posts.contains(&item.post_id))
            .collect();
        let plan: Vec<Value> = selected
            .iter()
            .map(|item| json!({"post_id": item.post_id, "locale": item.locale.as_str(), "media": item.source.len()}))
            .collect();
        let mut changed = 0;
        let mut failed: Vec<Value> = Vec::new();
        if apply {
            let ctx = AdapterContext {
                config: config.clone(),
                client: context.http.clone(),
                clock: Rc::new(FixedClock(Cell::new(context.now()))),
            };
            for item in &selected {
                let outcome: Result<(), String> = async {
                    let media = materialize_site_media(&ctx, item.post_id, item.locale, &item.source).await?;
                    let media = Value::Array(media.into_iter().map(Value::Object).collect());
                    let written = sqlite
                        .execute(
                            r#"update "post_locales" set "site_media_json" = ?, "updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ? and "post_locales"."site_enabled" = ? and "post_locales"."updated_at" = ? and EXISTS (SELECT 1 FROM "drafts" WHERE "drafts"."id" = ?
                AND "drafts"."updated_at" = ? AND "drafts"."status" IN ('published', 'failed')))"#,
                            params![
                                domain::json::stringify(&media),
                                to_iso_string(context.now()),
                                item.draft_id,
                                item.locale.as_str(),
                                1,
                                item.updated_at,
                                item.draft_id,
                                item.draft_updated_at,
                            ],
                        )
                        .map_err(|error| error.to_string())?;
                    if written != 1 {
                        return Err("Publication changed while its media was being restored".into());
                    }
                    Ok(())
                }
                .await;
                match outcome {
                    Ok(()) => changed += 1,
                    Err(error) => {
                        failed.push(json!({"post_id": item.post_id, "locale": item.locale.as_str(), "error": error}));
                    }
                }
            }
        }
        Ok(json!({
            "ok": failed.is_empty(),
            "apply": apply,
            "posts": selected_posts.len(),
            "locale_projections": selected.len(),
            "changed": changed,
            "remaining": work.len() - changed,
            "failed": failed,
            "plan": plan,
        }))
    })
}

fn text_of(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

static IMAGE_FILE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"(?i)\.(png|jpe?g)$").unwrap());

/// `path.relative(from, to)` for `to` inside `from`.
fn relative(from: &str, to: &str) -> String {
    let root = public_site::paths::resolve(from, "");
    let target = public_site::paths::resolve(to, "");
    target
        .strip_prefix(&format!("{}/", root.trim_end_matches('/')))
        .map_or(target.clone(), str::to_owned)
}

/// `backfillSiteResponsive`: historical gaps filled with the publication
/// worker's image recipe; only derivative files are written.
pub fn site_responsive_backfill<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let apply = input.bool("apply");
        let config = context.config()?;
        let feed = FeedReader::default().load(context.db()?, context.clock)?;
        let public_dir = text_of(&config.site_public_dir);
        let root = public_site::paths::resolve(&public_dir, "");
        let mut sources: Vec<String> = Vec::new();
        for item in feed.iter() {
            for media in item.media.iter().chain(item.media_en.iter()) {
                let key = if media.get("type") == Some(&json!("video")) {
                    "poster"
                } else {
                    "path"
                };
                let Some(url) = media.get(key).and_then(Value::as_str).filter(|url| !url.is_empty()) else {
                    continue;
                };
                let relative = url.trim_start_matches('/');
                let relative = relative.split(['?', '#']).next().unwrap_or_default();
                let file = public_site::paths::resolve(&public_dir, relative);
                if file.starts_with(&format!("{root}/")) && IMAGE_FILE.is_match(&file) && !sources.contains(&file) {
                    sources.push(file);
                }
            }
        }
        let mut missing: Vec<String> = Vec::new();
        for source in &sources {
            let Ok(info) = tokio::fs::metadata(source).await else {
                continue;
            };
            let source_mtime = info.modified()?;
            for variant in responsive_variant_paths(&config, Path::new(source)).map_err(OpError::Failed)? {
                let stale = match tokio::fs::metadata(&variant.file).await {
                    Ok(derivative) => derivative.modified()? < source_mtime,
                    Err(_) => true,
                };
                if stale {
                    missing.push(source.clone());
                    break;
                }
            }
        }
        let mut rendered = 0;
        let mut failed: Vec<Value> = Vec::new();
        if apply {
            // One image at a time keeps archive work out of visitors' request
            // path on the same small container that serves the site API.
            for source in &missing {
                match materialize_responsive_variants(&config, Path::new(source)).await {
                    Ok(()) => rendered += 1,
                    Err(error) => failed.push(json!({"path": relative(&public_dir, source), "error": error})),
                }
            }
        }
        Ok(json!({
            "ok": failed.is_empty(),
            "apply": apply,
            "sources": sources.len(),
            "missing": missing.len(),
            "rendered": rendered,
            "remaining": missing.len() - rendered,
            "failed": failed,
        }))
    })
}

fn metadata_schema() -> super::plan_schema::Kind {
    object(vec![
        ("version", literal(1)),
        (
            "items",
            array_min(
                object(vec![
                    ("post_id", positive_int()),
                    ("locale", locale()),
                    ("text_sha256", string().sha256()),
                    ("seo_title", string().trim().min(1).max(65).optional()),
                    ("expected_seo_title", string().max(65).nullable().optional()),
                    (
                        "images",
                        array(object(vec![
                            ("path", string().min(1)),
                            ("alt", string().trim().min(1).max(500)),
                            ("expected_alt", string().max(500).optional()),
                        ]))
                        .default_empty(),
                    ),
                ]),
                1,
            ),
        ),
    ])
}

/// One published locale of `siteMetadataInventory`.
fn inventory_items(feed: &[Rc<FeedItem>]) -> Vec<Value> {
    let mut items = Vec::new();
    for post in feed {
        for locale in ["ru", "en"] {
            let ru = locale == "ru";
            if !(if ru { post.has_ru } else { post.has_en }) {
                continue;
            }
            let text = if ru { &post.text } else { &post.text_en };
            let media = if ru { &post.media } else { &post.media_en };
            let images: Vec<Value> = media
                .iter()
                .filter(|item| item.get("type") != Some(&json!("video")))
                .map(|item| {
                    let mut image = Map::new();
                    if let Some(path) = item.get("path") {
                        image.insert("path".into(), path.clone());
                    }
                    let alt = item
                        .get("alt")
                        .filter(|alt| !alt.is_null())
                        .cloned()
                        .unwrap_or(json!(""));
                    image.insert("alt".into(), alt);
                    Value::Object(image)
                })
                .collect();
            let mut item = Map::new();
            item.insert("post_id".into(), (post.post_id as i64).into());
            item.insert("locale".into(), json!(locale));
            item.insert("text".into(), json!(text));
            item.insert("text_sha256".into(), json!(sha256_hex(text)));
            let seo = if ru { &post.seo_title_ru } else { &post.seo_title_en };
            item.insert("seo_title".into(), json!(seo));
            item.insert("images".into(), Value::Array(images));
            items.push(Value::Object(item));
        }
    }
    items
}

struct MetadataRow {
    draft_id: i64,
    media: Value,
    media_raw: Option<String>,
    seo_title: Option<String>,
    source_text: String,
    approved_text: Option<String>,
}

/// `applySiteMetadata`: reviewed descriptions and search titles, every
/// prerequisite rechecked in the transaction and in the guarded write.
fn apply_site_metadata(
    context: &OperationContext<'_>,
    feed: &[Rc<FeedItem>],
    raw: &Value,
    apply: bool,
) -> Result<(Value, BTreeSet<String>), OpError> {
    let input = parse(&metadata_schema(), raw)?;
    let sqlite = context.sqlite()?;
    let published: HashMap<String, Value> = inventory_items(feed)
        .into_iter()
        .map(|item| {
            (
                format!("{}:{}", item["post_id"], item["locale"].as_str().unwrap_or_default()),
                item,
            )
        })
        .collect();
    let mut public_media: HashMap<String, Vec<Map<String, Value>>> = HashMap::new();
    for post in feed {
        for (locale, media) in [("ru", &post.media), ("en", &post.media_en)] {
            public_media.insert(format!("{}:{locale}", post.post_id), media.clone());
        }
    }
    let now = to_iso_string(context.now());
    let items = input["items"].as_array().cloned().unwrap_or_default();
    in_transaction(sqlite, || {
        let mut seen = HashSet::new();
        let (mut changed, mut images) = (0, 0);
        let mut keys: Vec<String> = Vec::new();
        for item in &items {
            let key = format!("{}:{}", item["post_id"], item["locale"].as_str().unwrap_or_default());
            if !seen.insert(key.clone()) {
                return Err(OpError::Failed(format!("Duplicate metadata for {key}")));
            }
            let expected_hash = item["text_sha256"].as_str().unwrap_or_default();
            let Some(current) = published
                .get(&key)
                .filter(|current| current["text_sha256"] == expected_hash)
            else {
                return Err(OpError::Failed(format!(
                    "Published text changed for {key}; regenerate metadata"
                )));
            };
            let row = sqlite
                .query_row(
                    r#"select "post_locales"."draft_id", "post_locales"."site_media_json", CAST("post_locales"."site_media_json" AS TEXT), "post_locales"."seo_title", "post_locales"."source_text", "post_locales"."approved_text" from "post_locales" inner join "drafts" on "drafts"."id" = "post_locales"."draft_id" where ("drafts"."post_id" = ? and "post_locales"."locale" = ? and "post_locales"."site_enabled" = ?)"#,
                    params![item["post_id"].as_i64(), item["locale"].as_str(), 1],
                    |row| {
                        Ok((
                            row.get::<_, i64>(0)?,
                            row.get::<_, Option<String>>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, String>(4)?,
                            row.get::<_, Option<String>>(5)?,
                        ))
                    },
                )
                .optional()?;
            let row = match row {
                Some((draft_id, media, media_raw, seo_title, source_text, approved_text)) => Some(MetadataRow {
                    draft_id,
                    media: json_column(media)?,
                    media_raw,
                    seo_title,
                    source_text,
                    approved_text,
                }),
                None => None,
            };
            let Some(row) =
                row.filter(|row| sha256_hex(row.approved_text.as_deref().unwrap_or(&row.source_text)) == expected_hash)
            else {
                return Err(OpError::Failed(format!("Published text changed for {key}")));
            };
            let seo_title = item.get("seo_title").and_then(Value::as_str);
            let expected_seo = item.get("expected_seo_title");
            if let Some(seo_title) = seo_title.filter(|title| !title.is_empty())
                && Some(seo_title) != row.seo_title.as_deref()
            {
                if let Some(expected) = expected_seo
                    && expected.as_str() != row.seo_title.as_deref()
                {
                    return Err(OpError::Failed(format!("SEO title changed for {key}")));
                }
                if row.seo_title.as_deref().is_some_and(|title| !title.is_empty()) && expected_seo.is_none() {
                    return Err(OpError::Failed(format!("SEO title already edited for {key}")));
                }
            }
            let stored = media_list(&row.media).filter(|media| !media.is_empty());
            let mut media: Vec<Value> = match stored {
                Some(stored) => stored.clone(),
                None => public_media
                    .get(&key)
                    .map(|media| media.iter().cloned().map(Value::Object).collect())
                    .unwrap_or_default(),
            };
            let mut paths = HashSet::new();
            for image in item["images"].as_array().into_iter().flatten() {
                let path = image["path"]
                    .as_str()
                    .unwrap_or_default()
                    .trim_start_matches('/')
                    .to_owned();
                if !paths.insert(path.clone()) {
                    return Err(OpError::Failed(format!("Duplicate image for {key}: {path}")));
                }
                let asset = media.iter_mut().find(|asset| {
                    let stored = first_present(asset, &["path"])
                        .and_then(Value::as_str)
                        .unwrap_or_default();
                    stored.trim_start_matches('/') == path && asset.get("type") != Some(&json!("video"))
                });
                let Some(Value::Object(asset)) = asset else {
                    return Err(OpError::Failed(format!("Published image changed for {key}: {path}")));
                };
                let alt = &image["alt"];
                if asset.get("alt") != Some(alt) {
                    if let Some(expected) = image.get("expected_alt") {
                        let current = asset
                            .get("alt")
                            .filter(|alt| !alt.is_null())
                            .cloned()
                            .unwrap_or(json!(""));
                        if *expected != current {
                            return Err(OpError::Failed(format!("Alt changed for {key}: {path}")));
                        }
                    }
                    if asset
                        .get("alt")
                        .and_then(Value::as_str)
                        .is_some_and(|alt| !alt.is_empty())
                        && image.get("expected_alt").is_none()
                    {
                        return Err(OpError::Failed(format!("Alt already edited for {key}: {path}")));
                    }
                    asset.insert("alt".into(), alt.clone());
                    images += 1;
                }
            }
            let title = seo_title.map(str::to_owned).or_else(|| row.seo_title.clone());
            let media = Value::Array(media);
            let before = if row.media.is_null() {
                json!([])
            } else {
                row.media.clone()
            };
            if title == row.seo_title && domain::json::stringify(&media) == domain::json::stringify(&before) {
                continue;
            }
            changed += 1;
            let publication = format!("post:{}", item["post_id"]);
            if !keys.contains(&publication) {
                keys.push(publication);
            }
            if apply {
                let written = sqlite.execute(
                    r#"update "post_locales" set "seo_title" = ?, "site_media_json" = ?, "updated_at" = ? where ("post_locales"."draft_id" = ? and "post_locales"."locale" = ? and "post_locales"."site_enabled" = ? and coalesce("post_locales"."approved_text", "post_locales"."source_text") = ? and "post_locales"."site_media_json" IS ? and "post_locales"."seo_title" IS ?)"#,
                    params![
                        title,
                        domain::json::stringify(&media),
                        now,
                        row.draft_id,
                        item["locale"].as_str(),
                        1,
                        current["text"].as_str(),
                        row.media_raw.clone().map_or(SqlValue::Null, SqlValue::Text),
                        row.seo_title,
                    ],
                )?;
                if written != 1 {
                    return Err(OpError::Failed(format!("Concurrent metadata edit for {key}")));
                }
            }
        }
        let result = json!({
            "ok": true,
            "apply": apply,
            "locales": items.len(),
            "changed": changed,
            "images": images,
            "publication_keys": keys,
        });
        Ok((result, keys.into_iter().collect()))
    })
}

/// `siteMetadata`: the inventory without a file; with one, the reviewed plan
/// validated, and with `apply` saved and the changed pages queued for
/// IndexNow.
pub fn site_metadata<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let apply = input.bool("apply");
        let reader = FeedReader::default();
        let Some(file) = input.opt_str("file") else {
            if apply {
                return Err(OpError::failed("site-metadata --apply requires --file"));
            }
            let feed = reader.load(context.db()?, context.clock)?;
            return Ok(json!({"version": 1, "items": inventory_items(&feed)}));
        };
        let content = String::from_utf8_lossy(&tokio::fs::read(file).await?).into_owned();
        if content.encode_utf16().count() > 5_000_000 {
            return Err(OpError::failed("Site metadata exceeds 5 MB"));
        }
        let raw: Value = serde_json::from_str(&content)?;
        let feed = reader.load(context.db()?, context.clock)?;
        let (result, keys) = apply_site_metadata(context, &feed, &raw, apply)?;
        if apply && !keys.is_empty() {
            let queued = site_urls_for_index_now(context.db()?, &config, context.clock, &keys)
                .map_err(|error| error.to_string())
                .and_then(|urls| enqueue_index_now(&config, &urls));
            if let Err(error) = queued {
                return Err(OpError::Failed(format!(
                    "Site metadata was saved, but IndexNow could not be queued: {error}"
                )));
            }
        }
        Ok(result)
    })
}

struct StoredFile {
    file: PathBuf,
    legacy: bool,
    size: u64,
    key: String,
    inode: (u64, u64),
}

async fn read_directory(directory: &Path) -> Result<Vec<(String, std::fs::FileType)>, OpError> {
    let mut entries = match tokio::fs::read_dir(directory).await {
        Ok(entries) => entries,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
        Err(error) => return Err(error.into()),
    };
    let mut out = Vec::new();
    while let Some(entry) = entries.next_entry().await? {
        out.push((
            entry.file_name().to_string_lossy().into_owned(),
            entry.file_type().await?,
        ));
    }
    Ok(out)
}

/// `collect`: every site media file under `directory`, depth first in
/// directory order.
fn collect<'r>(
    directory: PathBuf,
    result: &'r mut Vec<(PathBuf, bool)>,
) -> std::pin::Pin<Box<dyn std::future::Future<Output = Result<(), OpError>> + 'r>> {
    Box::pin(async move {
        for (name, kind) in read_directory(&directory).await? {
            let file = directory.join(&name);
            if kind.is_dir() {
                collect(file, result).await?;
            } else if kind.is_file() && is_site_media_extension(&name) {
                result.push((file, false));
            }
        }
        Ok(())
    })
}

/// `deduplicateSiteMedia`: a historical migration that turns every old URL
/// into a hard link to its content's blob.
pub fn site_media_deduplicate<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let apply = input.bool("apply");
        let config = context.config()?;
        let media_root = PathBuf::from(public_site::paths::join(&text_of(&config.site_public_dir), "media"));
        let mut candidates: Vec<(PathBuf, bool)> = Vec::new();
        for (name, kind) in read_directory(&media_root).await? {
            if kind.is_file() && is_site_media_extension(&name) {
                candidates.push((media_root.join(&name), true));
            }
        }
        collect(media_root.join("posts"), &mut candidates).await?;
        let mut entries: Vec<StoredFile> = Vec::new();
        for (file, legacy) in candidates {
            let stat = std::fs::metadata(&file)?;
            let digest = sha256_file(&file).await?;
            entries.push(StoredFile {
                key: format!("{digest}:{}", extname(&text_of(&file)).to_lowercase()),
                size: stat.len(),
                inode: (stat.dev(), stat.ino()),
                file,
                legacy,
            });
        }
        let mut groups: Vec<(String, Vec<&StoredFile>)> = Vec::new();
        for entry in &entries {
            match groups.iter_mut().find(|(key, _)| *key == entry.key) {
                Some((_, group)) => group.push(entry),
                None => groups.push((entry.key.clone(), vec![entry])),
            }
        }
        let logical_duplicates: u64 = groups
            .iter()
            .map(|(_, group)| group.iter().skip(1).map(|entry| entry.size).sum::<u64>())
            .sum();
        // Same-inode files already share data, so a dry run after the
        // migration reports nothing left to reclaim.
        let reclaimable: u64 = groups
            .iter()
            .map(|(_, group)| {
                let mut physical: Vec<((u64, u64), u64)> = Vec::new();
                for entry in group {
                    match physical.iter_mut().find(|(inode, _)| *inode == entry.inode) {
                        Some((_, size)) => *size = entry.size,
                        None => physical.push((entry.inode, entry.size)),
                    }
                }
                physical.iter().map(|(_, size)| size).sum::<u64>() - group[0].size
            })
            .sum();
        if apply {
            for entry in &entries {
                deduplicate_site_media_file(&media_root, &entry.file).await?;
            }
        }
        Ok(json!({
            "ok": true,
            "apply": apply,
            "files": entries.len(),
            "legacy_url_files": entries.iter().filter(|entry| entry.legacy).count(),
            "logical_bytes": entries.iter().map(|entry| entry.size).sum::<u64>(),
            "unique_blobs": groups.len(),
            "logical_duplicate_bytes": logical_duplicates,
            "reclaimable_bytes": reclaimable,
            "excluded": ["media/.blobs", "media/threads", "other media caches"],
        }))
    })
}
