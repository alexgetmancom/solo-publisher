use foundation::json::json_record_array;

use crate::Locale;
use crate::message::{Entity, MediaItem};

/// A draft row's content columns, as stored: JSON columns are JSON text.
#[derive(Clone, Copy, Debug, Default)]
pub struct DraftContentSource<'a> {
    pub text_ru: Option<&'a str>,
    pub text_en_approved: Option<&'a str>,
    pub text_en_machine: Option<&'a str>,
    pub text_ru_entities_json: Option<&'a str>,
    pub text_en_entities_json: Option<&'a str>,
    pub media_ru_json: Option<&'a str>,
    pub media_en_json: Option<&'a str>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct DraftLocaleContent {
    pub text: String,
    pub entities: Vec<Entity>,
    pub media: Vec<MediaItem>,
    /// The media this locale has of its own, before it borrows the other's.
    /// Images carry no language so borrowing them is right at delivery time — but
    /// it is not evidence that this locale has anything to publish.
    pub own_media: Vec<MediaItem>,
}

/// Resolves the content that a locale actually receives at delivery time.
pub fn draft_locale_content(draft: &DraftContentSource, locale: Locale) -> DraftLocaleContent {
    let ru_media = json_record_array(draft.media_ru_json);
    match locale {
        Locale::Ru => DraftLocaleContent {
            text: draft.text_ru.unwrap_or("").to_owned(),
            entities: json_record_array(draft.text_ru_entities_json),
            media: ru_media.clone(),
            own_media: ru_media,
        },
        Locale::En => {
            let en_media = json_record_array(draft.media_en_json);
            DraftLocaleContent {
                // No fallback to `text_ru` here: borrowing the Russian text is how an
                // English target published Russian. A locale with nothing in it reads
                // as empty, and preflight refuses to publish that.
                text: draft
                    .text_en_approved
                    .or(draft.text_en_machine)
                    .unwrap_or("")
                    .to_owned(),
                entities: json_record_array(draft.text_en_entities_json),
                media: if en_media.is_empty() {
                    ru_media
                } else {
                    en_media.clone()
                },
                own_media: en_media,
            }
        }
    }
}
