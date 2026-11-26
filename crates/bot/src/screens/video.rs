//! The video area: the video publication card and everything on it: its 23 controls, the card renderer, the
//! MP4 → metadata → schedule conversation, the source preview and the intake's handoff into it.

mod actions;
mod conversation;
mod ingress;
mod preview;
mod scheduling;
mod state;

use domain::application::conversation_flow::PublicationKind;

use crate::callback::ScreenId;
use crate::registry::{Registry, VideoIntake};

pub use preview::video_preview_card;

pub fn register(registry: &mut Registry) {
    actions::register(registry);
    registry.renderer(PublicationKind::Video, preview::render_card);
    registry.publication_messages(PublicationKind::Video, conversation::handle_video_conversation_message);
    registry.screen(ScreenId::DeliveryPreviewVideo, preview::delivery_preview_video);
    registry.video_intake(VideoIntake {
        store: ingress::store_intake_video,
        attach: conversation::attach_intake_video,
    });
}
