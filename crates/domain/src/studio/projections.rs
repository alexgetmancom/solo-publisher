//! The delivery-facing view of a publication (`studio/projections.ts`),
//! shared by Telegram previews and MCP: what each language, or each video
//! platform, will actually receive.

use content::Locale;
use content::draft_content::{DraftLocaleContent, draft_locale_content};
use content::message::{Entity, MediaItem};
use content::thread::{LocalizedThreadPart, localized_thread};
use serde::{Serialize, Serializer};
use serde_json::{Value, json};

use crate::application::ports::{ApplicationPorts, DraftRecord, JsonObject};
use crate::publishing::chain_plan::{draft_content, planned_target_deliveries};
use crate::publishing::media_policy::{MediaPolicyMode, media_policy_for_target};
use crate::publishing::platform_profiles::{format_platform_text, platform_profile};
use crate::publishing::threads_text::is_threads_target;
use crate::targets::{TargetMap, is_story_target, target_locale};
use crate::{Error, Result};

/// One post as a thread consumer reads it: `{ text, entities, media }`.
pub(crate) fn serialize_posts<S: Serializer>(
    posts: &[LocalizedThreadPart],
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serializer.collect_seq(
        posts
            .iter()
            .map(|post| json!({ "text": post.text, "entities": post.entities, "media": post.media })),
    )
}

fn serialize_optional_posts<S: Serializer>(
    posts: &Option<Vec<LocalizedThreadPart>>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    serialize_posts(posts.as_deref().expect("skipped when absent"), serializer)
}

