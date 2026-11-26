//! Request goldens: what the TypeScript adapters recorded in
//! `parity/adapter-goldens/` before the cutover.
//! Each case replays its canned responses over a recording transport and
//! asserts the same requests went out — order, method, URL, headers, body
//! bytes (multipart as its parts) — and the same result or error class.

use std::cell::RefCell;
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use content::Locale;
use domain::application::ports::Clock;
use domain::publishing::queue::ClaimedPublishJob;
use foundation::config::{Config, load_config};
use jiff::Timestamp;
use providers::adapters::remote_media_processor::{MediaKind, Variant, process_vertical_media_remotely};
use providers::adapters::telegram_stories::{
    StoriesClient, StoryCaption, StoryError, StoryRequest, StoryUploadMedia, StoryVideoMetadata,
    telegram_story_caption_input, telegram_story_upload_media,
};
use providers::adapters::video_publishers::{
    VideoTargetRef, YoutubeMetadata, instagram_container_ready, keep_youtube_upload_private, prepare_instagram_reel,
    prepare_youtube_video, publish_instagram_reel, verify_youtube_video, video_target_is_absent,
};
use providers::adapters::zernio::{
    ZernioPlatform, publish_zernio_instagram_reel, verify_zernio_post, zernio_post_outcome,
};
use providers::adapters::{AdapterContext, AdapterError, EditRequest, Route, TargetRouting, Unprepared};
use providers::external::instagram::instagram_credentials_for_locale;
use runtime::http::{BodyPart, Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};

const NOW: &str = "2026-11-21T10:00:00Z";
const MAX_TEXT_BODY: usize = 16 * 1024;

fn goldens_dir() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../../parity/adapter-goldens")
}

fn golden_files() -> Vec<PathBuf> {
    let mut files = Vec::new();
    for platform in std::fs::read_dir(goldens_dir()).unwrap() {
        for case in std::fs::read_dir(platform.unwrap().path()).unwrap() {
            files.push(case.unwrap().path());
        }
    }
    files.sort();
    files
}

/// This case's own directory under `_trash-rust/tmp/adapter-tests/`.
struct Scratch(PathBuf);

impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.0);
    }
}

fn scratch(golden: &Value, label: &str) -> Scratch {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../_trash-rust/tmp/adapter-tests")
        .join(format!("{}-{label}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(dir.join("out")).unwrap();
    let dir = dir.canonicalize().unwrap();
    for (name, spec) in golden["files"].as_object().unwrap() {
        let fill = spec["fill"].as_str().unwrap();
        let size = spec["size"].as_u64().unwrap() as usize;
        std::fs::write(dir.join(name), fill.repeat(size)).unwrap();
    }
    Scratch(dir)
}

fn sha256(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|byte| format!("{byte:02x}")).collect()
}

/// Puts the credentials back as `{{NAME}}` and the scratch directory as
/// `$FILES`, as the recorder wrote them.
struct Scrubber {
    files: String,
    secrets: Vec<(String, String)>,
}

impl Scrubber {
    fn new(config: &Value, files: &Path) -> Self {
        let mut secrets: Vec<(String, String)> = ["env", "credentials"]
            .iter()
            .flat_map(|section| config[section].as_object().unwrap().iter())
            .filter(|(name, value)| {
                ["TOKEN", "SECRET", "KEY"].iter().any(|marker| name.contains(marker))
                    && value.as_str().unwrap().chars().count() >= 6
            })
            .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned()))
            .collect();
        secrets.sort_by_key(|(_, secret)| std::cmp::Reverse(secret.len()));
        Self {
            files: files.to_string_lossy().into_owned(),
            secrets,
        }
    }

    fn text(&self, value: &str) -> String {
        let mut text = value.replace(&self.files, "$FILES");
        for (name, secret) in &self.secrets {
            text = text.replace(secret.as_str(), &format!("{{{{{name}}}}}"));
        }
        text
    }

    fn deep(&self, value: &Value) -> Value {
        match value {
            Value::String(text) => Value::String(self.text(text)),
            Value::Array(items) => Value::Array(items.iter().map(|item| self.deep(item)).collect()),
            Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), self.deep(item))).collect()),
            other => other.clone(),
        }
    }
}

