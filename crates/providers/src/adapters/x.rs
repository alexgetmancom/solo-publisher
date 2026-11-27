//! Posts and reply chains over the v2 API, media
//! through the chunked upload, and Articles in their two calls.

use std::time::Duration;

use content::message::Entity;
use domain::json::stringify;
use domain::publishing::errors::PublishResult;
use domain::publishing::platform_profiles::format_platform_text;
use foundation::url::encode_uri_component;
use runtime::http::{HttpRequest, Response};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncReadExt as _, AsyncSeekExt as _};

use crate::adapters::error::{AdapterError, Result, ambiguous_mutation, publish_json, refused};
use crate::adapters::multipart::Form;
use crate::adapters::payload::{
    exists, field, guess_content_type, is_video, payload_media, payload_text, payload_thread,
};
use crate::adapters::ports::AdapterContext;

const UPLOAD_URL: &str = "https://api.x.com/2/media/upload";
const SEGMENT_BYTES: usize = 2 * 1024 * 1024;
const PROCESSING_DEADLINE: Duration = Duration::from_secs(600);

/// The posts of a chain that have already reached the audience.
const CHAIN_RESUME_KEY: &str = "_xPublishedIds";
/// Where a half-published Article leaves the draft it already created.
const ARTICLE_RESUME_KEY: &str = "_xArticleDraftId";

/// `publishToX`: one post, or a thread as a reply chain where each part
/// answers the one before it with its own media. A part that fails after
/// earlier ones went out hands their ids back, so the retry continues the
/// chain instead of starting a second one.
pub async fn publish_to_x(ctx: &AdapterContext, payload: &Map<String, Value>) -> Result<PublishResult> {
    assert_access_token(ctx)?;
    let mut parts = vec![(payload_text(payload), payload_media(payload))];
    parts.extend(payload_thread(payload).into_iter().map(|part| (part.text, part.media)));
    let mut published: Vec<String> = match payload.get(CHAIN_RESUME_KEY) {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_str)
            .filter(|id| !id.is_empty())
            .map(str::to_owned)
            .collect(),
        _ => Vec::new(),
    };
    let mut raw = Value::Null;
    let chain = async {
        for (text, media) in parts.iter().skip(published.len()) {
            let mut media_ids = Vec::new();
            for item in media {
                let Some(path) = field(item, "localPath").filter(|path| exists(path)) else {
                    continue;
                };
                let category = if is_video(item) { "tweet_video" } else { "tweet_image" };
                media_ids.push(upload_media(ctx, path, category).await?);
            }
            let mut body = Map::new();
            body.insert("text".into(), format_platform_text("x", text).into());
            if !media_ids.is_empty() {
                body.insert("media".into(), json!({"media_ids": media_ids}));
            }
            if let Some(parent) = published.last() {
                body.insert("reply".into(), json!({"in_reply_to_tweet_id": parent}));
            }
            let request = HttpRequest::post("https://api.x.com/2/tweets")
                .header("Content-Type", "application/json")
                .text(stringify(&Value::Object(body)));
            let response = ambiguous_mutation("x", x_fetch(ctx, request)).await?;
            let result = publish_json(response, "X tweet create").await?;
            let id = result
                .pointer("/data/id")
                .and_then(Value::as_str)
                .filter(|id| !id.is_empty())
                .map(str::to_owned);
            raw = result;
            // Nothing to reply to and nothing to settle on: the first post
            // without an id is not published, and a later one leaves the
            // chain to resume.
            match id {
                Some(id) => published.push(id),
                None if published.is_empty() => return Ok(false),
                None => return Err(AdapterError::message_text("x_tweet_missing_id")),
            }
        }
        Ok(true)
    }
    .await;
    match chain {
        Ok(false) => return Ok(unpublished(raw)),
        Ok(true) => {}
        Err(error) if error.is_ambiguous() || published.is_empty() => return Err(error),
        Err(error) => {
            let mut result = Map::new();
            result.insert("ok".into(), false.into());
            result.insert("partial".into(), true.into());
            result.insert("retryable".into(), true.into());
            result.insert("resumeKey".into(), CHAIN_RESUME_KEY.into());
            result.insert("ids".into(), json!(published));
            result.insert("error".into(), error.message().into());
            return Ok(result);
        }
    }
    let Some(root) = published.first().cloned() else {
        return Ok(unpublished(raw));
    };
    let mut result = Map::new();
    result.insert("ok".into(), true.into());
    result.insert("id".into(), root.clone().into());
    result.insert("ids".into(), json!(published));
    result.insert("url".into(), format!("https://x.com/i/web/status/{root}").into());
    result.insert("raw".into(), raw);
    Ok(result)
}

