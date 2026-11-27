//! Constraints that must block a plan. Delivery still validates defensively,
//! but a new draft must never become a partial publication merely because a
//! selected target cannot accept what it carries.

use serde::Serialize;
use std::collections::BTreeMap;

use content::Locale;
use content::draft_content::draft_locale_content;
use content::text::split_text;
use content::text_locale::text_locale;
use content::thread::{LocalizedThreadPart, chain_posts, joined_thread, localized_thread};
use foundation::errors::StudioError;
use foundation::text::utf16_len;
use serde_json::Value;

use super::chain_plan::draft_content;
use super::platform_profiles::{ThreadMode, format_platform_text, platform_profile};
use super::targets::assert_known_targets;
use super::threads_text::{is_threads_target, threads_body, threads_text_limit};
use crate::Result;
use crate::application::ports::DraftRecord;
use crate::targets::{TargetMap, target_locale};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum PreflightKind {
    TextLimit,
    CaptionLimit,
    MediaLimit,
    MediaSize,
    Language,
    Empty,
}

impl PreflightKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::TextLimit => "text-limit",
            Self::CaptionLimit => "caption-limit",
            Self::MediaLimit => "media-limit",
            Self::MediaSize => "media-size",
            Self::Language => "language",
            Self::Empty => "empty",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PublicationPreflightIssue {
    pub target: String,
    #[serde(with = "crate::json::locale")]
    pub locale: Locale,
    /// What is wrong, for surfaces to word in their own locale.
    pub kind: PreflightKind,
    pub label: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub limit: Option<f64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub actual: Option<f64>,
    /// The language the text is actually written in, on a `language` issue.
    #[serde(skip_serializing_if = "Option::is_none", with = "crate::json::optional_locale")]
    pub written: Option<Locale>,
    /// Which post of a thread is at fault; absent for the first post.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub part: Option<usize>,
    /// How many posts the text would make as a thread, on a first post that
    /// goes to a platform carrying one: the "make it a thread" button keys off it.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub thread_parts: Option<usize>,
}

impl PublicationPreflightIssue {
    fn new(target: &str, locale: Locale, kind: PreflightKind, label: &str) -> Self {
        Self {
            target: target.to_owned(),
            locale,
            kind,
            label: label.to_owned(),
            limit: None,
            actual: None,
            written: None,
            part: None,
            thread_parts: None,
        }
    }
}

/// A channel's own attachment limits, by target (`channelUploadLimits`).
pub type UploadLimits = BTreeMap<String, u64>;

/// The attachment's size in bytes, 0 when unknown.
fn file_size(item: &serde_json::Map<String, Value>) -> f64 {
    match item.get("file_size") {
        None | Some(Value::Null) => 0.0,
        Some(size) => size.as_f64().unwrap_or(f64::NAN),
    }
}