/// `$FILES` back to the scratch directory, everywhere in the inputs.
fn with_files(value: &Value, files: &Path) -> Value {
    match value {
        Value::String(text) => Value::String(text.replace("$FILES", &files.to_string_lossy())),
        Value::Array(items) => Value::Array(items.iter().map(|item| with_files(item, files)).collect()),
        Value::Object(map) => Value::Object(
            map.iter()
                .map(|(key, item)| (key.clone(), with_files(item, files)))
                .collect(),
        ),
        other => other.clone(),
    }
}

fn bytes_shape(bytes: &[u8], scrub: &Scrubber) -> Map<String, Value> {
    if bytes.len() <= MAX_TEXT_BODY
        && let Ok(text) = std::str::from_utf8(bytes)
    {
        let mut shape = Map::new();
        shape.insert("text".into(), scrub.text(text).into());
        return shape;
    }
    let mut shape = Map::new();
    shape.insert("size".into(), bytes.len().into());
    shape.insert("sha256".into(), sha256(bytes).into());
    shape
}

fn find(haystack: &[u8], needle: &[u8], from: usize) -> Option<usize> {
    haystack
        .get(from..)?
        .windows(needle.len())
        .position(|window| window == needle)
        .map(|index| index + from)
}

/// The parts as they went on the wire, by the same reading the recorder
/// applies.
fn multipart_parts(body: &[u8], boundary: &str, scrub: &Scrubber) -> Vec<Value> {
    let delimiter = format!("--{boundary}").into_bytes();
    let mut parts = Vec::new();
    let Some(first) = find(body, &delimiter, 0) else {
        return parts;
    };
    let mut start = first + delimiter.len();
    while body.get(start..start + 2) == Some(b"\r\n") {
        let end = find(body, &delimiter, start).unwrap();
        let part = &body[start + 2..end - 2];
        let split = find(part, b"\r\n\r\n", 0).unwrap();
        let headers: Vec<Value> = std::str::from_utf8(&part[..split])
            .unwrap()
            .split("\r\n")
            .map(|line| scrub.text(line).into())
            .collect();
        let mut shape = Map::new();
        shape.insert("headers".into(), Value::Array(headers));
        shape.extend(bytes_shape(&part[split + 4..], scrub));
        parts.push(Value::Object(shape));
        start = end + delimiter.len();
    }
    parts
}

fn body_bytes(request: &HttpRequest) -> Vec<u8> {
    let mut bytes = Vec::new();
    for part in &request.body.0 {
        match part {
            BodyPart::Bytes(chunk) => bytes.extend_from_slice(chunk),
            BodyPart::File { path, offset } => {
                let file = std::fs::read(path).unwrap();
                bytes.extend_from_slice(&file[(*offset as usize).min(file.len())..]);
            }
        }
    }
    bytes
}

/// A request as the recorder saw it through `new Request`: the
/// normalized URL, header names lower-cased and sorted.
fn recorded(request: &HttpRequest, scrub: &Scrubber) -> Value {
    let boundary = request
        .header_value("content-type")
        .and_then(|value| value.strip_prefix("multipart/form-data; boundary="))
        .map(str::to_owned);
    let mut headers: Vec<(String, String)> = request
        .headers
        .iter()
        .map(|(name, value)| {
            let name = name.to_ascii_lowercase();
            let value = if boundary.is_some() && name == "content-type" {
                "multipart/form-data".to_owned()
            } else {
                scrub.text(value)
            };
            (name, value)
        })
        .collect();
    headers.sort_by(|left, right| left.0.cmp(&right.0));
    let bytes = body_bytes(request);
    let body = match &boundary {
        Some(boundary) => json!({"parts": multipart_parts(&bytes, boundary, scrub)}),
        None => Value::Object(bytes_shape(&bytes, scrub)),
    };
    json!({
        "method": request.method.as_str(),
        "url": scrub.text(&url::Url::parse(&request.url).map_or_else(|_| request.url.clone(), String::from)),
        "headers": headers.into_iter().map(|(name, value)| json!([name, value])).collect::<Vec<_>>(),
        "body": body,
    })
}

/// Records each request as sent and answers the next canned response.
struct Recorder {
    sent: RefCell<Vec<HttpRequest>>,
    responses: RefCell<VecDeque<Value>>,
}

