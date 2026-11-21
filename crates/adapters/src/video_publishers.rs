//! The platform side of `delivery/video-publishers.ts`: the YouTube resumable
//! upload and its status edits, Instagram Reels containers, and whether a
//! published video is still there. The video worker loop that drives them
//! belongs to `delivery`.

use std::path::Path;
use std::sync::LazyLock;
use std::time::Duration;

use content::Locale;
use domain::json::stringify;
use regex::Regex;
use runtime::external::instagram::{InstagramCredentials, instagram_credentials_for_locale, instagram_graph_host};
use runtime::external::youtube::youtube_access_token;
use runtime::http::{Body, BodyPart, HttpRequest, Response};
use serde_json::{Map, Value, json};

use crate::error::{AdapterError, Result, absent_if_missing, ambiguous_error, ambiguous_mutation, refused};
use crate::instagram::is_expired_container;
use crate::js::encode_uri_component;
use crate::ports::AdapterContext;
use crate::zernio::{ZernioPlatform, verify_zernio_post};

const VIDEO_UPLOAD_TIMEOUT: Duration = Duration::from_secs(30 * 60);

/// Every mutable field of `videos.status` this project sets. `videos.update`
/// clears any field of the selected part the request omits, so a status edit
/// reads these back and resends them verbatim.
const PRESERVED_YOUTUBE_STATUS_FIELDS: [&str; 5] = [
    "license",
    "embeddable",
    "publicStatsViewable",
    "selfDeclaredMadeForKids",
    "containsSyntheticMedia",
];

/// What a YouTube video's metadata says (`YouTubeMetadata`).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct YoutubeMetadata {
    pub title: String,
    pub description: String,
    pub tags: Vec<String>,
}

/// An uploaded video: YouTube's id and its watch URL. A 2xx answer without
/// an id is still an upload that happened, so it is reported, not refused.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadedVideo {
    pub id: Option<String>,
    pub url: String,
}

fn watch_url(id: &str) -> String {
    format!("https://www.youtube.com/watch?v={id}")
}

/// `String(value)` of an id a provider may have left out (`undefined`).
fn id_text(id: Option<&str>) -> &str {
    id.unwrap_or("undefined")
}

fn locale_code(locale: Locale) -> &'static str {
    match locale {
        Locale::Ru => "ru",
        Locale::En => "en",
    }
}

/// `prepareYouTubeVideo`: a private upload scheduled to go public at
/// `publish_at`, sent through a resumable session.
pub async fn prepare_youtube_video(
    ctx: &AdapterContext,
    file_path: &Path,
    metadata: &YoutubeMetadata,
    publish_at: &str,
    locale: Locale,
) -> Result<UploadedVideo> {
    let token = youtube_access_token(&ctx.client, &ctx.config, locale).await?;
    let size = tokio::fs::metadata(file_path)
        .await
        .map_err(|error| AdapterError::Message(error.to_string()))?
        .len();
    let language = locale_code(locale);
    let body = json!({
        "snippet": {
            "title": metadata.title,
            "description": metadata.description,
            "tags": metadata.tags,
            "categoryId": "20",
            "defaultLanguage": language,
            "defaultAudioLanguage": language,
        },
        "status": {"privacyStatus": "private", "publishAt": publish_at, "selfDeclaredMadeForKids": false},
        "recordingDetails": {"recordingDate": publish_at},
    });
    let request = HttpRequest::post(
        "https://www.googleapis.com/upload/youtube/v3/videos?uploadType=resumable&part=snippet,status,recordingDetails",
    )
    .header("Authorization", format!("Bearer {token}"))
    .header("Content-Type", "application/json; charset=utf-8")
    .header("X-Upload-Content-Type", "video/mp4")
    .header("X-Upload-Content-Length", size.to_string())
    .text(stringify(&body));
    let session = ctx.client.fetch(request).await?;
    if !session.ok() {
        return Err(refused(session, "YouTube upload session").await);
    }
    let Some(location) = session.headers.get("location") else {
        return Err(AdapterError::message_text("YouTube did not return an upload location."));
    };
    let id = upload_resumable(ctx, &location, file_path, size).await?;
    Ok(UploadedVideo {
        url: watch_url(id_text(id.as_deref())),
        id,
    })
}