fn unpublished(raw: Value) -> PublishResult {
    let mut result = Map::new();
    result.insert("ok".into(), false.into());
    result.insert("id".into(), Value::Null);
    result.insert("url".into(), Value::Null);
    result.insert("raw".into(), raw);
    result
}

fn refusal(error: &str) -> PublishResult {
    let mut result = Map::new();
    result.insert("ok".into(), false.into());
    result.insert("error".into(), error.into());
    result
}

/// `publishXArticle`: a draft carrying the body, then the publish that puts
/// it in front of an audience. Only the second call can reach anyone, so only
/// it is ambiguous when its answer is lost; the draft id is handed back on a
/// retryable failure so the next attempt publishes the draft it already made.
pub async fn publish_x_article(ctx: &AdapterContext, payload: &Map<String, Value>) -> Result<PublishResult> {
    assert_access_token(ctx)?;
    // The queue stores a resume under its key as the id list it settled with.
    let mut article_id = match payload.get(ARTICLE_RESUME_KEY) {
        Some(Value::Array(ids)) => ids
            .iter()
            .filter_map(Value::as_str)
            .find(|id| !id.is_empty())
            .unwrap_or_default()
            .to_owned(),
        _ => String::new(),
    };

    if article_id.is_empty() {
        let mut media_ids = Vec::new();
        for item in payload_media(payload) {
            if is_video(&item) {
                continue;
            }
            let Some(path) = field(&item, "localPath").filter(|path| exists(path)) else {
                continue;
            };
            media_ids.push(upload_media(ctx, path, "tweet_image").await?);
        }
        let entities: Vec<Entity> = payload
            .get("entities")
            .and_then(Value::as_array)
            .map(|entities| {
                entities
                    .iter()
                    .filter_map(|entity| entity.as_object().cloned())
                    .collect()
            })
            .unwrap_or_default();
        let title = payload
            .get("title")
            .and_then(Value::as_str)
            .map(str::trim)
            .unwrap_or_default();
        if title.is_empty() {
            return Ok(refusal("x_article_title_missing"));
        }
        // A lost draft call has reached nobody: an ordinary retryable
        // failure, and the retry writes a fresh draft.
        let content_state =
            crate::adapters::x_content_state::to_content_state(&payload_text(payload), &entities, &media_ids);
        let request = HttpRequest::post("https://api.x.com/2/articles/draft")
            .header("Content-Type", "application/json")
            .text(stringify(&json!({"title": title, "content_state": content_state})));
        let draft = publish_json(x_fetch(ctx, request).await?, "X article draft").await?;
        article_id = draft
            .pointer("/data/id")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        if article_id.is_empty() {
            return Ok(refusal("x_article_draft_missing_id"));
        }
    }

    let publish = async {
        let request = HttpRequest::post(format!(
            "https://api.x.com/2/articles/{}/publish",
            encode_uri_component(&article_id)
        ));
        let response = ambiguous_mutation("x_article", x_fetch(ctx, request)).await?;
        publish_json(response, "X article publish").await
    }
    .await;
    match publish {
        Ok(result) => {
            let id = result
                .pointer("/data/id")
                .and_then(foundation::json::id_text)
                .unwrap_or_else(|| article_id.clone());
            let mut published = Map::new();
            published.insert("ok".into(), true.into());
            published.insert("id".into(), id.clone().into());
            published.insert("url".into(), format!("https://x.com/i/article/{id}").into());
            published.insert("raw".into(), result);
            Ok(published)
        }
        Err(error) if error.is_ambiguous() => Err(error),
        // The draft exists and nobody has seen it. Carrying its id forward
        // keeps a retry from leaving a second unpublished article behind.
        Err(error) => {
            let mut result = Map::new();
            result.insert("ok".into(), false.into());
            result.insert("partial".into(), true.into());
            result.insert("retryable".into(), true.into());
            result.insert("resumeKey".into(), ARTICLE_RESUME_KEY.into());
            result.insert("ids".into(), json!([article_id]));
            result.insert("error".into(), error.message().into());
            Ok(result)
        }
    }
}

/// `verifyXPost`.
pub async fn verify_x_post(ctx: &AdapterContext, id: &str) -> Result<String> {
    let request = HttpRequest::get(format!("https://api.x.com/2/tweets/{}", encode_uri_component(id)));
    let result = publish_json(x_fetch(ctx, request).await?, "X post verify").await?;
    if result.pointer("/data/id").and_then(Value::as_str) != Some(id) {
        return Err(AdapterError::message_text(
            "X verification did not return the expected post",
        ));
    }
    Ok(id.to_owned())
}