impl Transport for Recorder {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        self.sent.borrow_mut().push(request);
        let next = self.responses.borrow_mut().pop_front();
        Box::pin(async move {
            let Some(next) = next else {
                return Err(TransportFailure {
                    message: "no canned response left".into(),
                    timed_out: false,
                });
            };
            if let Some(message) = next.get("throws") {
                return Err(TransportFailure {
                    message: message.as_str().unwrap().into(),
                    timed_out: false,
                });
            }
            if next.get("hang").is_some() {
                return std::future::pending().await;
            }
            let headers = next
                .get("headers")
                .and_then(Value::as_array)
                .map(|pairs| {
                    pairs
                        .iter()
                        .map(|pair| {
                            (
                                pair[0].as_str().unwrap().to_owned(),
                                pair[1].as_str().unwrap().to_owned(),
                            )
                        })
                        .collect()
                })
                .unwrap_or_default();
            let body = next.get("body").and_then(Value::as_str).unwrap_or_default();
            Ok(HttpResponse::buffered(
                u16::try_from(next["status"].as_u64().unwrap()).unwrap(),
                headers,
                body,
            ))
        })
    }
}

struct FixedClock;

impl Clock for FixedClock {
    fn now(&self) -> Timestamp {
        NOW.parse().unwrap()
    }
}

/// The guard cases never reach the MTProto half.
struct NoStories;

impl StoriesClient for NoStories {
    fn send_story<'a>(&'a self, _: &'a StoryRequest) -> Fut<'a, Result<i64, StoryError>> {
        panic!("a recorded case reached the Stories client")
    }
}

fn config_of(golden: &Value) -> Config {
    let env = golden["config"]["env"].as_object().unwrap();
    let mut config = load_config(
        env.iter()
            .map(|(name, value)| (name.clone(), value.as_str().unwrap().to_owned())),
    )
    .unwrap();
    let credentials = &golden["config"]["credentials"];
    let credential = |name: &str| credentials.get(name).and_then(Value::as_str).map(str::to_owned);
    config.x_access_token = credential("X_ACCESS_TOKEN");
    config.x_refresh_token = credential("X_REFRESH_TOKEN");
    config.zernio_api_key = credential("ZERNIO_API_KEY");
    config.discord_bot_token = credential("DISCORD_BOT_TOKEN");
    config
}

fn error_shape(error: &AdapterError, scrub: &Scrubber) -> Value {
    let mut shape = Map::new();
    let kind = match error {
        AdapterError::Http(_) => "http",
        AdapterError::Transport(_) => "transport",
        AdapterError::Ambiguous { .. } => "ambiguous",
        AdapterError::ContainerInvalid(_) => "container_invalid",
        AdapterError::ContainerProcessing(_) => "container_processing",
        AdapterError::Timeout(_) => "timeout",
        AdapterError::Message(_) => "message",
    };
    shape.insert("kind".into(), kind.into());
    shape.insert("message".into(), scrub.text(error.message()).into());
    shape.insert("class".into(), error.class().as_str().into());
    match error {
        AdapterError::Ambiguous { provider, .. } => {
            shape.insert("provider".into(), provider.clone().into());
        }
        AdapterError::Http(http) => {
            shape.insert("status".into(), http.status.into());
            shape.insert("retryAfterSeconds".into(), json!(http.retry_after_seconds));
        }
        _ => {}
    }
    Value::Object(shape)
}

fn object(value: &Value) -> Map<String, Value> {
    value.as_object().cloned().unwrap_or_default()
}

fn locale(inputs: &Value) -> Locale {
    if inputs["locale"] == "en" {
        Locale::En
    } else {
        Locale::Ru
    }
}

fn routing(inputs: &Value) -> TargetRouting {
    TargetRouting(
        inputs
            .get("routing")
            .and_then(Value::as_object)
            .map(|routes| {
                routes
                    .iter()
                    .map(|(target, route)| {
                        (
                            target.clone(),
                            Route {
                                provider: route["provider"].as_str().unwrap().to_owned(),
                                account_id: route["accountId"].as_str().map(str::to_owned),
                            },
                        )
                    })
                    .collect()
            })
            .unwrap_or_default(),
    )
}

