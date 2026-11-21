//! `delivery/social/telegramStories.ts`, the Rust half: the guards, the
//! caption with its clickable hidden links, the upload description and the
//! small-file re-encode. The MTProto call itself (mtcute's
//! `stories.sendStory`) stays in the TypeScript sidecar, reached through
//! [`StoriesSidecar`]; its contract is in this crate's README.

use std::path::{Path, PathBuf};
use std::sync::LazyLock;
use std::time::Duration;

use content::message::MediaItem;
use domain::publishing::errors::PublishResult;
use regex::Regex;
use runtime::ffmpeg::{probe_media_metadata, run_ffmpeg};
use runtime::http::{Fut, HttpClient, HttpRequest};
use serde_json::{Map, Value, json};

use crate::error::{AdapterError, Result, ambiguous_error};
use crate::js::{as_record, js_number, utf16_len, utf16_prefix};
use crate::payload::{field, is_video, payload_media, payload_text};
use crate::ports::AdapterContext;

/// mtcute switches to its "big file" upload (`upload.saveBigFilePart`, no
/// checksum) above 10 MiB, and `stories.sendStory` rejects files uploaded
/// that way with MEDIA_FILE_INVALID, so a video Story stays under this.
pub const STORY_MAX_BYTES: u64 = 9_961_472;
const STORY_TARGET_BYTES: f64 = 9.0 * 1024.0 * 1024.0;
const CAPTION_LIMIT: usize = 2048;
const STORY_PERIOD_SECONDS: u64 = 86_400;
const PROBE_TIMEOUT: Duration = Duration::from_secs(10);
const FFMPEG_TIMEOUT: Duration = Duration::from_secs(600);
/// Over the sidecar's own deadlines (connect 30 s, identity 30 s, send
/// 120 s, teardown 5 s), so the sidecar is the one that says what timed out.
const SIDECAR_TIMEOUT: Duration = Duration::from_secs(200);

/// One hidden link of a Story caption (`messageEntityTextUrl`), in UTF-16 units.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CaptionLink {
    pub offset: u64,
    pub length: u64,
    pub url: String,
}

/// `telegramStoryCaptionInput`: a plain caption, or one keeping its hidden
/// links clickable.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct StoryCaption {
    pub text: String,
    pub links: Vec<CaptionLink>,
}

/// `telegramStoryUploadMedia`: what the sidecar uploads, with the dimensions
/// `stories.sendStory` validates for a video.
#[derive(Clone, Debug, PartialEq)]
pub enum StoryUploadMedia {
    Photo {
        path: PathBuf,
    },
    Video {
        path: PathBuf,
        width: f64,
        height: f64,
        duration: f64,
    },
}

/// One Story to post on behalf of the channel.
#[derive(Clone, Debug, PartialEq)]
pub struct StoryRequest {
    pub peer: String,
    pub media: StoryUploadMedia,
    pub caption: StoryCaption,
    pub period_seconds: u64,
}

/// What the sidecar answered when it did not post the Story.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum SidecarError {
    /// The Story was not sent: connecting, identity, or a refusal from
    /// Telegram itself. Nothing reached the audience.
    Refused(String),
    /// `stories.sendStory` was sent and no answer came, or the sidecar's own
    /// answer was lost: the Story may be up.
    Ambiguous(String),
}

/// The MTProto half (`stories.sendStory` through mtcute), in the sidecar.
pub trait StoriesSidecar {
    /// The id of the posted Story.
    fn send_story<'a>(&'a self, request: &'a StoryRequest) -> Fut<'a, Result<i64, SidecarError>>;
}

/// The sidecar over local HTTP (`POST {base}/v1/stories`), authorized by the
/// bearer token the container entrypoint draws for both processes
/// (`STORIES_SIDECAR_URL`, `STORIES_SIDECAR_TOKEN`).
pub struct HttpStoriesSidecar {
    client: HttpClient,
    base_url: String,
    token: String,
}

