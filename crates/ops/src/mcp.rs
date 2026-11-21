//! The Studio MCP server (`interfaces/mcp.ts`), framework-free: JSON-RPC
//! `initialize`, `tools/list`, `tools/call` over the hand-written `studio_*`
//! tools and the `ops_*` projection of the registry. The HTTP transport
//! (`POST`/`GET /api/mcp`) mounts it.

use std::cell::RefCell;
use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::LazyLock;

use bot::DynAdapters;
use content::Locale;
use content::message::DraftMessage;
use domain::application::ports::{Clock, DomainEventInput, Severity, StoryPublishMode};
use domain::application::publication_ref::PublicationRefKind;
use domain::application::publication_ref::publication_ref;
use domain::publishing::video_types::VideoTarget;
use domain::repositories::record_event;
use domain::studio::services::StudioServices;
use domain::studio::services::posts::{DraftConfiguration, EditInput, PostScheduleInput};
use domain::studio::services::settings::{NotificationSettingsInput, StudioLocale};
use foundation::logger::{LogLevel, log};
use foundation::redact::redact_external_secrets;
use runtime::http::HttpClient;
use serde_json::{Map, Value, json};

use crate::context::{Fut, Input, OpError, OpResult, OperationContext, Surface, to_value};
use crate::registry::{operation_def, operation_defs, run_operation};
use crate::schema::{
    Issue, ParseError, Schema, Transform, array, boolean, enumeration, number, object, record, string,
};

/// The metadata `initialize` returns and discovery advertises (`mcp-protocol.ts`).
pub fn server_metadata() -> Value {
    json!({
        "protocolVersion": "2024-11-05",
        "capabilities": {"tools": {}},
        "serverInfo": {"name": "solo-publisher-studio-mcp", "version": "2.1.0"},
    })
}

// --- Shared zod building blocks -------------------------------------------------

fn trimmed(min: f64, max: f64) -> crate::schema::Field {
    string().trim().min(min).max(max)
}

fn positive_int() -> crate::schema::Field {
    number().int().min(1.0)
}

const LOCALES: &[&str] = &["ru", "en"];
/// `STUDIO_LOCALES`: the interface languages the locale registry knows.
const UI_LOCALES: &[&str] = &["en", "ru"];
const VIDEO_TARGETS: &[&str] = &["youtube_shorts", "instagram_reels"];

fn iso_date_or_null() -> crate::schema::Field {
    string().max(80.0).optional().transform(Transform::IsoDateOrNull)
}

fn unique_int_array(min: f64, max: f64) -> crate::schema::Field {
    array(positive_int()).min(min).max(max).transform(Transform::Unique)
}

/// The tool handler: Studio services as the authenticated actor.
type ToolHandler = for<'a> fn(StudioServices<'a, DynAdapters>, i64, &'a Input) -> Fut<'a, OpResult>;
/// The domain-event ref a mutating tool journals against.
type ToolRef = fn(&Input, &Value) -> Option<String>;

struct ToolDef {
    name: &'static str,
    description: &'static str,
    schema: Schema,
    mutates: bool,
    reference: Option<ToolRef>,
    handler: ToolHandler,
}

fn tool(name: &'static str, description: &'static str, schema: Schema, handler: ToolHandler) -> ToolDef {
    ToolDef {
        name,
        description,
        schema,
        mutates: false,
        reference: None,
        handler,
    }
}

impl ToolDef {
    fn mutation(mut self, reference: Option<ToolRef>) -> Self {
        self.mutates = true;
        self.reference = reference;
        self
    }
}

fn draft_ref(input: &Input, _: &Value) -> Option<String> {
    Some(publication_ref(PublicationRefKind::Draft, input.int("draft_id")))
}

fn video_ref(input: &Input, _: &Value) -> Option<String> {
    Some(publication_ref(PublicationRefKind::Video, input.int("video_draft_id")))
}

fn locale(input: &Input, name: &str) -> Locale {
    if input.str(name) == "en" {
        Locale::En
    } else {
        Locale::Ru
    }
}

fn video_target(input: &Input, name: &str) -> VideoTarget {
    VideoTarget::parse(input.str(name)).unwrap_or(VideoTarget::YoutubeShorts)
}

fn ids(input: &Input, name: &str) -> Vec<i64> {
    input
        .get(name)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(Value::as_i64).collect())
        .unwrap_or_default()
}

/// `{ ...base, ...extra }`.
fn merged(mut base: Map<String, Value>, extra: Value) -> Value {
    if let Value::Object(extra) = extra {
        for (key, value) in extra {
            base.insert(key, value);
        }
    }
    Value::Object(base)
}

fn ready(value: OpResult) -> Fut<'static, OpResult> {
    Box::pin(std::future::ready(value))
}