fn job(inputs: &Value) -> ClaimedPublishJob {
    ClaimedPublishJob {
        job_id: inputs.get("jobId").and_then(Value::as_i64).unwrap_or(7),
        publication_key: "post:12".into(),
        target: inputs["target"].as_str().unwrap().to_owned(),
        payload: object(&inputs["payload"]),
        attempt_count: 1,
        lock_id: "lock-1".into(),
    }
}

fn caption_json(caption: StoryCaption) -> Value {
    if caption.links.is_empty() {
        return caption.text.into();
    }
    json!({
        "text": caption.text,
        "entities": caption.links.iter().map(|link| json!({
            "_": "messageEntityTextUrl", "offset": link.offset, "length": link.length, "url": link.url,
        })).collect::<Vec<_>>(),
    })
}

fn upload_media_json(media: StoryUploadMedia) -> Value {
    match media {
        StoryUploadMedia::Photo { path } => json!({"type": "photo", "file": format!("file:{}", path.display())}),
        StoryUploadMedia::Video {
            path,
            width,
            height,
            duration,
        } => json!({
            "type": "video", "file": format!("file:{}", path.display()), "width": width, "height": height,
            "duration": duration, "supportsStreaming": true,
        }),
    }
}

fn file_input(files: &Path, inputs: &Value, key: &str) -> PathBuf {
    files.join(inputs[key].as_str().unwrap())
}

