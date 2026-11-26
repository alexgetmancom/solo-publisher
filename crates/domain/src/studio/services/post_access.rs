//! Shared access and decoding rules for post use cases.

use content::Locale;
use content::message::MediaItem;
use foundation::config::Config;
use foundation::errors::StudioError;
use foundation::json::json_record_array;
use jiff::Timestamp;

use crate::application::ports::{ApplicationPorts, DraftRecord};
use crate::publishing::parse_ms;
use crate::publishing::state::is_post_draft_mutable;
use crate::studio::access::can_access_studio_owner;
use crate::{Error, Result};

/// Refuse material post edits shortly before delivery so one locale cannot
/// silently publish the old payload while another publishes the new one.
const POST_EDIT_LOCK_MINUTES: i64 = 2;

pub fn require_owned_draft(
    ports: ApplicationPorts<'_>,
    config: &Config,
    actor_id: i64,
    draft_id: i64,
) -> Result<DraftRecord> {
    let draft = ports
        .drafts()
        .get(draft_id)?
        .ok_or_else(|| Error::message(format!("draft {draft_id} not found")))?;
    if !can_access_studio_owner(config, actor_id, draft.actor_id) {
        return Err(StudioError::new("err.post-not-yours").into());
    }
    Ok(draft)
}

pub fn require_mutable_draft(
    ports: ApplicationPorts<'_>,
    config: &Config,
    actor_id: i64,
    draft_id: i64,
) -> Result<DraftRecord> {
    let draft = require_owned_draft(ports, config, actor_id, draft_id)?;
    if !is_post_draft_mutable(&draft.status) {
        return Err(StudioError::new("err.post-locked").into());
    }
    Ok(draft)
}

/// Prevents payload-changing edits from racing a due publication. The
/// schedule command remains available so an operator can explicitly replan a
/// draft; this guard applies to content, media, target and policy mutations.
/// `locale` narrows it to the one language being edited.
pub fn require_post_edit_allowed(
    ports: ApplicationPorts<'_>,
    config: &Config,
    actor_id: i64,
    draft_id: i64,
    now: Timestamp,
    locale: Option<Locale>,
) -> Result<DraftRecord> {
    let draft = require_mutable_draft(ports, config, actor_id, draft_id)?;
    let lock_until = now.as_millisecond() + POST_EDIT_LOCK_MINUTES * 60_000;
    let scheduled = match locale {
        Some(Locale::Ru) => vec![&draft.scheduled_at],
        Some(Locale::En) => vec![&draft.scheduled_en_at],
        None => vec![&draft.scheduled_at, &draft.scheduled_en_at],
    };
    if scheduled
        .into_iter()
        .filter_map(|value| value.as_deref().and_then(parse_ms))
        .any(|scheduled_at| scheduled_at <= lock_until)
    {
        return Err(StudioError::new("err.post-too-close-to-publish").into());
    }
    Ok(draft)
}

pub fn draft_media(draft: &DraftRecord, locale: Locale) -> Vec<MediaItem> {
    json_record_array(match locale {
        Locale::Ru => draft.media_ru_json.as_deref(),
        Locale::En => draft.media_en_json.as_deref(),
    })
}
