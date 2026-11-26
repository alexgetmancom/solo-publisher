//! The remote media processor: the Studio's `remote_http` executor for the
//! vertical media recipe (`vertical_media`), encoding on a VAAPI render node.
//! Its one client is `providers::adapters::remote_media_processor`; the operations CLI
//! reads `/health` and runs a fixture through it.
//!
//! - `GET /health`, unauthenticated: always 200; `ok: false`, `status: busy`
//!   while the encoder slot is held.
//! - `POST /v1/transforms/ffmpeg`: the source as the body, described by the
//!   `x-studio-*` headers. Answers with a JSON manifest of the variants.
//! - `GET /v1/transforms/ffmpeg/{key}/{standard|telegram}`: a rendered variant.
//!
//! There is one encoder slot. A request is answered from the cache first, then
//! by sharing the render of the same key already in flight; any other work
//! while the slot is held is refused at once (`429 media_processor_busy` with
//! `Retry-After`), because a queued request cannot make progress while its
//! caller's deadline runs — the caller's durable queue retries it instead.

mod commands;

use std::collections::HashMap;
use std::convert::Infallible;
use std::fmt::Display;
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant, SystemTime};

use futures_util::TryStreamExt as _;
use http_body_util::combinators::UnsyncBoxBody;
use http_body_util::{BodyExt as _, Full, StreamBody};
use hyper::body::{Body, Bytes, Frame};
use hyper::header::{CONTENT_LENGTH, CONTENT_TYPE, RETRY_AFTER};
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Method, Request, Response, StatusCode};
use hyper_util::rt::{TokioIo, TokioTimer};
use serde_json::{Map, Value, json};
use tokio::io::{AsyncRead, AsyncWrite, AsyncWriteExt as _};
use tokio::net::TcpListener;
use tokio::sync::watch;
use tokio_util::io::ReaderStream;
use vertical_media::{
    Encoder, needs_vertical_blur, site_video_ffmpeg_args, story_ffmpeg_args, telegram_video_kbps,
    vertical_image_ffmpeg_args,
};

pub use commands::{Commands, Finished, HostCommands, Running, ffmpeg_failure, probe_args};

/// The port inside the container; compose publishes it on the host.
pub const PORT: u16 = 8787;
/// How often aged cache entries and orphaned request folders are reclaimed.
pub const PRUNE_INTERVAL: Duration = Duration::from_secs(60 * 60);
const MIN_TOKEN_UNITS: usize = 16;
const TRANSFORM_PATH: &str = "/v1/transforms/ffmpeg";

pub type ResponseBody = UnsyncBoxBody<Bytes, std::io::Error>;

/// The environment the processor runs in.
#[derive(Clone, Debug)]
pub struct Options {
    pub token: String,
    pub work_dir: PathBuf,
    pub max_bytes: u64,
    pub timeout_seconds: u64,
    pub cache_ttl_seconds: u64,
    pub retry_after_seconds: u64,
    pub revision: String,
    /// What `/health` reports as `vaapi`: present on VM-106 only.
    pub vaapi_device: PathBuf,
}

