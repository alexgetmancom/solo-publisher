//! Studio service equivalence with the recorded goldens: every scenario in
//! `studio_scenarios.json` drove the TypeScript backend's Studio services
//! before the cutover (`studio_scenarios.golden.json`) and drives
//! `domain::studio::services`, each on its own fresh database under the same
//! fixed clock, and every step's result and every table's rows must come out
//! identical.
//!
//! Reminders and Story cards run on their real stores (`domain::notifications`,
//! `domain::story_cards`). The other boundaries Studio does not own are faked
//! here with the recorded rule for exactly the states the scenarios reach, so
//! what they write is compared too: the readiness report over the spec's
//! configuration, the connection links of an unconfigured Studio, the Zernio
//! account list the spec serves, and the prober answering what ffprobe reported
//! in the recording for the same clip.

mod support;

use std::cell::Cell;
use std::path::{Path, PathBuf};

use content::Locale;
use content::message::DraftMessage;
use db::rusqlite::Connection;
use db::{BackendDb, unsafe_db};
use domain::application::conversation_flow::{accept_flow, back_flow};
use domain::application::ports::{ApplicationPorts, FixedClock};
use domain::notifications::ReminderJobs;
use domain::publishing::Publishing;
use domain::publishing::article_publish::PublishArticleInput;
use domain::publishing::boundaries::{Boundaries, MediaMetadata, MediaProbe, NoWorker, ProviderOutcome, VideoProvider};
use domain::publishing::platform_profiles::platform_profile;
use domain::publishing::video_types::VideoTarget;
use domain::story_cards::StoryCardStore;
use domain::studio::Studio;
use domain::studio::boundaries::{
    CapabilityReportEntry, CapabilityStatus, ChannelConnectLinks, ConnectPlatform, ConnectStart, MetaOauthPlatform,
    Readiness, StudioBoundaries, YoutubeUploads, ZernioAccount, ZernioDirectory,
};
use domain::studio::config::studio_config;
use domain::studio::services::create_studio_services;
use domain::studio::services::media::{ImportedMedia, ImportedMediaFile, MediaSource};
use domain::studio::services::posts::PostScheduleScope;
use domain::studio::video_fsm::{
    VIDEO_FLOW, VideoWizardStep, advance_video_metadata, first_video_metadata_step, is_video_wizard_step,
    video_schedule_dates,
};
use foundation::config::Config;
use jiff::Timestamp;
use serde::Deserialize;
use serde_json::{Map, Value, json};
use support::{FixedJitter, Inert, arg, differences, dump, instant, out, ready, resolve};

fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/studio_scenarios.json")
}

fn base_dir() -> PathBuf {
    support::repo_root().join("_trash-rust/tmp/studio-scenarios")
}

/// `capabilityReport` over the registry for the spec's configuration.
struct Report<'a> {
    env: &'a Map<String, Value>,
    zernio: bool,
    config: &'a Config,
}

impl Readiness for Report<'_> {
    fn capability_report(&self, sqlite: &Connection) -> domain::Result<Vec<CapabilityReportEntry>> {
        let mut requirements: Vec<(String, Vec<String>)> = Vec::new();
        let mut set =
            |target: String, required: Vec<String>| match requirements.iter_mut().find(|(key, _)| *key == target) {
                Some(entry) => entry.1 = required,
                None => requirements.push((target, required)),
            };
        if self.config.controller_bot_token.is_some() || !self.config.controller_admin_ids.is_empty() {
            set(
                "controller_bot".into(),
                vec!["CONTROLLER_BOT_TOKEN".into(), "CONTROLLER_ADMIN_IDS".into()],
            );
        }
        let names = |names: &[&str]| names.iter().map(|name| (*name).to_owned()).collect::<Vec<_>>();
        for channel in domain::channels::list_channels(sqlite, true)? {
            let channel = channel.connection;
            if let Some(target) = channel.target_id {
                let required = if channel.provider == "zernio" {
                    names(&["ZERNIO_API_KEY"])
                } else {
                    platform_profile(&target)
                        .map(|profile| names(profile.requirements))
                        .unwrap_or_default()
                };
                set(target, required);
            } else if channel.platform == "youtube" || channel.platform == "instagram" {
                let suffix = if channel.locale == "en" { "EN" } else { "RU" };
                let required = if channel.provider == "zernio" {
                    names(&["ZERNIO_API_KEY"])
                } else if channel.platform == "youtube" {
                    ["CLIENT_ID", "CLIENT_SECRET", "REFRESH_TOKEN"]
                        .map(|name| format!("YOUTUBE_{suffix}_{name}"))
                        .to_vec()
                } else {
                    ["ACCESS_TOKEN", "USER_ID"]
                        .map(|name| format!("INSTAGRAM_{suffix}_{name}"))
                        .to_vec()
                };
                set(channel.id, required);
            }
        }
        Ok(requirements
            .into_iter()
            .map(|(target, required)| {
                let missing: Vec<String> = required
                    .iter()
                    .filter(|name| match name.as_str() {
                        "CONTROLLER_ADMIN_IDS" => self.config.controller_admin_ids.is_empty(),
                        "ZERNIO_API_KEY" => !self.zernio,
                        other => self.env.get(other).and_then(Value::as_str).is_none_or(str::is_empty),
                    })
                    .cloned()
                    .collect();
                CapabilityReportEntry {
                    status: if missing.is_empty() {
                        CapabilityStatus::Ready
                    } else {
                        CapabilityStatus::Missing
                    },
                    target,
                    required,
                    missing,
                }
            })
            .collect())
    }
}

