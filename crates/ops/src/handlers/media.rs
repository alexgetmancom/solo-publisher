//! The media processor and the stored files: the media processor, the Story
//! media backfill and prune, and the site media operations of [`super::site`].

use std::cell::Cell;
use std::collections::{HashMap, HashSet};
use std::path::Path;
use std::rc::Rc;
use std::sync::{Arc, LazyLock};
use std::time::Duration;

use base64::Engine as _;
use content::message::MediaItem;
use db::rusqlite::Connection;
use delivery::story_derivatives::{DeliveryMedia, prepared_story_media, story_derivative_present, story_variant_paths};
use delivery::story_media::story_directory;
use domain::application::ports::FixedClock;
use domain::channels::{publishes_story, registered_post_target_ids};
use domain::publishing::media_policy::select_media_for_target;
use domain::publishing::payload::payload_media;
use domain::targets::{TargetMap, story_targets_enabled};
use foundation::config::{Config, SharedConfig};
use jiff::Timestamp;
use regex::Regex;
use runtime::http::{Body, BodyPart, HttpRequest};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};

use super::timeline::publication_timeline;
use crate::context::{Fut, Input, OpError, OpResult, OperationContext};

pub use super::site::{
    site_display_repair, site_media_backfill, site_media_deduplicate, site_metadata, site_responsive_backfill,
};

/// The process's media runtime: the CLI renders Stories in its own process.
pub(crate) fn delivery_media(context: &OperationContext<'_>, config: &Arc<Config>) -> DeliveryMedia {
    DeliveryMedia::new(
        context.http.clone(),
        SharedConfig::new((**config).clone()),
        Rc::new(FixedClock(Cell::new(context.now()))),
    )
}

fn object(value: Value) -> Map<String, Value> {
    match value {
        Value::Object(object) => object,
        _ => unreachable!("built as an object"),
    }
}

fn elapsed_ms(context: &OperationContext<'_>, started: Timestamp) -> i64 {
    context.now().as_millisecond() - started.as_millisecond()
}

/// `mediaUrl`.
fn media_url(config: &Config, pathname: &str) -> Result<String, String> {
    match (&config.media_processor_url, &config.media_processor_token) {
        (Some(url), Some(_)) if config.media_processor_provider.as_str() == "remote_http" && !url.is_empty() => {
            Ok(format!("{}{pathname}", url.strip_suffix('/').unwrap_or(url)))
        }
        _ => Err("remote media processor is not configured".into()),
    }
}

/// `redactMediaUrl`: `${protocol}//${host}` of the configured URL.
fn redact_media_url(value: Option<&str>) -> Value {
    let Some(value) = value.filter(|value| !value.is_empty()) else {
        return Value::Null;
    };
    let Some((scheme, rest)) = value.split_once("://") else {
        return json!("configured");
    };
    let scheme = scheme.to_ascii_lowercase();
    let authority = rest.split(['/', '?', '#']).next().unwrap_or_default();
    let host = authority.rsplit('@').next().unwrap_or_default().to_ascii_lowercase();
    let host = match (scheme.as_str(), host.rsplit_once(':')) {
        ("http", Some((name, "80"))) | ("https", Some((name, "443"))) => name.to_owned(),
        _ => host,
    };
    if host.is_empty() {
        return json!("configured");
    }
    json!(format!("{scheme}://{host}"))
}

/// `{ ...base, ...spread }`: a key already present keeps its place.
fn spread(mut base: Map<String, Value>, spread: &Value) -> Map<String, Value> {
    if let Value::Object(fields) = spread {
        for (key, value) in domain::json::object_entries(fields) {
            base.insert(key.clone(), value.clone());
        }
    }
    base
}

/// `mediaProcessorStatus`.
async fn media_processor_status(
    context: &OperationContext<'_>,
    config: &Config,
) -> Result<Map<String, Value>, OpError> {
    let started = context.now();
    // An unconfigured processor is refused before the probe, not reported by it.
    let url = media_url(config, "/health").map_err(OpError::Failed)?;
    let base = |context: &OperationContext<'_>| {
        object(json!({
            "ok": false,
            "provider": config.media_processor_provider.as_str(),
            "url": redact_media_url(config.media_processor_url.as_deref()),
            "latencyMs": elapsed_ms(context, started),
        }))
    };
    let answer: Result<(bool, Value), String> = async {
        let response = context
            .http
            .exchange(HttpRequest::get(url).deadline(Duration::from_secs(5)))
            .await
            .map_err(|failure| failure.message)?;
        let ok = response.ok();
        let text = response.text().await.map_err(|error| error.to_string())?;
        let health: Value = serde_json::from_str(&text).map_err(|error| format!("JSON Parse error: {error}"))?;
        Ok((ok, health))
    }
    .await;
    match answer {
        Ok((ok, health)) => {
            let mut status = base(context);
            status.insert("ok".into(), json!(ok && health.get("ok") == Some(&json!(true))));
            Ok(spread(status, &health))
        }
        Err(error) => {
            let mut status = base(context);
            status.insert("error".into(), json!(error));
            Ok(status)
        }
    }
}