impl Options {
    /// The `MEDIA_PROCESSOR_*` variables, each with its default.
    pub fn from_env(vars: impl IntoIterator<Item = (String, String)>) -> Result<Self, String> {
        let env: HashMap<String, String> = vars.into_iter().collect();
        let number = |name: &str, default: u64| match env.get(name) {
            None => Ok(default),
            Some(value) => value
                .trim()
                .parse()
                .map_err(|_| format!("{name} must be a whole number, got {value:?}")),
        };
        Ok(Self {
            token: env.get("MEDIA_PROCESSOR_TOKEN").cloned().unwrap_or_default(),
            // compose mounts the work volume at /work; the override lets the
            // same binary start outside the image (the CI smoke test).
            work_dir: env
                .get("MEDIA_PROCESSOR_WORK_DIR")
                .map_or_else(|| PathBuf::from("/work"), PathBuf::from),
            max_bytes: number("MEDIA_PROCESSOR_MAX_BYTES", 1_073_741_824)?,
            timeout_seconds: number("MEDIA_PROCESSOR_TIMEOUT_SECONDS", 900)?,
            cache_ttl_seconds: number("MEDIA_PROCESSOR_CACHE_TTL_SECONDS", 86_400)?,
            retry_after_seconds: number("MEDIA_PROCESSOR_RETRY_AFTER_SECONDS", 60)?,
            revision: env
                .get("MEDIA_PROCESSOR_REVISION")
                .cloned()
                .unwrap_or_else(|| "unknown".into()),
            vaapi_device: PathBuf::from(vertical_media::VAAPI_DEVICE),
        })
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum MediaKind {
    Video,
    Image,
}

impl MediaKind {
    fn extension(self) -> &'static str {
        match self {
            Self::Video => "mp4",
            Self::Image => "jpg",
        }
    }
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Transform {
    /// `story_vertical`: the Studio's Stories and short-form video.
    Story,
    /// `site_vertical`: one standard render of the whole source.
    Site,
}

/// One accepted transform request.
struct Job {
    key: String,
    kind: MediaKind,
    transform: Transform,
    received: Instant,
}

impl Job {
    /// A Story video is two files; everything else is the standard one.
    fn variants(&self) -> &'static [&'static str] {
        if self.transform == Transform::Story && self.kind == MediaKind::Video {
            &["standard", "telegram"]
        } else {
            &["standard"]
        }
    }

    /// `cached-` or `shared-` and the key's first twelve characters.
    fn job_name(&self, how: &str) -> String {
        format!("{how}-{}", &self.key[..12])
    }
}

#[derive(Default)]
struct State {
    /// The one encoder slot.
    busy: bool,
    /// The render of each key in progress; its sender closes when it settles.
    in_flight: HashMap<String, watch::Receiver<()>>,
    rejected: u64,
    shared: u64,
}

struct Inner {
    options: Options,
    cache_dir: PathBuf,
    commands: Box<dyn Commands>,
    state: Mutex<State>,
}

/// The processor; clones share one encoder slot and one cache.
#[derive(Clone)]
pub struct Processor(Arc<Inner>);

/// The held encoder slot: released, and the key's waiters woken, however the
/// render ends.
struct Slot {
    processor: Processor,
    key: String,
    _settled: watch::Sender<()>,
}

impl Drop for Slot {
    fn drop(&mut self) {
        let mut state = self.processor.state();
        state.busy = false;
        state.in_flight.remove(&self.key);
    }
}

enum Admission {
    Share(watch::Receiver<()>),
    Busy,
    Run(Slot),
}

impl Processor {
    /// Refuses a token short enough to brute-force, and creates the work and
    /// cache directories so `/health` can measure the disk from the start.
    pub fn new(options: Options, commands: impl Commands) -> Result<Self, String> {
        if options.token.encode_utf16().count() < MIN_TOKEN_UNITS {
            return Err(format!(
                "MEDIA_PROCESSOR_TOKEN must contain at least {MIN_TOKEN_UNITS} characters"
            ));
        }
        let cache_dir = options.work_dir.join("cache");
        std::fs::create_dir_all(&cache_dir)
            .map_err(|error| format!("cannot create {}: {error}", cache_dir.display()))?;
        Ok(Self(Arc::new(Inner {
            options,
            cache_dir,
            commands: Box::new(commands),
            state: Mutex::new(State::default()),
        })))
    }

    fn state(&self) -> MutexGuard<'_, State> {
        // The state is counters and a map; a panic cannot leave it half-written.
        self.0.state.lock().unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    pub async fn handle<B>(&self, request: Request<B>) -> Response<ResponseBody>
    where
        B: Body<Data = Bytes> + Send + Unpin + 'static,
        B::Error: Display + Send,
    {
        let path = request.uri().path();
        if request.method() == Method::GET && path == "/health" {
            return self.health();
        }
        if request.method() == Method::GET
            && let Some((key, variant)) = download_path(path)
        {
            if !self.authorized(&request) {
                return text(StatusCode::UNAUTHORIZED, "unauthorized");
            }
            return self.download(key, variant).await;
        }
        if request.method() != Method::POST || path != TRANSFORM_PATH {
            return text(StatusCode::NOT_FOUND, "not_found");
        }
        if !self.authorized(&request) {
            return text(StatusCode::UNAUTHORIZED, "unauthorized");
        }
        self.transform(request).await
    }

