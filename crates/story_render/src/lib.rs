//! The Story-card renderer and its worker: queued `draft_story_cards` rows are
//! claimed one at a time, drawn into a 1080×1920 JPEG and settled as ready,
//! or retried and finally failed.

mod render;
mod svg;
mod worker;

pub use render::{StoryCardRender, render_story_card};
pub use svg::{STORY_CARD_HEIGHT, STORY_CARD_WIDTH, emoji_asset_file, story_card_emoji_top, story_card_overlay_svg};
pub use worker::{STORY_CARD_WORKER, StoryCardCycle, recover_story_card_jobs, run_story_card_cycle};
