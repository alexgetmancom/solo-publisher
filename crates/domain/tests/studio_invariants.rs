//! Studio rules that pinned real bugs: publication ownership (every
//! publication-scoped method refuses an actor outside the roster, and every
//! method is classified), the post edit lock (the lock is per language), draft
//! Story media (it is prepared when a draft goes to a Story, and only then) and
//! the channel service (a channel reports the breaker its credential tripped).
//! The persistence boundary — Studio writes no SQL of its own — is checked over
//! the source.

mod support;

use std::cell::{Cell, RefCell};
use std::future::Future;
use std::path::Path;
use std::pin::pin;
use std::task::{Context, Poll, Waker};

use content::Locale;
use content::message::DraftMessage;
use db::rusqlite::{Connection, params};
use db::{BackendDb, unsafe_db};
use domain::application::ports::{ApplicationPorts, NewThreadPart, StoryPublishMode};
use domain::publishing::Publishing;
use domain::publishing::boundaries::{
    AuthCircuit, AuthCircuitState, Boundaries, Jitter, MediaMetadata, MediaProbe, ProviderOutcome, StoryCardMedia,
    StoryCardState, StoryCards, UsageMeter, VideoCompletion, VideoProvider, WorkerBell,
};
use domain::publishing::video_types::VideoTarget;
use domain::studio::Studio;
use domain::studio::boundaries::{
    CapabilityReportEntry, ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform, Readiness, Reminder,
    Reminders, StoryDerivatives, StudioBoundaries, YoutubeUploads, ZernioAccount, ZernioDirectory,
};
use domain::studio::services::channels::ChannelStatus;
use domain::studio::services::create_studio_services;
use domain::studio::services::post_access::require_post_edit_allowed;
use domain::studio::services::posts::{DraftConfiguration, EditInput, PostScheduleInput, PostScheduleScope};
use domain::studio::video_fsm::VideoWizardStep;
use foundation::config::Config;
use jiff::Timestamp;
use serde_json::{Map, Value, json};
use support::FixedClock;

const OWNER: i64 = 42;
/// Not on the roster: one installation is one editorial boundary, so the
/// refusal this drives is for someone outside it.
const STRANGER: i64 = 7;

/// Records what the boundaries were asked; answers as an empty Studio would.
#[derive(Default)]
struct Recorder {
    calls: RefCell<Vec<String>>,
    circuits: Vec<AuthCircuitState>,
}

