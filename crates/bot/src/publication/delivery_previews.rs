//! The delivery previews (`interfaces/telegram/delivery-previews.ts`, spec
//! §7.6): what each platform will receive, rendered from Studio's delivery
//! projections. It owns no planning decisions.

use content::message::{Entity, MediaItem};
use domain::publishing::threads_text::{threads_body, threads_text_limit};
use domain::studio::projections::DeliveryProjection;
use foundation::i18n::{Key, t};
use foundation::logger::{LogLevel, log};
use foundation::markdown::escape_markdown;
use serde_json::{Map, Value, json};

use crate::Fut;
use crate::api::FileSource;
use crate::api::payload::{InputFile, Payload};
use crate::context::Ctx;
use crate::effects::{Below, Effect, error_js_string};

const TELEGRAM_MEDIA_GROUP_LIMIT: usize = 10;

/// Telegram allows 1024 characters in a caption; a preview stops short of
/// that so the text it shows is the post's own. Past the budget the media
/// goes first and the text follows as its own message.
const PREVIEW_CAPTION_LIMIT: usize = 1000;

fn below<F>(run: F) -> Below
where
    F: for<'a> FnOnce(&'a Ctx) -> Fut<'a, crate::Result<()>> + 'static,
{
    Box::new(run)
}

/// The `delivery-previews` effect: the previews, below whatever the update
/// has already shown.
pub fn effect(projections: Vec<DeliveryProjection>) -> Effect {
    Effect::Below(below(move |ctx| {
        Box::pin(async move {
            send(ctx, &projections).await;
            Ok(())
        })
    }))
}

/// `sendTelegramDeliveryPreviews`: one unrenderable projection must not
/// swallow the previews that follow it.
pub async fn send(ctx: &Ctx, projections: &[DeliveryProjection]) {
    for projection in projections {
        if let Err(error) = send_projection(ctx, projection).await {
            log(
                LogLevel::Error,
                "telegram delivery preview failed",
                Some(json!({"projection": projection.id, "error": error_js_string(&*error)})),
            );
        }
    }
}

async fn send_projection(ctx: &Ctx, projection: &DeliveryProjection) -> crate::Result<()> {
    let targets = match projection.targets.join(" · ") {
        joined if joined.is_empty() => t(Key::PreviewNoCompatibleTarget, &[]),
        joined => joined,
    };
    let header = format!(
        "👁 *{}*\n{}",
        escape_markdown(&projection.label),
        escape_markdown(&targets)
    );
    ctx.reply(&header, Payload::new().markdown()).await?;
    if !projection.targets.is_empty() {
        send_projection_content(ctx, projection).await?;
    }
    if !projection.notes.is_empty() {
        let notes: Vec<String> = projection
            .notes
            .iter()
            .map(|note| format!("ℹ️ {}", escape_markdown(note)))
            .collect();
        ctx.reply(&notes.join("\n"), Payload::new().markdown()).await?;
    }
    Ok(())
}

async fn send_projection_content(ctx: &Ctx, projection: &DeliveryProjection) -> crate::Result<()> {
    let metadata = projection.metadata.as_ref().map(format_metadata).unwrap_or_default();
    let text = [projection.text.as_str(), metadata.as_str()]
        .into_iter()
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    // Metadata is preview-only and has no source entities; formatting is kept
    // only when the projection carries its original post text unchanged.
    let entities: &[Entity] = if metadata.is_empty() { &projection.entities } else { &[] };
    send_media(ctx, &projection.media, &text, entities).await?;
    // A thread is previewed post by post, in the order it will be read.
    for part in projection.thread.iter().flatten() {
        send_media(ctx, &part.media, &part.text, &part.entities).await?;
    }
    // And for every Threads account it goes to, the posts as Threads will
    // receive them: cut at its own budget, counted, the link's fate stated.
    for chain in projection.chains.iter().flatten() {
        let Some((first, rest)) = chain.posts.split_first() else {
            continue;
        };
        let rest: Vec<(&str, &[Entity])> = rest
            .iter()
            .map(|post| (post.text.as_str(), post.entities.as_slice()))
            .collect();
        let text = threads_preview_text(&chain.target, &first.text, &first.entities, &rest);
        ctx.reply(&text, Payload::new()).await?;
    }
    Ok(())
}

struct Renderable {
    source: FileSource,
    video: bool,
}

