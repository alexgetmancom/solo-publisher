//! The Studio's client (`adapters::remote_media_processor`) against this
//! server, over HTTP/1.1 on an in-process stream: the headers and body it
//! sends are what the server accepts, and the manifest, the variants and the
//! refusals the server answers with are what the client reads.

mod support;

use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;
use std::time::Duration;

use adapters::remote_media_processor::{MediaKind, Variant, media_transform_key, process_vertical_media_remotely};
use adapters::{AdapterContext, AdapterError};
use domain::application::ports::SystemClock;
use foundation::config::load_config;
use http_body_util::{BodyExt as _, Full};
use hyper::body::Bytes;
use hyper_util::rt::TokioIo;
use media_processor::{Processor, serve_connection};
use runtime::http::{BodyPart, Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use support::{Fake, TOKEN, Work, vertical_probe};

const BASE: &str = "http://media-processor.test/";

/// Every request on a fresh HTTP/1.1 connection to the processor.
struct InProcess(Processor);

impl Transport for InProcess {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        let processor = self.0.clone();
        Box::pin(async move {
            let failure = |error: &dyn std::fmt::Display| TransportFailure {
                message: error.to_string(),
                timed_out: false,
            };
            let (client, server) = tokio::io::duplex(64 * 1024);
            tokio::spawn(serve_connection(server, processor));
            let (mut sender, connection) = hyper::client::conn::http1::handshake(TokioIo::new(client))
                .await
                .map_err(|error| failure(&error))?;
            tokio::spawn(connection);
            let path = request.url.strip_prefix(BASE.trim_end_matches('/')).unwrap();
            let mut outgoing = hyper::Request::builder()
                .method(request.method.as_str())
                .uri(path)
                .header("host", "media-processor.test");
            for (name, value) in &request.headers {
                outgoing = outgoing.header(name, value);
            }
            let mut body = Vec::new();
            for part in &request.body.0 {
                match part {
                    BodyPart::Bytes(bytes) => body.extend_from_slice(bytes),
                    BodyPart::File { path, offset } => {
                        body.extend_from_slice(&std::fs::read(path).unwrap()[*offset as usize..]);
                    }
                }
            }
            let response = sender
                .send_request(outgoing.body(Full::new(Bytes::from(body))).unwrap())
                .await
                .map_err(|error| failure(&error))?;
            let status = response.status().as_u16();
            let headers = response
                .headers()
                .iter()
                .map(|(name, value)| (name.to_string(), value.to_str().unwrap().to_owned()))
                .collect();
            let body = response
                .into_body()
                .collect()
                .await
                .map_err(|error| failure(&error))?
                .to_bytes();
            Ok(HttpResponse::buffered(status, headers, body.to_vec()))
        })
    }
}

fn studio(processor: &Processor) -> AdapterContext {
    let config = load_config([
        ("DATA_DIR", "/data"),
        ("MEDIA_PROCESSOR_PROVIDER", "remote_http"),
        ("MEDIA_PROCESSOR_URL", BASE),
        ("MEDIA_PROCESSOR_TOKEN", TOKEN),
    ])
    .unwrap();
    AdapterContext {
        config: Arc::new(config),
        client: HttpClient::new(Rc::new(InProcess(processor.clone()))),
        clock: Rc::new(SystemClock),
    }
}

/// A source file and the Studio's output directory, inside the test's work.
fn source(work: &Work, name: &str, bytes: &[u8]) -> (PathBuf, PathBuf) {
    let studio = work.work_dir.with_extension("studio");
    std::fs::create_dir_all(&studio).unwrap();
    let source = studio.join(name);
    std::fs::write(&source, bytes).unwrap();
    (source, studio)
}

fn variant(name: &str, output: &Path) -> Variant {
    Variant {
        name: name.into(),
        output: output.to_owned(),
    }
}

async fn transform(
    ctx: &AdapterContext,
    source: &Path,
    kind: MediaKind,
    variants: &[Variant],
) -> Result<serde_json::Value, AdapterError> {
    process_vertical_media_remotely(ctx, source, kind, variants, Duration::from_secs(30)).await
}