/// `studio_post_schedule` / `studio_video_schedule`: one of the times is required.
fn one_of(
    first: &'static str,
    second: &'static str,
    message: &'static str,
) -> impl Fn(&Map<String, Value>) -> Result<(), Issue> {
    move |value| {
        let given = |name: &str| value.get(name).is_some_and(|v| !v.is_null() && v != "");
        if given(first) || given(second) {
            Ok(())
        } else {
            Err(Issue {
                path: Vec::new(),
                message: message.into(),
            })
        }
    }
}

fn post_schedule_check(value: &mut Map<String, Value>) -> Result<(), Issue> {
    one_of("ru_at", "en_at", "ru_at or en_at is required")(value)
}

fn video_schedule_check(value: &mut Map<String, Value>) -> Result<(), Issue> {
    one_of(
        "youtube_shorts_at",
        "instagram_reels_at",
        "youtube_shorts_at or instagram_reels_at is required",
    )(value)
}

/// `studio_video_update_metadata`'s transform: the metadata is validated
/// against the target's own shape, and the input becomes
/// `{ publicationId, target, metadata }`.
fn video_metadata_check(value: &mut Map<String, Value>) -> Result<(), Issue> {
    static YOUTUBE: LazyLock<Schema> = LazyLock::new(|| {
        object(vec![
            ("title", trimmed(1.0, 100.0)),
            ("description", trimmed(0.0, 5_000.0)),
            ("tags", array(trimmed(1.0, 100.0))),
            ("game_url", trimmed(1.0, 500.0).optional()),
        ])
    });
    static INSTAGRAM: LazyLock<Schema> = LazyLock::new(|| object(vec![("caption", trimmed(1.0, 2_200.0))]));
    let target = value["target"].as_str().unwrap_or_default().to_owned();
    let metadata = value["metadata"].as_object().cloned().unwrap_or_default();
    let schema = if target == "youtube_shorts" {
        &*YOUTUBE
    } else {
        &*INSTAGRAM
    };
    let parsed = match schema.parse(&metadata) {
        Ok(parsed) => parsed,
        Err(ParseError::Issue(issue)) => {
            return Err(Issue {
                path: Vec::new(),
                message: issue.message,
            });
        }
        Err(ParseError::Thrown(message)) => {
            return Err(Issue {
                path: Vec::new(),
                message,
            });
        }
    };
    let metadata = if parsed.contains_key("game_url") {
        json!({
            "title": parsed["title"], "description": parsed["description"], "tags": parsed["tags"],
            "gameUrl": parsed["game_url"],
        })
    } else {
        Value::Object(parsed)
    };
    let publication_id = value["video_draft_id"].clone();
    value.clear();
    value.insert("publicationId".into(), publication_id);
    value.insert("target".into(), Value::from(target));
    value.insert("metadata".into(), metadata);
    Ok(())
}

