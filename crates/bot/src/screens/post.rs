//! The post area: the text post card and everything on it: its 25 controls, the card renderer, the
//! message handler of the post conversation, the Story-card choice and the publication-progress card.

mod actions;
mod flow;
mod input;
mod preview;
mod progress;
mod screen;
mod story_cards;

use domain::application::conversation_flow::PublicationKind;

use crate::registry::Registry;

pub use preview::{draft_preview, is_draft_view, mode_label, post_preview_card};
pub use progress::{refresh_post_control_card, refresh_post_preview_card, render_post_progress};
pub use screen::create_post_from_message;
pub use story_cards::{set_story_card_poll, story_card_waiters_settled};

pub fn register(registry: &mut Registry) {
    actions::register(registry);
    registry.renderer(PublicationKind::Post, preview::render_card);
    registry.publication_messages(PublicationKind::Post, screen::handle_post_message);
    progress::register(registry);
}