    /// Reclaims what is older than the cache TTL: cache entries, and request
    /// folders a crash left behind before their cleanup. The cache directory
    /// itself is never a candidate.
    pub fn prune(&self, now: SystemTime) {
        let ttl = Duration::from_secs(self.0.options.cache_ttl_seconds);
        let cutoff = now.checked_sub(ttl).unwrap_or(SystemTime::UNIX_EPOCH);
        let work_dir = &self.0.options.work_dir;
        for dir in [work_dir, &self.0.cache_dir] {
            let Ok(entries) = std::fs::read_dir(dir) else {
                continue;
            };
            for entry in entries.flatten() {
                if dir == work_dir && entry.file_name() == "cache" {
                    continue;
                }
                let target = entry.path();
                let Ok(metadata) = std::fs::metadata(&target) else {
                    continue;
                };
                if metadata.modified().is_ok_and(|modified| modified < cutoff) {
                    let _ = if metadata.is_dir() {
                        std::fs::remove_dir_all(&target)
                    } else {
                        std::fs::remove_file(&target)
                    };
                }
            }
        }
    }

    fn authorized<B>(&self, request: &Request<B>) -> bool {
        let expected = format!("Bearer {}", self.0.options.token);
        header(request, "authorization")
            .is_some_and(|given| subtle::ConstantTimeEq::ct_eq(given.as_bytes(), expected.as_bytes()).into())
    }

    fn health(&self) -> Response<ResponseBody> {
        let disk = match rustix::fs::statfs(&self.0.options.work_dir) {
            Ok(disk) => disk,
            Err(error) => {
                return text(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("media_processor_work_dir_unavailable: {error}"),
                );
            }
        };
        let block = disk.f_bsize as u64;
        let state = self.state();
        json_response(&json!({
            "ok": !state.busy,
            "status": if state.busy { "busy" } else { "ready" },
            // Distinct work is refused rather than queued, so nothing waits.
            "queued": 0,
            "active": u8::from(state.busy),
            "concurrency": 1,
            "inFlight": state.in_flight.len(),
            "rejected": state.rejected,
            "shared": state.shared,
            "version": self.0.options.revision,
            "vaapi": self.0.options.vaapi_device.exists(),
            "workDisk": {
                "availableBytes": disk.f_bavail * block,
                "totalBytes": disk.f_blocks * block,
            },
        }))
    }

    /// A rendered variant, with an explicit length: the response crosses an
    /// SSH tunnel and a TCP proxy, and its framing must not depend on the
    /// connection closing.
    async fn download(&self, key: &str, variant: &str) -> Response<ResponseBody> {
        let cached = |kind: MediaKind| self.cache_file(key, variant, kind);
        let (file, content_type) = if cached(MediaKind::Video).exists() {
            (cached(MediaKind::Video), "video/mp4")
        } else if variant == "standard" && cached(MediaKind::Image).exists() {
            (cached(MediaKind::Image), "image/jpeg")
        } else {
            return text(StatusCode::NOT_FOUND, "not_found");
        };
        let opened = async {
            let file = tokio::fs::File::open(&file).await?;
            let length = file.metadata().await?.len();
            Ok::<_, std::io::Error>((file, length))
        };
        let (file, length) = match opened.await {
            Ok(opened) => opened,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                return text(StatusCode::NOT_FOUND, "not_found");
            }
            Err(error) => return internal(error),
        };
        let body = StreamBody::new(ReaderStream::new(file).map_ok(Frame::data));
        Response::builder()
            .header(CONTENT_TYPE, content_type)
            .header(CONTENT_LENGTH, length)
            .header("x-media-processor-job", format!("cached-{}", &key[..12]))
            .body(UnsyncBoxBody::new(body))
            .expect("a static response is well-formed")
    }