impl Jitter for Recorder {
    fn unit(&self) -> f64 {
        0.5
    }
}
impl WorkerBell for Recorder {
    fn ring_publish(&self) {}
    fn ring_publish_after(&self, _: u64) {}
}
impl AuthCircuit for Recorder {
    fn record_failure(&self, _: &Connection, _: &str) -> domain::Result<()> {
        Ok(())
    }
    fn record_success(&self, _: &Connection, _: &str) -> domain::Result<()> {
        Ok(())
    }
    fn states(&self, _: &Connection) -> domain::Result<Vec<AuthCircuitState>> {
        Ok(self.circuits.clone())
    }
}
impl UsageMeter for Recorder {
    fn record(&self, _: &Connection, _: &str, _: bool, _: u64) {}
}
impl VideoCompletion for Recorder {
    fn record_if_final(&self, _: &Connection, _: i64) -> domain::Result<()> {
        Ok(())
    }
}
impl StoryCards for Recorder {
    fn queue(&self, _: &Connection, _: i64) -> domain::Result<()> {
        Ok(())
    }
    fn for_draft(&self, _: &Connection, _: i64) -> domain::Result<Vec<StoryCardState>> {
        Ok(Vec::new())
    }
    fn ready_media(&self, _: &Connection, _: i64) -> domain::Result<Option<StoryCardMedia>> {
        Ok(None)
    }
    fn set_publish_mode(&self, _: &Connection, _: i64, _: StoryPublishMode) -> domain::Result<()> {
        Ok(())
    }
    fn discard(&self, _: &Connection, _: i64) -> domain::Result<()> {
        Ok(())
    }
}
impl Reminders for Recorder {
    fn schedule(&self, _: &Connection, _: &Reminder<'_>) -> domain::Result<()> {
        Ok(())
    }
    fn cancel(&self, _: &Connection, _: &str) -> domain::Result<()> {
        Ok(())
    }
}
impl StoryDerivatives for Recorder {
    fn ensure(&self, local_path: &str, video: bool, draft_id: i64) {
        self.calls
            .borrow_mut()
            .push(format!("story derivative {local_path} video={video} draft={draft_id}"));
    }
}
impl Readiness for Recorder {
    fn capability_report(&self, _: &Connection) -> domain::Result<Vec<CapabilityReportEntry>> {
        Ok(Vec::new())
    }
}
impl ChannelConnectLinks for Recorder {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        Err(domain::Error::message("not configured"))
    }
    fn start_connect(&self, _: &Config, _: ConnectPlatform, _: Locale, _: Timestamp) -> domain::Result<ConnectStart> {
        Err(domain::Error::message("not configured"))
    }
}
impl MediaProbe for Recorder {
    async fn probe(&self, _: &str) -> Result<MediaMetadata, String> {
        Err("no prober".into())
    }
    async fn audio_stats(&self, _: &str) -> Result<String, String> {
        Err("no prober".into())
    }
}
impl VideoProvider for Recorder {
    async fn post_outcome(&self, _: &str, _: &str) -> domain::Result<ProviderOutcome> {
        Err(domain::Error::message("no provider"))
    }
    async fn publish_instagram_reel(&self, _: &str, _: &str, _: &Value, _: &str) -> domain::Result<ProviderOutcome> {
        Err(domain::Error::message("no provider"))
    }
}
impl YoutubeUploads for Recorder {
    async fn keep_private(&self, _: &Config, _: &str, _: Locale) -> domain::Result<()> {
        Ok(())
    }
}
impl ZernioDirectory for Recorder {
    async fn accounts(&self, _: &Config) -> domain::Result<Vec<ZernioAccount>> {
        Ok(Vec::new())
    }
}

fn ready<T>(future: impl Future<Output = T>) -> T {
    match pin!(future).poll(&mut Context::from_waker(Waker::noop())) {
        Poll::Ready(value) => value,
        Poll::Pending => panic!("a fake boundary never waits"),
    }
}

struct Fixture {
    db: BackendDb,
    clock: FixedClock,
    config: Config,
    recorder: Recorder,
}

impl Fixture {
    fn new(channels: &[(&str, &str, &str, Option<&str>)]) -> Self {
        let db = BackendDb::open(":memory:").unwrap();
        for (id, platform, locale, target) in channels {
            unsafe_db(&db)
                .execute(
                    r#"insert into "channel_connections" ("id", "platform", "locale", "provider", "provider_account_id", "target_id", "label", "enabled", "source", "created_at", "updated_at") values (?, ?, ?, 'native', null, ?, ?, 1, 'test', '2026-03-01T10:00:00.000Z', '2026-03-01T10:00:00.000Z')"#,
                    params![id, platform, locale, target, id],
                )
                .unwrap();
        }
        let clock = FixedClock(Cell::new(
            foundation::time::parse_iso_instant("2026-03-01T10:00:00.000Z").unwrap(),
        ));
        let config = foundation::config::load_config([("CONTROLLER_ADMIN_IDS", "42")]).unwrap();
        Self {
            db,
            clock,
            config,
            recorder: Recorder::default(),
        }
    }

    fn studio(&self) -> Studio<'_> {
        let recorder = &self.recorder;
        Studio::new(
            Publishing::new(
                unsafe_db(&self.db),
                &self.clock,
                Boundaries {
                    jitter: recorder,
                    bell: recorder,
                    auth_circuit: recorder,
                    usage: recorder,
                    story_cards: recorder,
                    video_completion: recorder,
                },
            ),
            &self.config,
            StudioBoundaries {
                reminders: recorder,
                story_derivatives: recorder,
                readiness: recorder,
                connect_links: recorder,
            },
        )
    }

    fn sqlite(&self) -> &Connection {
        unsafe_db(&self.db)
    }
}