async fn run(operation: &str, inputs: &Value, ctx: AdapterContext, files: &Path) -> Result<Value, AdapterError> {
    let adapters = providers::adapters::create_platform_adapters(
        ctx.clone(),
        Rc::new(Unprepared),
        Rc::new(NoStories),
        &routing(inputs),
    );
    let adapter = || adapters.get(inputs["target"].as_str().unwrap()).unwrap();
    let option = |value: Option<String>| value.map_or(Value::Null, Value::from);
    Ok(match operation {
        "adapter.publish" => Value::Object(adapter().publish(&job(inputs)).await?),
        "adapter.validate" => {
            adapter().validate(&job(inputs))?;
            Value::Null
        }
        "adapter.verify" => Value::Object(adapter().verify(&job(inputs), object(&inputs["result"])).await),
        "adapter.edit" => {
            let edit = &inputs["edit"];
            let request = EditRequest {
                external_id: edit["externalId"].as_str().unwrap().to_owned(),
                text: edit["text"].as_str().unwrap().to_owned(),
                chat_id: edit.get("chatId").cloned(),
                media_count: edit["mediaCount"].as_u64().unwrap() as usize,
                external_id_count: edit["externalIdCount"].as_u64().unwrap() as usize,
            };
            let outcome = adapter().edit(&request).expect("no edit port").await?;
            Value::Object(outcome.to_json())
        }
        "adapter.remove" => {
            adapter()
                .remove(inputs["externalId"].as_str().unwrap())
                .expect("no remove port")
                .await?
        }
        "x.publish" => Value::Object(providers::adapters::x::publish_to_x(&ctx, &object(&inputs["payload"])).await?),
        "x.article" => {
            Value::Object(providers::adapters::x::publish_x_article(&ctx, &object(&inputs["payload"])).await?)
        }
        "platform.text_absent" => providers::adapters::platform_adapters::text_target_is_absent(
            &ctx,
            inputs["target"].as_str().unwrap(),
            inputs["externalId"].as_str().unwrap(),
        )
        .await?
        .map_or(Value::Null, Value::from),
        "zernio.reel" => {
            let input = &inputs["input"];
            let published = publish_zernio_instagram_reel(
                &ctx,
                input["accountId"].as_str().unwrap(),
                input["publicUrl"].as_str().unwrap(),
                input["metadata"]["caption"].as_str().unwrap(),
                input["requestId"].as_str().unwrap(),
            )
            .await?;
            Value::Object(published.to_json())
        }
        "zernio.outcome" => {
            let platform = ZernioPlatform::parse(inputs["platform"].as_str().unwrap()).unwrap();
            let outcome = zernio_post_outcome(&ctx, inputs["providerPostId"].as_str().unwrap(), platform).await?;
            let mut record = outcome.publication.to_json();
            record.insert("failure".into(), option(outcome.failure));
            Value::Object(record)
        }
        "zernio.verify" => {
            let platform = ZernioPlatform::parse(inputs["platform"].as_str().unwrap()).unwrap();
            Value::Object(
                verify_zernio_post(&ctx, inputs["providerPostId"].as_str().unwrap(), platform)
                    .await?
                    .to_json(),
            )
        }
        "youtube.prepare" => {
            let metadata = &inputs["metadata"];
            let uploaded = prepare_youtube_video(
                &ctx,
                &file_input(files, inputs, "file"),
                &YoutubeMetadata {
                    title: metadata["title"].as_str().unwrap().to_owned(),
                    description: metadata["description"].as_str().unwrap().to_owned(),
                    tags: metadata["tags"]
                        .as_array()
                        .unwrap()
                        .iter()
                        .map(|tag| tag.as_str().unwrap().to_owned())
                        .collect(),
                },
                inputs["publishAt"].as_str().unwrap(),
                locale(inputs),
            )
            .await?;
            let mut record = Map::new();
            if let Some(id) = uploaded.id {
                record.insert("id".into(), id.into());
            }
            record.insert("url".into(), uploaded.url.into());
            Value::Object(record)
        }
        "youtube.keep_private" => {
            keep_youtube_upload_private(&ctx, inputs["videoId"].as_str().unwrap(), locale(inputs)).await?;
            Value::Null
        }
        "youtube.verify" => {
            let video = verify_youtube_video(&ctx, inputs["videoId"].as_str().unwrap(), locale(inputs)).await?;
            json!({"id": video.id, "url": video.url, "privacyStatus": video.privacy_status})
        }
        "reels.prepare" => {
            let credentials = instagram_credentials_for_locale(&ctx.config, locale(inputs));
            let id = prepare_instagram_reel(
                &ctx,
                credentials,
                inputs["publicUrl"].as_str().unwrap(),
                inputs["metadata"]["caption"].as_str().unwrap(),
            )
            .await?;
            id.map_or_else(|| json!({}), |id| json!({"id": id}))
        }
        "reels.ready" => {
            let credentials = instagram_credentials_for_locale(&ctx.config, locale(inputs));
            instagram_container_ready(&ctx, credentials, inputs["containerId"].as_str().unwrap()).await?;
            Value::Null
        }
        "reels.publish" => {
            let credentials = instagram_credentials_for_locale(&ctx.config, locale(inputs));
            let reel = publish_instagram_reel(&ctx, credentials, inputs["containerId"].as_str().unwrap()).await?;
            let mut record = Map::new();
            if let Some(id) = reel.id {
                record.insert("id".into(), id.into());
            }
            record.insert("url".into(), reel.url.into());
            Value::Object(record)
        }
        "video.absent" => {
            let target = &inputs["videoTarget"];
            let absent = video_target_is_absent(
                &ctx,
                VideoTargetRef {
                    target: target["target"].as_str().unwrap(),
                    external_id: target["externalId"].as_str(),
                    delivery_provider: target["deliveryProvider"].as_str().unwrap(),
                    provider_post_id: target["providerPostId"].as_str(),
                },
                locale(inputs),
            )
            .await?;
            absent.into()
        }
        "remote_media.process" => {
            let variants: Vec<Variant> = inputs["variants"]
                .as_array()
                .unwrap()
                .iter()
                .map(|variant| Variant {
                    name: variant["name"].as_str().unwrap().to_owned(),
                    output: files.join(variant["output"].as_str().unwrap()),
                })
                .collect();
            process_vertical_media_remotely(
                &ctx,
                &file_input(files, inputs, "source"),
                if inputs["kind"] == "video" {
                    MediaKind::Video
                } else {
                    MediaKind::Image
                },
                &variants,
                Duration::from_millis(inputs["timeoutMs"].as_u64().unwrap()),
            )
            .await?
        }
        "stories.caption" => caption_json(telegram_story_caption_input(
            inputs["text"].as_str().unwrap(),
            inputs["entities"].as_array().unwrap(),
        )),
        "stories.upload_media" => {
            let metadata = &inputs["metadata"];
            upload_media_json(telegram_story_upload_media(
                Path::new(inputs["path"].as_str().unwrap()),
                inputs["type"] == "VIDEO",
                &StoryVideoMetadata {
                    width: metadata["width"].as_f64().unwrap(),
                    height: metadata["height"].as_f64().unwrap(),
                    duration: metadata["duration"].as_f64().unwrap(),
                    audio_bitrate: 0.0,
                },
            ))
        }
        other => panic!("unknown operation {other}"),
    })
}