/// Sends the file; after a lost answer the session says how many bytes it
/// committed, so the upload resumes or settles without a second video.
async fn upload_resumable(ctx: &AdapterContext, location: &str, file_path: &Path, size: u64) -> Result<Option<String>> {
    match put_bytes(ctx, location, file_path, 0, size).await {
        Err(AdapterError::Transport(_)) => {}
        other => return other,
    }
    let status = query_upload_status(ctx, location, size).await?;
    if status.ok() {
        return video_id(status).await;
    }
    if status.status != 308 {
        return Err(refused(status, "YouTube upload status").await);
    }
    let committed = committed_bytes(status.headers.get("range").as_deref());
    if committed >= size as f64 {
        // Every byte arrived but the final representation is still
        // converging. Never send an empty, invalid N-(N-1) range; ask again.
        let confirmed = query_upload_status(ctx, location, size).await?;
        if confirmed.ok() {
            return video_id(confirmed).await;
        }
        return Err(ambiguous_error(
            "youtube_upload",
            "YouTube received every byte but did not return the video resource",
        ));
    }
    ambiguous_mutation(
        "youtube_upload",
        put_bytes(ctx, location, file_path, committed as u64, size),
    )
    .await
}

static RANGE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"bytes=0-(\d+)").unwrap());

/// `Number(range.match(/bytes=0-(\d+)/)?.[1] ?? -1) + 1`.
fn committed_bytes(range: Option<&str>) -> f64 {
    range
        .and_then(|range| RANGE.captures(range))
        .map_or(-1.0, |captures| foundation::js::number(&captures[1]))
        + 1.0
}

async fn query_upload_status(ctx: &AdapterContext, location: &str, total: u64) -> Result<Response> {
    let request = HttpRequest::put(location)
        .header("Content-Length", "0")
        .header("Content-Range", format!("bytes */{total}"));
    Ok(ctx.client.fetch(request).await?)
}

async fn put_bytes(
    ctx: &AdapterContext,
    location: &str,
    file_path: &Path,
    start: u64,
    total: u64,
) -> Result<Option<String>> {
    let request = HttpRequest::put(location)
        .header("Content-Type", "video/mp4")
        .header("Content-Length", (total - start).to_string())
        .header(
            "Content-Range",
            format!("bytes {start}-{}/{total}", total.saturating_sub(1)),
        )
        .body(Body(vec![BodyPart::File {
            path: file_path.to_owned(),
            offset: start,
        }]));
    let response = ctx.client.fetch_within(request, VIDEO_UPLOAD_TIMEOUT).await?;
    if !response.ok() {
        return Err(refused(response, "YouTube upload").await);
    }
    video_id(response).await
}

async fn video_id(response: Response) -> Result<Option<String>> {
    let video = crate::error::parse_json(&response.text().await?)?;
    Ok(video.get("id").and_then(Value::as_str).map(str::to_owned))
}