const TEXT_CHANNELS: [(&str, &str, &str, Option<&str>); 3] = [
    ("telegram", "telegram", "ru", Some("telegram")),
    ("threads_en", "threads_en", "en", Some("threads_en")),
    (
        "instagram_stories_ru",
        "instagram_stories_ru",
        "ru",
        Some("instagram_stories_ru"),
    ),
];

fn text(value: &str) -> DraftMessage {
    DraftMessage {
        text: value.into(),
        ..DraftMessage::default()
    }
}

/// Every answer a method gives to a stranger, by method name.
fn answers(calls: Vec<(&'static str, domain::Result<()>)>) -> Vec<(&'static str, String)> {
    calls
        .into_iter()
        .map(|(name, result)| {
            (
                name,
                match result {
                    Ok(()) => "returned".to_owned(),
                    Err(error) => error.to_string(),
                },
            )
        })
        .collect()
}

fn drop_ok<T>(result: domain::Result<T>) -> domain::Result<()> {
    result.map(drop)
}

/// The public methods of one service `impl`, minus those that take no
/// publication.
fn publication_scoped(file: &str, impl_header: &str, actor_scoped: &[&str]) -> Vec<String> {
    let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join(file)).unwrap();
    let start = source
        .find(impl_header)
        .unwrap_or_else(|| panic!("{impl_header} in {file}"));
    let body = &source[start..];
    let body = &body[..body.find("\n}\n").unwrap()];
    body.lines()
        .filter_map(|line| {
            let line = line.trim_start();
            let rest = line
                .strip_prefix("pub fn ")
                .or_else(|| line.strip_prefix("pub async fn "))?;
            Some(rest[..rest.find(['(', '<']).unwrap()].to_owned())
        })
        .filter(|name| !actor_scoped.contains(&name.as_str()))
        .collect()
}

/// `kind`, `capabilities` and `new` are labels and construction, not
/// capabilities; the replans are the Story-card worker's, keyed by draft alone.
const POST_ACTOR_SCOPED: [&str; 10] = [
    "new",
    "kind",
    "capabilities",
    "create",
    "list",
    "media_assets",
    "slot_time",
    "publish_article",
    "replan_scheduled_post_after_story_cards",
    "replan_scheduled_post_after_story_card_failure",
];
const VIDEO_ACTOR_SCOPED: [&str; 9] = [
    "new",
    "kind",
    "capabilities",
    "create",
    "list",
    "slot_time",
    "immediate_time",
    "is_immediate",
    "asset_technical_check",
];