impl HttpStoriesSidecar {
    pub fn new(client: HttpClient, base_url: impl Into<String>, token: impl Into<String>) -> Self {
        Self {
            client,
            base_url: base_url.into(),
            token: token.into(),
        }
    }
}

/// The request body of the sidecar contract.
pub fn story_request_json(request: &StoryRequest) -> Value {
    let media = match &request.media {
        StoryUploadMedia::Photo { path } => json!({"type": "photo", "path": path}),
        StoryUploadMedia::Video {
            path,
            width,
            height,
            duration,
        } => json!({
            "type": "video", "path": path, "width": width, "height": height, "duration": duration,
            "supportsStreaming": true,
        }),
    };
    let links: Vec<Value> = request
        .caption
        .links
        .iter()
        .map(|link| json!({"offset": link.offset, "length": link.length, "url": link.url}))
        .collect();
    json!({
        "peer": request.peer,
        "media": media,
        "caption": {"text": request.caption.text, "links": links},
        "periodSeconds": request.period_seconds,
    })
}

impl StoriesSidecar for HttpStoriesSidecar {
    fn send_story<'a>(&'a self, request: &'a StoryRequest) -> Fut<'a, Result<i64, SidecarError>> {
        Box::pin(async move {
            let base = self.base_url.strip_suffix('/').unwrap_or(&self.base_url);
            let http = HttpRequest::post(format!("{base}/v1/stories"))
                .header("Authorization", format!("Bearer {}", self.token))
                .header("Content-Type", "application/json")
                .text(domain::json::stringify(&story_request_json(request)));
            let response = self
                .client
                .fetch_within(http, SIDECAR_TIMEOUT)
                .await
                .map_err(|error| SidecarError::Ambiguous(error.to_string()))?;
            let status = response.status;
            let body = response
                .text()
                .await
                .map_err(|error| SidecarError::Ambiguous(error.to_string()))?;
            let answer: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            if status == 200
                && let Some(id) = answer.get("id").and_then(Value::as_i64)
            {
                return Ok(id);
            }
            let message = answer
                .pointer("/error/message")
                .and_then(Value::as_str)
                .map_or_else(|| format!("stories sidecar answered {status}: {body}"), str::to_owned);
            // Only an explicit "not sent" is a refusal; anything else after the
            // request went out may have posted the Story.
            if answer.pointer("/error/sent") == Some(&Value::Bool(false)) {
                Err(SidecarError::Refused(message))
            } else {
                Err(SidecarError::Ambiguous(message))
            }
        })
    }
}

static URL: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"https?://[^\s<>)]*").unwrap());
static BEFORE_NEWLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+\n").unwrap());
static BLANK_LINES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n{3,}").unwrap());

/// `telegramStoryCaption`: links stripped, the blank lines they leave
/// collapsed, capped at 2048 units.
pub fn telegram_story_caption(text: &str) -> String {
    let text = URL.replace_all(text, "");
    let text = BEFORE_NEWLINE.replace_all(&text, "\n");
    let text = BLANK_LINES.replace_all(&text, "\n\n");
    utf16_prefix(foundation::js::trim(&text), CAPTION_LIMIT).to_owned()
}

/// `telegramStoryCaptionInput`. URL removal shifts offsets, so entities
/// survive only when the visible text did not change; hidden links have no
/// visible URL, which is the supported authoring flow.
pub fn telegram_story_caption_input(text: &str, entities: &[Value]) -> StoryCaption {
    let caption = telegram_story_caption(text);
    if caption != utf16_prefix(foundation::js::trim(text), CAPTION_LIMIT) {
        return StoryCaption {
            text: caption,
            links: Vec::new(),
        };
    }
    let length = utf16_len(&caption) as f64;
    let links = entities
        .iter()
        .filter_map(as_record)
        .filter_map(|entity| {
            let offset = js_number(entity.get("offset"));
            let span = js_number(entity.get("length"));
            let url = entity.get("url").and_then(Value::as_str)?;
            let valid = foundation::js::is_safe_integer(offset)
                && foundation::js::is_safe_integer(span)
                && offset >= 0.0
                && span > 0.0
                && offset + span <= length;
            (entity.get("type").and_then(Value::as_str) == Some("text_link") && valid).then(|| CaptionLink {
                offset: offset as u64,
                length: span as u64,
                url: url.to_owned(),
            })
        })
        .collect();
    StoryCaption { text: caption, links }
}

