//! The service that runs on VM-106 and renders every Story remotely. It is
//! reached only through an SSH tunnel from the Studio, so its contract —
//! status codes, manifest shape, caching, the one encoder slot and the disk
//! it leaves behind — is what `providers::adapters::remote_media_processor` depends on.
//!
//! ffmpeg and ffprobe are injected: this is about the service around them.

mod support;

use std::time::{Duration, SystemTime};

use http_body_util::{BodyExt as _, Full};
use hyper::body::Bytes;
use hyper::{Request, Response, StatusCode};
use media_processor::{Options, Processor, ResponseBody};
use serde_json::{Value, json};
use support::{Fake, KEY, TOKEN, vertical_probe, work};

async fn read(response: Response<ResponseBody>) -> (StatusCode, hyper::HeaderMap, Vec<u8>) {
    let (parts, body) = response.into_parts();
    (
        parts.status,
        parts.headers,
        body.collect().await.unwrap().to_bytes().to_vec(),
    )
}

async fn json_of(response: Response<ResponseBody>) -> Value {
    let (status, _, body) = read(response).await;
    assert_eq!(status, StatusCode::OK, "{}", String::from_utf8_lossy(&body));
    serde_json::from_slice(&body).unwrap()
}

async fn text_of(response: Response<ResponseBody>) -> (StatusCode, String) {
    let (status, _, body) = read(response).await;
    (status, String::from_utf8(body).unwrap())
}

fn transform(body: &str, headers: &[(&str, &str)]) -> Request<Full<Bytes>> {
    let length = body.len().to_string();
    let mut defaults = vec![
        ("authorization", format!("Bearer {TOKEN}")),
        ("x-studio-transform", "story_vertical".into()),
        ("x-studio-media-kind", "video".into()),
        ("x-studio-idempotency-key", KEY.into()),
        ("content-length", length),
    ];
    for (name, value) in headers {
        defaults.retain(|(default, _)| default != name);
        defaults.push((name, (*value).into()));
    }
    let mut request = Request::post("http://processor/v1/transforms/ffmpeg");
    for (name, value) in defaults {
        request = request.header(name, value);
    }
    request.body(Full::new(Bytes::from(body.to_owned()))).unwrap()
}

fn get(path: &str, authorized: bool) -> Request<Full<Bytes>> {
    let mut request = Request::get(format!("http://processor{path}"));
    if authorized {
        request = request.header("authorization", format!("Bearer {TOKEN}"));
    }
    request.body(Full::default()).unwrap()
}

fn cache(processor: &Options, name: &str) -> std::path::PathBuf {
    processor.work_dir.join("cache").join(name)
}

fn names(dir: &std::path::Path) -> Vec<String> {
    let mut names: Vec<String> = std::fs::read_dir(dir)
        .unwrap()
        .map(|entry| entry.unwrap().file_name().to_string_lossy().into_owned())
        .collect();
    names.sort();
    names
}

#[test]
fn refuses_to_start_with_a_token_short_enough_to_brute_force() {
    let mut options = work("short-token");
    options.token = "short".into();
    let error = Processor::new(options.clone(), Fake::default()).err().unwrap();
    assert!(error.contains("at least 16 characters"), "{error}");
}

#[test]
fn reads_its_environment_with_the_typescript_defaults() {
    let options = Options::from_env([("MEDIA_PROCESSOR_TOKEN".to_owned(), TOKEN.to_owned())]).unwrap();
    assert_eq!(options.work_dir, std::path::Path::new("/work"));
    assert_eq!(
        (
            options.max_bytes,
            options.timeout_seconds,
            options.cache_ttl_seconds,
            options.retry_after_seconds
        ),
        (1_073_741_824, 900, 86_400, 60)
    );
    assert_eq!(options.revision, "unknown");
    let error = Options::from_env([("MEDIA_PROCESSOR_MAX_BYTES".to_owned(), "lots".to_owned())]).unwrap_err();
    assert!(error.contains("MEDIA_PROCESSOR_MAX_BYTES"), "{error}");
}