/// Every number as an f64, so `12` and `12.0` compare equal.
fn numbers(value: &Value) -> Value {
    match value {
        Value::Number(number) => json!(number.as_f64().unwrap()),
        Value::Array(items) => Value::Array(items.iter().map(numbers).collect()),
        Value::Object(map) => Value::Object(map.iter().map(|(key, item)| (key.clone(), numbers(item))).collect()),
        other => other.clone(),
    }
}

/// One case: `None` when it matches, else what differed.
fn replay(path: &Path) -> Option<String> {
    let golden: Value = serde_json::from_str(&std::fs::read_to_string(path).unwrap()).unwrap();
    let name = format!(
        "{}/{}",
        path.parent().unwrap().file_name().unwrap().to_string_lossy(),
        golden["name"].as_str().unwrap()
    );
    let files = scratch(&golden, &name.replace('/', "-"));
    let scrub = Scrubber::new(&golden["config"], &files.0);
    let recorder = Rc::new(Recorder {
        sent: RefCell::new(Vec::new()),
        responses: RefCell::new(golden["responses"].as_array().unwrap().iter().cloned().collect()),
    });
    let ctx = AdapterContext {
        config: Arc::new(config_of(&golden)),
        client: HttpClient::new(recorder.clone()),
        clock: Rc::new(FixedClock),
    };
    let inputs = with_files(&golden["inputs"], &files.0);
    let operation = golden["operation"].as_str().unwrap();
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .start_paused(true)
        .build()
        .unwrap();
    let (outcome, slept) = runtime.block_on(async {
        let started = tokio::time::Instant::now();
        let outcome = run(operation, &inputs, ctx, &files.0).await;
        (outcome, started.elapsed())
    });
    let outcome = match outcome {
        Ok(value) => json!({"ok": scrub.deep(&value)}),
        Err(error) => json!({"error": error_shape(&error, &scrub)}),
    };
    let requests: Vec<Value> = recorder
        .sent
        .borrow()
        .iter()
        .map(|request| recorded(request, &scrub))
        .collect();
    let mut differences = Vec::new();
    let expected_requests = golden["requests"].as_array().unwrap();
    if requests.len() != expected_requests.len() {
        differences.push(format!(
            "{} requests, expected {}",
            requests.len(),
            expected_requests.len()
        ));
    }
    for (index, (actual, expected)) in requests.iter().zip(expected_requests).enumerate() {
        if actual != expected {
            differences.push(format!(
                "request {index}:\n    actual   {actual}\n    expected {expected}"
            ));
        }
    }
    if numbers(&outcome) != numbers(&golden["outcome"]) {
        differences.push(format!(
            "outcome:\n    actual   {outcome}\n    expected {}",
            golden["outcome"]
        ));
    }
    let left = recorder.responses.borrow().len();
    if left > 0 {
        differences.push(format!("{left} canned responses were never asked for"));
    }
    if operation.starts_with("x.") {
        let expected = golden["sleptMs"].as_u64().unwrap();
        if slept.as_millis() as u64 != expected {
            differences.push(format!("slept {}ms, expected {expected}ms", slept.as_millis()));
        }
    }
    for (written, digest) in golden["written"].as_object().unwrap() {
        let actual = std::fs::read(files.0.join(written)).ok().map(|bytes| sha256(&bytes));
        if actual.as_deref() != digest.as_str() {
            differences.push(format!("{written}: wrote {actual:?}, expected {digest}"));
        }
    }
    (!differences.is_empty()).then(|| format!("{name}\n  {}", differences.join("\n  ")))
}

#[test]
fn adapter_requests_match_the_typescript_goldens() {
    let files = golden_files();
    assert!(files.len() >= 60, "only {} goldens recorded", files.len());
    let failures: Vec<String> = files.iter().filter_map(|path| replay(path)).collect();
    assert!(
        failures.is_empty(),
        "{} of {} cases differ:\n{}",
        failures.len(),
        files.len(),
        failures.join("\n")
    );
}
