use foundation::text::utf16_len;

use crate::Locale;
use crate::message::{Entity, MediaItem, entity_span};
use crate::text::split_text;

/// A post of a thread after the first, as it is stored. Positions start at 2.
#[derive(Clone, Debug, PartialEq)]
pub struct ThreadPart {
    pub position: i64,
    pub text_ru: String,
    pub entities_ru: Vec<Entity>,
    pub text_en: Option<String>,
    pub text_en_approved: Option<String>,
    pub media: Vec<MediaItem>,
}

/// One post of a thread in one language, as every consumer reads it.
#[derive(Clone, Debug, PartialEq)]
pub struct LocalizedThreadPart<M = MediaItem> {
    pub text: String,
    pub entities: Vec<Entity>,
    pub media: Vec<M>,
}

/// The posts after the first, in one language. English is the machine
/// translation; a part whose English has not arrived yet has no text, which
/// preflight refuses rather than publishing an empty reply.
pub fn localized_thread(thread: &[ThreadPart], locale: Locale) -> Vec<LocalizedThreadPart> {
    thread
        .iter()
        .map(|part| LocalizedThreadPart {
            text: match locale {
                Locale::Ru => part.text_ru.clone(),
                Locale::En => part
                    .text_en_approved
                    .clone()
                    .or_else(|| part.text_en.clone())
                    .unwrap_or_default(),
            },
            entities: match locale {
                Locale::Ru => part.entities_ru.clone(),
                Locale::En => Vec::new(),
            },
            media: part.media.clone(),
        })
        .collect()
}

/// The whole thread as one text, for the places that publish a single post:
/// the parts become paragraphs, and each part's entities move with it.
pub fn joined_thread<M>(text: &str, entities: &[Entity], rest: &[LocalizedThreadPart<M>]) -> (String, Vec<Entity>) {
    let mut text = text.trim_end().to_owned();
    let mut entities = entities.to_vec();
    for part in rest {
        let body = part.text.trim();
        if body.is_empty() {
            continue;
        }
        let lead = (utf16_len(&part.text) - utf16_len(part.text.trim_start())) as u64;
        let offset = (utf16_len(&text) + 2) as u64;
        text = format!("{text}\n\n{body}");
        let body_length = utf16_len(body) as u64;
        for entity in &part.entities {
            let Some((start, length)) = entity_span(entity) else {
                continue;
            };
            let Some(start) = start.checked_sub(lead).filter(|start| start + length <= body_length) else {
                continue;
            };
            let mut moved = entity.clone();
            moved.insert("offset".into(), (offset + start).into());
            entities.push(moved);
        }
    }
    (text, entities)
}

/// The posts a chain platform actually sends for one locale: every written post
/// cut to the platform's own budget, in order.
///
/// The author writes and edits Russian that fits; the English is a machine
/// translation of it and is routinely longer than the Russian it renders, so a
/// post the author made fit went out as a refusal in the other language. A
/// platform that carries a reply chain can carry that overflow as the reply it
/// would have been, and this is the one place that decides where the cut falls
/// -- preflight counts these posts and delivery sends them.
///
/// Media and entities stay with the first piece: they point into the text that
/// was written, and only that piece still holds it.
pub fn chain_posts<M: Clone>(posts: &[LocalizedThreadPart<M>], limit: usize) -> Vec<LocalizedThreadPart<M>> {
    posts
        .iter()
        .flat_map(|post| {
            split_text(&post.text, limit)
                .into_iter()
                .enumerate()
                .map(|(index, text)| {
                    let length = utf16_len(&text) as u64;
                    LocalizedThreadPart {
                        entities: if index == 0 {
                            post.entities
                                .iter()
                                .filter(|entity| {
                                    entity_span(entity).is_some_and(|(offset, span)| offset + span <= length)
                                })
                                .cloned()
                                .collect()
                        } else {
                            Vec::new()
                        },
                        media: if index == 0 { post.media.clone() } else { Vec::new() },
                        text,
                    }
                })
        })
        .collect()
}