pub fn media_status<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        Ok(Value::Object(media_processor_status(context, &config).await?))
    })
}

const DIAGNOSE_FIXTURE: &str = "/9j/4AAQSkZJRgABAQAAAQABAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////2wBDAf//////////////////////////////////////////////////////////////////////////////////////wAARCAABAAEDASIAAhEBAxEB/8QAFQABAQAAAAAAAAAAAAAAAAAAAAX/xAAUEAEAAAAAAAAAAAAAAAAAAAAA/9oADAMBAAIQAxAAAAEf/8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABBQJ//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPwF//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPwF//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQAGPwJ//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPyF//9oADAMBAAIAAwAAABAf/8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAwEBPxB//8QAFBEBAAAAAAAAAAAAAAAAAAAAAP/aAAgBAgEBPxB//8QAFBABAAAAAAAAAAAAAAAAAAAAAP/aAAgBAQABPxB//9k=";

/// `diagnoseMediaProcessor`: the health probe, then one authenticated
/// transform of a one-pixel JPEG.
pub fn media_diagnose<'a>(context: &'a OperationContext<'a>, _input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let health = media_processor_status(context, &config).await?;
        let fixture = base64::engine::general_purpose::STANDARD
            .decode(DIAGNOSE_FIXTURE)
            .expect("a valid fixture");
        let idempotency_key = format!("{:x}", Sha256::digest(b"ops-media-diagnose-v1"));
        let started = context.now();
        let attempt: Result<(bool, u16, String), String> = async {
            let url = media_url(&config, "/v1/transforms/ffmpeg")?;
            let request = HttpRequest::post(url)
                .header(
                    "authorization",
                    format!("Bearer {}", config.media_processor_token.as_deref().unwrap_or_default()),
                )
                .header("content-length", fixture.len().to_string())
                .header("content-type", "image/jpeg")
                .header("x-studio-transform", "story_vertical")
                .header("x-studio-media-kind", "image")
                .header("x-studio-idempotency-key", idempotency_key.clone())
                .body(Body(vec![BodyPart::Bytes(fixture.clone())]))
                .deadline(Duration::from_secs(30));
            let response = context
                .http
                .exchange(request)
                .await
                .map_err(|failure| failure.message)?;
            let (ok, status) = (response.ok(), response.status);
            let text = response.text().await.map_err(|error| error.to_string())?;
            Ok((ok, status, text))
        }
        .await;
        let health_ok = health.get("ok").is_some_and(foundation::js::truthy);
        Ok(match attempt {
            Ok((ok, status, text)) => {
                let result = serde_json::from_str::<Value>(&text)
                    .ok()
                    .filter(|parsed| !parsed.is_null())
                    .unwrap_or_else(|| json!(foundation::js::utf16_prefix(&text, 800)));
                json!({
                    "ok": health_ok && ok,
                    "health": health,
                    "authenticatedFixture": {
                        "ok": ok,
                        "status": status,
                        "durationMs": elapsed_ms(context, started),
                        "idempotencyKey": idempotency_key,
                        "result": result,
                    },
                })
            }
            Err(error) => json!({
                "ok": false,
                "health": health,
                "authenticatedFixture": {
                    "ok": false,
                    "durationMs": elapsed_ms(context, started),
                    "error": error,
                },
            }),
        })
    })
}

/// `mediaJobReport`: the media events of one publication's timeline.
pub fn media_job<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let reference = input.str("ref");
        let timeline = publication_timeline(context.sqlite()?, reference)?;
        let events: Vec<Value> = timeline["events"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|event| {
                let phase = match event["details"].get("phase") {
                    None | Some(Value::Null) => String::new(),
                    Some(phase) => foundation::js::string_of(phase),
                };
                event["type"] == "publish.job.phase" || phase.contains("media")
            })
            .cloned()
            .collect();
        Ok(json!({"ref": reference, "mediaEvents": events, "timeline": timeline}))
    })
}

static POST_REF: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"^post:\d+$").unwrap());

