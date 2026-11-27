//! The one answer to "how many posts is this, and where do the cuts fall".

use content::Locale;
use content::draft_content::{DraftContentSource, draft_locale_content};
use content::thread::{LocalizedThreadPart, chain_posts, joined_thread, localized_thread};

use super::platform_profiles::{ThreadMode, platform_profile};
use crate::application::ports::DraftRecord;
use crate::targets::{TargetMap, target_locale};

/// What one target actually receives: the posts it will be sent, already cut
/// the way delivery cuts them.
#[derive(Clone, Debug, PartialEq)]
pub struct TargetDelivery {
    pub target: String,
    pub label: String,
    pub locale: Locale,
    pub posts: Vec<LocalizedThreadPart>,
    pub chained: bool,
}

/// A draft record's content columns as the content crate reads them.
pub(crate) fn draft_content(draft: &DraftRecord) -> DraftContentSource<'_> {
    DraftContentSource {
        text_ru: Some(&draft.text_ru),
        text_en_approved: draft.text_en_approved.as_deref(),
        text_en_machine: draft.text_en_machine.as_deref(),
        text_ru_entities_json: draft.text_ru_entities_json.as_deref(),
        text_en_entities_json: draft.text_en_entities_json.as_deref(),
        media_ru_json: draft.media_ru_json.as_deref(),
        media_en_json: draft.media_en_json.as_deref(),
    }
}

/// The author's Russian is cut to the Threads budget when it is saved, and
/// every language is cut again at delivery — the English machine translation
/// of a post that fit rarely does. Every surface that says anything about a
/// thread reads this, and delivery cuts with the same `chain_posts`.
pub fn planned_target_deliveries(draft: &DraftRecord) -> Vec<TargetDelivery> {
    let source = draft_content(draft);
    let content = [
        draft_locale_content(&source, Locale::Ru),
        draft_locale_content(&source, Locale::En),
    ];
    TargetMap::parse(Some(&draft.targets_json))
        .enabled()
        .map(|target| {
            let locale = target_locale(target).unwrap_or(Locale::Ru);
            let profile = platform_profile(target);
            let value = &content[usize::from(locale == Locale::En)];
            let thread = localized_thread(&draft.thread, locale);
            let chained = matches!(
                profile.and_then(|profile| profile.thread),
                Some(ThreadMode::Chain { .. })
            );
            let posts = if chained {
                let mut written = vec![LocalizedThreadPart {
                    text: value.text.clone(),
                    entities: value.entities.clone(),
                    media: value.media.clone(),
                }];
                written.extend(thread.iter().cloned());
                chain_posts(
                    &written,
                    profile.and_then(|profile| profile.limits.text).unwrap_or(usize::MAX),
                )
            } else {
                let (text, entities) = joined_thread(&value.text, &value.entities, &thread);
                let mut media = value.media.clone();
                media.extend(thread.iter().flat_map(|part| part.media.iter().cloned()));
                vec![LocalizedThreadPart { text, entities, media }]
            };
            TargetDelivery {
                target: target.to_owned(),
                label: profile.map_or(target, |profile| profile.label).to_owned(),
                locale,
                posts,
                chained,
            }
        })
        .collect()
}