/// `keepYouTubeUploadPrivate`: stops a future release but keeps the private
/// upload. Not for a target that may already have been published.
pub async fn keep_youtube_upload_private(ctx: &AdapterContext, video_id: &str, locale: Locale) -> Result<()> {
    let token = youtube_access_token(&ctx.client, &ctx.config, locale).await?;
    let authorization = format!("Bearer {token}");
    let current = ctx
        .client
        .request_json(
            HttpRequest::get(format!(
                "https://www.googleapis.com/youtube/v3/videos?part=status&id={}",
                encode_uri_component(video_id)
            ))
            .header("Authorization", authorization.clone()),
        )
        .await?;
    let Some(status) = current.pointer("/items/0/status").and_then(Value::as_object) else {
        return Err(AdapterError::message_text(
            "YouTube upload was not found while cancelling its schedule.",
        ));
    };
    // videos.update clears omitted mutable fields of the selected part: keep
    // the existing settings and deliberately leave publishAt out.
    let mut next = Map::new();
    next.insert("privacyStatus".into(), "private".into());
    for field in PRESERVED_YOUTUBE_STATUS_FIELDS {
        if let Some(value) = crate::js::present(status.get(field)) {
            next.insert(field.into(), value.clone());
        }
    }
    ctx.client
        .request_json(
            HttpRequest::put("https://www.googleapis.com/youtube/v3/videos?part=status")
                .header("Authorization", authorization)
                .header("Content-Type", "application/json; charset=utf-8")
                .text(stringify(&json!({"id": video_id, "status": next}))),
        )
        .await?;
    Ok(())
}

/// A video as YouTube reports it: existence is not publication, so the
/// privacy status comes with it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct VerifiedVideo {
    pub id: String,
    pub url: String,
    pub privacy_status: Option<String>,
}

/// `verifyYouTubeVideo`.
pub async fn verify_youtube_video(ctx: &AdapterContext, video_id: &str, locale: Locale) -> Result<VerifiedVideo> {
    let token = youtube_access_token(&ctx.client, &ctx.config, locale).await?;
    let response = ctx
        .client
        .request_json(
            HttpRequest::get(format!(
                "https://www.googleapis.com/youtube/v3/videos?part=id,status&id={}",
                encode_uri_component(video_id)
            ))
            .header("Authorization", format!("Bearer {token}")),
        )
        .await?;
    let video = response.pointer("/items/0");
    if video.and_then(|video| video.get("id")).and_then(Value::as_str) != Some(video_id) {
        return Err(AdapterError::message_text(
            "YouTube verification did not find the expected video",
        ));
    }
    Ok(VerifiedVideo {
        id: video_id.to_owned(),
        url: watch_url(video_id),
        privacy_status: video
            .and_then(|video| video.pointer("/status/privacyStatus"))
            .and_then(Value::as_str)
            .map(str::to_owned),
    })
}

/// The video target whose presence is asked about.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoTargetRef<'a> {
    pub target: &'a str,
    pub external_id: Option<&'a str>,
    pub delivery_provider: &'a str,
    pub provider_post_id: Option<&'a str>,
}

/// `videoTargetIsAbsent`: asked of the platform itself, because Instagram
/// serves a login wall with HTTP 200 whether or not the reel is there.
pub async fn video_target_is_absent(ctx: &AdapterContext, target: VideoTargetRef<'_>, locale: Locale) -> Result<bool> {
    if target.delivery_provider == "zernio" {
        let Some(provider_post_id) = target.provider_post_id.filter(|id| !id.is_empty()) else {
            return Err(AdapterError::message_text(
                "cannot ask the provider about a target with no provider post id",
            ));
        };
        return absent_if_missing(verify_zernio_post(ctx, provider_post_id, ZernioPlatform::Instagram).await);
    }
    let Some(external_id) = target.external_id.filter(|id| !id.is_empty()) else {
        return Err(AdapterError::Message(format!(
            "cannot ask {} about a target with no external id",
            target.target
        )));
    };
    if target.target == "youtube_shorts" {
        return absent_if_missing(verify_youtube_video(ctx, external_id, locale).await);
    }
    let credentials = instagram_credentials_for_locale(&ctx.config, locale);
    let Some(token) = credentials.access_token.filter(|token| !token.is_empty()) else {
        return Err(AdapterError::message_text("Instagram credentials are missing"));
    };
    let url = format!(
        "{}/{external_id}?fields=id&access_token={}",
        graph_base(ctx, token),
        encode_uri_component(token)
    );
    absent_if_missing(
        ctx.client
            .request_json(HttpRequest::get(url))
            .await
            .map_err(AdapterError::from),
    )
}

