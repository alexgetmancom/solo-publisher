//! Every post target described as data: its locale, capabilities, limits and
//! media semantics in one place, not as target checks spread between the
//! interface and delivery code.

use std::sync::LazyLock;

use content::Locale;
use regex::Regex;

use crate::targets::{TARGETS, TargetKind};

/// Each mode carries what it needs to be applied: a `limited` rule without its
/// limit and label, or a first/story-first rule without its note, used to
/// degrade silently into "deliver everything".
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum MediaRule {
    All,
    Limited { limit: usize, label: &'static str },
    First { note: &'static str },
    StoryFirst { note: &'static str },
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct MediaContract {
    pub rule: MediaRule,
    pub when_video: Option<MediaRule>,
}

/// How a thread reaches a platform. `Chain` posts each part as a reply to the
/// one before; `Rich` sends the whole thread as one message; a platform with
/// neither publishes one post and the parts are joined into it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ThreadMode {
    Chain { reply_media_limit: usize },
    Rich { text_limit: usize, media_limit: usize },
}

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Limits {
    pub text: Option<usize>,
    pub caption: Option<usize>,
    /// A floor the platform enforces for everyone; a connected channel may
    /// report a higher one of its own, which preflight prefers.
    pub attachment: Option<u64>,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Capabilities {
    pub text: bool,
    pub image: bool,
    pub video: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct VideoBoundsTable {
    pub landscape: (u32, u32),
    pub portrait: (u32, u32),
    pub square: (u32, u32),
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Analytics {
    pub enabled: bool,
    pub source: &'static str,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PlatformProfile {
    pub id: &'static str,
    pub label: &'static str,
    pub locale: Locale,
    pub kind: TargetKind,
    pub capabilities: Capabilities,
    pub requirements: &'static [&'static str],
    pub remove_urls: bool,
    pub limits: Limits,
    pub media: Option<MediaContract>,
    pub thread: Option<ThreadMode>,
    pub video: Option<VideoBoundsTable>,
    pub analytics: Analytics,
}

const THREADS_VIDEO: VideoBoundsTable = VideoBoundsTable {
    landscape: (1920, 1080),
    portrait: (1080, 1920),
    square: (1080, 1080),
};
const STORY_NOTE: &str = "Stories use a single rendered asset made from the first source item.";
const ALL_CAPABILITIES: Capabilities = Capabilities {
    text: true,
    image: true,
    video: true,
};
const NO_VIDEO: Capabilities = Capabilities {
    text: true,
    image: true,
    video: false,
};
const X_REQUIREMENTS: &[&str] = &["X_CLIENT_ID", "X_CLIENT_SECRET", "X_ACCESS_TOKEN", "X_REFRESH_TOKEN"];

fn media(rule: MediaRule) -> Option<MediaContract> {
    Some(MediaContract { rule, when_video: None })
}

fn analytics_source(id: &str) -> Option<&'static str> {
    Some(match id {
        "telegram" => "t_me_public",
        "threads_ru" | "threads_en" => "threads_insights_api",
        "x" => "x_api",
        "telegram_stories" => "telegram_story_api",
        "instagram_stories" | "instagram_stories_ru" => "instagram_graph_api",
        _ => return None,
    })
}

fn requirements(id: &str) -> &'static [&'static str] {
    match id {
        "telegram" => &["CONTROLLER_BOT_TOKEN"],
        "threads_ru" => &["THREADS_RU_ACCESS_TOKEN"],
        "threads_en" => &["THREADS_EN_ACCESS_TOKEN"],
        "x" | "x_article" => X_REQUIREMENTS,
        "discord" => &["DISCORD_BOT_TOKEN", "DISCORD_CHANNEL_ID"],
        "telegram_stories" => &[
            "TELEGRAM_CHANNEL_STORIES_API_ID",
            "TELEGRAM_CHANNEL_STORIES_API_HASH",
            "TELEGRAM_CHANNEL_STORIES_SESSION",
        ],
        "instagram_stories" => &["INSTAGRAM_EN_USER_ID", "INSTAGRAM_EN_ACCESS_TOKEN"],
        "instagram_stories_ru" => &["INSTAGRAM_RU_USER_ID", "INSTAGRAM_RU_ACCESS_TOKEN"],
        _ => &[],
    }
}

/// The overrides every target declares beyond its catalogue entry.
fn override_profile(profile: &mut PlatformProfile) {
    match profile.id {
        "telegram" => {
            profile.capabilities = ALL_CAPABILITIES;
            profile.limits = Limits {
                text: Some(4096),
                caption: Some(1024),
                attachment: None,
            };
            profile.media = media(MediaRule::Limited {
                limit: 10,
                label: "Telegram",
            });
            // Bot API 10.1 sendRichMessage: one message, 32768 characters, 50 media.
            profile.thread = Some(ThreadMode::Rich {
                text_limit: 32768,
                media_limit: 50,
            });
        }
        "site_ru" | "site_en" | "x_article" => {
            profile.capabilities = NO_VIDEO;
            profile.media = media(MediaRule::All);
        }
        // 500 is the Threads API's own hard cap on a single post, and it binds
        // every part of a thread: a post over it becomes the replies it would
        // have been. A reply here is a single image or video.
        "threads_ru" | "threads_en" => {
            profile.capabilities = ALL_CAPABILITIES;
            profile.limits.text = Some(500);
            profile.thread = Some(ThreadMode::Chain { reply_media_limit: 1 });
            profile.media = media(MediaRule::All);
            profile.video = Some(THREADS_VIDEO);
        }
        "x" => {
            profile.capabilities = ALL_CAPABILITIES;
            profile.remove_urls = true;
            profile.media = media(MediaRule::All);
            profile.thread = Some(ThreadMode::Chain { reply_media_limit: 4 });
        }
        // Discord's own cap on `content` is 2000; the adapter splits longer
        // text. 10 MB is what an unboosted server takes, and going over it makes
        // Discord refuse the whole message, so preflight rejects it.
        "discord" => {
            profile.capabilities = ALL_CAPABILITIES;
            profile.limits = Limits {
                text: Some(2000),
                caption: None,
                attachment: Some(10_485_760),
            };
            profile.media = media(MediaRule::Limited {
                limit: 10,
                label: "Discord",
            });
        }
        "telegram_stories" | "instagram_stories_ru" | "instagram_stories" => {
            profile.capabilities = ALL_CAPABILITIES;
            profile.media = media(MediaRule::StoryFirst { note: STORY_NOTE });
        }
        other => unreachable!("target {other} has no platform profile"),
    }
}

/// The single publishing-facing catalogue of a target's capabilities and
/// runtime requirements.
pub static PLATFORM_PROFILES: LazyLock<Vec<PlatformProfile>> = LazyLock::new(|| {
    TARGETS
        .iter()
        .map(|target| {
            let mut profile = PlatformProfile {
                id: target.id,
                label: target.label,
                locale: target.locale,
                kind: target.kind,
                capabilities: NO_VIDEO,
                requirements: requirements(target.id),
                remove_urls: false,
                limits: Limits::default(),
                media: None,
                thread: None,
                video: None,
                analytics: match analytics_source(target.id) {
                    Some(source) => Analytics { enabled: true, source },
                    None => Analytics {
                        enabled: false,
                        source: "unsupported",
                    },
                },
            };
            override_profile(&mut profile);
            profile
        })
        .collect()
});

pub fn platform_profile(target: &str) -> Option<&'static PlatformProfile> {
    PLATFORM_PROFILES.iter().find(|profile| profile.id == target)
}

/// One catalogue for publishing, validation and analytics capability.
pub fn platform_analytics_profile(target: &str) -> Analytics {
    platform_profile(target).map_or(
        Analytics {
            enabled: false,
            source: "unsupported",
        },
        |profile| profile.analytics,
    )
}

/// JavaScript's `\S`: anything but its whitespace and line terminators.
static URL: LazyLock<Regex> = LazyLock::new(|| {
    Regex::new(
        r"https?://[^\t\n\x0B\x0C\r \x{a0}\x{1680}\x{2000}-\x{200a}\x{2028}\x{2029}\x{202f}\x{205f}\x{3000}\x{feff}]+",
    )
    .unwrap()
});
static SPACES: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]{2,}").unwrap());
static BEFORE_NEWLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"[ \t]+\n").unwrap());
static AFTER_NEWLINE: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"\n[ \t]+").unwrap());

/// The text a platform that strips URLs receives. Paragraph breaks survive:
/// `\s` also matches newlines, which used to turn two paragraphs into one
/// sentence on X after a URL was removed.
pub fn format_platform_text(target: &str, text: &str) -> String {
    if !platform_profile(target).is_some_and(|profile| profile.remove_urls) {
        return text.to_owned();
    }
    let text = URL.replace_all(text, "");
    let text = SPACES.replace_all(&text, " ");
    let text = BEFORE_NEWLINE.replace_all(&text, "\n");
    let text = AFTER_NEWLINE.replace_all(&text, "\n");
    foundation::js::trim(&text).to_owned()
}

/// The largest frame a platform takes for a video of this shape.
pub fn video_bounds(target: &str, width: u32, height: u32) -> Option<(u32, u32)> {
    let bounds = platform_profile(target)?.video?;
    Some(if width > height {
        bounds.landscape
    } else if height > width {
        bounds.portrait
    } else {
        bounds.square
    })
}
