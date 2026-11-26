//! "Retry" and "give up" for every target a publication did not land on:
//! the publication card and the completion
//! notice offer the same decision, so they build it here once.

use content::Locale;
use domain::application::conversation_flow::PublicationKind;
use foundation::i18n::{Key, t};

use crate::api::payload::InlineKeyboard;
use crate::callback::publication_callback;

/// One target a publication did not land on, as the operator has to act on it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct UnlandedTarget {
    pub target: String,
    pub label: String,
    pub retryable: bool,
    pub skippable: bool,
    /// Set when the platform refused the content itself: which language of
    /// the post has to be edited for the answer to change.
    pub fix: Option<Locale>,
}

/// Which surface the tap comes from, so the handler knows whether a card is
/// open to refresh behind it.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Card,
    Notice,
}

impl Origin {
    fn as_str(self) -> &'static str {
        match self {
            Self::Card => "card",
            Self::Notice => "notice",
        }
    }
}

/// `appendUnlandedControls`: returns the keyboard and whether anything was
/// added, so a notice with nothing to decide carries no keyboard at all.
pub fn append_unlanded_controls(
    mut keyboard: InlineKeyboard,
    kind: PublicationKind,
    draft_id: i64,
    origin: Origin,
    targets: &[UnlandedTarget],
) -> crate::Result<(InlineKeyboard, bool)> {
    // Giving up on a target, and doing every target at once, are post
    // operations: a video is retried one upload at a time and given up on by
    // cancelling it, which its own card offers.
    let post = kind == PublicationKind::Post;
    let any_retryable = targets.iter().any(|item| item.retryable);
    let skippable = |item: &UnlandedTarget| post && item.skippable;
    let any_skippable = targets.iter().any(skippable);
    if !any_retryable && !any_skippable {
        return Ok((keyboard, false));
    }
    let origin = origin.as_str();
    let callback = |kind: PublicationKind, action: &str, target: &str| {
        publication_callback(kind, action, &[&draft_id, &target, &origin], None)
    };
    if post {
        if any_retryable {
            keyboard = keyboard.text(
                t(Key::NotifRetryFailed, &[]),
                callback(PublicationKind::Post, "retry", "all")?,
            );
        }
        if any_skippable {
            keyboard = keyboard.text(
                t(Key::NotifSkipFailed, &[]),
                callback(PublicationKind::Post, "skip", "all")?,
            );
        }
        keyboard = keyboard.row();
    }
    for item in targets {
        let skip = skippable(item);
        if !item.retryable && !skip && item.fix.is_none() {
            continue;
        }
        let label: [(&str, &dyn std::fmt::Display); 1] = [("target", &item.label)];
        match item.fix {
            Some(Locale::En) => {
                keyboard = keyboard.text(
                    t(Key::NotifFixTarget, &label),
                    publication_callback(PublicationKind::Post, "edit_en", &[&draft_id], None)?,
                );
            }
            Some(Locale::Ru) => {
                keyboard = keyboard.text(
                    t(Key::NotifFixTarget, &label),
                    publication_callback(PublicationKind::Post, "edit_ru", &[&draft_id], None)?,
                );
            }
            None => {}
        }
        if item.retryable {
            keyboard = keyboard.text(t(Key::NotifRetryTarget, &label), callback(kind, "retry", &item.target)?);
        }
        if skip {
            keyboard = keyboard.text(
                t(Key::NotifSkipTarget, &label),
                callback(PublicationKind::Post, "skip", &item.target)?,
            );
        }
        keyboard = keyboard.row();
    }
    Ok((keyboard, true))
}
