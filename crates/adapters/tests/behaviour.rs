//! What the request goldens cannot record: the Story re-encode budget, the
//! stories sidecar contract on both sides, and the preparation cache of the
//! social ports.

use std::cell::{Cell, RefCell};
use std::collections::VecDeque;
use std::path::{Path, PathBuf};
use std::rc::Rc;
use std::sync::Arc;

use adapters::telegram_stories::{
    HttpStoriesSidecar, SidecarError, StoriesSidecar, StoryCaption, StoryRequest, StoryUploadMedia, StoryVideoMetadata,
    publish_telegram_story, story_reencode_args,
};
use adapters::{AdapterContext, AdapterError, MediaPreparation, PrepareJob, PreparedMedia};
use content::message::MediaItem;
use domain::application::ports::SystemClock;
use domain::publishing::queue::ClaimedPublishJob;
use foundation::config::{Config, load_config};
use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;
use runtime::http::{Fut, HttpClient, HttpRequest, HttpResponse, Transport, TransportFailure};
use serde_json::{Map, Value, json};

fn config(extra: &[(&str, &str)]) -> Config {
    let mut env = vec![("DATA_DIR".to_owned(), "/data".to_owned())];
    env.extend(
        extra
            .iter()
            .map(|(name, value)| ((*name).to_owned(), (*value).to_owned())),
    );
    load_config(env).unwrap()
}

/// Answers each request with the next canned response and keeps it.
struct Canned {
    sent: RefCell<Vec<HttpRequest>>,
    answers: RefCell<VecDeque<Result<(u16, String), String>>>,
}

impl Canned {
    fn new(answers: Vec<Result<(u16, &str), &str>>) -> Rc<Self> {
        Rc::new(Self {
            sent: RefCell::new(Vec::new()),
            answers: RefCell::new(
                answers
                    .into_iter()
                    .map(|answer| {
                        answer
                            .map(|(status, body)| (status, body.to_owned()))
                            .map_err(str::to_owned)
                    })
                    .collect(),
            ),
        })
    }
}

impl Transport for Canned {
    fn send(&self, request: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        self.sent.borrow_mut().push(request);
        let answer = self.answers.borrow_mut().pop_front().expect("no answer left");
        Box::pin(async move {
            answer
                .map(|(status, body)| HttpResponse::buffered(status, Vec::new(), body))
                .map_err(|message| TransportFailure {
                    message,
                    timed_out: false,
                })
        })
    }
}

fn block_on<T>(work: impl Future<Output = T>) -> T {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
        .block_on(work)
}

#[test]
fn story_reencode_budget_takes_the_copied_audio_out_of_the_video_rate() {
    let args = |duration: f64, audio_bitrate: f64| {
        let metadata = StoryVideoMetadata {
            width: 1080.0,
            height: 1920.0,
            duration,
            audio_bitrate,
        };
        let args = story_reencode_args(Path::new("/in.mp4"), Path::new("/out.mp4"), &metadata);
        let at = |flag: &str| args[args.iter().position(|arg| arg == flag).unwrap() + 1].clone();
        (at("-b:v"), at("-maxrate"), at("-bufsize"), at("-c:a"))
    };
    // floor(9 MiB * 8 / 60 - 320 kbps) = 938291 bit/s.
    assert_eq!(
        args(60.0, 320_000.0),
        ("938k".into(), "938k".into(), "1876k".into(), "copy".into())
    );
    // A silent 30 s clip spends the whole budget on video.
    assert_eq!(args(30.0, 0.0).0, "2516k");
    // A long story never drops under the watchable floor.
    assert_eq!(
        args(600.0, 320_000.0),
        ("150k".into(), "150k".into(), "300k".into(), "copy".into())
    );
    let full = story_reencode_args(
        Path::new("/in.mp4"),
        Path::new("/out.mp4"),
        &StoryVideoMetadata {
            width: 1.0,
            height: 1.0,
            duration: 0.0,
            audio_bitrate: 0.0,
        },
    );
    assert_eq!(
        full,
        [
            "-y",
            "-i",
            "/in.mp4",
            "-r",
            "50",
            "-c:v",
            "libx264",
            "-b:v",
            "75497k",
            "-maxrate",
            "75497k",
            "-bufsize",
            "150994k",
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
            "/out.mp4",
        ]
    );
}

fn story_request() -> StoryRequest {
    StoryRequest {
        peer: "studiostories".into(),
        media: StoryUploadMedia::Video {
            path: PathBuf::from("/data/story.mp4"),
            width: 1080.0,
            height: 1920.0,
            duration: 12.0,
        },
        caption: StoryCaption {
            text: "Tap here".into(),
            links: vec![adapters::telegram_stories::CaptionLink {
                offset: 4,
                length: 4,
                url: "https://example.com".into(),
            }],
        },
        period_seconds: 86_400,
    }
}