#[test]
fn every_post_capability_that_takes_a_draft_refuses_a_stranger() {
    let fixture = Fixture::new(&TEXT_CHANNELS);
    let services = create_studio_services(fixture.studio(), &fixture.recorder);
    let posts = services.posts;
    let draft = posts.create(OWNER, &text("Черновик"), None).unwrap();
    let part = NewThreadPart {
        text_ru: "Часть".into(),
        ..NewThreadPart::default()
    };
    let at = fixture.clock.0.get();
    let edit = EditInput {
        locale: Locale::Ru,
        text: "Текст".into(),
        entities: Vec::new(),
        media: Vec::new(),
        replace_media_only: false,
        clear_media: false,
    };
    let s = STRANGER;
    let calls = answers(vec![
        ("get", drop_ok(posts.get(s, draft))),
        ("validate", drop_ok(posts.validate(s, draft))),
        ("preview", drop_ok(posts.preview(s, draft))),
        ("progress", drop_ok(posts.progress(s, draft))),
        ("history", drop_ok(posts.history(s, draft, None))),
        (
            "attach_media_assets",
            posts.attach_media_assets(s, draft, Locale::Ru, &[], false),
        ),
        ("remove_media", posts.remove_media(s, draft, Locale::Ru, &[])),
        (
            "schedule",
            drop_ok(posts.schedule(s, draft, &PostScheduleInput::default())),
        ),
        (
            "has_locale_targets",
            drop_ok(posts.has_locale_targets(s, draft, Locale::Ru)),
        ),
        (
            "manual_schedule",
            drop_ok(posts.manual_schedule(s, draft, PostScheduleScope::Both, "12:00")),
        ),
        (
            "schedule_at",
            drop_ok(posts.schedule_at(s, draft, PostScheduleScope::Both, at)),
        ),
        ("cancel", posts.cancel(s, draft)),
        ("delivery_plan", drop_ok(posts.delivery_plan(s, draft))),
        ("pending_targets", drop_ok(posts.pending_targets(s, draft))),
        ("cancel_remaining", drop_ok(posts.cancel_remaining(s, draft))),
        (
            "set_story_publish_mode",
            posts.set_story_publish_mode(s, draft, StoryPublishMode::All),
        ),
        (
            "replace_entity_candidates",
            posts.replace_entity_candidates(s, draft, &[]),
        ),
        ("accept_entity_candidates", posts.accept_entity_candidates(s, draft)),
        ("make_thread", posts.make_thread(s, draft)),
        ("append_thread_part", drop_ok(posts.append_thread_part(s, draft, &part))),
        ("edit_thread_part", posts.edit_thread_part(s, draft, 2, &part)),
        (
            "edit_thread_part_english",
            posts.edit_thread_part_english(s, draft, 2, "Part"),
        ),
        ("remove_thread_part", posts.remove_thread_part(s, draft, 2)),
        ("publish", drop_ok(posts.publish(s, draft))),
        ("retry_target", drop_ok(posts.retry_target(s, draft, None))),
        ("resendable_targets", drop_ok(posts.resendable_targets(s, draft))),
        ("resend_target", drop_ok(posts.resend_target(s, draft, "telegram"))),
        ("skip_target", drop_ok(posts.skip_target(s, draft, None))),
        ("toggle_target", posts.toggle_target(s, draft, "telegram")),
        ("remove_target", posts.remove_target(s, draft, "telegram")),
        ("cycle_mode", drop_ok(posts.cycle_mode(s, draft))),
        ("edit", posts.edit(s, draft, &edit)),
    ]);
    // Every one of them names ownership. A method that got as far as
    // complaining about an argument never checked.
    for (name, answer) in &calls {
        assert_eq!((name, answer.as_str()), (name, "err.post-not-yours"));
    }
    let mut swept: Vec<&str> = calls.iter().map(|(name, _)| *name).collect();
    let mut declared = publication_scoped(
        "src/studio/services/posts.rs",
        "impl<'a> PostService<'a> {",
        &POST_ACTOR_SCOPED,
    );
    swept.sort_unstable();
    declared.sort_unstable();
    assert_eq!(swept, declared, "every publication-scoped post method is swept");
}

