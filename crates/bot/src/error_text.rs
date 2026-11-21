//! How a failure reads to the operator (`describeError`,
//! `bot/error-text.ts`, `callbackToast`).

use foundation::errors::StudioError;
use foundation::i18n::{Key, t};
use foundation::text::truncate_unicode;

const MAX_TOAST_LENGTH: usize = 200;

/// The `StudioError` inside an error, wherever a layer wrapped it.
pub fn studio_error<'a>(error: &'a (dyn std::error::Error + 'static)) -> Option<&'a StudioError> {
    if let Some(studio) = error.downcast_ref::<StudioError>() {
        return Some(studio);
    }
    match error.downcast_ref::<domain::Error>() {
        Some(domain::Error::Studio(studio)) => Some(studio),
        _ => None,
    }
}

/// `describeError`: a catalog code renders through the catalog; anything else
/// is its own message.
pub fn describe_error(error: &(dyn std::error::Error + 'static)) -> String {
    match studio_error(error) {
        Some(studio) => foundation::i18n::describe_error(studio),
        None => error.to_string(),
    }
}

/// `describePublicationError`: a date the parser refused names the zone it
/// was read in.
pub fn describe_publication_error(error: &(dyn std::error::Error + 'static), timezone_label: &str) -> String {
    if studio_error(error).is_some_and(|studio| studio.code == "common.schedule-parse-error") {
        return t(Key::CommonScheduleParseError, &[("timezone", &timezone_label)]);
    }
    describe_error(error)
}

/// `callbackToast`: Telegram drops a toast over 200 characters, so it is cut.
pub fn callback_toast(text: &str) -> String {
    let shortened = truncate_unicode(text, MAX_TOAST_LENGTH);
    if shortened.len() < text.len() {
        format!("{}…", truncate_unicode(text, MAX_TOAST_LENGTH - 1))
    } else {
        shortened.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn toasts_are_cut_to_fit() {
        assert_eq!(callback_toast("short"), "short");
        let long = "я".repeat(201);
        let toast = callback_toast(&long);
        assert_eq!(toast.chars().count(), 200);
        assert!(toast.ends_with('…'));
        assert_eq!(callback_toast(&"я".repeat(200)), "я".repeat(200));
    }

    #[test]
    fn wrapped_studio_errors_render_through_the_catalog() {
        let error: Box<dyn std::error::Error> = Box::new(domain::Error::Studio(StudioError::new("action.in-flight")));
        assert_eq!(describe_error(&*error), t(Key::ActionInFlight, &[]));
        let plain = crate::error("draft 999 not found");
        assert_eq!(describe_error(&*plain), "draft 999 not found");
    }
}