#[test]
fn the_sidecar_client_speaks_the_documented_contract() {
    let transport = Canned::new(vec![
        Ok((200, r#"{"id":321}"#)),
        Ok((
            502,
            r#"{"error":{"message":"telegram_channel_story_connect_timeout","sent":false}}"#,
        )),
        Ok((
            504,
            r#"{"error":{"message":"telegram_channel_story_timeout","sent":true}}"#,
        )),
        Ok((500, "<html>crash</html>")),
        Err("connection reset by peer"),
    ]);
    let sidecar = HttpStoriesSidecar::new(
        HttpClient::new(transport.clone()),
        "http://127.0.0.1:8790/",
        "sidecar-test-token",
    );
    let request = story_request();
    let answers: Vec<Result<i64, SidecarError>> = block_on(async {
        let mut answers = Vec::new();
        for _ in 0..5 {
            answers.push(sidecar.send_story(&request).await);
        }
        answers
    });
    assert_eq!(answers[0], Ok(321));
    assert_eq!(
        answers[1],
        Err(SidecarError::Refused("telegram_channel_story_connect_timeout".into()))
    );
    assert_eq!(
        answers[2],
        Err(SidecarError::Ambiguous("telegram_channel_story_timeout".into()))
    );
    assert_eq!(
        answers[3],
        Err(SidecarError::Ambiguous(
            "stories sidecar answered 500: <html>crash</html>".into()
        ))
    );
    assert!(
        matches!(&answers[4], Err(SidecarError::Ambiguous(message)) if message.contains("failed before receiving"))
    );

    let sent = transport.sent.borrow();
    assert_eq!(sent[0].url, "http://127.0.0.1:8790/v1/stories");
    assert_eq!(sent[0].header_value("content-type"), Some("application/json"));
    assert_eq!(sent[0].header_value("authorization"), Some("Bearer sidecar-test-token"));
    let body: Value = serde_json::from_slice(&sent[0].body.as_bytes().unwrap()).unwrap();
    assert_eq!(
        body,
        json!({
            "peer": "studiostories",
            "media": {"type": "video", "path": "/data/story.mp4", "width": 1080, "height": 1920, "duration": 12,
                "supportsStreaming": true},
            "caption": {"text": "Tap here", "links": [{"offset": 4, "length": 4, "url": "https://example.com"}]},
            "periodSeconds": 86_400,
        })
    );
}

/// The sidecar as the publisher sees it: one canned answer.
struct FakeSidecar {
    answer: Result<i64, SidecarError>,
    seen: RefCell<Option<StoryRequest>>,
}

impl StoriesSidecar for FakeSidecar {
    fn send_story<'a>(&'a self, request: &'a StoryRequest) -> Fut<'a, Result<i64, SidecarError>> {
        *self.seen.borrow_mut() = Some(request.clone());
        let answer = self.answer.clone();
        Box::pin(async move { answer })
    }
}

#[test]
fn a_story_settles_as_the_sidecar_answers() {
    let dir = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../_trash-rust/tmp/adapter-tests")
        .join(format!("{}-story", std::process::id()));
    std::fs::create_dir_all(&dir).unwrap();
    let photo = dir.join("story.jpg");
    std::fs::write(&photo, "JPEG").unwrap();
    let ctx = AdapterContext {
        config: Arc::new(config(&[
            ("TELEGRAM_CHANNEL_STORIES_API_ID", "12345"),
            ("TELEGRAM_CHANNEL_STORIES_API_HASH", "test-secret-hash"),
            ("TELEGRAM_CHANNEL_STORIES_SESSION", "/data/stories.session"),
            ("TELEGRAM_STORIES_CHANNEL", "@studiostories"),
        ])),
        client: HttpClient::new(Canned::new(Vec::new())),
        clock: Rc::new(SystemClock),
    };
    let payload: Map<String, Value> = serde_json::from_value(json!({
        "text": "Tap here",
        "entities": [{"type": "text_link", "offset": 4, "length": 4, "url": "https://example.com"}],
        "media": [{"type": "IMAGE", "localPath": photo}],
    }))
    .unwrap();
    let publish = |answer| {
        let sidecar = FakeSidecar {
            answer,
            seen: RefCell::new(None),
        };
        let outcome = block_on(publish_telegram_story(&ctx, &sidecar, &payload));
        (outcome, sidecar.seen.into_inner())
    };

    let (outcome, seen) = publish(Ok(77));
    assert_eq!(
        Value::Object(outcome.unwrap()),
        json!({"ok": true, "id": 77, "url": "https://t.me/studiostories/s/77", "raw": {"source": "mtproto_stories.sendStory"}})
    );
    let seen = seen.unwrap();
    assert_eq!(seen.media, StoryUploadMedia::Photo { path: photo.clone() });
    assert_eq!(seen.caption.links.len(), 1);
    assert_eq!(seen.period_seconds, 86_400);

    let (outcome, _) = publish(Err(SidecarError::Ambiguous("telegram_channel_story_timeout".into())));
    assert_eq!(
        outcome.unwrap_err(),
        AdapterError::Ambiguous {
            provider: "telegram_stories".into(),
            message: "verification_required: telegram_stories may have published before confirmation was lost: \
                      telegram_channel_story_timeout"
                .into(),
        }
    );
    let (outcome, _) = publish(Err(SidecarError::Refused("PEER_ID_INVALID".into())));
    assert_eq!(outcome.unwrap_err(), AdapterError::Message("PEER_ID_INVALID".into()));
    std::fs::remove_dir_all(&dir).unwrap();
}

/// Counts preparations and fails the ones it is told to.
struct CountingPreparation {
    calls: Rc<Cell<usize>>,
    fail_next: Rc<Cell<bool>>,
    story_variant: Option<MediaItem>,
}

impl MediaPreparation for CountingPreparation {
    fn prepare_media_items(
        &self,
        _: Arc<Config>,
        media: Vec<MediaItem>,
        target: String,
    ) -> LocalBoxFuture<'static, adapters::Result<Vec<MediaItem>>> {
        self.calls.set(self.calls.get() + 1);
        let fail = self.fail_next.replace(false);
        async move {
            if fail {
                return Err(AdapterError::message_text("staging failed"));
            }
            Ok(media
                .into_iter()
                .map(|mut item| {
                    item.insert("vpsUrl".into(), format!("https://media.example/{target}.jpg").into());
                    item
                })
                .collect())
        }
        .boxed_local()
    }

    fn await_prepared_story_media<'a>(
        &'a self,
        _: &'a Config,
        _: &'a MediaItem,
    ) -> Fut<'a, adapters::Result<Option<MediaItem>>> {
        let variant = self.story_variant.clone();
        Box::pin(async move { Ok(variant) })
    }
}