#[tokio::test]
async fn reports_health_without_a_token_since_the_tunnel_is_the_only_way_in() {
    let (processor, _work) = Fake::default().processor("health");
    let (status, headers, body) = read(processor.handle(get("/health", false)).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json;charset=utf-8");
    let text = String::from_utf8(body).unwrap();
    // CI's image smoke test greps the compact form.
    assert!(text.contains(r#""status":"ready""#), "{text}");
    let health: Value = serde_json::from_str(&text).unwrap();
    let keys: Vec<&str> = health.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(
        keys,
        [
            "ok",
            "status",
            "queued",
            "active",
            "concurrency",
            "inFlight",
            "rejected",
            "shared",
            "version",
            "vaapi",
            "workDisk"
        ]
    );
    assert_eq!(health["ok"], true);
    assert_eq!(health["queued"], 0);
    assert_eq!(health["active"], 0);
    assert_eq!(health["concurrency"], 1);
    assert_eq!(health["version"], "abc123");
    assert_eq!(health["vaapi"], false);
    assert!(health["workDisk"]["totalBytes"].as_u64().unwrap() > 0);
}

#[tokio::test]
async fn rejects_an_unauthorised_transform_and_download() {
    let (processor, _work) = Fake::default().processor("unauthorised");
    let post = Request::post("http://processor/v1/transforms/ffmpeg")
        .body(Full::new(Bytes::from("x")))
        .unwrap();
    assert_eq!(
        text_of(processor.handle(post).await).await,
        (StatusCode::UNAUTHORIZED, "unauthorized".into())
    );
    let wrong = transform("x", &[("authorization", "Bearer media-processor-token-wrong")]);
    assert_eq!(processor.handle(wrong).await.status(), StatusCode::UNAUTHORIZED);
    let download = get(&format!("/v1/transforms/ffmpeg/{KEY}/standard"), false);
    assert_eq!(processor.handle(download).await.status(), StatusCode::UNAUTHORIZED);
}

#[tokio::test]
async fn answers_anything_else_with_404() {
    let (processor, _work) = Fake::default().processor("not-found");
    for path in [
        "/".to_owned(),
        "/v1/transforms/ffmpeg".to_owned(),
        format!("/v1/transforms/ffmpeg/{}/standard", KEY.to_uppercase()),
        format!("/v1/transforms/ffmpeg/{KEY}/poster"),
    ] {
        assert_eq!(
            text_of(processor.handle(get(&path, true)).await).await,
            (StatusCode::NOT_FOUND, "not_found".into()),
            "{path}"
        );
    }
}

#[tokio::test]
async fn validates_the_transform_media_kind_and_key_before_accepting_bytes() {
    let fake = Fake::default();
    let (processor, _work) = fake.processor("validation");
    for (headers, body, expected) in [
        (
            vec![("x-studio-transform", "sepia")],
            "data",
            "invalid_transform_request",
        ),
        (vec![], "", "invalid_transform_request"),
        (vec![("x-studio-media-kind", "audio")], "data", "invalid_media_kind"),
        (
            vec![("x-studio-idempotency-key", "not-a-digest")],
            "data",
            "invalid_idempotency_key",
        ),
    ] {
        assert_eq!(
            text_of(processor.handle(transform(body, &headers)).await).await,
            (StatusCode::BAD_REQUEST, expected.into())
        );
    }
    assert!(fake.commands().is_empty());
}

#[tokio::test]
async fn rejects_a_declared_size_above_the_cap_without_reading_the_body() {
    let fake = Fake::default();
    let mut options = work("declared-size");
    options.max_bytes = 100;
    let processor = Processor::new(options.clone(), fake.clone()).unwrap();
    let response = processor.handle(transform("data", &[("content-length", "1000")])).await;
    assert_eq!(
        text_of(response).await,
        (StatusCode::PAYLOAD_TOO_LARGE, "invalid_source_size".into())
    );
    assert!(fake.commands().is_empty());
}

#[tokio::test]
async fn stops_a_source_that_understates_its_own_content_length() {
    // The header is a client claim; trusting it lets a small declared upload
    // fill the disk that holds both the work directory and the cache.
    let fake = Fake::default();
    let mut options = work("understated");
    options.max_bytes = 10;
    let processor = Processor::new(options.clone(), fake.clone()).unwrap();
    let response = processor
        .handle(transform(&"x".repeat(500), &[("content-length", "8")]))
        .await;
    assert_eq!(response.status(), StatusCode::PAYLOAD_TOO_LARGE);
    assert!(fake.commands().is_empty());
    assert_eq!(names(&options.work_dir), ["cache"]);
}

#[tokio::test]
async fn renders_a_story_video_into_both_variants_and_reports_their_sizes() {
    let fake = Fake {
        probe: vertical_probe(12.0),
        ..Fake::default()
    };
    let (processor, work) = fake.processor("story");
    let (status, headers, body) = read(processor.handle(transform("video-bytes", &[])).await).await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "application/json;charset=utf-8");
    let manifest: Value = serde_json::from_slice(&body).unwrap();
    let keys: Vec<&str> = manifest.as_object().unwrap().keys().map(String::as_str).collect();
    assert_eq!(keys, ["job", "requestId", "timings", "outputs"]);
    assert_eq!(manifest["job"], manifest["requestId"]);
    let outputs: Vec<&str> = manifest["outputs"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(outputs, ["standard", "telegram"]);
    assert_eq!(manifest["outputs"]["standard"], json!({"bytes": 64}));
    assert_eq!(manifest["timings"]["cacheHit"], false);
    let timings: Vec<&str> = manifest["timings"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(timings, ["uploadMs", "queueWaitMs", "ffmpegMs", "totalMs", "cacheHit"]);
    assert!(cache(&work, &format!("{KEY}.standard.mp4")).exists());
    assert!(cache(&work, &format!("{KEY}.telegram.mp4")).exists());
    // The request folder and the partial outputs are gone.
    assert_eq!(names(&work.work_dir), ["cache"]);
    assert_eq!(
        names(&work.work_dir.join("cache")),
        [format!("{KEY}.standard.mp4"), format!("{KEY}.telegram.mp4")]
    );

    let commands = fake.commands();
    assert_eq!(commands.len(), 2);
    let job = manifest["job"].as_str().unwrap();
    let source = work.work_dir.join(job).join("source.mp4");
    let source = source.to_str().unwrap();
    assert_eq!(
        commands[0],
        [
            "ffprobe",
            "-v",
            "error",
            "-show_entries",
            "format=duration:stream=codec_type,bit_rate,width,height",
            "-of",
            "json",
            source
        ]
    );
    assert_eq!(fake.sources(), [b"video-bytes".to_vec()]);
    let ffmpeg = &commands[1];
    assert_eq!(ffmpeg[0], "ffmpeg");
    assert_eq!(
        ffmpeg[1..6],
        [
            "-init_hw_device",
            "vaapi=va:/dev/dri/renderD128",
            "-filter_hw_device",
            "va",
            "-y"
        ]
    );
    let cache_dir = work.work_dir.join("cache");
    let partial = |variant: &str| format!("{}/{KEY}.{variant}.mp4.{job}.part.mp4", cache_dir.display());
    assert!(ffmpeg.contains(&partial("standard")), "{ffmpeg:?}");
    assert!(ffmpeg.contains(&partial("telegram")), "{ffmpeg:?}");
    assert!(ffmpeg.contains(&source.to_owned()));
}

#[tokio::test]
async fn produces_only_a_standard_variant_for_a_site_transform() {
    let fake = Fake {
        probe: vertical_probe(12.0),
        ..Fake::default()
    };
    let (processor, _work) = fake.processor("site");
    let manifest = json_of(
        processor
            .handle(transform("video-bytes", &[("x-studio-transform", "site_vertical")]))
            .await,
    )
    .await;
    let outputs: Vec<&str> = manifest["outputs"]
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(outputs, ["standard"]);
    let ffmpeg = fake.ffmpeg_args().join(" ");
    assert!(!ffmpeg.contains("trim="));
    assert!(!ffmpeg.contains(" -t "));
}

#[tokio::test]
async fn renders_an_image_as_one_standard_jpeg() {
    let fake = Fake {
        probe: r#"{"streams":[{"codec_type":"video","width":1600,"height":1200}]}"#.into(),
        ..Fake::default()
    };
    let (processor, work) = fake.processor("image");
    let manifest = json_of(
        processor
            .handle(transform("jpeg-bytes", &[("x-studio-media-kind", "image")]))
            .await,
    )
    .await;
    assert_eq!(manifest["outputs"], json!({"standard": {"bytes": 64}}));
    assert!(cache(&work, &format!("{KEY}.standard.jpg")).exists());
    let ffmpeg = fake.ffmpeg_args().join(" ");
    assert!(ffmpeg.contains("boxblur=20:10"), "{ffmpeg}");
    assert!(!ffmpeg.contains("vaapi"), "{ffmpeg}");
}

#[tokio::test]
async fn blurs_a_backdrop_for_a_source_that_is_not_already_vertical() {
    let fake = Fake {
        probe: r#"{"format":{"duration":"10"},"streams":[{"codec_type":"video","width":1920,"height":1080}]}"#.into(),
        ..Fake::default()
    };
    let (processor, _work) = fake.processor("blur");
    processor.handle(transform("video-bytes", &[])).await;
    let args = fake.ffmpeg_args().join(" ");
    for expected in [
        "scale=540:960",
        "crop=540:960",
        "boxblur=10:4",
        "scale=1080:1920",
        "overlay",
    ] {
        assert!(args.contains(expected), "{expected} in {args}");
    }
    assert!(!args.contains("boxblur=20:10"));
}

#[tokio::test]
async fn falls_back_to_safe_defaults_when_ffprobe_cannot_read_the_source() {
    for fake in [
        Fake {
            probe_exit: 1,
            ..Fake::default()
        },
        Fake {
            probe: "<html>proxy error</html>".into(),
            ..Fake::default()
        },
    ] {
        let (processor, _work) = fake.processor("unreadable");
        let response = processor.handle(transform("video-bytes", &[])).await;
        // A source it cannot measure must still render, at the conservative
        // bitrate for a full-length clip.
        assert_eq!(response.status(), StatusCode::OK);
        let kbps = vertical_media::telegram_video_kbps(59.0, 128_000.0);
        assert_eq!(kbps, 1056);
        assert!(fake.ffmpeg_args().contains(&format!("{kbps}k")));
    }
}

#[tokio::test]
async fn serves_the_cached_manifest_on_a_repeat_request_without_spawning_ffmpeg() {
    let fake = Fake {
        probe: vertical_probe(10.0),
        ..Fake::default()
    };
    let (processor, _work) = fake.processor("repeat");
    processor.handle(transform("video-bytes", &[])).await;
    let spawned = fake.commands().len();
    let repeat = json_of(processor.handle(transform("video-bytes", &[])).await).await;
    assert_eq!(repeat["timings"]["cacheHit"], true);
    assert_eq!(repeat["job"], format!("cached-{}", &KEY[..12]));
    assert_eq!(fake.commands().len(), spawned);
    // The key does not name the transform: the Story render answers a site request.
    let site = json_of(
        processor
            .handle(transform("video-bytes", &[("x-studio-transform", "site_vertical")]))
            .await,
    )
    .await;
    assert_eq!(site["timings"]["cacheHit"], true);
    assert_eq!(fake.commands().len(), spawned);
}

#[tokio::test]
async fn returns_422_with_the_tail_of_ffmpegs_diagnostics_and_leaves_nothing_behind() {
    let fake = Fake {
        ffmpeg_exit: 1,
        write_outputs: false,
        ffmpeg_stderr: "frame=  12 fps=3 q=28\nnoise\n[libx264 @ 0x1] height not divisible by 2\nConversion failed!\n"
            .into(),
        ..Fake::default()
    };
    let (processor, work) = fake.processor("failure");
    let (status, text) = text_of(processor.handle(transform("video-bytes", &[])).await).await;
    assert_eq!(status, StatusCode::UNPROCESSABLE_ENTITY);
    assert!(text.contains("ffmpeg exit 1"), "{text}");
    assert!(text.contains("Conversion failed!"), "{text}");
    // Progress spam would push the real diagnostic out of the tail.
    assert!(!text.contains("fps="), "{text}");
    // A partial output kept under the cache name would be served later as if
    // it were a finished render.
    assert!(names(&work.work_dir.join("cache")).is_empty());
    assert_eq!(names(&work.work_dir), ["cache"]);
}

#[tokio::test]
async fn names_a_render_that_outlived_its_timeout() {
    let fake = Fake::default();
    fake.hold_ffmpeg();
    let mut options = work("timeout");
    options.timeout_seconds = 1;
    let processor = Processor::new(options.clone(), fake.clone()).unwrap();
    let (status, text) = text_of(processor.handle(transform("video-bytes", &[])).await).await;
    assert_eq!(
        (status, text.as_str()),
        (
            StatusCode::UNPROCESSABLE_ENTITY,
            "media_processing_timeout: ffmpeg exceeded 1s"
        )
    );
    assert!(names(&options.work_dir.join("cache")).is_empty());
    let health = json_of(processor.handle(get("/health", false)).await).await;
    assert_eq!(health["status"], "ready");
}

#[tokio::test]
async fn downloads_a_rendered_variant_with_an_explicit_length_and_404s_the_rest() {
    let (processor, work) = Fake::default().processor("download");
    std::fs::write(cache(&work, &format!("{KEY}.standard.mp4")), [2u8; 128]).unwrap();
    let (status, headers, body) = read(
        processor
            .handle(get(&format!("/v1/transforms/ffmpeg/{KEY}/standard"), true))
            .await,
    )
    .await;
    assert_eq!(status, StatusCode::OK);
    assert_eq!(headers["content-type"], "video/mp4");
    // Framing has to be deterministic through the tunnel and its TCP proxy.
    assert_eq!(headers["content-length"], "128");
    assert_eq!(headers["x-media-processor-job"], format!("cached-{}", &KEY[..12]));
    assert_eq!(body, [2u8; 128]);
    let missing = processor
        .handle(get(&format!("/v1/transforms/ffmpeg/{KEY}/telegram"), true))
        .await;
    assert_eq!(missing.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn serves_a_rendered_image_only_as_the_standard_variant() {
    let (processor, work) = Fake::default().processor("download-image");
    std::fs::write(cache(&work, &format!("{KEY}.standard.jpg")), [3u8; 32]).unwrap();
    std::fs::write(cache(&work, &format!("{KEY}.telegram.jpg")), [3u8; 32]).unwrap();
    let standard = processor
        .handle(get(&format!("/v1/transforms/ffmpeg/{KEY}/standard"), true))
        .await;
    assert_eq!(standard.headers()["content-type"], "image/jpeg");
    let telegram = processor
        .handle(get(&format!("/v1/transforms/ffmpeg/{KEY}/telegram"), true))
        .await;
    assert_eq!(telegram.status(), StatusCode::NOT_FOUND);
}

#[tokio::test]
async fn runs_one_render_at_a_time_and_refuses_distinct_work_while_the_slot_is_held() {
    let fake = Fake {
        probe: vertical_probe(10.0),
        ..Fake::default()
    };
    fake.hold_ffmpeg();
    let mut options = work("busy");
    options.retry_after_seconds = 75;
    let processor = Processor::new(options.clone(), fake.clone()).unwrap();
    let first = tokio::spawn({
        let processor = processor.clone();
        async move {
            processor
                .handle(transform("first", &[("x-studio-idempotency-key", &"b".repeat(64))]))
                .await
        }
    });
    fake.wait_for_ffmpeg(1).await;
    let health = json_of(processor.handle(get("/health", false)).await).await;
    assert_eq!(
        (&health["ok"], &health["status"], &health["active"], &health["inFlight"]),
        (&json!(false), &json!("busy"), &json!(1), &json!(1))
    );

    for key in ["c", "d"] {
        let (status, headers, body) = read(
            processor
                .handle(transform("second", &[("x-studio-idempotency-key", &key.repeat(64))]))
                .await,
        )
        .await;
        assert_eq!(status, StatusCode::TOO_MANY_REQUESTS);
        assert_eq!(headers["retry-after"], "75");
        assert_eq!(body, b"media_processor_busy");
    }
    fake.release_ffmpeg();
    assert_eq!(first.await.unwrap().status(), StatusCode::OK);
    // VM-106 has one VAAPI device and a 2-CPU budget.
    assert_eq!(fake.peak_ffmpeg(), 1);
    let health = json_of(processor.handle(get("/health", false)).await).await;
    assert_eq!((&health["status"], &health["rejected"]), (&json!("ready"), &json!(2)));
}

#[tokio::test]
async fn shares_one_in_flight_render_between_requests_with_the_same_content_key() {
    let fake = Fake {
        probe: vertical_probe(10.0),
        ..Fake::default()
    };
    fake.hold_ffmpeg();
    let (processor, _work) = fake.processor("shared");
    let first = tokio::spawn({
        let processor = processor.clone();
        async move { processor.handle(transform("first", &[])).await }
    });
    fake.wait_for_ffmpeg(1).await;
    let shared = tokio::spawn({
        let processor = processor.clone();
        async move { processor.handle(transform("duplicate", &[])).await }
    });
    tokio::task::yield_now().await;
    fake.release_ffmpeg();
    assert_eq!(first.await.unwrap().status(), StatusCode::OK);
    let shared = json_of(shared.await.unwrap()).await;
    assert_eq!(shared["job"], format!("shared-{}", &KEY[..12]));
    assert_eq!(fake.ffmpeg_count(), 1);
    let health = json_of(processor.handle(get("/health", false)).await).await;
    assert_eq!(health["shared"], 1);
}

#[tokio::test]
async fn a_shared_render_that_failed_is_503_for_the_requests_sharing_it() {
    let fake = Fake {
        ffmpeg_exit: 1,
        write_outputs: false,
        ..Fake::default()
    };
    fake.hold_ffmpeg();
    let (processor, _work) = fake.processor("shared-failed");
    let first = tokio::spawn({
        let processor = processor.clone();
        async move { processor.handle(transform("first", &[])).await }
    });
    fake.wait_for_ffmpeg(1).await;
    let shared = tokio::spawn({
        let processor = processor.clone();
        async move { processor.handle(transform("duplicate", &[])).await }
    });
    tokio::task::yield_now().await;
    fake.release_ffmpeg();
    assert_eq!(first.await.unwrap().status(), StatusCode::UNPROCESSABLE_ENTITY);
    assert_eq!(
        text_of(shared.await.unwrap()).await,
        (
            StatusCode::SERVICE_UNAVAILABLE,
            "media_processing_shared_job_failed".into()
        )
    );
}

#[tokio::test]
async fn a_render_survives_its_caller_going_away() {
    let fake = Fake {
        probe: vertical_probe(10.0),
        ..Fake::default()
    };
    fake.hold_ffmpeg();
    let (processor, work) = fake.processor("abandoned");
    let caller = tokio::spawn({
        let processor = processor.clone();
        async move { processor.handle(transform("first", &[])).await }
    });
    fake.wait_for_ffmpeg(1).await;
    caller.abort();
    fake.release_ffmpeg();
    for _ in 0..100 {
        if cache(&work, &format!("{KEY}.telegram.mp4")).exists() {
            break;
        }
        tokio::time::sleep(Duration::from_millis(5)).await;
    }
    let repeat = json_of(processor.handle(transform("first", &[])).await).await;
    assert_eq!(repeat["timings"]["cacheHit"], true);
}

#[test]
fn reclaims_aged_cache_entries_and_orphaned_request_folders_keeping_fresh_ones() {
    let mut options = work("prune");
    options.cache_ttl_seconds = 60;
    let processor = Processor::new(options.clone(), Fake::default()).unwrap();
    let old = SystemTime::now() - Duration::from_secs(3600);
    let stale = cache(&options, "stale.mp4");
    let fresh = cache(&options, "fresh.mp4");
    let orphan = options.work_dir.join("orphaned-request");
    std::fs::write(&stale, "x").unwrap();
    std::fs::write(&fresh, "x").unwrap();
    std::fs::create_dir(&orphan).unwrap();
    std::fs::write(orphan.join("source.mp4"), "x").unwrap();
    for target in [&stale, &orphan] {
        std::fs::File::open(target).unwrap().set_modified(old).unwrap();
    }
    // The cache directory itself is never a prune candidate, however old.
    std::fs::File::open(options.work_dir.join("cache"))
        .unwrap()
        .set_modified(old)
        .unwrap();

    processor.prune(SystemTime::now());

    assert!(!stale.exists());
    assert!(!orphan.exists());
    assert!(fresh.exists());
    assert!(options.work_dir.join("cache").exists());
}