/// A Studio with no OAuth app configured.
struct Unconfigured;

impl ChannelConnectLinks for Unconfigured {
    fn meta_oauth_connect_url(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        Err(domain::Error::message("Meta OAuth is not configured"))
    }
    fn meta_oauth_connect_path(&self, _: &Config, _: MetaOauthPlatform, _: Locale) -> domain::Result<String> {
        Err(domain::Error::message("Meta OAuth is not configured"))
    }
    fn x_oauth_connect_url(&self, _: &Config) -> domain::Result<String> {
        Err(domain::Error::message("X OAuth is not configured"))
    }
    fn x_oauth_connect_path(&self, _: &Config) -> domain::Result<String> {
        Err(domain::Error::message("X OAuth is not configured"))
    }
    fn start_connect(
        &self,
        _: &Config,
        platform: ConnectPlatform,
        _: Locale,
        _: Timestamp,
    ) -> domain::Result<ConnectStart> {
        assert_eq!(platform, ConnectPlatform::X, "the scenarios start only an X connection");
        Err(domain::Error::message(
            "X is not configured: X_CLIENT_ID, X_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY",
        ))
    }
}

/// The outside world: ffprobe's answer for the clip, the spec's Zernio
/// accounts, and nothing else.
struct World {
    probe: MediaMetadata,
    accounts: Vec<ZernioAccount>,
}

impl MediaProbe for World {
    async fn probe(&self, path: &str) -> Result<MediaMetadata, String> {
        assert!(path.ends_with("clip.mp4"), "only the clip is probed, not {path}");
        Ok(self.probe.clone())
    }
    async fn audio_stats(&self, _: &str) -> Result<String, String> {
        panic!("the clip has no audio")
    }
}

impl VideoProvider for World {
    async fn post_outcome(&self, _: &str, _: &str) -> domain::Result<ProviderOutcome> {
        panic!("the scenarios never reach a provider")
    }
    async fn publish_instagram_reel(&self, _: &str, _: &str, _: &Value, _: &str) -> domain::Result<ProviderOutcome> {
        panic!("the scenarios never reach a provider")
    }
}

impl YoutubeUploads for World {
    async fn keep_private(&self, _: &Config, _: &str, _: Locale) -> domain::Result<()> {
        panic!("no scenario holds a YouTube upload")
    }
}

impl ZernioDirectory for World {
    async fn accounts(&self, config: &Config) -> domain::Result<Vec<ZernioAccount>> {
        if config.zernio_api_key.is_none() {
            return Err(domain::Error::message("ZERNIO_API_KEY is missing"));
        }
        Ok(self.accounts.clone())
    }
}

fn locale(value: &str) -> Locale {
    match value {
        "ru" => Locale::Ru,
        "en" => Locale::En,
        other => panic!("locale {other}"),
    }
}

fn timestamp(value: &str) -> Timestamp {
    foundation::time::parse_iso_instant(value).unwrap()
}

fn iso(at: Timestamp) -> Value {
    json!(foundation::time::to_iso_string(at))
}

fn video_target(value: &str) -> VideoTarget {
    VideoTarget::parse(value).unwrap_or_else(|| panic!("video target {value}"))
}

