//! The pure publishing decision: draft content plus a schedule becomes a
//! complete publication plan.

use content::Locale;
use content::draft_content::draft_locale_content;
use content::message::{MediaItem, first_line, slugify};
use content::text::entities_to_html;
use content::thread::{LocalizedThreadPart, joined_thread, localized_thread};
use serde::Deserialize;

use super::boundaries::StoryCardMedia;
use super::chain_plan::draft_content;
use super::publication_source::{PublicationLocaleSource, PublicationSource};
use super::targets::assert_known_targets;
use crate::Result;
use crate::application::ports::DraftRecord;
use crate::application::publication_ref::{PublicationRefKind, publication_ref};
use crate::targets::{TargetMap, is_story_target, target_locale};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum PublishMode {
    Immediate,
    Scheduled,
}

impl PublishMode {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Immediate => "immediate",
            Self::Scheduled => "scheduled",
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct PublicationSchedule {
    pub mode: PublishMode,
    pub ru_at: Option<String>,
    pub en_at: Option<String>,
}

/// The targets a plan actually delivers to. A generated card gates a Story
/// target behind the editor's explicit choice, but it never revives a target
/// the editor switched off; and without the registry's word nothing is cut.
pub fn effective_publication_targets(
    requested: &TargetMap,
    available_targets: Option<&[String]>,
    media_counts: [usize; 2],
    generated_story_cards: bool,
    story_publish_mode: Option<&str>,
) -> TargetMap {
    requested.map(|target, enabled| {
        let story = is_story_target(target);
        let has_media = match target_locale(target) {
            Some(Locale::Ru) => media_counts[0] > 0,
            Some(Locale::En) => media_counts[1] > 0,
            None => false,
        };
        enabled
            && (!story || generated_story_cards || has_media)
            && (!generated_story_cards || !story || story_publish_mode == Some("all"))
            && available_targets.is_none_or(|available| available.iter().any(|known| known == target))
    })
}

/// One locale of a plan: the page HTML and the entities column it writes.
#[derive(Clone, Debug, PartialEq)]
pub struct PlanLocale {
    pub locale: Locale,
    pub html: String,
    pub entities_json: Option<String>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PublicationPlan {
    pub draft_id: i64,
    pub post_id: i64,
    pub publication_key: String,
    pub mode: PublishMode,
    pub ru_at: Option<String>,
    pub en_at: Option<String>,
    pub now: String,
    pub media_ru: Vec<MediaItem>,
    pub targets: TargetMap,
    pub text_ru: String,
    pub text_en: String,
    /// The source every target's job is localized from.
    pub payload: PublicationSource,
    pub locales: [PlanLocale; 2],
}

#[allow(clippy::too_many_arguments)]
fn locale_source(
    text: &str,
    entities: &[content::message::Entity],
    media: &[MediaItem],
    story_media: Vec<MediaItem>,
    slug: String,
    publish_at: Option<String>,
    site_enabled: bool,
    thread: Vec<LocalizedThreadPart>,
) -> PublicationLocaleSource {
    // The site shows a thread as one page: every post's pictures belong to it.
    let site_media = media
        .iter()
        .chain(thread.iter().flat_map(|part| part.media.iter()))
        .cloned()
        .collect();
    PublicationLocaleSource {
        text: text.to_owned(),
        entities: entities.to_vec(),
        media: media.to_vec(),
        story_media,
        site_media,
        slug,
        publish_at,
        site_enabled,
        thread,
    }
}

pub fn create_publication_plan(
    draft: &DraftRecord,
    draft_id: i64,
    post_id: i64,
    schedule: &PublicationSchedule,
    now: &str,
    available_targets: Option<&[String]>,
    story_cards: Option<&StoryCardMedia>,
) -> Result<PublicationPlan> {
    let parsed_targets = TargetMap::parse(Some(&draft.targets_json));
    assert_known_targets(&parsed_targets)?;
    let source = draft_content(draft);
    let ru = draft_locale_content(&source, Locale::Ru);
    let en = draft_locale_content(&source, Locale::En);
    let targets = effective_publication_targets(
        &parsed_targets,
        available_targets,
        [ru.media.len(), en.media.len()],
        story_cards.is_some(),
        draft.story_publish_mode.as_deref(),
    );
    // An empty first line leaves the slug to `slugify`, which names the post
    // by its own id.
    let slug_ru = slugify(first_line(Some(&ru.text), ""), post_id);
    let slug_en = slugify(first_line(Some(&en.text), ""), post_id);
    let thread_ru = localized_thread(&draft.thread, Locale::Ru);
    let thread_en = localized_thread(&draft.thread, Locale::En);
    let page_ru = joined_thread(&ru.text, &ru.entities, &thread_ru);
    let page_en = joined_thread(&en.text, &en.entities, &thread_en);
    let payload = PublicationSource {
        draft_id,
        post_id,
        ru: locale_source(
            &ru.text,
            &ru.entities,
            &ru.media,
            story_cards.map(|cards| vec![cards.ru.clone()]).unwrap_or_default(),
            slug_ru,
            schedule.ru_at.clone(),
            targets.get("site_ru"),
            thread_ru,
        ),
        en: locale_source(
            &en.text,
            &en.entities,
            &en.media,
            story_cards.map(|cards| vec![cards.en.clone()]).unwrap_or_default(),
            slug_en,
            schedule.en_at.clone(),
            targets.get("site_en"),
            thread_en,
        ),
        targets: targets.clone(),
    };
    Ok(PublicationPlan {
        draft_id,
        post_id,
        publication_key: publication_ref(PublicationRefKind::Post, post_id),
        mode: schedule.mode,
        ru_at: schedule.ru_at.clone(),
        en_at: schedule.en_at.clone(),
        now: now.to_owned(),
        media_ru: ru.media,
        targets,
        text_ru: ru.text,
        text_en: en.text,
        payload,
        locales: [
            PlanLocale {
                locale: Locale::Ru,
                html: entities_to_html(&page_ru.0, &page_ru.1),
                entities_json: draft.text_ru_entities_json.clone(),
            },
            PlanLocale {
                locale: Locale::En,
                html: entities_to_html(&page_en.0, &page_en.1),
                entities_json: draft.text_en_entities_json.clone(),
            },
        ],
    })
}