#[rustfmt::skip]
fn studio_tool_defs() -> Vec<ToolDef> {
    vec![
        tool("studio_capabilities", "Read Studio capabilities and sanitized platform readiness before selecting a command.",
            object(vec![]),
            |studio, _, _| ready(studio.capabilities.report().map_err(OpError::from).and_then(to_value))),
        tool("studio_queue", "Read upcoming work, drafts and failures for the authenticated Studio.",
            object(vec![]),
            |studio, actor, _| ready(studio.queue.snapshot(actor, None).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_list", "List post drafts visible to the authenticated Studio operator.",
            object(vec![("limit", positive_int().max(100.0).optional())]),
            |studio, actor, input| ready(studio.posts.list(actor, Some(input.opt_int("limit").unwrap_or(50))).map_err(OpError::from).and_then(to_value))),
        tool("studio_notification_settings", "Read the authenticated owner's Studio notification policy.",
            object(vec![]),
            |studio, actor, _| ready(studio.settings.notifications(actor).map_err(OpError::from).and_then(to_value))),
        tool("studio_locale", "Read the authenticated owner's Studio interface locale.",
            object(vec![]),
            |studio, actor, _| ready(studio.settings.locale(actor).map_err(OpError::from).map(|locale| json!({"locale": locale.as_str()})))),
        tool("studio_channels", "List connected Studio channels without exposing stored credentials.",
            object(vec![]),
            |studio, _, _| ready(studio.channels.list(false).map_err(OpError::from).map(|channels| {
                Value::Array(channels.into_iter().map(|record| {
                    let channel = record.connection;
                    json!({
                        "id": channel.id, "platform": channel.platform, "locale": channel.locale,
                        "provider": channel.provider, "provider_account_id": channel.provider_account_id,
                        "target_id": channel.target_id, "label": channel.label, "enabled": channel.enabled == 1,
                        "source": channel.source,
                    })
                }).collect())
            }))),
        tool("studio_zernio_connection_options", "List publishable Zernio account routes for one language without exposing the stored API key.",
            object(vec![("locale", enumeration(LOCALES))]),
            |studio, _, input| Box::pin(async move {
                let options = studio.channels.discover_zernio_connections(locale(input, "locale")).await?;
                let options: Vec<Value> = options.into_iter().map(|option| {
                    let channel_connect = match &option.input.target_id {
                        Some(target) => json!({
                            "target": target, "provider": "zernio", "account_id": option.account_id, "label": option.label,
                        }),
                        None => json!({
                            "platform": option.input.platform, "locale": option.locale.as_str(), "provider": "zernio",
                            "account_id": option.account_id, "label": option.label,
                        }),
                    };
                    json!({"connection": option.key, "label": option.label, "channel_connect": channel_connect})
                }).collect();
                Ok(Value::Array(options))
            })),
        tool("studio_locale_update", "Update the authenticated owner's shared interface locale.",
            object(vec![("locale", enumeration(UI_LOCALES))]),
            |studio, actor, input| {
                let ui = StudioLocale::parse(input.opt_str("locale"), StudioLocale::Ru);
                ready(studio.settings.set_locale(actor, ui).map_err(OpError::from)
                    .map(|()| json!({"locale": ui.as_str(), "updated": true})))
            }).mutation(None),
        tool("studio_youtube_signature", "Read this Studio's YouTube description signature.",
            object(vec![]),
            |studio, _, _| ready(studio.settings.youtube_signature().map_err(OpError::from).map(|signature| json!({"signature": signature})))),
        tool("studio_youtube_signature_update", "Set or clear this Studio's YouTube description signature. It reaches every video on the Studio's channel, whoever authored it.",
            object(vec![("signature", string().max(500.0))]),
            |studio, _, input| ready((|| {
                studio.settings.set_youtube_signature(input.str("signature"))?;
                Ok(json!({"signature": studio.settings.youtube_signature()?, "updated": true}))
            })())).mutation(None),
        tool("studio_notification_settings_update", "Update notification policy. These settings apply to every connected interface; Telegram is only one delivery adapter.",
            object(vec![
                ("video_reminders_enabled", boolean().optional()),
                ("post_reminders_enabled", boolean().optional()),
                ("reminder_minutes", number().int().min(1.0).max(60.0).optional()),
                ("completion_enabled", boolean().optional()),
            ]),
            |studio, actor, input| ready(studio.settings.set_notifications(actor, &NotificationSettingsInput {
                video_reminders_enabled: input.opt_bool("video_reminders_enabled"),
                post_reminders_enabled: input.opt_bool("post_reminders_enabled"),
                reminder_minutes: input.get("reminder_minutes").and_then(Value::as_f64),
                completion_enabled: input.opt_bool("completion_enabled"),
            }).map_err(OpError::from).and_then(to_value))).mutation(None),
        tool("studio_media_list", "List reusable media assets visible to the authenticated Studio operator.",
            object(vec![("limit", positive_int().max(100.0).optional())]),
            |studio, actor, input| ready(studio.posts.media_assets(actor, Some(input.opt_int("limit").unwrap_or(50))).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_create", "Create a text-post draft with its exact publication targets. Every target publishes one language and takes that language's text: `text` is Russian, `text_en` is English. A target connected on the EN locale — which is what a single X or Threads account connects as — publishes `text_en`, and refuses a draft that has only `text`. `studio_capabilities` lists each connected target with its locale.",
            object(vec![
                ("text", trimmed(1.0, 20_000.0)),
                ("text_en", trimmed(0.0, 20_000.0).optional()),
                ("targets", array(trimmed(1.0, 120.0)).min(1.0).max(10.0).transform(Transform::Unique)),
                ("story_publish_mode", enumeration(&["all", "site_only"]).optional()),
            ]),
            |studio, actor, input| ready((|| {
                let text_en = input.opt_str("text_en").map(str::to_owned);
                let targets = input.strings("targets");
                let story_mode = match input.opt_str("story_publish_mode") {
                    Some("all") => Some(StoryPublishMode::All),
                    Some("site_only") => Some(StoryPublishMode::SiteOnly),
                    _ => None,
                };
                let draft_id = studio.posts.create(
                    actor,
                    &DraftMessage {
                        text: input.str("text").to_owned(),
                        text_en_approved: text_en.clone(),
                        text_en,
                        media: Vec::new(),
                        entities: Vec::new(),
                    },
                    Some(&DraftConfiguration { targets: targets.clone(), story_mode }),
                )?;
                Ok(json!({"draft_id": draft_id, "targets": targets}))
            })())).mutation(Some(|_, result| Some(publication_ref(PublicationRefKind::Draft, result["draft_id"].as_i64().unwrap_or_default())))),
        tool("studio_post_get", "Read one owned post draft.",
            object(vec![("draft_id", positive_int())]),
            |studio, actor, input| ready(studio.posts.get(actor, input.int("draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_validate", "Validate one owned post draft before publishing.",
            object(vec![("draft_id", positive_int())]),
            |studio, actor, input| ready(studio.posts.validate(actor, input.int("draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_status", "Read queue and target status for one owned post draft.",
            object(vec![("draft_id", positive_int())]),
            |studio, actor, input| ready(studio.posts.progress(actor, input.int("draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_history", "Read durable event history for one owned post draft.",
            object(vec![("draft_id", positive_int()), ("limit", positive_int().max(100.0).optional())]),
            |studio, actor, input| ready(studio.posts.history(actor, input.int("draft_id"), Some(input.opt_int("limit").unwrap_or(50))).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_attach_media", "Attach already uploaded Studio media assets to an owned post locale. Upload files through POST /api/studio/media first.",
            object(vec![
                ("draft_id", positive_int()),
                ("locale", enumeration(LOCALES)),
                ("asset_ids", unique_int_array(1.0, 10.0)),
                ("replace", boolean().optional()),
            ]),
            |studio, actor, input| ready((|| {
                let replace = input.bool("replace");
                studio.posts.attach_media_assets(actor, input.int("draft_id"), locale(input, "locale"), &ids(input, "asset_ids"), replace)?;
                Ok(json!({
                    "draft_id": input.int("draft_id"), "locale": input.str("locale"), "asset_ids": input.get("asset_ids"),
                    "attached": true, "replace": replace,
                }))
            })())).mutation(Some(draft_ref)),
        tool("studio_post_remove_media", "Remove selected Studio media assets from one owned post locale.",
            object(vec![("draft_id", positive_int()), ("locale", enumeration(LOCALES)), ("asset_ids", unique_int_array(1.0, 10.0))]),
            |studio, actor, input| ready((|| {
                studio.posts.remove_media(actor, input.int("draft_id"), locale(input, "locale"), &ids(input, "asset_ids"))?;
                Ok(json!({"draft_id": input.int("draft_id"), "locale": input.str("locale"), "asset_ids": input.get("asset_ids"), "removed": true}))
            })())).mutation(Some(draft_ref)),
        tool("studio_post_preview", "Read a transport-neutral preview of one owned post draft.",
            object(vec![("draft_id", positive_int())]),
            |studio, actor, input| ready(studio.posts.preview(actor, input.int("draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_post_edit", "Edit text on one owned post draft.",
            object(vec![("draft_id", positive_int()), ("locale", enumeration(LOCALES)), ("text", trimmed(0.0, 20_000.0))]),
            |studio, actor, input| ready((|| {
                studio.posts.edit(actor, input.int("draft_id"), &EditInput {
                    locale: locale(input, "locale"),
                    text: input.str("text").to_owned(),
                    entities: Vec::new(),
                    media: Vec::new(),
                    replace_media_only: false,
                    clear_media: false,
                })?;
                Ok(json!({"draft_id": input.int("draft_id"), "updated": true}))
            })())).mutation(Some(draft_ref)),
        tool("studio_post_publish", "Queue an owned post draft for immediate publication.",
            object(vec![("draft_id", positive_int())]),
            |studio, actor, input| ready((|| {
                let post_id = studio.posts.publish(actor, input.int("draft_id"))?;
                Ok(json!({"draft_id": input.int("draft_id"), "post_id": post_id, "queued": true}))
            })())).mutation(Some(|_, result| Some(publication_ref(PublicationRefKind::Post, result["post_id"].as_i64().unwrap_or_default())))),
        tool("studio_post_schedule", "Schedule an owned post draft. ISO dates are optional per locale.",
            object(vec![("draft_id", positive_int()), ("ru_at", iso_date_or_null()), ("en_at", iso_date_or_null())])
                .refine(post_schedule_check),
            |studio, actor, input| ready((|| {
                let at = |name: &str| input.opt_str(name).and_then(|at| foundation::time::parse_iso_instant(at).ok());
                let post_id = studio.posts.schedule(actor, input.int("draft_id"), &PostScheduleInput {
                    ru_at: at("ru_at"),
                    en_at: at("en_at"),
                    ..PostScheduleInput::default()
                })?;
                Ok(json!({"draft_id": input.int("draft_id"), "post_id": post_id, "scheduled": true}))
            })())).mutation(Some(|_, result| Some(publication_ref(PublicationRefKind::Post, result["post_id"].as_i64().unwrap_or_default())))),
        tool("studio_post_cancel", "Cancel an owned post draft and its remaining work.",
            object(vec![("draft_id", positive_int())]),
            |studio, actor, input| ready((|| {
                studio.posts.cancel(actor, input.int("draft_id"))?;
                Ok(json!({"draft_id": input.int("draft_id"), "cancelled": true}))
            })())).mutation(Some(draft_ref)),
        tool("studio_video_create", "Create an owned video draft from an already-uploaded Studio video asset.",
            object(vec![("asset_id", positive_int()), ("locale", enumeration(LOCALES).optional())]),
            |studio, actor, input| ready((|| {
                let chosen = input.opt_str("locale").map(|_| locale(input, "locale"));
                let id = studio.videos.create(actor, input.int("asset_id"), chosen)?;
                Ok(json!({"video_draft_id": id}))
            })())).mutation(Some(|_, result| Some(publication_ref(PublicationRefKind::Video, result["video_draft_id"].as_i64().unwrap_or_default())))),
        tool("studio_video_list", "List video drafts visible to the authenticated Studio operator.",
            object(vec![("limit", positive_int().max(100.0).optional())]),
            |studio, actor, input| ready(studio.videos.list(actor, Some(input.opt_int("limit").unwrap_or(50))).map_err(OpError::from).and_then(to_value))),
        tool("studio_video_get", "Read an owned video draft and its targets.",
            object(vec![("video_draft_id", positive_int())]),
            |studio, actor, input| ready(studio.videos.get(actor, input.int("video_draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_video_preview", "Read an owned video draft preview and target metadata.",
            object(vec![("video_draft_id", positive_int())]),
            |studio, actor, input| ready(studio.videos.preview(actor, input.int("video_draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_video_status", "Read owned video targets and durable jobs.",
            object(vec![("video_draft_id", positive_int())]),
            |studio, actor, input| ready(studio.videos.status(actor, input.int("video_draft_id")).map_err(OpError::from).and_then(to_value))),
        tool("studio_video_history", "Read durable event history for one owned video draft.",
            object(vec![("video_draft_id", positive_int()), ("limit", positive_int().max(100.0).optional())]),
            |studio, actor, input| ready(studio.videos.history(actor, input.int("video_draft_id"), Some(input.opt_int("limit").unwrap_or(50))).map_err(OpError::from).and_then(to_value))),
        tool("studio_video_rename", "Rename an owned video draft.",
            object(vec![("video_draft_id", positive_int()), ("label", trimmed(1.0, 500.0))]),
            |studio, actor, input| ready((|| {
                studio.videos.rename(actor, input.int("video_draft_id"), input.str("label"))?;
                Ok(json!({"video_draft_id": input.int("video_draft_id"), "updated": true}))
            })())).mutation(Some(video_ref)),
        tool("studio_video_replace_targets", "Replace editable video publication targets.",
            object(vec![
                ("video_draft_id", positive_int()),
                ("targets", array(enumeration(VIDEO_TARGETS)).min(1.0).max(2.0).transform(Transform::NoDuplicates("targets must not contain duplicates"))),
            ]),
            |studio, actor, input| ready((|| {
                let targets: Vec<VideoTarget> = input.strings("targets").iter().filter_map(|target| VideoTarget::parse(target)).collect();
                studio.videos.replace_targets(actor, input.int("video_draft_id"), &targets)?;
                Ok(json!({"video_draft_id": input.int("video_draft_id"), "updated": true}))
            })())).mutation(Some(video_ref)),
        tool("studio_video_update_metadata", "Set target metadata. YouTube requires title, description and tags; Instagram requires caption.",
            object(vec![("video_draft_id", positive_int()), ("target", enumeration(VIDEO_TARGETS)), ("metadata", record())])
                .refine(video_metadata_check),
            |studio, actor, input| ready((|| {
                let metadata = input.get("metadata").and_then(Value::as_object).cloned().unwrap_or_default();
                studio.videos.update_metadata(actor, input.int("publicationId"), video_target(input, "target"), &metadata)?;
                Ok(json!({"video_draft_id": input.int("publicationId"), "target": input.str("target"), "updated": true}))
            })())).mutation(Some(|input, _| Some(publication_ref(PublicationRefKind::Video, input.int("publicationId"))))),
        tool("studio_video_schedule", "Schedule one or both connected video targets at future ISO datetimes.",
            object(vec![("video_draft_id", positive_int()), ("youtube_shorts_at", iso_date_or_null()), ("instagram_reels_at", iso_date_or_null())])
                .refine(video_schedule_check),
            |studio, actor, input| Box::pin(async move {
                let mut schedule = Vec::new();
                for (name, target) in [("youtube_shorts_at", VideoTarget::YoutubeShorts), ("instagram_reels_at", VideoTarget::InstagramReels)] {
                    if let Some(at) = input.opt_str(name).and_then(|at| foundation::time::parse_iso_instant(at).ok()) {
                        schedule.push((target, at));
                    }
                }
                let technical = studio.videos.schedule(actor, input.int("video_draft_id"), &schedule).await?;
                Ok(json!({"video_draft_id": input.int("video_draft_id"), "scheduled": true, "technical": to_value(technical)?}))
            })).mutation(Some(video_ref)),
        tool("studio_video_preflight", "Validate an owned video source and configured targets without scheduling it.",
            object(vec![("video_draft_id", positive_int())]),
            |studio, actor, input| Box::pin(async move {
                to_value(studio.videos.technical_check(actor, input.int("video_draft_id")).await?)
            })),
        tool("studio_video_publish", "Queue all connected video targets for immediate publication.",
            object(vec![("video_draft_id", positive_int())]),
            |studio, actor, input| Box::pin(async move {
                let technical = studio.videos.publish(actor, input.int("video_draft_id")).await?;
                Ok(json!({"video_draft_id": input.int("video_draft_id"), "queued": true, "technical": to_value(technical)?}))
            })).mutation(Some(video_ref)),
        tool("studio_video_retry", "Retry one failed video target.",
            object(vec![("video_draft_id", positive_int()), ("target", enumeration(VIDEO_TARGETS))]),
            |studio, actor, input| Box::pin(async move {
                studio.videos.retry_target(actor, input.int("video_draft_id"), video_target(input, "target")).await?;
                Ok(json!({"video_draft_id": input.int("video_draft_id"), "target": input.str("target"), "retried": true}))
            })).mutation(Some(video_ref)),
        tool("studio_video_remove_target", "Remove one editable video target.",
            object(vec![("video_draft_id", positive_int()), ("target", enumeration(VIDEO_TARGETS))]),
            |studio, actor, input| ready((|| {
                let removal = studio.videos.remove_target(actor, input.int("video_draft_id"), video_target(input, "target"))?;
                let mut base = Map::new();
                base.insert("video_draft_id".into(), json!(input.int("video_draft_id")));
                base.insert("target".into(), json!(input.str("target")));
                Ok(merged(base, to_value(removal)?))
            })())).mutation(Some(video_ref)),
        tool("studio_video_cancel", "Cancel an owned video publication.",
            object(vec![("video_draft_id", positive_int())]),
            |studio, actor, input| Box::pin(async move {
                let report = studio.videos.cancel(actor, input.int("video_draft_id")).await?;
                let mut base = Map::new();
                base.insert("video_draft_id".into(), json!(input.int("video_draft_id")));
                base.insert("cancelled".into(), json!(true));
                Ok(merged(base, to_value(report)?))
            })).mutation(Some(video_ref)),
    ]
}

static STUDIO_TOOLS: LazyLock<Vec<ToolDef>> = LazyLock::new(studio_tool_defs);

fn feedback_schema() -> Schema {
    object(vec![
        ("name", trimmed(0.0, 120.0).optional()),
        ("message", trimmed(1.0, 2_000.0)),
    ])
}

const FEEDBACK_DESCRIPTION: &str = "Record feedback or a bug report in this Studio's own journal, where its operator will see it. It is not sent anywhere.";
const OPS_TOOL_PREFIX: &str = "ops_";

/// What each Studio tool is called and whether it declares itself a mutation.
pub fn studio_tool_catalog() -> Vec<(&'static str, bool)> {
    STUDIO_TOOLS.iter().map(|def| (def.name, def.mutates)).collect()
}

fn ops_tool_name(operation: &str) -> String {
    format!("{OPS_TOOL_PREFIX}{}", operation.replace('-', "_"))
}

fn ops_operation(tool: &str) -> Option<&'static str> {
    operation_defs()
        .iter()
        .find(|def| def.agent && ops_tool_name(def.name) == tool)
        .map(|def| def.name)
}

/// `placeholder` is the CLI usage line's device; the wire does not get it.
fn agent_schema(mut schema: Value) -> Value {
    if let Some(properties) = schema.get_mut("properties").and_then(Value::as_object_mut) {
        for property in properties.values_mut() {
            if let Some(property) = property.as_object_mut() {
                property.shift_remove("placeholder");
            }
        }
    }
    schema
}

static PUBLIC_TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    vec![
        json!({"name": "submit_feedback", "description": FEEDBACK_DESCRIPTION, "inputSchema": feedback_schema().json_schema()}),
    ]
});

static ALL_TOOLS: LazyLock<Vec<Value>> = LazyLock::new(|| {
    let studio = STUDIO_TOOLS
        .iter()
        .map(|def| json!({"name": def.name, "description": def.description, "inputSchema": def.schema.json_schema()}));
    let ops = operation_defs().iter().filter(|def| def.agent).map(|def| {
        let mut description = format!("[{}] {}", def.section.as_str(), def.summary);
        if let (Some(note), true) = (def.note, def.mutates) {
            description.push_str(&format!(" ({note})"));
        }
        json!({
            "name": ops_tool_name(def.name),
            "description": description,
            "inputSchema": agent_schema(def.schema.json_schema()),
        })
    });
    PUBLIC_TOOLS.iter().cloned().chain(studio).chain(ops).collect()
});

/// The `tools/list` answer for an authenticated caller, or an anonymous one.
pub fn tools(authenticated: bool) -> Vec<Value> {
    if authenticated {
        ALL_TOOLS.clone()
    } else {
        PUBLIC_TOOLS.clone()
    }
}

struct ToolError {
    code: i64,
    message: String,
}

impl ToolError {
    fn new(code: i64, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl From<OpError> for ToolError {
    fn from(error: OpError) -> Self {
        match error {
            OpError::Input(message) => Self::new(-32602, message),
            OpError::Failed(message) => Self::new(-32603, message),
        }
    }
}

fn parse_tool_args(schema: &Schema, args: &Map<String, Value>) -> Result<Input, ToolError> {
    match schema.parse(args) {
        Ok(parsed) => Ok(Input(parsed)),
        Err(ParseError::Issue(issue)) => Err(ToolError::new(-32602, issue.describe())),
        Err(ParseError::Thrown(message)) => Err(ToolError::new(-32603, message)),
    }
}

thread_local! {
    static FEEDBACK_HITS: RefCell<HashMap<String, Vec<i64>>> = RefCell::new(HashMap::new());
}

/// Five reports an hour per client.
fn rate_limited(key: &str, now_ms: i64) -> bool {
    let cutoff = now_ms - 3_600_000;
    FEEDBACK_HITS.with_borrow_mut(|hits| {
        let mut mine: Vec<i64> = hits
            .get(key)
            .map(|all| all.iter().copied().filter(|at| *at >= cutoff).collect())
            .unwrap_or_default();
        if mine.len() >= 5 {
            hits.insert(key.to_owned(), mine);
            return true;
        }
        mine.push(now_ms);
        hits.insert(key.to_owned(), mine);
        hits.retain(|_, other| !(other.is_empty() || other.iter().all(|at| *at < cutoff)));
        false
    })
}

/// The server's view of one request: its surface, clock and HTTP client.
pub struct McpServer<'a> {
    pub surface: &'a dyn Surface,
    pub clock: &'a dyn Clock,
    pub http: HttpClient,
    pub env: &'a dyn Fn(&str) -> Option<String>,
    pub cwd: PathBuf,
}

fn rpc_error(id: Value, code: i64, message: &str) -> Value {
    json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": redact_external_secrets(message)}})
}

fn success(id: Value, value: &Value) -> Value {
    let text = serde_json::to_string(value).unwrap_or_default();
    json!({"jsonrpc": "2.0", "id": id, "result": {"content": [{"type": "text", "text": redact_external_secrets(&text)}]}})
}

fn as_object(value: Option<&Value>) -> Map<String, Value> {
    match value {
        Some(Value::Object(map)) => map.clone(),
        _ => Map::new(),
    }
}

impl McpServer<'_> {
    /// `mcpResponse`: `None` is a notification (no response at all).
    pub fn respond<'s>(
        &'s self,
        body: &'s Value,
        client_key: &'s str,
        actor_id: Option<i64>,
    ) -> Fut<'s, Option<Value>> {
        Box::pin(async move {
            // A batch is answered as a batch, minus the notifications in it.
            if let Value::Array(entries) = body {
                if entries.is_empty() {
                    return Some(rpc_error(Value::Null, -32600, "Invalid request"));
                }
                let mut answers = Vec::new();
                for entry in entries {
                    match self.respond(entry, client_key, actor_id).await {
                        Some(Value::Array(many)) => answers.extend(many),
                        Some(one) => answers.push(one),
                        None => {}
                    }
                }
                return (!answers.is_empty()).then_some(Value::Array(answers));
            }
            let Value::Object(request) = body else {
                return Some(rpc_error(Value::Null, -32600, "Invalid request"));
            };
            // A notification carries no id and draws no response.
            let id = request.get("id")?.clone();
            let method = request.get("method");
            match method.and_then(Value::as_str) {
                Some("initialize") => return Some(json!({"jsonrpc": "2.0", "id": id, "result": server_metadata()})),
                Some("tools/list") => {
                    return Some(json!({"jsonrpc": "2.0", "id": id, "result": {"tools": tools(actor_id.is_some())}}));
                }
                Some("tools/call") => {}
                _ => {
                    let shown = match method {
                        None => "undefined".to_owned(),
                        Some(Value::String(text)) => text.clone(),
                        Some(other) => js_string(other),
                    };
                    return Some(rpc_error(id, -32601, &format!("Unknown method: {shown}")));
                }
            }
            let params = as_object(request.get("params"));
            let name = params
                .get("name")
                .and_then(Value::as_str)
                .unwrap_or_default()
                .to_owned();
            let args = as_object(params.get("arguments"));
            let answer = self.call(&name, &args, client_key, actor_id).await;
            Some(match answer {
                Ok(value) => success(id, &value),
                Err(error) => rpc_error(id, error.code, &error.message),
            })
        })
    }

    async fn call(
        &self,
        name: &str,
        args: &Map<String, Value>,
        client_key: &str,
        actor_id: Option<i64>,
    ) -> Result<Value, ToolError> {
        if name == "submit_feedback" {
            return self.submit_feedback(args, client_key).map(Value::from);
        }
        let Some(actor_id) = actor_id else {
            return Err(ToolError::new(-32001, "Studio MCP authorization is required"));
        };
        if let Some(operation) = ops_operation(name) {
            return self.run_ops_tool(operation, args).await;
        }
        self.run_studio_tool(actor_id, name, args).await
    }

    async fn run_studio_tool(&self, actor_id: i64, name: &str, args: &Map<String, Value>) -> Result<Value, ToolError> {
        let Some(def) = STUDIO_TOOLS.iter().find(|def| def.name == name) else {
            return Err(ToolError::new(-32601, format!("Unknown Studio tool: {name}")));
        };
        let config = self.surface.config()?;
        let services =
            domain::studio::services::create_studio_services(self.surface.studio(&config)?, self.surface.adapters()?);
        let input = parse_tool_args(&def.schema, args)?;
        let result = crate::context::js_numbers((def.handler)(services, actor_id, &input).await?);
        // The mutation already happened: the audit trail is best-effort.
        if def.mutates {
            let mut details = Map::new();
            details.insert("actorId".into(), json!(actor_id));
            details.insert("tool".into(), json!(name));
            let event = DomainEventInput {
                publication_ref: def.reference.and_then(|reference| reference(&input, &result)),
                event_type: "studio.mcp.command".into(),
                severity: Severity::Info,
                target: Some("mcp".into()),
                message: format!("Studio MCP {name} executed"),
                details: Some(details),
                cooldown_seconds: None,
            };
            let recorded = self
                .surface
                .db()
                .and_then(|db| record_event(db::unsafe_db(db), self.clock, &event).map_err(OpError::from));
            if let Err(error) = recorded {
                log(
                    LogLevel::Error,
                    "studio MCP audit event failed",
                    Some(json!({"actorId": actor_id, "tool": name, "error": error.message()})),
                );
            }
        }
        Ok(result)
    }

    /// Dispatched through `run_operation`, the same entry the CLI uses.
    async fn run_ops_tool(&self, operation: &str, args: &Map<String, Value>) -> Result<Value, ToolError> {
        let config = self.surface.config()?;
        let context = OperationContext {
            db_path: config.pipeline_db.clone(),
            actor_type: "ops-mcp",
            http: self.http.clone(),
            clock: self.clock,
            env: self.env,
            cwd: self.cwd.clone(),
            terminal: None,
            surface: self.surface,
        };
        debug_assert!(operation_def(operation).is_some());
        Ok(run_operation(operation, &context, &Value::Object(args.clone())).await?)
    }

    fn submit_feedback(&self, args: &Map<String, Value>, client_key: &str) -> Result<String, ToolError> {
        let input = parse_tool_args(&feedback_schema(), args)?;
        let name = input
            .opt_str("name")
            .filter(|name| !name.is_empty())
            .unwrap_or("Anonymous Agent")
            .to_owned();
        if rate_limited(client_key, self.clock.now().as_millisecond()) {
            return Err(ToolError::new(-32000, "rate limit exceeded"));
        }
        let event = DomainEventInput {
            publication_ref: Some("mcp:feedback".into()),
            event_type: "mcp.feedback.received".into(),
            severity: Severity::Info,
            target: Some("mcp".into()),
            message: format!("MCP Feedback from {name}: {}", input.str("message")),
            details: None,
            cooldown_seconds: None,
        };
        let db = self.surface.db()?;
        record_event(db::unsafe_db(db), self.clock, &event)
            .map_err(|error| ToolError::new(-32603, error.to_string()))?;
        Ok(format!("Thank you, {name}! Your feedback has been logged."))
    }
}

/// `String(value)` for a JSON value that is not a string.
fn js_string(value: &Value) -> String {
    match value {
        Value::Null => "null".into(),
        Value::Bool(b) => b.to_string(),
        Value::Number(n) => n
            .as_f64()
            .map_or_else(|| n.to_string(), foundation::js::number_to_string),
        Value::String(s) => s.clone(),
        Value::Array(items) => items
            .iter()
            .map(|item| if item.is_null() { String::new() } else { js_string(item) })
            .collect::<Vec<_>>()
            .join(","),
        Value::Object(_) => "[object Object]".into(),
    }
}