struct ReprocessPlan {
    job_id: i64,
    target: String,
    locale: &'static str,
    media: Vec<Value>,
}

/// `reprocessPostMedia`: renders the Story of each distinct media of one
/// publication's Story jobs again, into the path publishing reads.
pub fn media_reprocess<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let reference = input.str("ref");
        if !POST_REF.is_match(reference) {
            return Err(OpError::failed("--ref must look like post:106"));
        }
        let sqlite = context.sqlite()?;
        let mut statement = sqlite.prepare(
            "SELECT job_id,target,payload_json
       FROM publish_jobs
       WHERE publication_key=? AND target IN ('instagram_stories','instagram_stories_ru','telegram_stories')
       ORDER BY job_id",
        )?;
        let rows: Vec<(i64, String, Option<String>)> = statement
            .query_map([reference], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?
            .collect::<Result<_, _>>()?;
        let mut plans: Vec<ReprocessPlan> = Vec::new();
        for (job_id, target, payload_json) in rows {
            let payload = serde_json::from_str::<Value>(payload_json.as_deref().unwrap_or("{}")).unwrap_or(Value::Null);
            let Value::Object(payload) = payload else { continue };
            let items: Vec<Value> = payload_media(&payload).into_iter().map(Value::Object).collect();
            let media = select_media_for_target(&target, &items, |item| item);
            if media.is_empty() {
                continue;
            }
            let locale = if payload.get("locale") == Some(&json!("ru")) || target.ends_with("_ru") {
                "ru"
            } else {
                "en"
            };
            plans.push(ReprocessPlan {
                job_id,
                target,
                locale,
                media,
            });
        }
        // `new Map(plans.map(...))`: the first plan's place, the last plan's value.
        let mut order: Vec<String> = Vec::new();
        let mut unique: HashMap<String, ReprocessPlan> = HashMap::new();
        for plan in plans {
            let key = format!(
                "{}:{}",
                plan.locale,
                domain::json::stringify(&Value::Array(plan.media.clone()))
            );
            if !unique.contains_key(&key) {
                order.push(key.clone());
            }
            unique.insert(key, plan);
        }
        let unique: Vec<ReprocessPlan> = order.iter().filter_map(|key| unique.remove(key)).collect();
        if !input.bool("apply") {
            let plan: Vec<Value> = unique
                .iter()
                .map(|plan| {
                    json!({"jobId": plan.job_id, "target": plan.target, "locale": plan.locale, "media": plan.media})
                })
                .collect();
            return Ok(json!({"ok": true, "apply": false, "ref": reference, "count": unique.len(), "plan": plan}));
        }
        let post_id: i64 = reference[5..].parse().unwrap_or_default();
        let media = delivery_media(context, &config);
        let mut results = Vec::new();
        for plan in &unique {
            let started = context.now();
            let output = repair_story_media(&media, &config, &plan.media, post_id, plan.locale).await?;
            let mut outputs = Map::new();
            for (key, value) in [
                ("storyLocalPath", output.get("storyLocalPath")),
                ("telegramStoryLocalPath", output.get("telegramStoryLocalPath")),
            ] {
                if let Some(value) = value {
                    outputs.insert(key.into(), value.clone());
                }
            }
            results.push(json!({
                "jobId": plan.job_id,
                "target": plan.target,
                "locale": plan.locale,
                "durationMs": elapsed_ms(context, started),
                "outputs": [outputs],
            }));
        }
        Ok(
            json!({"ok": true, "apply": true, "ref": reference, "count": results.len(), "results": results, "published": false}),
        )
    })
}

fn is_video_item(item: &Map<String, Value>) -> bool {
    let kind = match item.get("type") {
        None | Some(Value::Null) => String::new(),
        Some(kind) => foundation::js::string_of(kind),
    };
    kind.to_lowercase().contains("video")
}

/// `repairStoryMedia`: the operator's "make this Story again" for one item,
/// into the content-addressed path publishing reads. A payload with no local
/// media has nowhere for a repair to land.
async fn repair_story_media(
    media: &DeliveryMedia,
    config: &Arc<Config>,
    items: &[Value],
    post_id: i64,
    locale: &str,
) -> Result<MediaItem, OpError> {
    let source = items.first().and_then(Value::as_object);
    let Some((source, local_path)) = source.and_then(|source| {
        source
            .get("localPath")
            .and_then(Value::as_str)
            .map(|path| (source, path))
    }) else {
        return Err(OpError::failed(
            "story_repair_unavailable: this post carries no local media -- re-import it in Studio, then reschedule",
        ));
    };
    let video = is_video_item(source);
    media
        .ensure_story_derivative(
            Arc::clone(config),
            local_path,
            video,
            object(json!({"postId": post_id, "locale": locale, "source": "repair"})),
            true,
        )
        .await
        .map_err(OpError::Failed)?;
    prepared_story_media(config, source).ok_or_else(|| {
        OpError::Failed(format!(
            "story_repair_failed: {}",
            story_variant_paths(config, local_path, video).standard.display()
        ))
    })
}

