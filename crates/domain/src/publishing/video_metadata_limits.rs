//! What each platform accepts, checked where the text is typed. The budgets
//! sit under the platform's real ceiling on purpose: a limit met exactly is a
//! limit crossed by the next emoji, and a description gains a signature line
//! before it is sent.

use foundation::errors::StudioError;
use foundation::text::utf16_len;
use serde_json::{Map, Value};

use super::video_types::VideoTarget;

/// YouTube: 100.
pub const YOUTUBE_TITLE: usize = 95;
/// YouTube: 5000, and this Studio appends a game link and a signature.
pub const YOUTUBE_DESCRIPTION: usize = 4_800;
/// YouTube: 500, counted the way [`youtube_tags_length`] explains.
pub const YOUTUBE_TAGS: usize = 470;
/// YouTube accepts more, but a tag this long is a sentence, not a keyword.
pub const YOUTUBE_TAG: usize = 60;
/// Instagram: 2200.
pub const INSTAGRAM_CAPTION: usize = 2_100;

/// How YouTube measures a tag list: the serialized list, not the sum of its
/// tags. Tags are joined by commas, a tag containing a space is wrapped in
/// quotes, and every one of those characters counts against the 500.
pub fn youtube_tags_length(tags: &[String]) -> usize {
    tags.iter()
        .map(|tag| utf16_len(tag) + if tag.contains(' ') { 2 } else { 0 })
        .sum::<usize>()
        + tags.len().saturating_sub(1)
}

fn over(code: &str, used: usize, limit: usize) -> StudioError {
    StudioError::new(code)
        .with_param("used", used)
        .with_param("limit", limit)
        .with_param("over", used - limit)
}

fn text<'a>(metadata: &'a Map<String, Value>, key: &str) -> &'a str {
    metadata.get(key).and_then(Value::as_str).unwrap_or("")
}

/// Rejects text a platform would refuse, naming what to cut and by how much.
pub fn assert_video_metadata(target: VideoTarget, metadata: &Map<String, Value>) -> Result<(), StudioError> {
    if target == VideoTarget::InstagramReels {
        return assert_instagram_caption(text(metadata, "caption"));
    }
    assert_youtube_title(text(metadata, "title"))?;
    assert_youtube_description(text(metadata, "description"))?;
    let tags: Vec<String> = metadata
        .get("tags")
        .and_then(Value::as_array)
        .map(|tags| tags.iter().filter_map(Value::as_str).map(str::to_owned).collect())
        .unwrap_or_default();
    assert_youtube_tags(&tags)
}

pub fn assert_instagram_caption(caption: &str) -> Result<(), StudioError> {
    let used = utf16_len(caption);
    if used > INSTAGRAM_CAPTION {
        return Err(over("err.video-caption-too-long", used, INSTAGRAM_CAPTION));
    }
    Ok(())
}

pub fn assert_youtube_title(title: &str) -> Result<(), StudioError> {
    let used = utf16_len(title);
    if used > YOUTUBE_TITLE {
        return Err(over("err.video-title-too-long", used, YOUTUBE_TITLE));
    }
    // YouTube refuses these outright, and a title is where a stray one lands.
    if title.contains('<') || title.contains('>') {
        return Err(StudioError::new("err.video-title-brackets"));
    }
    Ok(())
}

pub fn assert_youtube_description(description: &str) -> Result<(), StudioError> {
    let used = utf16_len(description);
    if used > YOUTUBE_DESCRIPTION {
        return Err(over("err.video-description-too-long", used, YOUTUBE_DESCRIPTION));
    }
    Ok(())
}

/// No cap on how many: YouTube has none, and the budget is the real constraint.
pub fn assert_youtube_tags(tags: &[String]) -> Result<(), StudioError> {
    if let Some(long) = tags.iter().find(|tag| utf16_len(tag) > YOUTUBE_TAG) {
        return Err(StudioError::new("err.video-tag-too-long")
            .with_param("tag", long)
            .with_param("limit", YOUTUBE_TAG));
    }
    let used = youtube_tags_length(tags);
    if used > YOUTUBE_TAGS {
        return Err(over("err.video-tags-too-long", used, YOUTUBE_TAGS));
    }
    Ok(())
}