    async fn transform<B>(&self, request: Request<B>) -> Response<ResponseBody>
    where
        B: Body<Data = Bytes> + Send + Unpin + 'static,
        B::Error: Display + Send,
    {
        let transform = match header(&request, "x-studio-transform").as_deref() {
            Some("story_vertical") => Some(Transform::Story),
            Some("site_vertical") => Some(Transform::Site),
            _ => None,
        };
        let Some(transform) = transform.filter(|_| !request.body().is_end_stream()) else {
            return text(StatusCode::BAD_REQUEST, "invalid_transform_request");
        };
        let kind = match header(&request, "x-studio-media-kind").as_deref() {
            Some("video") => MediaKind::Video,
            Some("image") => MediaKind::Image,
            _ => return text(StatusCode::BAD_REQUEST, "invalid_media_kind"),
        };
        // A client claim, checked once the slot is held and enforced again on
        // the bytes that actually arrive.
        let declared_size = header(&request, "content-length").and_then(|value| value.trim().parse::<u64>().ok());
        let key = header(&request, "x-studio-idempotency-key").unwrap_or_default();
        if !is_digest(&key) {
            return text(StatusCode::BAD_REQUEST, "invalid_idempotency_key");
        }
        let job = Job {
            key,
            kind,
            transform,
            received: Instant::now(),
        };
        // Answered without the body: dropping it is what cancels the upload.
        if let Some(cached) = self.cached_manifest(&job, "cached") {
            return cached;
        }
        let admission = {
            let mut state = self.state();
            if let Some(settled) = state.in_flight.get(&job.key) {
                // Identical work shares the render and is never refused.
                let settled = settled.clone();
                state.shared += 1;
                Admission::Share(settled)
            } else if state.busy {
                state.rejected += 1;
                Admission::Busy
            } else {
                state.busy = true;
                let (settled, waiters) = watch::channel(());
                state.in_flight.insert(job.key.clone(), waiters);
                Admission::Run(Slot {
                    processor: self.clone(),
                    key: job.key.clone(),
                    _settled: settled,
                })
            }
        };
        match admission {
            Admission::Share(mut settled) => {
                drop(request);
                // The sender only closes; that is the render settling.
                let _ = settled.changed().await;
                self.cached_manifest(&job, "shared")
                    .unwrap_or_else(|| text(StatusCode::SERVICE_UNAVAILABLE, "media_processing_shared_job_failed"))
            }
            Admission::Busy => {
                drop(request);
                let mut response = text(StatusCode::TOO_MANY_REQUESTS, "media_processor_busy");
                response
                    .headers_mut()
                    .insert(RETRY_AFTER, self.0.options.retry_after_seconds.into());
                response
            }
            Admission::Run(slot) => {
                // A render outlives its request: a caller that goes away
                // mid-encode still leaves the cache warm for its retry, and
                // the requests sharing it still get their answer.
                let processor = self.clone();
                let body = request.into_body();
                let render = tokio::spawn(async move {
                    let _slot = slot;
                    processor.render(body, declared_size, &job).await
                });
                render.await.unwrap_or_else(internal)
            }
        }
    }

    /// The render itself, with the slot held. Only the atomically renamed
    /// cache entries survive it; the source folder and any partial output are
    /// always reclaimed.
    async fn render<B>(&self, body: B, declared_size: Option<u64>, job: &Job) -> Response<ResponseBody>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: Display,
    {
        let queue_wait_ms = millis(job.received.elapsed());
        if !declared_size.is_some_and(|size| size > 0 && size <= self.0.options.max_bytes) {
            return text(StatusCode::PAYLOAD_TOO_LARGE, "invalid_source_size");
        }
        // The same key may have settled between the first look and the slot.
        if let Some(cached) = self.cached_manifest(job, "cached") {
            return cached;
        }
        let id = uuid();
        let folder = self.0.options.work_dir.join(&id);
        let ext = job.kind.extension();
        let files = Files {
            input: folder.join(format!("source.{ext}")),
            outputs: job
                .variants()
                .iter()
                .map(|variant| {
                    let cached = self.cache_file(&job.key, variant, job.kind);
                    // The final extension stays last so ffmpeg picks the muxer.
                    let mut partial = cached.clone().into_os_string();
                    partial.push(format!(".{id}.part.{ext}"));
                    (PathBuf::from(partial), cached)
                })
                .collect(),
        };
        let response = self.encode(body, job, &id, &folder, &files, queue_wait_ms).await;
        let _ = std::fs::remove_dir_all(&folder);
        for (partial, _) in &files.outputs {
            let _ = std::fs::remove_file(partial);
        }
        response
    }