#[tokio::test]
async fn a_story_video_round_trips_into_both_variants() {
    let fake = Fake {
        probe: vertical_probe(20.0),
        ..Fake::default()
    };
    let (processor, work) = fake.processor("client-story");
    let (source, studio_dir) = source(&work, "clip.mp4", b"studio video bytes");
    let ctx = studio(&processor);
    let variants = [
        variant("standard", &studio_dir.join("clip.story.mp4")),
        variant("telegram", &studio_dir.join("clip.telegram.mp4")),
    ];
    let manifest = transform(&ctx, &source, MediaKind::Video, &variants).await.unwrap();

    assert_eq!(manifest["outputs"]["standard"]["bytes"], 64);
    assert_eq!(manifest["outputs"]["telegram"]["bytes"], 64);
    assert_eq!(manifest["timings"]["cacheHit"], false);
    // The body arrived whole, and the client's key names the cache entries.
    assert_eq!(fake.sources(), [b"studio video bytes".to_vec()]);
    let key = media_transform_key(&source, "vertical-variants-v6:video")
        .await
        .unwrap();
    for variant in &variants {
        assert_eq!(std::fs::read(&variant.output).unwrap(), [1u8; 64]);
        assert!(
            work.work_dir
                .join("cache")
                .join(format!("{key}.{}.mp4", variant.name))
                .exists()
        );
    }

    // The repeat is the cache's.
    let repeat = transform(&ctx, &source, MediaKind::Video, &variants).await.unwrap();
    assert_eq!(repeat["job"], format!("cached-{}", &key[..12]));
    assert_eq!(fake.ffmpeg_count(), 1);
    let _ = std::fs::remove_dir_all(studio_dir);
}

#[tokio::test]
async fn an_image_round_trips_into_its_standard_variant() {
    let fake = Fake::default();
    let (processor, work) = fake.processor("client-image");
    let (source, studio_dir) = source(&work, "card.jpg", b"jpeg");
    let output = studio_dir.join("card.story.jpg");
    let manifest = transform(
        &studio(&processor),
        &source,
        MediaKind::Image,
        &[variant("standard", &output)],
    )
    .await
    .unwrap();
    assert_eq!(manifest["outputs"], serde_json::json!({"standard": {"bytes": 64}}));
    assert_eq!(std::fs::read(&output).unwrap(), [1u8; 64]);
    assert!(fake.ffmpeg_args().join(" ").contains(" -frames:v 1 -q:v 2 "));
    let _ = std::fs::remove_dir_all(studio_dir);
}

/// The refusal as the client reports it.
fn refusal(error: AdapterError) -> (u16, Option<f64>, String) {
    match error {
        AdapterError::Http(refused) => (refused.status, refused.retry_after_seconds, refused.message),
        other => panic!("not a refusal: {other:?}"),
    }
}

#[tokio::test]
async fn a_busy_processor_hands_the_client_its_retry_after() {
    let fake = Fake {
        probe: vertical_probe(10.0),
        ..Fake::default()
    };
    fake.hold_ffmpeg();
    let (processor, work) = fake.processor("client-busy");
    let first = tokio::spawn({
        let processor = processor.clone();
        let request = hyper::Request::post("http://processor/v1/transforms/ffmpeg")
            .header("authorization", format!("Bearer {TOKEN}"))
            .header("x-studio-transform", "story_vertical")
            .header("x-studio-media-kind", "video")
            .header("x-studio-idempotency-key", "b".repeat(64))
            .header("content-length", "5")
            .body(Full::new(Bytes::from_static(b"first")))
            .unwrap();
        async move { processor.handle(request).await.status() }
    });
    fake.wait_for_ffmpeg(1).await;
    // Larger than the stream's buffer: the refusal comes back while the
    // upload is still being written.
    let (source, studio_dir) = source(&work, "second.mp4", &vec![7u8; 1 << 20]);
    let variants = [
        variant("standard", &studio_dir.join("second.story.mp4")),
        variant("telegram", &studio_dir.join("second.telegram.mp4")),
    ];
    let error = transform(&studio(&processor), &source, MediaKind::Video, &variants)
        .await
        .unwrap_err();
    assert_eq!(
        refusal(error),
        (
            429,
            Some(60.0),
            "media_processor_failed: 429 media_processor_busy".into()
        )
    );
    fake.release_ffmpeg();
    assert_eq!(first.await.unwrap(), 200);
    assert!(!variants[0].output.exists());
    let _ = std::fs::remove_dir_all(studio_dir);
}

#[tokio::test]
async fn a_failed_render_reaches_the_client_with_ffmpegs_diagnostic() {
    let fake = Fake {
        ffmpeg_exit: 1,
        write_outputs: false,
        ffmpeg_stderr: "frame=  12 fps=3 q=28\nConversion failed!\n".into(),
        ..Fake::default()
    };
    let (processor, work) = fake.processor("client-failure");
    let (source, studio_dir) = source(&work, "card.jpg", b"jpeg");
    let output = studio_dir.join("card.story.jpg");
    let error = transform(
        &studio(&processor),
        &source,
        MediaKind::Image,
        &[variant("standard", &output)],
    )
    .await
    .unwrap_err();
    assert_eq!(
        refusal(error),
        (
            422,
            None,
            "media_processor_failed: 422 media_processing_failed: ffmpeg exit 1: Conversion failed!".into()
        )
    );
    assert!(!output.exists());
    let _ = std::fs::remove_dir_all(studio_dir);
}