fn graph_base(ctx: &AdapterContext, token: &str) -> String {
    format!(
        "https://{}/{}",
        instagram_graph_host(token),
        ctx.config.instagram_graph_api_version
    )
}

fn account<'a>(credentials: InstagramCredentials<'a>) -> Result<(&'a str, &'a str)> {
    match (
        credentials.access_token.filter(|token| !token.is_empty()),
        credentials.user_id.filter(|id| !id.is_empty()),
    ) {
        (Some(token), Some(user_id)) => Ok((token, user_id)),
        _ => Err(AdapterError::message_text("Instagram credentials are missing")),
    }
}

/// `prepareInstagramReel`: the REELS container. Instagram has one caption
/// field; hashtags are part of the caption the creator writes.
pub async fn prepare_instagram_reel(
    ctx: &AdapterContext,
    credentials: InstagramCredentials<'_>,
    public_url: &str,
    caption: &str,
) -> Result<Option<String>> {
    let (token, user_id) = account(credentials)?;
    let request = HttpRequest::post(format!("{}/{user_id}/media", graph_base(ctx, token))).form(&[
        ("media_type", Some("REELS")),
        ("video_url", Some(public_url)),
        ("caption", Some(foundation::js::trim(caption))),
        ("share_to_feed", Some("true")),
        ("access_token", Some(token)),
    ]);
    let response = ctx.client.request_json(request).await?;
    Ok(response.get("id").and_then(Value::as_str).map(str::to_owned))
}

/// `instagramContainerReady`: `Ok` once FINISHED; a dead container is
/// [`AdapterError::ContainerInvalid`], one still processing
/// [`AdapterError::ContainerProcessing`].
pub async fn instagram_container_ready(
    ctx: &AdapterContext,
    credentials: InstagramCredentials<'_>,
    container_id: &str,
) -> Result<()> {
    let (token, _) = account(credentials)?;
    let url = format!(
        "{}/{container_id}?fields=status_code,status&access_token={}",
        graph_base(ctx, token),
        encode_uri_component(token)
    );
    let status = ctx.client.request_json(HttpRequest::get(url)).await?;
    let code = status.get("status_code").and_then(Value::as_str);
    if matches!(code, Some("ERROR" | "EXPIRED")) {
        let detail = match status.get("status") {
            Some(detail) if !detail.is_null() => domain::json::js_string(detail),
            _ => "unknown error".into(),
        };
        return Err(AdapterError::ContainerInvalid(format!(
            "Instagram container {}: {detail}",
            code.unwrap_or_default()
        )));
    }
    if code != Some("FINISHED") {
        return Err(AdapterError::ContainerProcessing(format!(
            "Instagram container {}",
            code.unwrap_or("PROCESSING")
        )));
    }
    Ok(())
}

/// `publishInstagramReel`. A 400 naming a dead creation_id means the
/// container died after its last good poll: the worker starts a fresh
/// prepare cycle instead of retrying it.
pub async fn publish_instagram_reel(
    ctx: &AdapterContext,
    credentials: InstagramCredentials<'_>,
    container_id: &str,
) -> Result<UploadedReel> {
    let (token, user_id) = account(credentials)?;
    let request = HttpRequest::post(format!("{}/{user_id}/media_publish", graph_base(ctx, token)))
        .form(&[("creation_id", Some(container_id)), ("access_token", Some(token))]);
    let published = ambiguous_mutation("instagram_reels", async { Ok(ctx.client.request_json(request).await?) })
        .await
        .map_err(|error| {
            if is_expired_container(&error, Some(400)) {
                AdapterError::ContainerInvalid(error.message().to_owned())
            } else {
                error
            }
        })?;
    let id = published.get("id").and_then(Value::as_str).map(str::to_owned);
    Ok(UploadedReel {
        url: format!("https://www.instagram.com/reel/{}/", id_text(id.as_deref())),
        id,
    })
}

/// A published reel. Like an upload, an answer without an id is still a
/// publication.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UploadedReel {
    pub id: Option<String>,
    pub url: String,
}