#[derive(Clone)]
struct StorySource {
    local_path: String,
    video: bool,
    origin: &'static str,
    wanted: bool,
}

/// A `{ mode: "json" }` column as drizzle reads it.
fn json_column(text: Option<String>) -> Result<Value, OpError> {
    match text {
        None => Ok(Value::Null),
        Some(text) => Ok(serde_json::from_str(&text)?),
    }
}

/// `mediaItems`: an array of `jsonObject`s.
fn media_items(value: &Value) -> Vec<Map<String, Value>> {
    let parsed = match value {
        Value::String(text) => serde_json::from_str(text).unwrap_or(json!([])),
        other => other.clone(),
    };
    match parsed {
        Value::Array(items) => items.iter().map(super::timeline::json_object).collect(),
        _ => Vec::new(),
    }
}

/// `pathOf`.
fn path_of(item: &Map<String, Value>) -> Option<String> {
    item.get("local_path")
        .and_then(Value::as_str)
        .or_else(|| item.get("localPath").and_then(Value::as_str))
        .map(str::to_owned)
}

/// `collectSources`: every local file a Story could be made of, once, and
/// whether a draft that publishes a Story points at it.
fn collect_sources(sqlite: &Connection) -> Result<Vec<StorySource>, OpError> {
    let mut wanted: HashSet<String> = HashSet::new();
    let mut sources: Vec<StorySource> = Vec::new();
    let mut statement = sqlite.prepare(
        r#"select "drafts"."targets_json", "post_locales"."media_json" from "post_locales" inner join "drafts" on "drafts"."id" = "post_locales"."draft_id""#,
    )?;
    let locales: Vec<(String, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (targets_json, media_json) in locales {
        let draft_wants_story = publishes_story(sqlite, &targets_json)?;
        for item in media_items(&json_column(media_json)?) {
            let Some(local_path) = path_of(&item) else { continue };
            if draft_wants_story {
                wanted.insert(local_path.clone());
            }
            match sources.iter_mut().find(|source| source.local_path == local_path) {
                Some(existing) => existing.wanted = existing.wanted || draft_wants_story,
                None => sources.push(StorySource {
                    local_path,
                    video: is_video_item(&item),
                    origin: "draft",
                    wanted: draft_wants_story,
                }),
            }
        }
    }
    let mut statement = sqlite.prepare(r#"select "local_path", "kind" from "studio_media_assets""#)?;
    let assets: Vec<(Option<String>, Option<String>)> = statement
        .query_map([], |row| Ok((row.get(0)?, row.get(1)?)))?
        .collect::<Result<_, _>>()?;
    for (local_path, kind) in assets {
        let Some(local_path) = local_path.filter(|path| !path.is_empty()) else {
            continue;
        };
        if sources.iter().any(|source| source.local_path == local_path) {
            continue;
        }
        sources.push(StorySource {
            wanted: wanted.contains(&local_path),
            local_path,
            video: kind.as_deref() == Some("video"),
            origin: "asset",
        });
    }
    Ok(sources)
}

/// `backfillStoryMedia`: renders the Story shapes a publication is going to
/// ask for and not find, wanted ones first, `limit` per run.
pub fn story_media_backfill<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let (apply, limit, all) = (
            input.bool("apply"),
            input.int("limit").max(0) as usize,
            input.bool("all"),
        );
        let sqlite = context.sqlite()?;
        let connected: TargetMap = registered_post_target_ids(sqlite)?
            .into_iter()
            .map(|target| (target, true))
            .collect();
        if !story_targets_enabled(&connected) {
            return Ok(json!({
                "ok": true,
                "applied": false,
                "story_targets_connected": false,
                "missing_wanted": 0,
                "note": "this Studio publishes no Stories",
            }));
        }
        let sources = collect_sources(sqlite)?;
        let (mut gone, mut prepared, mut missing) = (0, 0, Vec::new());
        for source in &sources {
            if !Path::new(&source.local_path).exists() {
                gone += 1;
            } else if story_derivative_present(&config, &source.local_path, source.video) {
                prepared += 1;
            } else {
                missing.push(source.clone());
            }
        }
        let missing_wanted = missing.iter().filter(|source| source.wanted).count();
        let queue: Vec<&StorySource> = missing
            .iter()
            .filter(|source| source.wanted)
            .chain(missing.iter().filter(|source| all && !source.wanted))
            .collect();
        let batch: Vec<&StorySource> = queue.iter().take(limit).copied().collect();
        let mut out = object(json!({
            "ok": true,
            "applied": false,
            "story_targets_connected": true,
            "sources": sources.len(),
            "prepared": prepared,
            "missing_wanted": missing_wanted,
            "missing_unused": missing.len() - missing_wanted,
            "source_file_gone": gone,
            "all": all,
            "plan": batch
                .iter()
                .map(|source| json!({"local_path": source.local_path, "video": source.video, "origin": source.origin}))
                .collect::<Vec<_>>(),
        }));
        if !apply || queue.is_empty() {
            return Ok(Value::Object(out));
        }
        let media = delivery_media(context, &config);
        let mut rendered = 0;
        let mut failed = Vec::new();
        for source in &batch {
            match media
                .ensure_story_derivative(
                    Arc::clone(&config),
                    &source.local_path,
                    source.video,
                    object(json!({"source": "backfill"})),
                    false,
                )
                .await
            {
                Ok(_) => rendered += 1,
                Err(error) => failed.push(json!({"local_path": source.local_path, "error": error})),
            }
        }
        out.insert("ok".into(), json!(failed.is_empty()));
        out.insert("applied".into(), json!(true));
        out.insert("rendered".into(), json!(rendered));
        out.insert("failed".into(), Value::Array(failed));
        out.insert("remaining".into(), json!(queue.len() - rendered));
        Ok(Value::Object(out))
    })
}