/// Sends whatever of `media` Telegram can address, with `text` attached once.
async fn send_media(ctx: &Ctx, media: &[MediaItem], text: &str, entities: &[Entity]) -> crate::Result<()> {
    // An item with neither a local path nor a file id cannot be sent; dropping
    // it keeps the rest of the album from riding on the first item's fate.
    let items: Vec<Renderable> = media
        .iter()
        .filter_map(|item| {
            media_source(item).map(|source| Renderable {
                source,
                video: is_video(item),
            })
        })
        .collect();
    let length = text.encode_utf16().count();
    let Some(first) = items.first() else {
        if !text.is_empty() {
            ctx.reply(text, entity_options("entities", entities, length)).await?;
        }
        return Ok(());
    };
    let has_caption = !text.is_empty() && length <= PREVIEW_CAPTION_LIMIT;
    let caption = if has_caption {
        Payload::new()
            .set("caption", text)
            .extend(entity_options("caption_entities", entities, length))
    } else {
        Payload::new()
    };
    if items.len() > 1 {
        // Telegram rejects an album larger than 10 outright, which would lose
        // the whole preview: the first ten go as the album, the rest one by one.
        let mut payload = Payload::new().set("chat_id", ctx.chat_id().unwrap_or_default());
        let mut group = Vec::new();
        for (index, item) in items.iter().take(TELEGRAM_MEDIA_GROUP_LIMIT).enumerate() {
            let kind = if item.video { "video" } else { "photo" };
            let media = match &item.source {
                FileSource::Upload(file) => payload.attach(kind, file.clone()),
                FileSource::Id(id) => id.clone(),
            };
            let mut entry = Map::new();
            entry.insert("type".into(), kind.into());
            entry.insert("media".into(), media.into());
            if index == 0 {
                for (key, value) in caption.entries() {
                    if let crate::api::payload::Field::Json(value) = value {
                        entry.insert(key.clone(), value.clone());
                    }
                }
            }
            group.push(Value::Object(entry));
        }
        ctx.call("sendMediaGroup", ctx.reply_fields(payload).set("media", group))
            .await?;
        for item in items.iter().skip(TELEGRAM_MEDIA_GROUP_LIMIT) {
            let (method, key) = file_method(item.video);
            ctx.reply_with_file(method, key, item.source.clone(), Payload::new())
                .await?;
        }
    } else {
        let (method, key) = file_method(first.video);
        ctx.reply_with_file(method, key, first.source.clone(), caption).await?;
    }
    if !text.is_empty() && !has_caption {
        ctx.reply(text, entity_options("entities", entities, length)).await?;
    }
    Ok(())
}

fn file_method(video: bool) -> (&'static str, &'static str) {
    if video {
        ("sendVideo", "video")
    } else {
        ("sendPhoto", "photo")
    }
}

fn is_video(media: &MediaItem) -> bool {
    let kind = match media.get("type") {
        None | Some(Value::Null) => "photo".to_owned(),
        Some(Value::String(kind)) => kind.clone(),
        Some(other) => other.to_string(),
    };
    kind.to_lowercase() == "video"
}

/// `threadsPreviewText`: each post of a thread is its own Threads post with
/// its own budget, so the counter is per post; an ordinary post is a thread
/// of one.
pub fn threads_preview_text(target: &str, text: &str, entities: &[Entity], thread: &[(&str, &[Entity])]) -> String {
    let limit = threads_text_limit(target);
    let label = if target == "threads_ru" {
        "Threads RU"
    } else {
        "Threads EN"
    };
    let posts: Vec<_> = std::iter::once((text, entities))
        .chain(thread.iter().copied())
        .map(|(text, entities)| threads_body(target, text, entities))
        .collect();
    let budget = |body: &str| {
        let length = body.encode_utf16().count();
        format!("{length}/{limit}{}", if length > limit { " ⚠️" } else { "" })
    };
    // The link's fate is stated on the counter line, with how many characters
    // it was short.
    let link_note = |decision: &domain::publishing::threads_text::ThreadsBody| {
        if decision.dropped_url.is_some() {
            format!(
                " · {}",
                t(Key::PreviewThreadsLinkDropped, &[("shortfall", &decision.shortfall)])
            )
        } else if decision.url.is_some() {
            format!(" · {}", t(Key::PreviewThreadsLinkKept, &[]))
        } else {
            String::new()
        }
    };
    if let [first] = posts.as_slice() {
        return format!(
            "🧵 {label} · {}{}\n\n{}",
            budget(&first.text),
            link_note(first),
            first.text
        );
    }
    let body: Vec<String> = posts
        .iter()
        .enumerate()
        .map(|(index, post)| {
            format!(
                "{} {}{}\n{}",
                thread_marker(index),
                budget(&post.text),
                link_note(post),
                post.text
            )
        })
        .collect();
    format!("🧵 {label} · {}\n\n{}", posts.len(), body.join("\n\n"))
}

