//! Generated Story cards (`story-cards/store.ts`, `story-cards/copy.ts`): the
//! `draft_story_cards` rows the Studio and publishing queue, read and discard,
//! and the card copy each row carries. Rendering a queued card into its image
//! is the Story worker's (`worker.ts`, `svg.ts`), which is not here: a card
//! this module queues stays `queued` until a renderer runs.

mod copy;
mod store;

pub use copy::{StoryCardCopy, TEMPLATE_VERSION, story_card_copy};
pub use store::StoryCardStore;
