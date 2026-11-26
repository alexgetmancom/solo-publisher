//! The keyboards dialogs share.

use domain::application::conversation_flow::PublicationKind;
use foundation::i18n::{Key, t};

use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{ScreenId, publication_callback, screen, versioned_callback};
use crate::context::Ctx;
use crate::effects::Effect;
use crate::session::publication_session_kind;

/// A label and the callback it sends.
pub struct DialogButton<'a> {
    pub label: &'a str,
    pub callback: &'a str,
}

/// `appendCancelButton`.
pub fn append_cancel_button(keyboard: InlineKeyboard, callback: &str, revision: Option<i64>) -> InlineKeyboard {
    keyboard.text(t(Key::CommonCancel, &[]), versioned_callback(callback, revision))
}

/// `cancelPromptKeyboard`.
pub fn cancel_prompt_keyboard(callback: &str, revision: Option<i64>) -> InlineKeyboard {
    append_cancel_button(InlineKeyboard::new(), callback, revision)
}

/// `promptEffect`: asks for one value under the cancel button of the dialog
/// it belongs to, stamped with that dialog's revision.
pub fn prompt_effect(ctx: &Ctx, kind: PublicationKind, text: &str, plain_text: bool) -> crate::Result<Effect> {
    let revision = ctx
        .sessions()
        .get(ctx.actor_id(), publication_session_kind(kind))?
        .map(|state| state.revision);
    let cancel = publication_callback(kind, "cancel_dialog", &[], None)?;
    let mut options = Payload::new();
    if !plain_text {
        options = options.markdown();
    }
    Ok(Effect::Screen {
        text: text.to_owned(),
        options: options.reply_markup(cancel_prompt_keyboard(&cancel, revision)),
        card: None,
    })
}

/// `confirmationKeyboard`.
pub fn confirmation_keyboard(confirm: DialogButton, back: DialogButton, revision: Option<i64>) -> InlineKeyboard {
    append_confirmation_row(InlineKeyboard::new(), confirm, back, revision)
}

/// `appendConfirmationRow`.
pub fn append_confirmation_row(
    keyboard: InlineKeyboard,
    confirm: DialogButton,
    back: DialogButton,
    revision: Option<i64>,
) -> InlineKeyboard {
    [confirm, back].into_iter().fold(keyboard, |keyboard, button| {
        keyboard.text(button.label, versioned_callback(button.callback, revision))
    })
}

/// `resultNavigationKeyboard`.
pub fn result_navigation_keyboard() -> InlineKeyboard {
    append_result_navigation(InlineKeyboard::new())
}

/// `appendResultNavigation`: one way back to the queue, one to the menu.
pub fn append_result_navigation(keyboard: InlineKeyboard) -> InlineKeyboard {
    keyboard
        .text(t(Key::QueueBackBtn, &[]), screen(ScreenId::QueueHome))
        .text(t(Key::CommonMenu, &[]), screen(ScreenId::MenuHome))
}