fn message(value: &Value) -> DraftMessage {
    let records =
        |key: &str| -> Vec<Map<String, Value>> { serde_json::from_value(value[key].clone()).unwrap_or_default() };
    DraftMessage {
        text: value["text"].as_str().unwrap().into(),
        text_en: value["textEn"].as_str().map(str::to_owned),
        text_en_approved: value["textEnApproved"].as_str().map(str::to_owned),
        media: records("media"),
        entities: records("entities"),
    }
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ScheduleArgs {
    ru_at: Option<String>,
    en_at: Option<String>,
    #[serde(default)]
    allow_past: bool,
    immediate_locale: Option<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ImportArgs {
    filename: String,
    content_type: String,
    #[serde(default)]
    base64: String,
    #[serde(default)]
    local_path: String,
    source: MediaSource,
}

fn decode_base64(text: &str) -> Vec<u8> {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = Vec::new();
    let (mut buffer, mut bits) = (0u32, 0);
    for byte in text.bytes().filter(|byte| *byte != b'=') {
        buffer = (buffer << 6) | ALPHABET.iter().position(|c| *c == byte).expect("base64") as u32;
        bits += 6;
        if bits >= 8 {
            bits -= 8;
            out.push((buffer >> bits) as u8);
        }
    }
    out
}

fn scope(value: &str) -> PostScheduleScope {
    serde_json::from_value(json!(value)).unwrap()
}

fn call(studio: Studio<'_>, world: &World, name: &str, args: &[Value]) -> domain::Result<Value> {
    let services = create_studio_services(studio, world);
    let (posts, videos, queue, settings, channels, media) = (
        services.posts,
        services.videos,
        services.queue,
        services.settings,
        services.channels,
        services.media,
    );
    let int = |index| arg::<i64>(args, index);
    let text = |index| arg::<String>(args, index);
    let optional_int = |index| arg::<Option<i64>>(args, index);
    let optional_text = |index| arg::<Option<String>>(args, index);
    Ok(match name {
        "posts.create" => out(posts.create(int(0), &message(&args[1]), arg::<Option<_>>(args, 2).as_ref())?),
        "posts.get" => out(posts.get(int(0), int(1))?),
        "posts.list" => out(posts.list(int(0), optional_int(1))?),
        "posts.validate" => out(posts.validate(int(0), int(1))?),
        "posts.preview" => out(posts.preview(int(0), int(1))?),
        "posts.progress" => out(posts.progress(int(0), int(1))?),
        "posts.history" => out(posts.history(int(0), int(1), optional_int(2))?),
        "posts.mediaAssets" => out(posts.media_assets(int(0), optional_int(1))?),
        "posts.attachMediaAssets" => {
            posts.attach_media_assets(
                int(0),
                int(1),
                locale(&text(2)),
                &arg::<Vec<i64>>(args, 3),
                arg(args, 4),
            )?;
            Value::Null
        }
        "posts.removeMedia" => {
            posts.remove_media(int(0), int(1), locale(&text(2)), &arg::<Vec<i64>>(args, 3))?;
            Value::Null
        }
        "posts.schedule" => {
            let input: ScheduleArgs = arg(args, 2);
            out(posts.schedule(
                int(0),
                int(1),
                &domain::studio::services::posts::PostScheduleInput {
                    ru_at: input.ru_at.as_deref().map(timestamp),
                    en_at: input.en_at.as_deref().map(timestamp),
                    allow_past: input.allow_past,
                    immediate_locale: input.immediate_locale.as_deref().map(locale),
                },
            )?)
        }
        "posts.hasLocaleTargets" => out(posts.has_locale_targets(int(0), int(1), locale(&text(2)))?),
        "posts.slotTime" => iso(posts.slot_time(int(0), &text(1))?),
        "posts.manualSchedule" => out(posts.manual_schedule(int(0), int(1), scope(&text(2)), &text(3))?),
        "posts.scheduleAt" => out(posts.schedule_at(int(0), int(1), scope(&text(2)), timestamp(&text(3)))?),
        "posts.cancel" => {
            posts.cancel(int(0), int(1))?;
            Value::Null
        }
        "posts.deliveryPlan" => out(posts.delivery_plan(int(0), int(1))?),
        "posts.pendingTargets" => out(posts.pending_targets(int(0), int(1))?),
        "posts.cancelRemaining" => out(posts.cancel_remaining(int(0), int(1))?),
        "posts.setStoryPublishMode" => {
            posts.set_story_publish_mode(int(0), int(1), arg(args, 2))?;
            Value::Null
        }
        "posts.replaceEntityCandidates" => {
            posts.replace_entity_candidates(int(0), int(1), &arg::<Vec<_>>(args, 2))?;
            Value::Null
        }
        "posts.acceptEntityCandidates" => {
            posts.accept_entity_candidates(int(0), int(1))?;
            Value::Null
        }
        "posts.makeThread" => {
            posts.make_thread(int(0), int(1))?;
            Value::Null
        }
        "posts.appendThreadPart" => out(posts.append_thread_part(int(0), int(1), &arg(args, 2))?),
        "posts.editThreadPart" => {
            posts.edit_thread_part(int(0), int(1), int(2), &arg(args, 3))?;
            Value::Null
        }
        "posts.editThreadPartEnglish" => {
            posts.edit_thread_part_english(int(0), int(1), int(2), &text(3))?;
            Value::Null
        }
        "posts.removeThreadPart" => {
            posts.remove_thread_part(int(0), int(1), int(2))?;
            Value::Null
        }
        "posts.publishArticle" => {
            let input: Map<String, Value> = arg(args, 1);
            let targets: Vec<String> = serde_json::from_value(input["targets"].clone()).unwrap();
            let targets: Vec<&str> = targets.iter().map(String::as_str).collect();
            let published = posts.publish_article(
                int(0),
                &PublishArticleInput {
                    locale: locale(input["locale"].as_str().unwrap()),
                    targets: &targets,
                    markdown: input["markdown"].as_str().unwrap(),
                },
            )?;
            json!({
                "ok": true, "article_id": published.article_id, "ref": published.publication_ref,
                "title": published.title, "targets": published.targets, "queued": true,
            })
        }
        "posts.publish" => out(posts.publish(int(0), int(1))?),
        "posts.retryTarget" => out(posts.retry_target(int(0), int(1), optional_text(2).as_deref())?),
        "posts.resendableTargets" => out(posts.resendable_targets(int(0), int(1))?),
        "posts.resendTarget" => out(posts.resend_target(int(0), int(1), &text(2))?),
        "posts.skipTarget" => out(posts.skip_target(int(0), int(1), optional_text(2).as_deref())?),
        "posts.toggleTarget" => {
            posts.toggle_target(int(0), int(1), &text(2))?;
            Value::Null
        }
        "posts.removeTarget" => {
            posts.remove_target(int(0), int(1), &text(2))?;
            Value::Null
        }
        "posts.cycleMode" => out(posts.cycle_mode(int(0), int(1))?),
        "posts.edit" => {
            posts.edit(int(0), int(1), &arg(args, 2))?;
            Value::Null
        }
        "posts.replanAfterStoryCards" => out(posts.replan_scheduled_post_after_story_cards(int(0))?),
        "posts.replanAfterStoryCardFailure" => out(posts.replan_scheduled_post_after_story_card_failure(int(0))?),
        "videos.create" => out(videos.create(int(0), int(1), optional_text(2).as_deref().map(locale))?),
        "videos.get" => out(videos.get(int(0), int(1))?),
        "videos.replaceSource" => out(ready(videos.replace_source(int(0), int(1), int(2)))?),
        "videos.assetTechnicalCheck" => out(ready(videos.asset_technical_check(int(0), int(1)))?),
        "videos.sourceReplaceable" => out(videos.source_replaceable(int(0), int(1))?),
        "videos.metadataEditableTargets" => out(videos.metadata_editable_targets(int(0), int(1))?),
        "videos.list" => out(videos.list(int(0), optional_int(1))?),
        "videos.schedule" => {
            let schedule: Map<String, Value> = arg(args, 2);
            let schedule: Vec<(VideoTarget, Timestamp)> = schedule
                .iter()
                .map(|(target, at)| (video_target(target), timestamp(at.as_str().unwrap())))
                .collect();
            out(ready(videos.schedule(int(0), int(1), &schedule))?)
        }
        "videos.validate" => out(ready(videos.validate(int(0), int(1)))?),
        "videos.technicalCheck" => out(ready(videos.technical_check(int(0), int(1)))?),
        "videos.publish" => out(ready(videos.publish(int(0), int(1)))?),
        "videos.settleTarget" => out(ready(videos.settle_target(int(0), int(1), video_target(&text(2))))?),
        "videos.retryTarget" => out(ready(videos.retry_target(int(0), int(1), video_target(&text(2))))?),
        "videos.cancel" => out(ready(videos.cancel(int(0), int(1)))?),
        "videos.preview" => out(videos.preview(int(0), int(1))?),
        "videos.status" => out(videos.status(int(0), int(1))?),
        "videos.history" => out(videos.history(int(0), int(1), optional_int(2))?),
        "videos.updateMetadata" => {
            videos.update_metadata(int(0), int(1), video_target(&text(2)), &arg(args, 3))?;
            Value::Null
        }
        "videos.editMetadataField" => {
            let field = VideoWizardStep::parse(&text(2)).unwrap();
            videos.edit_metadata_field(int(0), int(1), field, &args[3])?;
            Value::Null
        }
        "videos.completeWizardTarget" => {
            let selected: Vec<String> = arg(args, 4);
            let selected: Vec<VideoTarget> = selected.iter().map(|target| video_target(target)).collect();
            videos.complete_wizard_target(int(0), int(1), video_target(&text(2)), &arg(args, 3), &selected)?;
            Value::Null
        }
        "videos.rename" => {
            videos.rename(int(0), int(1), &text(2))?;
            Value::Null
        }
        "videos.setScript" => {
            videos.set_script(int(0), int(1), &text(2))?;
            Value::Null
        }
        "videos.replaceTargets" => {
            let targets: Vec<String> = arg(args, 2);
            videos.replace_targets(
                int(0),
                int(1),
                &targets.iter().map(|target| video_target(target)).collect::<Vec<_>>(),
            )?;
            Value::Null
        }
        "videos.removeTarget" => out(videos.remove_target(int(0), int(1), video_target(&text(2)))?),
        "videos.toggleTarget" => {
            videos.toggle_target(int(0), int(1), &text(2))?;
            Value::Null
        }
        "videos.manualSchedule" => iso(videos.manual_schedule(int(0), int(1), &text(2))?),
        "videos.immediateTime" => iso(videos.immediate_time()),
        "videos.isImmediate" => out(videos.is_immediate(timestamp(&text(0)))),
        "videos.slotTime" => iso(videos.slot_time(int(0), &text(1))?),
        "fsm.accept" => match accept_flow(&VIDEO_FLOW, &text(0), args[1].clone(), arg(args, 2))? {
            Some(transition) => json!({ "data": transition.data, "next": transition.next }),
            None => Value::Null,
        },
        "fsm.back" => out(back_flow(&VIDEO_FLOW, &text(0), &arg(args, 1))),
        "fsm.firstMetadataStep" => {
            let selected: Vec<String> = arg(args, 0);
            let selected: Vec<VideoTarget> = selected.iter().map(|target| video_target(target)).collect();
            out(first_video_metadata_step(&selected).as_str())
        }
        "fsm.isWizardStep" => out(is_video_wizard_step(&text(0))),
        "fsm.advanceMetadata" => out(advance_video_metadata(
            VideoWizardStep::parse(&text(0)).unwrap(),
            &text(1),
            arg(args, 2),
        )?),
        "fsm.scheduleDates" => Value::Object(
            video_schedule_dates(&arg(args, 0))?
                .into_iter()
                .map(|(target, at)| (target.as_str().to_owned(), iso(at)))
                .collect(),
        ),
        "queue.headline" => out(queue.headline(int(0))?),
        "queue.snapshot" => out(queue.snapshot(int(0), optional_int(1))?),
        "settings.studioProfile" => out(settings.studio_profile()?),
        "settings.setStudioProfile" => out(settings.set_studio_profile(&arg(args, 0))?),
        "settings.timezone" => out(settings.timezone(int(0), &text(1))?),
        "settings.setTimezone" => {
            settings.set_timezone(int(0), &text(1))?;
            Value::Null
        }
        "settings.timeConfig" => out(settings.time_config(int(0))?),
        "settings.notifications" => out(settings.notifications(int(0))?),
        "settings.setNotifications" => out(settings.set_notifications(int(0), &arg(args, 1))?),
        "settings.backup" => out(settings.backup()?),
        "settings.setBackup" => out(settings.set_backup(args[0]["enabled"].as_bool().unwrap())?),
        "settings.youtubeSignature" => out(settings.youtube_signature()?),
        "settings.setYoutubeSignature" => {
            settings.set_youtube_signature(&text(0))?;
            Value::Null
        }
        "settings.clearYoutubeSignature" => {
            settings.clear_youtube_signature()?;
            Value::Null
        }
        "settings.defaultTargets" => out(settings.default_targets()?),
        "settings.toggleDefaultTarget" => out(settings.toggle_default_target(&text(0))?),
        "config.view" => {
            let view = studio_config(ApplicationPorts::within(
                studio.publishing.sqlite,
                studio.publishing.clock,
            ));
            let video = view.video()?;
            out(json!({
                "timezone": view.timezone()?, "timezoneLabel": view.timezone_label()?, "siteEnabled": view.site_enabled()?,
                "site": { "en": view.site(Locale::En)?, "ru": view.site(Locale::Ru)? },
                "siteTimezone": { "en": view.site_timezone(Locale::En)?, "ru": view.site_timezone(Locale::Ru)? },
                "video": { "prepare_lead_minutes": video.prepare_lead_minutes, "retention_hours": video.retention_hours },
            }))
        }
        "channels.list" => out(channels.list(arg(args, 0))?),
        "channels.report" => out(channels.report(arg(args, 0))?),
        "channels.connect" => out(channels.connect(&arg(args, 0), optional_text(1).as_deref())?),
        "channels.connectTarget" => out(channels.connect_target(
            &text(0),
            optional_text(1).as_deref(),
            optional_text(2).as_deref(),
            optional_text(3).as_deref(),
            optional_text(4).as_deref(),
        )?),
        "channels.disable" => out(channels.disable(&text(0))?),
        "channels.nativeConnectUrl" => out(channels.native_connect_url(arg(args, 0), locale(&text(1)))),
        "channels.nativeConnectPath" => out(channels.native_connect_path(arg(args, 0), locale(&text(1)))),
        "channels.startConnect" => out(channels.start_connect(arg(args, 0), locale(&text(1)))?),
        "channels.xConnectUrl" => out(channels.x_connect_url()),
        "channels.xConnectPath" => out(channels.x_connect_path()),
        "channels.discoverZernioAccounts" => out(ready(channels.discover_zernio_accounts())?),
        "channels.discoverZernioConnections" => out(ready(channels.discover_zernio_connections(locale(&text(0))))?),
        "channels.connectZernio" => out(ready(channels.connect_zernio(
            &text(0),
            locale(&text(1)),
            arg(args, 2),
        ))?),
        "media.import" => {
            let input: ImportArgs = arg(args, 1);
            let bytes = decode_base64(&input.base64);
            out(media.import(
                int(0),
                &ImportedMedia {
                    filename: &input.filename,
                    content_type: &input.content_type,
                    bytes: &bytes,
                    source: input.source,
                },
            )?)
        }
        "media.importFile" => {
            let input: ImportArgs = arg(args, 1);
            out(media.import_file(
                int(0),
                &ImportedMediaFile {
                    filename: &input.filename,
                    content_type: &input.content_type,
                    local_path: Path::new(&input.local_path),
                    byte_size: None,
                    source: input.source,
                },
            )?)
        }
        "capabilities.report" => out(services.capabilities.report()?),
        other => panic!("unknown call {other}"),
    })
}

fn error_json(error: &domain::Error) -> Value {
    match error {
        domain::Error::Studio(studio) if !studio.params.is_empty() => json!({
            "error": studio.code,
            "params": studio.params.iter().map(|(key, value)| (key.clone(), json!(value))).collect::<Map<_, _>>(),
        }),
        other => json!({ "error": other.to_string() }),
    }
}

fn run(spec: &Value, world: &World, scenario: &Value) -> Value {
    let backend_db = BackendDb::open(":memory:").unwrap();
    let clock = FixedClock(Cell::new(instant(&spec["clock"])));
    let sqlite = unsafe_db(&backend_db);
    let cards = StoryCardStore::new(&clock);
    let jobs = ReminderJobs::new(&clock);
    let env = spec["config"].as_object().unwrap();
    let mut config = foundation::config::load_config(
        env.iter()
            .map(|(key, value)| (key.clone(), value.as_str().unwrap().to_owned()))
            .chain([(
                "DATA_DIR".to_owned(),
                base_dir().join("data").to_string_lossy().into_owned(),
            )]),
    )
    .unwrap();
    config.zernio_api_key = Some(spec["zernioApiKey"].as_str().unwrap().into());
    let report = Report {
        env,
        zernio: true,
        config: &config,
    };
    let studio = Studio::new(
        Publishing::new(
            sqlite,
            &clock,
            Boundaries {
                jitter: &FixedJitter(0.5),
                bell: &NoWorker,
                auth_circuit: &Inert,
                usage: &Inert,
                story_cards: &cards,
                video_completion: &Inert,
            },
        ),
        &config,
        StudioBoundaries {
            reminders: &jobs,
            story_derivatives: &Inert,
            readiness: &report,
            connect_links: &Unconfigured,
        },
    );
    let ignored: Vec<String> = serde_json::from_value(spec["ignoredTables"].clone()).unwrap();
    let mut vars = Map::new();
    let mut results = Vec::new();
    for sql in spec["setup"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(at) = step.get("clock") {
            clock.0.set(instant(at));
        } else if let Some(sql) = step.get("sql") {
            sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
        } else if step.get("file").is_some() {
            // The recorded run wrote the file, with these bytes, before this one.
        } else {
            let name = step["call"].as_str().expect("step without clock, sql, file or call");
            let args = resolve(step.get("args").unwrap_or(&json!([])), &vars);
            let result = match call(studio, world, name, args.as_array().unwrap()) {
                Ok(value) => {
                    if let Some(bind) = step.get("bind").and_then(Value::as_str) {
                        vars.insert(bind.into(), value.clone());
                    }
                    value
                }
                Err(_) if step.get("error").is_some_and(|mode| mode == "any") => json!({ "error": "<any>" }),
                Err(error) => error_json(&error),
            };
            results.push(json!({ "call": name, "result": out(result) }));
        }
    }
    for sql in spec["beforeDump"].as_array().unwrap() {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    out(json!({ "name": scenario["name"], "results": results, "tables": dump(sqlite, &ignored) }))
}

/// A fresh base directory holding the committed media the spec names as `{MEDIA}`.
fn spec() -> Value {
    let base = base_dir();
    let _ = std::fs::remove_dir_all(&base);
    let media = base.join("media");
    std::fs::create_dir_all(&media).unwrap();
    let fixtures = Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/fixtures/studio-media");
    for entry in std::fs::read_dir(fixtures).unwrap() {
        let entry = entry.unwrap();
        std::fs::copy(entry.path(), media.join(entry.file_name())).unwrap();
    }
    let text = std::fs::read_to_string(spec_path())
        .unwrap()
        .replace("{DATA}", &base.join("data").to_string_lossy())
        .replace("{MEDIA}", &base.join("media").to_string_lossy());
    serde_json::from_str(&text).unwrap()
}

#[test]
fn studio_services_match_typescript() {
    let spec = spec();
    let typescript = support::golden(&spec_path());
    let probe = &typescript["probe"];
    let world = World {
        probe: MediaMetadata {
            width: probe["width"].as_f64().unwrap(),
            height: probe["height"].as_f64().unwrap(),
            duration_seconds: probe["durationSeconds"].as_f64().unwrap(),
            video_codec: probe["videoCodec"].as_str().unwrap().into(),
            audio_codec: probe["audioCodec"].as_str().map(str::to_owned),
            fps: probe["fps"].as_f64().unwrap(),
            audio_bitrate: probe["audioBitrate"].as_f64(),
        },
        accounts: serde_json::from_value(spec["zernioAccounts"].clone()).unwrap(),
    };
    let actual: Vec<Value> = spec["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scenario| run(&spec, &world, scenario))
        .collect();
    let failures = differences(typescript["scenarios"].as_array().unwrap(), &actual);
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// The scenarios reach every call the runner dispatches.
#[test]
fn scenarios_cover_every_call() {
    let spec = std::fs::read_to_string(spec_path()).unwrap();
    let source =
        std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/studio_scenarios.rs")).unwrap();
    let dispatch = &source[source.find("fn call(").unwrap()..source.find("fn error_json(").unwrap()];
    let dispatched: Vec<&str> = dispatch
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.split_once("\" =>").map(|(name, _)| name))
        .collect();
    assert!(dispatched.len() > 100, "{dispatched:?}");
    let missing: Vec<&&str> = dispatched
        .iter()
        .filter(|name| !spec.contains(&format!("\"call\": \"{name}\"")))
        .collect();
    assert!(missing.is_empty(), "never called: {missing:?}");
}