fn thread_marker(index: usize) -> String {
    const MARKERS: [&str; 10] = ["①", "②", "③", "④", "⑤", "⑥", "⑦", "⑧", "⑨", "⑩"];
    MARKERS
        .get(index)
        .map_or_else(|| format!("{}.", index + 1), |marker| (*marker).to_owned())
}

/// `{ <key>: entities }` when any survive, else nothing: an entity reaching
/// past the text it annotates is a 400 from Telegram, so it is clamped or dropped.
fn entity_options(key: &str, entities: &[Entity], length: usize) -> Payload {
    let safe = safe_entities(entities, length);
    if safe.is_empty() {
        Payload::new()
    } else {
        Payload::new().set(key, safe)
    }
}

fn safe_entities(entities: &[Entity], length: usize) -> Vec<Value> {
    let length = length as f64;
    entities
        .iter()
        .filter_map(|entity| {
            let offset = js_number(entity.get("offset"));
            let entity_length = js_number(entity.get("length"));
            let safe = |value: f64| foundation::js::is_safe_integer(value);
            if !safe(offset) || !safe(entity_length) || offset < 0.0 || entity_length <= 0.0 || offset >= length {
                return None;
            }
            let mut entity = entity.clone();
            entity.insert("offset".into(), json!(offset as i64));
            entity.insert("length".into(), json!(entity_length.min(length - offset) as i64));
            Some(Value::Object(entity))
        })
        .collect()
}

/// `Number(value)`.
fn js_number(value: Option<&Value>) -> f64 {
    match value {
        None => f64::NAN,
        Some(Value::Null) => 0.0,
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Number(number)) => number.as_f64().unwrap_or(f64::NAN),
        Some(Value::String(text)) => foundation::js::number(text),
        Some(_) => f64::NAN,
    }
}

fn string_field<'a>(media: &'a MediaItem, key: &str) -> Option<&'a str> {
    media.get(key).and_then(Value::as_str)
}

/// A local file uploads itself; otherwise the Telegram file id, if any.
pub fn media_source(media: &MediaItem) -> Option<FileSource> {
    let path = string_field(media, "local_path").or_else(|| string_field(media, "localPath"));
    if let Some(path) = path.filter(|path| !path.is_empty()) {
        return Some(FileSource::Upload(InputFile::path(path)));
    }
    string_field(media, "file_id")
        .or_else(|| string_field(media, "fileId"))
        .map(|id| FileSource::Id(id.to_owned()))
}

/// The preview-only metadata of a video projection.
fn format_metadata(metadata: &Map<String, Value>) -> String {
    let text = |key: &str| {
        metadata
            .get(key)
            .filter(|value| domain::json::truthy(value))
            .map(domain::json::js_string)
    };
    let mut lines = Vec::new();
    if let Some(title) = text("title") {
        lines.push(format!("{}: {title}", t(Key::PreviewMetadataTitle, &[])));
    }
    if let Some(description) = text("description") {
        lines.push(format!("{}: {description}", t(Key::PreviewMetadataDescription, &[])));
    }
    if let Some(caption) = text("caption") {
        lines.push(format!("{}: {caption}", t(Key::PreviewMetadataCaption, &[])));
    }
    if let Some(Value::Array(tags)) = metadata.get("tags")
        && !tags.is_empty()
    {
        let tags: Vec<String> = tags.iter().map(domain::json::js_string).collect();
        lines.push(format!("{}: {}", t(Key::PreviewMetadataTags, &[]), tags.join(", ")));
    }
    if let Some(game) = text("gameUrl") {
        lines.push(format!("{}: {game}", t(Key::PreviewMetadataGame, &[])));
    }
    lines.join("\n")
}