    async fn encode<B>(
        &self,
        body: B,
        job: &Job,
        id: &str,
        folder: &Path,
        files: &Files,
        queue_wait_ms: u64,
    ) -> Response<ResponseBody>
    where
        B: Body<Data = Bytes> + Unpin,
        B::Error: Display,
    {
        let options = &self.0.options;
        for dir in [folder, &self.0.cache_dir] {
            if let Err(error) = tokio::fs::create_dir_all(dir).await {
                return internal(error);
            }
        }
        let upload_started = Instant::now();
        if receive(body, &files.input, options.max_bytes).await.is_err() {
            return text(StatusCode::PAYLOAD_TOO_LARGE, "invalid_source_size");
        }
        let probe = match self.0.commands.run("ffprobe", probe_args(&files.input)).await {
            Ok(finished) => commands::parse_probe(&finished),
            Err(_) => commands::parse_probe(&Finished {
                code: -1,
                ..Finished::default()
            }),
        };
        let blur = needs_vertical_blur(probe.width, probe.height);
        let standard = &files.outputs[0].0;
        let args = match (job.kind, job.transform) {
            (MediaKind::Video, Transform::Story) => story_ffmpeg_args(
                Encoder::Vaapi,
                &files.input,
                standard,
                &files.outputs[1].0,
                telegram_video_kbps(probe.duration, probe.audio_bitrate),
                blur,
            ),
            (MediaKind::Video, Transform::Site) => site_video_ffmpeg_args(Encoder::Vaapi, &files.input, standard, blur),
            (MediaKind::Image, _) => vertical_image_ffmpeg_args(&files.input, standard, blur),
        };
        // Includes the probe, as it always has.
        let upload_ms = millis(upload_started.elapsed());
        let ffmpeg_started = Instant::now();
        let timeout = Duration::from_secs(options.timeout_seconds);
        let encoded = tokio::time::timeout(timeout, self.0.commands.run("ffmpeg", args)).await;
        let ffmpeg_ms = millis(ffmpeg_started.elapsed());
        let failure = match encoded {
            Err(_) => Some(ffmpeg_failure(137, "", true, options.timeout_seconds)),
            Ok(Err(error)) => return internal(error),
            Ok(Ok(finished)) if finished.code != 0 => Some(ffmpeg_failure(
                finished.code,
                &String::from_utf8_lossy(&finished.stderr),
                false,
                options.timeout_seconds,
            )),
            Ok(Ok(_)) => None,
        };
        if let Some(failure) = failure {
            return text(StatusCode::UNPROCESSABLE_ENTITY, failure);
        }
        for (partial, cached) in &files.outputs {
            if let Err(error) = tokio::fs::rename(partial, cached).await {
                return internal(error);
            }
        }
        let timings = json!({
            "uploadMs": upload_ms,
            "queueWaitMs": queue_wait_ms,
            "ffmpegMs": ffmpeg_ms,
            "totalMs": millis(job.received.elapsed()),
            "cacheHit": false,
        });
        log(
            "info",
            "media transform completed",
            json!({"job": id, "timings": timings}),
        );
        self.manifest(job, id, timings)
    }

    fn cache_file(&self, key: &str, variant: &str, kind: MediaKind) -> PathBuf {
        self.0.cache_dir.join(format!("{key}.{variant}.{}", kind.extension()))
    }

    /// The manifest of a key whose every variant is already rendered. The
    /// key does not name the transform, so a site request is answered by a
    /// Story render; a Story request needs its Telegram variant too.
    fn cached_manifest(&self, job: &Job, how: &str) -> Option<Response<ResponseBody>> {
        if !job
            .variants()
            .iter()
            .all(|variant| self.cache_file(&job.key, variant, job.kind).exists())
        {
            return None;
        }
        let timings = json!({
            "uploadMs": 0,
            "queueWaitMs": 0,
            "ffmpegMs": 0,
            "totalMs": millis(job.received.elapsed()),
            "cacheHit": true,
        });
        Some(self.manifest(job, &job.job_name(how), timings))
    }

    fn manifest(&self, job: &Job, name: &str, timings: Value) -> Response<ResponseBody> {
        let mut outputs = Map::new();
        for variant in job.variants() {
            match std::fs::metadata(self.cache_file(&job.key, variant, job.kind)) {
                Ok(metadata) => outputs.insert((*variant).into(), json!({"bytes": metadata.len()})),
                Err(error) => return internal(error),
            };
        }
        json_response(&json!({
            "job": name,
            "requestId": name,
            "timings": timings,
            "outputs": outputs,
        }))
    }
}

struct Files {
    input: PathBuf,
    /// Each variant's partial file and the cache entry it becomes.
    outputs: Vec<(PathBuf, PathBuf)>,
}

/// Streams the body to `output`, refusing it past `limit` bytes:
/// `content-length` is only a claim, and an understated one would fill the
/// disk that holds both the work directory and the cache.
async fn receive<B>(mut body: B, output: &Path, limit: u64) -> Result<(), String>
where
    B: Body<Data = Bytes> + Unpin,
    B::Error: Display,
{
    let mut file = tokio::fs::File::create(output)
        .await
        .map_err(|error| error.to_string())?;
    let mut written = 0u64;
    while let Some(frame) = body.frame().await {
        let frame = frame.map_err(|error| error.to_string())?;
        let Ok(data) = frame.into_data() else {
            continue;
        };
        written += data.len() as u64;
        if written > limit {
            return Err("source_exceeds_limit".into());
        }
        file.write_all(&data).await.map_err(|error| error.to_string())?;
    }
    file.flush().await.map_err(|error| error.to_string())
}

