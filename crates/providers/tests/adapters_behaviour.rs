//! What the request goldens cannot record: the Story re-encode budget, how a
//! Story settles on the Stories client's answer, and the preparation cache of
//! the social ports.

use std::cell::{Cell, RefCell};
use std::path::Path;
use std::rc::Rc;
use std::sync::Arc;

use content::message::MediaItem;
use domain::application::ports::SystemClock;
use domain::publishing::queue::ClaimedPublishJob;
use foundation::config::{Config, load_config};
use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;
use providers::adapters::telegram_stories::{
    StoriesClient, StoryError, StoryRequest, StoryUploadMedia, StoryVideoMetadata, publish_telegram_story,
    story_reencode_args,
};
use providers::adapters::{AdapterContext, AdapterError, MediaPreparation, PrepareJob, PreparedMedia};
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

/// The Story publisher reaches no HTTP service.
struct NoNetwork;

impl Transport for NoNetwork {
    fn send(&self, _: HttpRequest) -> Fut<'_, Result<HttpResponse, TransportFailure>> {
        panic!("a Story reached for HTTP")
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

/// The Stories client as the publisher sees it: one canned answer.
struct FakeStories {
    answer: Result<i64, StoryError>,
    seen: RefCell<Option<StoryRequest>>,
}

impl StoriesClient for FakeStories {
    fn send_story<'a>(&'a self, request: &'a StoryRequest) -> Fut<'a, Result<i64, StoryError>> {
        *self.seen.borrow_mut() = Some(request.clone());
        let answer = self.answer.clone();
        Box::pin(async move { answer })
    }
}

#[test]
fn a_story_settles_as_the_stories_client_answers() {
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
        client: HttpClient::new(Rc::new(NoNetwork)),
        clock: Rc::new(SystemClock),
    };
    let payload: Map<String, Value> = serde_json::from_value(json!({
        "text": "Tap here",
        "entities": [{"type": "text_link", "offset": 4, "length": 4, "url": "https://example.com"}],
        "media": [{"type": "IMAGE", "localPath": photo}],
    }))
    .unwrap();
    let publish = |answer| {
        let stories = FakeStories {
            answer,
            seen: RefCell::new(None),
        };
        let outcome = block_on(publish_telegram_story(&ctx, &stories, &payload));
        (outcome, stories.seen.into_inner())
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

    let (outcome, _) = publish(Err(StoryError::Ambiguous("telegram_channel_story_timeout".into())));
    assert_eq!(
        outcome.unwrap_err(),
        AdapterError::Ambiguous {
            provider: "telegram_stories".into(),
            message: "verification_required: telegram_stories may have published before confirmation was lost: \
                      telegram_channel_story_timeout"
                .into(),
        }
    );
    let (outcome, _) = publish(Err(StoryError::Refused("PEER_ID_INVALID".into())));
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
    ) -> LocalBoxFuture<'static, providers::adapters::Result<Vec<MediaItem>>> {
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
    ) -> Fut<'a, providers::adapters::Result<Option<MediaItem>>> {
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
