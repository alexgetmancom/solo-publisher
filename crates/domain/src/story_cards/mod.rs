//! Generated Story cards: the
//! `draft_story_cards` rows the Studio and publishing queue, read and discard,
//! and the card copy each row carries. Rendering a queued card into its image
//! is the Story worker's, in the `story_render` crate.

mod copy;
mod store;

pub use copy::{MAX_LINES, StoryCardCopy, TEMPLATE_VERSION, story_card_copy};
pub use store::StoryCardStore;