/// `telegramStoryUploadMedia`. Without explicit width, height and duration
/// mtcute writes zeros into documentAttributeVideo, which `stories.sendStory`
/// rejects with the same MEDIA_FILE_INVALID as a codec problem.
pub fn telegram_story_upload_media(path: &Path, video: bool, metadata: &StoryVideoMetadata) -> StoryUploadMedia {
    if video {
        StoryUploadMedia::Video {
            path: path.to_owned(),
            width: metadata.width,
            height: metadata.height,
            duration: metadata.duration,
        }
    } else {
        StoryUploadMedia::Photo { path: path.to_owned() }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct StoryVideoMetadata {
    pub width: f64,
    pub height: f64,
    pub duration: f64,
    pub audio_bitrate: f64,
}

/// What a probe that cannot read the file assumes. The audio rate matches
/// the canonical story encode (`-b:a 320k`): guessing low makes the size
/// budget optimistic, which is exactly the failure to avoid.
const FALLBACK: StoryVideoMetadata = StoryVideoMetadata {
    width: 720.0,
    height: 1280.0,
    duration: 10.0,
    audio_bitrate: 320_000.0,
};

/// `Math.round`: halves up.
fn js_round(value: f64) -> f64 {
    (value + 0.5).floor()
}

async fn probe_video(path: &Path, video: bool) -> StoryVideoMetadata {
    if !video {
        return FALLBACK;
    }
    match probe_media_metadata(&path.to_string_lossy(), PROBE_TIMEOUT).await {
        Ok(metadata) => StoryVideoMetadata {
            width: metadata.width,
            height: metadata.height,
            duration: js_round(
                if metadata.duration_seconds != 0.0 && !metadata.duration_seconds.is_nan() {
                    metadata.duration_seconds
                } else {
                    FALLBACK.duration
                },
            ),
            // A silent source costs nothing; an unreported rate falls back to
            // the pessimistic 320 kbps rather than to zero.
            audio_bitrate: if metadata.audio_codec.is_some() {
                metadata.audio_bitrate.unwrap_or(FALLBACK.audio_bitrate)
            } else {
                0.0
            },
        },
        Err(_) => FALLBACK,
    }
}

/// The ffmpeg arguments that bring a video under [`STORY_MAX_BYTES`]. The
/// audio is copied verbatim, so its real rate comes out of the budget —
/// assuming 128 kbps overshot by ~1.4 MB on a full-length story.
pub fn story_reencode_args(input: &Path, output: &Path, metadata: &StoryVideoMetadata) -> Vec<String> {
    let video_bitrate = ((STORY_TARGET_BYTES * 8.0) / metadata.duration.max(1.0) - metadata.audio_bitrate)
        .floor()
        .max(150_000.0);
    let kbps = |rate: f64| format!("{}k", (rate / 1000.0).floor());
    [
        "-y",
        "-i",
        &input.to_string_lossy(),
        "-r",
        "50",
        "-c:v",
        "libx264",
        "-b:v",
        &kbps(video_bitrate),
        "-maxrate",
        &kbps(video_bitrate),
        "-bufsize",
        &kbps(video_bitrate * 2.0),
        "-g",
        "50",
        "-pix_fmt",
        "yuv420p",
        "-c:a",
        "copy",
        "-tag:v",
        "avc1",
        "-movflags",
        "+faststart",
        &output.to_string_lossy(),
    ]
    .iter()
    .map(|argument| (*argument).to_owned())
    .collect()
}

fn skipped(reason: &str) -> PublishResult {
    let mut result = Map::new();
    result.insert("ok".into(), false.into());
    result.insert("skipped".into(), true.into());
    result.insert("reason".into(), reason.into());
    result
}

/// `publishTelegramStory`.
pub async fn publish_telegram_story(
    ctx: &AdapterContext,
    sidecar: &dyn StoriesSidecar,
    payload: &Map<String, Value>,
) -> Result<PublishResult> {
    let Some(media) = payload_media(payload)
        .into_iter()
        .find(|item| field(item, "storyLocalPath").is_some() || field(item, "localPath").is_some())
    else {
        return Ok(skipped("missing_media"));
    };
    let entities = payload
        .get("entities")
        .and_then(Value::as_array)
        .map_or(&[][..], Vec::as_slice);
    let caption = telegram_story_caption_input(&payload_text(payload), entities);
    let config = &ctx.config;
    if config.telegram_channel_stories_api_id.is_none_or(|id| id == 0)
        || config
            .telegram_channel_stories_api_hash
            .as_deref()
            .is_none_or(str::is_empty)
        || config
            .telegram_channel_stories_session
            .as_deref()
            .is_none_or(str::is_empty)
    {
        return Ok(skipped("missing_channel_story_credentials"));
    }
    if config.telegram_stories_channel.as_deref().is_none_or(str::is_empty) {
        return Ok(skipped("missing_story_channel"));
    }
    publish_channel_story(ctx, sidecar, &media, caption).await
}

async fn publish_channel_story(
    ctx: &AdapterContext,
    sidecar: &dyn StoriesSidecar,
    media: &MediaItem,
    caption: StoryCaption,
) -> Result<PublishResult> {
    let Some(source) = field(media, "storyLocalPath").or_else(|| field(media, "localPath")) else {
        return Ok(skipped("missing_media_path"));
    };
    let video = is_video(media);
    let source = PathBuf::from(source);
    let metadata = probe_video(&source, video).await;
    let size = tokio::fs::metadata(&source)
        .await
        .map_err(|error| AdapterError::Message(error.to_string()))?
        .len();
    // The local media provider emits only the quality master, so the
    // small-file conversion stays here; the remote provider supplies this
    // variant before publishing starts.
    let reencoded =
        (video && size > STORY_MAX_BYTES).then(|| std::env::temp_dir().join(format!("tg_story_{}.mp4", ctx.now_ms())));
    let posted = async {
        let upload = match &reencoded {
            Some(output) => {
                let args = story_reencode_args(&source, output, &metadata);
                let args: Vec<&str> = args.iter().map(String::as_str).collect();
                run_ffmpeg(&args, FFMPEG_TIMEOUT)
                    .await
                    .map_err(|error| AdapterError::Message(error.0))?;
                output.clone()
            }
            None => source.clone(),
        };
        let peer = ctx
            .config
            .telegram_stories_channel
            .as_deref()
            .map(|channel| channel.strip_prefix('@').unwrap_or(channel))
            .filter(|channel| !channel.is_empty())
            .ok_or_else(|| AdapterError::message_text("telegram_story_channel_missing"))?
            .to_owned();
        let request = StoryRequest {
            peer,
            media: telegram_story_upload_media(&upload, video, &metadata),
            caption,
            period_seconds: STORY_PERIOD_SECONDS,
        };
        let id = sidecar.send_story(&request).await.map_err(|error| match error {
            SidecarError::Refused(message) => AdapterError::Message(message),
            SidecarError::Ambiguous(message) => ambiguous_error("telegram_stories", &message),
        })?;
        let mut result = Map::new();
        result.insert("ok".into(), true.into());
        result.insert("id".into(), id.into());
        result.insert("url".into(), format!("https://t.me/{}/s/{id}", request.peer).into());
        result.insert("raw".into(), json!({"source": "mtproto_stories.sendStory"}));
        Ok(result)
    }
    .await;
    if let Some(output) = &reencoded {
        let _ = tokio::fs::remove_file(output).await;
    }
    posted
}