#[test]
fn every_video_capability_that_takes_a_draft_refuses_a_stranger() {
    let fixture = Fixture::new(&TEXT_CHANNELS);
    fixture
        .sqlite()
        .execute(
            r#"insert into "studio_media_assets" ("id", "actor_id", "kind", "mime_type", "filename", "local_path", "byte_size", "sha256", "source", "created_at") values (1, 42, 'video', 'video/mp4', 'owned.mp4', '/tmp/owned.mp4', 10, 'aa', 'ops_upload', '2026-03-01T10:00:00.000Z')"#,
            [],
        )
        .unwrap();
    let services = create_studio_services(fixture.studio(), &fixture.recorder);
    let videos = services.videos;
    let draft = videos.create(OWNER, 1, None).unwrap();
    let (s, shorts, empty) = (STRANGER, VideoTarget::YoutubeShorts, Map::new());
    let calls = answers(vec![
        ("get", drop_ok(videos.get(s, draft))),
        ("replace_source", drop_ok(ready(videos.replace_source(s, draft, 1)))),
        ("source_replaceable", drop_ok(videos.source_replaceable(s, draft))),
        (
            "metadata_editable_targets",
            drop_ok(videos.metadata_editable_targets(s, draft)),
        ),
        ("schedule", drop_ok(ready(videos.schedule(s, draft, &[])))),
        ("validate", drop_ok(ready(videos.validate(s, draft)))),
        ("technical_check", drop_ok(ready(videos.technical_check(s, draft)))),
        ("publish", drop_ok(ready(videos.publish(s, draft)))),
        ("settle_target", drop_ok(ready(videos.settle_target(s, draft, shorts)))),
        ("retry_target", drop_ok(ready(videos.retry_target(s, draft, shorts)))),
        ("cancel", drop_ok(ready(videos.cancel(s, draft)))),
        ("preview", drop_ok(videos.preview(s, draft))),
        ("status", drop_ok(videos.status(s, draft))),
        ("history", drop_ok(videos.history(s, draft, None))),
        ("update_metadata", videos.update_metadata(s, draft, shorts, &empty)),
        (
            "edit_metadata_field",
            videos.edit_metadata_field(s, draft, VideoWizardStep::YoutubeTitle, &json!("T")),
        ),
        (
            "complete_wizard_target",
            videos.complete_wizard_target(s, draft, shorts, &empty, &[shorts]),
        ),
        ("rename", videos.rename(s, draft, "Name")),
        ("set_script", videos.set_script(s, draft, "Script")),
        ("replace_targets", videos.replace_targets(s, draft, &[shorts])),
        ("remove_target", drop_ok(videos.remove_target(s, draft, shorts))),
        ("toggle_target", videos.toggle_target(s, draft, "youtube_shorts")),
        ("manual_schedule", drop_ok(videos.manual_schedule(s, draft, "12:00"))),
    ]);
    for (name, answer) in &calls {
        assert_eq!((name, answer.as_str()), (name, "err.video-not-yours"));
    }
    let mut swept: Vec<&str> = calls.iter().map(|(name, _)| *name).collect();
    let mut declared = publication_scoped(
        "src/studio/services/videos.rs",
        "impl<'a, A: MediaProbe + VideoProvider + YoutubeUploads> VideoService<'a, A> {",
        &VIDEO_ACTOR_SCOPED,
    );
    swept.sort_unstable();
    declared.sort_unstable();
    assert_eq!(swept, declared, "every publication-scoped video method is swept");
}

/// The language due soon is locked; the other keeps its edits.
#[test]
fn the_edit_lock_holds_only_the_locale_that_is_due() {
    let fixture = Fixture::new(&TEXT_CHANNELS);
    let posts = create_studio_services(fixture.studio(), &fixture.recorder).posts;
    let draft = posts.create(OWNER, &text("RU text"), None).unwrap();
    fixture
        .sqlite()
        .execute(
            r#"update "drafts" set "status" = 'scheduled', "scheduled_at" = '2026-03-01T10:01:00.000Z', "scheduled_en_at" = '2026-03-01T10:10:00.000Z' where "id" = ?"#,
            [draft],
        )
        .unwrap();
    let ports = ApplicationPorts::new(&fixture.db, &fixture.clock);
    let now = fixture.clock.0.get();
    let lock = |locale| {
        require_post_edit_allowed(ports, &fixture.config, OWNER, draft, now, locale)
            .map(|draft| draft.id)
            .map_err(|error| error.to_string())
    };
    assert_eq!(lock(Some(Locale::Ru)), Err("err.post-too-close-to-publish".into()));
    assert_eq!(lock(Some(Locale::En)), Ok(draft));
    assert_eq!(lock(None), Err("err.post-too-close-to-publish".into()));
}