fn file_bytes(path: &Path) -> u64 {
    std::fs::metadata(path).map_or(0, |metadata| metadata.len())
}

static PAYLOAD_FILE: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"[A-Za-z0-9._-]+-story-(?:standard|telegram)[A-Za-z0-9._-]*\.(?:jpg|mp4)").unwrap());

/// `payloadNamedFiles`: every file name any publish job payload mentions,
/// read as the text it is stored as.
fn payload_named_files(sqlite: &Connection) -> Result<HashSet<String>, OpError> {
    let mut names = HashSet::new();
    let mut statement = sqlite.prepare(r#"select "payload_json" from "publish_jobs""#)?;
    let payloads: Vec<Option<String>> = statement.query_map([], |row| row.get(0))?.collect::<Result<_, _>>()?;
    for payload in payloads {
        let text = match json_column(payload)? {
            Value::String(text) => text,
            parsed => domain::json::stringify(&parsed),
        };
        names.extend(PAYLOAD_FILE.find_iter(&text).map(|found| found.as_str().to_owned()));
    }
    Ok(names)
}

/// `pruneOrphanedStoryMedia`: removes Story variants whose source is gone;
/// one a publish job's payload still names is never removed.
pub fn story_media_prune<'a>(context: &'a OperationContext<'a>, input: &'a Input) -> Fut<'a, OpResult> {
    Box::pin(async move {
        let config = context.config()?;
        let sqlite = context.sqlite()?;
        let directory = story_directory(&config);
        let orphans = super::admin::orphaned_story_variants(sqlite, &config)?;
        let claimed = payload_named_files(sqlite)?;
        let removable: Vec<&String> = orphans
            .orphaned
            .iter()
            .filter(|name| !claimed.contains(*name))
            .collect();
        let held: Vec<&String> = orphans.orphaned.iter().filter(|name| claimed.contains(*name)).collect();
        let bytes: u64 = removable.iter().map(|name| file_bytes(&directory.join(name))).sum();
        let mut out = object(json!({
            "ok": true,
            "applied": false,
            "variants": orphans.total,
            "orphaned": orphans.orphaned.len(),
            "removable": removable.len(),
            "removable_megabytes": (bytes as f64 / 1_048_576.0 * 10.0).round() / 10.0,
            "held_by_a_publish_job": held,
            "plan": removable.iter().take(50).collect::<Vec<_>>(),
        }));
        if !input.bool("apply") || removable.is_empty() {
            return Ok(Value::Object(out));
        }
        let mut removed = 0;
        for name in &removable {
            match std::fs::remove_file(directory.join(name)) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            removed += 1;
        }
        out.insert("applied".into(), json!(true));
        out.insert("removed".into(), json!(removed));
        Ok(Value::Object(out))
    })
}