pub fn publication_preflight(draft: &DraftRecord, upload_limits: &UploadLimits) -> Vec<PublicationPreflightIssue> {
    let source = draft_content(draft);
    let content = [
        draft_locale_content(&source, Locale::Ru),
        draft_locale_content(&source, Locale::En),
    ];
    let targets = TargetMap::parse(Some(&draft.targets_json));
    targets
        .enabled()
        .flat_map(|target| {
            let profile = platform_profile(target);
            let locale = target_locale(target).unwrap_or(Locale::Ru);
            let value = &content[usize::from(locale == Locale::En)];
            let label = profile.map_or(target, |profile| profile.label);
            let thread = localized_thread(&draft.thread, locale);
            let issue = |kind| PublicationPreflightIssue::new(target, locale, kind, label);
            // A target publishes into one language, and the draft either has
            // that language or it does not. Its own media counts, not the
            // Russian images it would borrow.
            if value.text.trim().is_empty() && value.own_media.is_empty() {
                return vec![issue(PreflightKind::Empty)];
            }
            // A platform that refuses an oversized attachment refuses the whole
            // message that carried it, text and all.
            let attachment_limit = upload_limits
                .get(target)
                .copied()
                .or_else(|| profile.and_then(|profile| profile.limits.attachment))
                .filter(|limit| *limit > 0);
            if let Some(limit) = attachment_limit
                && let Some(size) = value
                    .media
                    .iter()
                    .chain(thread.iter().flat_map(|part| part.media.iter()))
                    .map(file_size)
                    .find(|size| *size > limit as f64)
            {
                return vec![PublicationPreflightIssue {
                    limit: Some(limit as f64),
                    actual: Some(size),
                    ..issue(PreflightKind::MediaSize)
                }];
            }
            // A part whose English has not arrived would be an empty reply.
            if let Some(index) = thread.iter().position(|part| part.text.trim().is_empty()) {
                return vec![PublicationPreflightIssue {
                    part: Some(index + 2),
                    ..issue(PreflightKind::Empty)
                }];
            }
            // Only a text that says what it is blocks.
            if let Some(written) = text_locale(&value.text).filter(|written| *written != locale) {
                return vec![PublicationPreflightIssue {
                    written: Some(written),
                    ..issue(PreflightKind::Language)
                }];
            }
            let mode = profile.and_then(|profile| profile.thread);
            let thread_media: usize = thread.iter().map(|part| part.media.len()).sum();
            // Telegram carries a thread as one rich message, which has its own
            // budget and no caption.
            if let Some(ThreadMode::Rich {
                text_limit,
                media_limit,
            }) = mode
                && !thread.is_empty()
            {
                let joined = utf16_len(&joined_thread(&value.text, &value.entities, &thread).0);
                let media = value.media.len() + thread_media;
                if joined > text_limit {
                    return vec![PublicationPreflightIssue {
                        limit: Some(text_limit as f64),
                        actual: Some(joined as f64),
                        ..issue(PreflightKind::TextLimit)
                    }];
                }
                if media > media_limit {
                    return vec![PublicationPreflightIssue {
                        limit: Some(media_limit as f64),
                        actual: Some(media as f64),
                        ..issue(PreflightKind::MediaLimit)
                    }];
                }
                return Vec::new();
            }
            if let Some(ThreadMode::Chain { reply_media_limit }) = mode
                && let Some(index) = thread.iter().position(|part| part.media.len() > reply_media_limit)
            {
                return vec![PublicationPreflightIssue {
                    limit: Some(reply_media_limit as f64),
                    actual: Some(thread[index].media.len() as f64),
                    part: Some(index + 2),
                    ..issue(PreflightKind::MediaLimit)
                }];
            }
            let measure = |text: &str, entities: &[content::message::Entity]| {
                if is_threads_target(target) {
                    threads_body(target, text, entities).text
                } else {
                    format_platform_text(target, text)
                }
            };
            let text_limit = profile.and_then(|profile| profile.limits.text);
            // A chain platform cuts a post that does not fit into the replies
            // it would have been, so what is measured is those posts.
            let posts: Vec<(String, usize)> = if matches!(mode, Some(ThreadMode::Chain { .. })) {
                let mut written = vec![LocalizedThreadPart {
                    text: value.text.clone(),
                    entities: value.entities.clone(),
                    media: value.media.clone(),
                }];
                written.extend(thread.iter().cloned());
                chain_posts(&written, text_limit.unwrap_or(usize::MAX))
                    .iter()
                    .map(|post| (measure(&post.text, &post.entities), post.media.len()))
                    .collect()
            } else {
                let joined = joined_thread(&value.text, &value.entities, &thread).0;
                vec![(measure(&joined, &[]), value.media.len() + thread_media)]
            };
            let caption_limit = profile.and_then(|profile| profile.limits.caption);
            posts
                .iter()
                .enumerate()
                .flat_map(|(index, (text, media))| {
                    let length = utf16_len(text);
                    [
                        (PreflightKind::TextLimit, text_limit, true),
                        (PreflightKind::CaptionLimit, caption_limit, *media > 0),
                    ]
                    .into_iter()
                    .filter_map(|(kind, limit, applies)| {
                        let limit = limit.filter(|limit| applies && *limit > 0 && length > *limit)?;
                        Some(PublicationPreflightIssue {
                            limit: Some(limit as f64),
                            actual: Some(length as f64),
                            part: (index > 0).then_some(index + 1),
                            // A thread is cut at the Threads budget whatever the
                            // overflow was, and an existing thread grows by the
                            // pieces its first post makes.
                            thread_parts: (mode.is_some() && index == 0)
                                .then(|| split_text(text, threads_text_limit("threads_ru")).len() + thread.len()),
                            ..issue(kind)
                        })
                    })
                    .collect::<Vec<_>>()
                })
                .collect()
        })
        .collect()
}

pub fn assert_publication_preflight(draft: &DraftRecord, upload_limits: &UploadLimits) -> Result<()> {
    let targets = TargetMap::parse(Some(&draft.targets_json));
    assert_known_targets(&targets)?;
    // The caller has already narrowed these to the targets with a connected
    // channel, so an empty set is a publication with nowhere to go.
    if !targets.any_enabled() {
        return Err(StudioError::new("err.post-no-targets").into());
    }
    if let Some(issue) = publication_preflight(draft, upload_limits).first() {
        return Err(StudioError::new("err.post-preflight")
            .with_param("target", &issue.label)
            .with_param("reason", issue.kind.as_str())
            .into());
    }
    Ok(())
}