/// INIT, one APPEND per 2 MiB segment, FINALIZE, then wait for processing.
async fn upload_media(ctx: &AdapterContext, path: &str, category: &str) -> Result<String> {
    let io = |error: std::io::Error| AdapterError::Message(error.to_string());
    let size = tokio::fs::metadata(path).await.map_err(io)?.len();
    let request = HttpRequest::post(format!("{UPLOAD_URL}/initialize"))
        .header("Content-Type", "application/json")
        .text(stringify(&json!({
            "total_bytes": size,
            "media_type": guess_content_type(path),
            "media_category": category,
        })));
    let initialized = publish_json(x_fetch(ctx, request).await?, "X media INIT").await?;
    let Some(media_id) = initialized
        .pointer("/data/id")
        .and_then(Value::as_str)
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
    else {
        return Err(AdapterError::message_text("X media INIT missing data.id"));
    };

    let mut file = tokio::fs::File::open(path).await.map_err(io)?;
    let mut position = 0u64;
    let mut segment_index = 0;
    loop {
        file.seek(std::io::SeekFrom::Start(position)).await.map_err(io)?;
        let mut segment = Vec::with_capacity(SEGMENT_BYTES);
        (&mut file)
            .take(SEGMENT_BYTES as u64)
            .read_to_end(&mut segment)
            .await
            .map_err(io)?;
        if segment.is_empty() {
            break;
        }
        let read = segment.len() as u64;
        let mut form = Form::new();
        form.text("segment_index", &segment_index.to_string());
        form.blob(
            "media",
            segment,
            &format!("segment-{segment_index}"),
            "application/octet-stream",
        );
        let request = form.attach(HttpRequest::post(format!("{UPLOAD_URL}/{media_id}/append")));
        let response = x_fetch(ctx, request).await?;
        if !response.ok() {
            return Err(refused(response, &format!("X media APPEND {segment_index}")).await);
        }
        position += read;
        segment_index += 1;
    }

    let request = HttpRequest::post(format!("{UPLOAD_URL}/{media_id}/finalize"));
    let finalized = publish_json(x_fetch(ctx, request).await?, "X media FINALIZE").await?;
    wait_for_processing(ctx, &media_id, processing_info(&finalized)).await?;
    Ok(media_id)
}

fn processing_info(response: &Value) -> Option<Value> {
    response
        .pointer("/data/processing_info")
        .filter(|info| !info.is_null())
        .or_else(|| response.get("processing_info").filter(|info| !info.is_null()))
        .cloned()
}

async fn wait_for_processing(ctx: &AdapterContext, media_id: &str, initial: Option<Value>) -> Result<()> {
    let mut processing = initial;
    let deadline = tokio::time::Instant::now() + PROCESSING_DEADLINE;
    while let Some(info) = processing.as_ref().filter(|info| {
        matches!(
            info.get("state").and_then(Value::as_str),
            Some("pending" | "in_progress")
        )
    }) {
        if tokio::time::Instant::now() >= deadline {
            return Err(AdapterError::message_text("X media processing timeout"));
        }
        let check_after = info.get("check_after_secs").and_then(Value::as_f64).unwrap_or(5.0);
        tokio::time::sleep(Duration::from_secs_f64(check_after.max(1.0))).await;
        let query = url::form_urlencoded::Serializer::new(String::new())
            .append_pair("media_id", media_id)
            .finish();
        let request = HttpRequest::get(format!("{UPLOAD_URL}?{query}"));
        let result = publish_json(x_fetch(ctx, request).await?, "X media STATUS").await?;
        processing = processing_info(&result);
        if let Some(info) = &processing
            && info.get("state").and_then(Value::as_str) == Some("failed")
        {
            let message = info
                .pointer("/error/message")
                .and_then(Value::as_str)
                .unwrap_or("Unknown error");
            return Err(AdapterError::Message(format!("X video processing failed: {message}")));
        }
    }
    Ok(())
}

async fn x_fetch(ctx: &AdapterContext, request: HttpRequest) -> Result<Response> {
    let token = assert_access_token(ctx)?;
    Ok(ctx
        .client
        .fetch(request.header("Authorization", format!("Bearer {token}")))
        .await?)
}

fn assert_access_token(ctx: &AdapterContext) -> Result<&str> {
    ctx.config
        .x_access_token
        .as_deref()
        .filter(|token| !token.is_empty())
        .ok_or_else(|| AdapterError::message_text("missing X OAuth access token; connect X in Studio > Channels"))
}