fn job(target: &str, payload: Value) -> ClaimedPublishJob {
    ClaimedPublishJob {
        job_id: 1,
        publication_key: "post:1".into(),
        target: target.into(),
        payload: serde_json::from_value(payload).unwrap(),
        attempt_count: 1,
        lock_id: "lock".into(),
    }
}

#[test]
fn media_is_staged_once_per_target_and_a_failed_staging_is_retried() {
    let calls = Rc::new(Cell::new(0));
    let fail_next = Rc::new(Cell::new(false));
    let prepared = PreparedMedia::new(Rc::new(CountingPreparation {
        calls: Rc::clone(&calls),
        fail_next: Rc::clone(&fail_next),
        story_variant: None,
    }));
    let config = Arc::new(config(&[]));
    let payload = json!({"text": "t", "media": [{"type": "IMAGE", "localPath": "/a.jpg"}]});
    let staged = block_on(async {
        let first = prepared.prepare(job("x", payload.clone()), &config).await.unwrap();
        prepared.prepare(job("x", payload.clone()), &config).await.unwrap();
        prepared
            .prepare(job("discord", payload.clone()), &config)
            .await
            .unwrap();
        first
    });
    assert_eq!(calls.get(), 2, "one staging per target");
    assert_eq!(staged.payload["media"][0]["vpsUrl"], "https://media.example/x.jpg");

    fail_next.set(true);
    let failed = block_on(prepared.prepare(job("threads_ru", payload.clone()), &config));
    assert_eq!(failed.unwrap_err(), AdapterError::message_text("staging failed"));
    block_on(prepared.prepare(job("threads_ru", payload.clone()), &config)).unwrap();
    assert_eq!(calls.get(), 4, "the failed staging is not cached");

    // A job going back to finish a publication keeps its media as it is.
    let resumed = json!({"text": "t", "media": [{"type": "IMAGE", "localPath": "/a.jpg"}], "_xPublishedIds": ["1"]});
    let kept = block_on(prepared.prepare(job("x", resumed.clone()), &config)).unwrap();
    assert_eq!(Value::Object(kept.payload), resumed);
    assert_eq!(calls.get(), 4);
}

#[test]
fn a_story_takes_its_prepared_variant_or_refuses() {
    let calls = Rc::new(Cell::new(0));
    let variant: MediaItem =
        serde_json::from_value(json!({"type": "IMAGE", "localPath": "/story/a.jpg", "storyLocalPath": "/story/a.jpg"}))
            .unwrap();
    let payload =
        json!({"media": [{"type": "IMAGE", "localPath": "/a.jpg"}, {"type": "IMAGE", "localPath": "/b.jpg"}]});
    let config = Arc::new(config(&[]));
    let with_variant = PreparedMedia::new(Rc::new(CountingPreparation {
        calls: Rc::clone(&calls),
        fail_next: Rc::new(Cell::new(false)),
        story_variant: Some(variant),
    }));
    let story = block_on(with_variant.prepare(job("instagram_stories", payload.clone()), &config)).unwrap();
    let media = story.payload["media"].as_array().unwrap();
    assert_eq!(media.len(), 1, "a Story is one visual");
    assert_eq!(media[0]["localPath"], "/story/a.jpg");

    let without = PreparedMedia::new(Rc::new(CountingPreparation {
        calls,
        fail_next: Rc::new(Cell::new(false)),
        story_variant: None,
    }));
    let refused = block_on(without.prepare(job("telegram_stories", payload), &config)).unwrap_err();
    assert_eq!(
        refused.message(),
        "story_media_unprepared: no Story variant for /a.jpg -- run `ops story-media-backfill --apply`"
    );
}
