//! Telegram channel Stories over MTProto (grammers), in process: the
//! account's session file, posting one Story, and the one-time sign-in.
//!
//! [`MtprotoStories`] is the Studio's [`providers::adapters::StoriesClient`]; the
//! adapter in `providers::adapters::telegram_stories` does the guards, the caption, the
//! probe and the re-encode, and hands this crate one [`StoryRequest`].

mod connection;
pub mod session;
pub mod sign_in;
pub mod stories;

use std::path::PathBuf;

use foundation::config::{Config, SharedConfig};
use providers::adapters::telegram_stories::{StoriesClient, StoryError, StoryRequest};
use runtime::http::Fut;

pub use sign_in::{SignInPrompts, SignedIn, sign_in};
pub use stories::post_story;

/// The Stories account: `TELEGRAM_CHANNEL_STORIES_API_ID`, `_API_HASH`
/// (https://my.telegram.org) and `_SESSION`, the session file's path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Credentials {
    pub api_id: i32,
    pub api_hash: String,
    pub session: PathBuf,
}

impl Credentials {
    /// From the configuration; `None` when any of the three is unset.
    pub fn from_config(config: &Config) -> Result<Option<Self>, String> {
        let (Some(api_id), Some(api_hash), Some(session)) = (
            config.telegram_channel_stories_api_id.filter(|id| *id != 0),
            config
                .telegram_channel_stories_api_hash
                .as_deref()
                .filter(|hash| !hash.is_empty()),
            config
                .telegram_channel_stories_session
                .as_deref()
                .filter(|path| !path.is_empty()),
        ) else {
            return Ok(None);
        };
        let api_id = i32::try_from(api_id)
            .map_err(|_| format!("TELEGRAM_CHANNEL_STORIES_API_ID {api_id} is not an MTProto api_id"))?;
        Ok(Some(Self {
            api_id,
            api_hash: api_hash.to_owned(),
            session: PathBuf::from(session),
        }))
    }
}

/// Posts each Story with the Stories account as configured at that moment.
pub struct MtprotoStories {
    config: SharedConfig,
}

impl MtprotoStories {
    pub fn new(config: SharedConfig) -> Self {
        Self { config }
    }
}

impl StoriesClient for MtprotoStories {
    fn send_story<'a>(&'a self, request: &'a StoryRequest) -> Fut<'a, Result<i64, StoryError>> {
        Box::pin(async move {
            let credentials = Credentials::from_config(&self.config.load())
                .map_err(StoryError::Refused)?
                .ok_or_else(|| StoryError::Refused("missing_channel_story_credentials".into()))?;
            post_story(&credentials, request).await
        })
    }
}