/// What a Threads account actually receives: every post cut at its own 500
/// characters, in order.
#[derive(Clone, Debug, PartialEq, Serialize)]
pub struct ThreadChain {
    pub target: String,
    #[serde(serialize_with = "serialize_posts")]
    pub posts: Vec<LocalizedThreadPart>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeliveryProjection {
    pub id: String,
    pub label: String,
    pub targets: Vec<String>,
    #[serde(skip_serializing_if = "Option::is_none", with = "crate::json::optional_locale")]
    pub locale: Option<Locale>,
    pub text: String,
    /// Native Telegram entities retained for a faithful delivery preview.
    pub entities: Vec<Entity>,
    pub media: Vec<MediaItem>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub unavailable_targets: Option<Vec<String>>,
    /// The posts after the first when the draft is a thread.
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "serialize_optional_posts")]
    pub thread: Option<Vec<LocalizedThreadPart>>,
    /// Not the same list as `thread`: a post the author made fit in Russian
    /// is cut again in English, and showing the written parts as though they
    /// were the sent ones is how a preview lied.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub chains: Option<Vec<ThreadChain>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub metadata: Option<JsonObject>,
    pub notes: Vec<String>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PostDeliveryProjections {
    pub kind: &'static str,
    pub draft_id: i64,
    pub projections: Vec<DeliveryProjection>,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VideoDeliveryProjections {
    pub kind: &'static str,
    pub publication_id: i64,
    pub projections: Vec<DeliveryProjection>,
    pub source: Option<JsonObject>,
    pub source_available: bool,
}

fn values(media: &[MediaItem]) -> Vec<Value> {
    media.iter().cloned().map(Value::Object).collect()
}

/// `storyCardsReady && isStoryTarget(target) ? [{}] : media`.
fn target_media(target: &str, media: &[MediaItem], story_cards_ready: bool) -> Vec<Value> {
    if story_cards_ready && is_story_target(target) {
        vec![json!({})]
    } else {
        values(media)
    }
}

fn unavailable(target: &str, media: &[Value]) -> bool {
    let policy = media_policy_for_target(target, media);
    policy.mode == MediaPolicyMode::StoryFirst && policy.input_count == 0
}

/// One platform-specific deviation note per locale, not a whole separate
/// preview per platform: with a dozen targets, most differing only by a
/// character limit or a dropped video, a full resend for every one buried
/// the two previews that matter.
pub fn post_delivery_projections(draft: &DraftRecord, story_cards_ready: bool) -> PostDeliveryProjections {
    let targets: Vec<String> = TargetMap::parse(Some(&draft.targets_json))
        .enabled()
        .map(str::to_owned)
        .collect();
    let source = draft_content(draft);
    let content = |locale: Locale| -> DraftLocaleContent { draft_locale_content(&source, locale) };
    let (ru, en) = (content(Locale::Ru), content(Locale::En));
    let of = |locale: Locale| if locale == Locale::Ru { &ru } else { &en };
    let mut deviation_notes: [Vec<String>; 2] = [Vec::new(), Vec::new()];
    for target in &targets {
        let locale = target_locale(target).unwrap_or(Locale::En);
        let content = of(locale);
        let text = format_platform_text(target, &content.text);
        let media = target_media(target, &content.media, story_cards_ready);
        let policy = media_policy_for_target(target, &media);
        let mut notes: Vec<String> = Vec::new();
        if text != content.text {
            notes.push("text is shortened/transformed for this platform".into());
        }
        if policy.mode == MediaPolicyMode::StoryFirst && policy.input_count == 0 {
            notes.push("requires media and will be skipped".into());
        }
        notes.extend(policy.note);
        if !notes.is_empty() {
            let label = platform_profile(target).map_or(target.as_str(), |profile| profile.label);
            deviation_notes[usize::from(locale == Locale::En)].push(format!("{label}: {}", notes.join("; ")));
        }
    }
    let deliveries = planned_target_deliveries(draft);
    let projections = [Locale::Ru, Locale::En]
        .into_iter()
        .filter_map(|locale| {
            let selected: Vec<&String> = targets
                .iter()
                .filter(|target| target_locale(target) == Some(locale))
                .collect();
            if selected.is_empty() {
                return None;
            }
            let content = of(locale);
            let unavailable_targets: Vec<String> = selected
                .iter()
                .filter(|target| unavailable(target, &target_media(target, &content.media, story_cards_ready)))
                .map(|target| (*target).clone())
                .collect();
            Some(DeliveryProjection {
                id: format!("post:{}:{}", draft.id, locale.as_str()),
                label: format!("Preview · {}", locale.as_str().to_uppercase()),
                targets: selected
                    .iter()
                    .filter(|target| !unavailable_targets.contains(target))
                    .map(|target| (*target).clone())
                    .collect(),
                locale: Some(locale),
                thread: Some(localized_thread(&draft.thread, locale)),
                chains: Some(
                    deliveries
                        .iter()
                        .filter(|delivery| {
                            delivery.locale == locale
                                && is_threads_target(&delivery.target)
                                && selected.contains(&&delivery.target)
                        })
                        .map(|delivery| ThreadChain {
                            target: delivery.target.clone(),
                            posts: delivery.posts.clone(),
                        })
                        .collect(),
                ),
                text: content.text.clone(),
                entities: content.entities.clone(),
                media: content.media.clone(),
                unavailable_targets: Some(unavailable_targets),
                metadata: None,
                notes: std::mem::take(&mut deviation_notes[usize::from(locale == Locale::En)]),
            })
        })
        .collect();
    PostDeliveryProjections {
        kind: "post",
        draft_id: draft.id,
        projections,
    }
}

/// Every platform of a video publication shows the same one file, so the
/// projections carry no media: the source is offered once, beside them.
pub fn video_delivery_projections(
    ports: ApplicationPorts<'_>,
    publication_id: i64,
) -> Result<VideoDeliveryProjections> {
    let videos = ports.studio_videos();
    let draft = videos
        .get(publication_id)?
        .ok_or_else(|| Error::message("Video publication was not found."))?;
    let asset = match draft.studio_media_asset_id {
        Some(id) => ports.studio_media_assets().get(id)?,
        None => None,
    };
    let source = asset.map(|asset| {
        let Value::Object(media) = json!({
            "type": "video", "asset_id": asset.id, "local_path": asset.asset.local_path,
            "filename": asset.asset.filename, "mime_type": asset.asset.mime_type,
        }) else {
            unreachable!("built as an object")
        };
        media
    });
    let projections = videos
        .targets(publication_id)?
        .into_iter()
        .map(|target| DeliveryProjection {
            id: format!("video:{publication_id}:{}", target.target),
            label: if target.target == "youtube_shorts" {
                "Preview · YouTube Shorts".into()
            } else {
                "Preview · Instagram Reels".into()
            },
            targets: vec![target.target],
            locale: None,
            text: String::new(),
            entities: Vec::new(),
            media: Vec::new(),
            unavailable_targets: Some(Vec::new()),
            thread: None,
            chains: None,
            metadata: Some(target.metadata_json),
            notes: Vec::new(),
        })
        .collect();
    Ok(VideoDeliveryProjections {
        kind: "video",
        publication_id,
        projections,
        source_available: source.is_some(),
        source,
    })
}
