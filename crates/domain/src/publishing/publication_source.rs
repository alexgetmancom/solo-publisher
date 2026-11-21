//! The dual-locale publication source every delivery job is built from.

use content::Locale;
use content::message::{Entity, MediaItem};
use content::thread::LocalizedThreadPart;

use crate::targets::TargetMap;

#[derive(Clone, Debug, PartialEq)]
pub struct PublicationLocaleSource {
    pub text: String,
    pub entities: Vec<Entity>,
    pub media: Vec<MediaItem>,
    pub story_media: Vec<MediaItem>,
    pub site_media: Vec<MediaItem>,
    pub slug: String,
    pub publish_at: Option<String>,
    pub site_enabled: bool,
    /// The posts after the first, in this language.
    pub thread: Vec<LocalizedThreadPart>,
}

#[derive(Clone, Debug, PartialEq)]
pub struct PublicationSource {
    pub draft_id: i64,
    pub post_id: i64,
    pub targets: TargetMap,
    pub ru: PublicationLocaleSource,
    pub en: PublicationLocaleSource,
}

impl PublicationSource {
    pub fn locale(&self, locale: Locale) -> &PublicationLocaleSource {
        match locale {
            Locale::Ru => &self.ru,
            Locale::En => &self.en,
        }
    }
}