/// Accepts connections until the process stops; each is served on its own task.
pub async fn serve(listener: TcpListener, processor: Processor) {
    loop {
        match listener.accept().await {
            Ok((stream, _)) => {
                tokio::spawn(serve_connection(stream, processor.clone()));
            }
            Err(error) => {
                log("warn", "accept failed", json!({"error": error.to_string()}));
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        }
    }
}

/// One HTTP/1.1 connection. A client that goes away mid-request is not the
/// processor's error.
pub async fn serve_connection<S>(stream: S, processor: Processor)
where
    S: AsyncRead + AsyncWrite + Send + Unpin + 'static,
{
    let service = service_fn(move |request| {
        let processor = processor.clone();
        async move { Ok::<_, Infallible>(processor.handle(request).await) }
    });
    let _ = http1::Builder::new()
        .timer(TokioTimer::new())
        .serve_connection(TokioIo::new(stream), service)
        .await;
}

/// `/v1/transforms/ffmpeg/{64 lowercase hex}/{standard|telegram}`.
fn download_path(path: &str) -> Option<(&str, &str)> {
    let (key, variant) = path.strip_prefix(TRANSFORM_PATH)?.strip_prefix('/')?.split_once('/')?;
    (is_digest(key) && matches!(variant, "standard" | "telegram")).then_some((key, variant))
}

/// `^[a-f0-9]{64}$`.
fn is_digest(key: &str) -> bool {
    key.len() == 64 && key.bytes().all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
}

/// A header's values joined by `", "`, as `Headers.get` reads them.
fn header<B>(request: &Request<B>, name: &str) -> Option<String> {
    let values: Vec<&str> = request
        .headers()
        .get_all(name)
        .iter()
        .map(|value| value.to_str().unwrap_or_default())
        .collect();
    (!values.is_empty()).then(|| values.join(", "))
}

fn text(status: StatusCode, body: impl Into<String>) -> Response<ResponseBody> {
    respond(status, "text/plain;charset=utf-8", body.into().into_bytes())
}

fn json_response(value: &Value) -> Response<ResponseBody> {
    respond(
        StatusCode::OK,
        "application/json;charset=utf-8",
        value.to_string().into_bytes(),
    )
}

fn internal(error: impl Display) -> Response<ResponseBody> {
    text(
        StatusCode::INTERNAL_SERVER_ERROR,
        format!("media_processor_error: {error}"),
    )
}

fn respond(status: StatusCode, content_type: &'static str, body: Vec<u8>) -> Response<ResponseBody> {
    Response::builder()
        .status(status)
        .header(CONTENT_TYPE, content_type)
        .body(UnsyncBoxBody::new(
            Full::new(Bytes::from(body)).map_err(|never| match never {}),
        ))
        .expect("a static response is well-formed")
}

fn millis(elapsed: Duration) -> u64 {
    elapsed.as_millis() as u64
}

/// A random (version 4) UUID: the request's job id and work folder.
fn uuid() -> String {
    let mut bytes = [0u8; 16];
    getrandom::getrandom(&mut bytes).expect("the operating system has no randomness source");
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let hex: String = bytes.iter().map(|byte| format!("{byte:02x}")).collect();
    format!(
        "{}-{}-{}-{}-{}",
        &hex[0..8],
        &hex[8..12],
        &hex[12..16],
        &hex[16..20],
        &hex[20..32]
    )
}

/// One JSON line, `{"ts","level","message",...fields}`: warnings and errors
/// on stderr, the rest on stdout.
pub fn log(level: &str, message: &str, fields: Value) {
    let mut line = Map::new();
    line.insert(
        "ts".into(),
        jiff::Timestamp::now()
            .strftime("%Y-%m-%dT%H:%M:%S%.3fZ")
            .to_string()
            .into(),
    );
    line.insert("level".into(), level.into());
    line.insert("message".into(), message.into());
    if let Value::Object(fields) = fields {
        line.extend(fields);
    }
    let line = Value::Object(line);
    if matches!(level, "warn" | "error") {
        eprintln!("{line}");
    } else {
        println!("{line}");
    }
}