/// The Story target goes on after the draft exists, which is when its media
/// needs its 9:16 shapes; a draft that goes to no Story costs no encode.
#[test]
fn story_media_is_prepared_when_a_draft_goes_to_a_story_and_only_then() {
    let fixture = Fixture::new(&TEXT_CHANNELS);
    let posts = create_studio_services(fixture.studio(), &fixture.recorder).posts;
    let mut photo = Map::new();
    photo.insert("type".into(), json!("photo"));
    photo.insert("local_path".into(), json!("/media/source.jpg"));
    let mut video = Map::new();
    video.insert("type".into(), json!("VIDEO"));
    video.insert("localPath".into(), json!("/media/clip.mp4"));
    let message = DraftMessage {
        text: "текст".into(),
        media: vec![photo, video, Map::new()],
        ..DraftMessage::default()
    };
    let only_telegram = DraftConfiguration {
        targets: vec!["telegram".into()],
        story_mode: None,
    };
    let draft = posts.create(1, &message, Some(&only_telegram)).unwrap();
    assert!(fixture.recorder.calls.borrow().is_empty());
    posts.toggle_target(1, draft, "instagram_stories_ru").unwrap();
    assert_eq!(
        *fixture.recorder.calls.borrow(),
        [
            format!("story derivative /media/source.jpg video=false draft={draft}"),
            format!("story derivative /media/clip.mp4 video=true draft={draft}"),
        ]
    );
}

/// The breaker is read on the publish path and nowhere else, so a target
/// whose credential is failing stops publishing while its channel still
/// reports `ready`; the report says so beside it.
#[test]
fn a_channel_reports_the_credential_breaker_beside_its_readiness() {
    let mut fixture = Fixture::new(&[]);
    fixture.recorder.circuits = vec![AuthCircuitState {
        target: "telegram_stories".into(),
        blocked: true,
        blocked_until: Some("2026-03-01T11:00:00.000Z".into()),
        auth_failure_streak: 3,
        last_auth_failure_at: Some("2026-03-01T09:59:00.000Z".into()),
        last_ping_at: Some("2026-03-01T09:00:00.000Z".into()),
        token_expires_at: None,
    }];
    let channels = create_studio_services(fixture.studio(), &fixture.recorder).channels;
    channels
        .connect_target("telegram_stories", None, None, None, None)
        .unwrap();
    let report = channels.report(false).unwrap();
    assert_eq!(report.len(), 1);
    assert_eq!(report[0].status, ChannelStatus::Ready);
    assert!(report[0].credential.blocked);
    assert_eq!(report[0].credential.auth_failure_streak, 3);
    assert_eq!(
        serde_json::to_value(&report[0].credential).unwrap(),
        json!({
            "blocked": true, "blockedUntil": "2026-03-01T11:00:00.000Z", "authFailureStreak": 3,
            "lastAuthFailureAt": "2026-03-01T09:59:00.000Z", "tokenExpiresAt": null,
        })
    );
    channels.disable("telegram_stories").unwrap();
    assert!(channels.report(true).unwrap().is_empty());
    assert_eq!(channels.report(false).unwrap()[0].status, ChannelStatus::Disabled);
}

/// Studio goes through the persistence ports; its exception set is empty.
#[test]
fn studio_writes_no_sql_of_its_own() {
    let root = Path::new(env!("CARGO_MANIFEST_DIR")).join("src/studio");
    let mut offenders = Vec::new();
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(dir).unwrap() {
            let path = entry.unwrap().path();
            if path.is_dir() {
                pending.push(path);
                continue;
            }
            let source = std::fs::read_to_string(&path).unwrap();
            for needle in [".execute(", ".prepare(", ".query_row(", "execute_batch(", "unsafe_db("] {
                if source.contains(needle) {
                    offenders.push(format!("{} uses {needle}", path.display()));
                }
            }
        }
    }
    assert!(offenders.is_empty(), "{offenders:#?}");
}
