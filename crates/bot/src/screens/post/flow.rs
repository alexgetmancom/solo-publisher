//! The post conversation's steps: what each expects from
//! the operator, where it leads, and how a step travels in the session row.
//!
//! The domain `Flow` table takes `'static` input, and a post step's `accept`
//! needs the update's services, so the table is spelled here as the three
//! questions the adapter asks of it: does the step take a message, and which
//! step follows. `accept` lives with the input handler (`input.rs`).

use content::Locale;
use domain::application::ports::JsonObject;
use foundation::time::{parse_iso_instant, to_iso_string};
use jiff::Timestamp;
use serde_json::{Value, json};

use crate::session::ConversationState;

/// One open post input, with what it carries.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum PostWizardStep {
    EditText { locale: Locale },
    ScheduleManual { locale: Locale },
    ScheduleConfirm { locale: Locale, value: Timestamp },
    /// The next post of a thread; `ThreadEdit` replaces the one at `position`.
    ThreadPart,
    ThreadEdit { position: i64, locale: Locale },
}

impl PostWizardStep {
    pub(super) fn name(self) -> &'static str {
        match self {
            Self::EditText { .. } => "edit_text",
            Self::ScheduleManual { .. } => "schedule_manual",
            Self::ScheduleConfirm { .. } => "schedule_confirm",
            Self::ThreadPart => "thread_part",
            Self::ThreadEdit { .. } => "thread_edit",
        }
    }

    /// `flowStepInput(POST_FLOW, step)`: every step but the confirmation
    /// is answered with a message.
    pub(super) fn takes_input(self) -> bool {
        !matches!(self, Self::ScheduleConfirm { .. })
    }

    /// `POST_STEPS[step].next()`.
    pub(super) fn next(self) -> &'static str {
        match self {
            Self::ScheduleManual { .. } => "schedule_confirm",
            _ => "completed",
        }
    }
}

fn locale_value(locale: Locale) -> Value {
    Value::from(locale.as_str())
}

/// `postStepData`: the session payload a step carries beside its name.
pub(super) fn post_step_data(step: PostWizardStep) -> JsonObject {
    let value = match step {
        PostWizardStep::EditText { locale } | PostWizardStep::ScheduleManual { locale } => {
            json!({"locale": locale_value(locale)})
        }
        PostWizardStep::ScheduleConfirm { locale, value } => {
            json!({"locale": locale_value(locale), "value": to_iso_string(value)})
        }
        PostWizardStep::ThreadEdit { position, locale } => {
            json!({"position": position, "locale": locale_value(locale)})
        }
        PostWizardStep::ThreadPart => json!({}),
    };
    match value {
        Value::Object(object) => object,
        _ => unreachable!("built as an object"),
    }
}

fn parse_locale(value: Option<&Value>) -> Option<Locale> {
    match value.and_then(Value::as_str) {
        Some("ru") => Some(Locale::Ru),
        Some("en") => Some(Locale::En),
        _ => None,
    }
}

/// `Number(value)` as an integer of at least 2, the way a thread position is read.
fn parse_position(value: Option<&Value>) -> Option<i64> {
    let number = match value {
        Some(Value::Number(number)) => number.as_f64()?,
        Some(Value::String(text)) => foundation::js::number(text),
        Some(Value::Bool(flag)) => f64::from(u8::from(*flag)),
        Some(Value::Null) => 0.0,
        _ => return None,
    };
    (foundation::js::is_integer(number) && number >= 2.0).then_some(number as i64)
}

/// `postStateStep`: the open step of a stored session, or none.
pub(super) fn post_state_step(state: Option<&ConversationState>) -> Option<PostWizardStep> {
    let state = state?;
    let data = &state.data;
    match state.step.as_str() {
        "edit_text" => parse_locale(data.get("locale")).map(|locale| PostWizardStep::EditText { locale }),
        "schedule_manual" => parse_locale(data.get("locale")).map(|locale| PostWizardStep::ScheduleManual { locale }),
        "thread_part" => Some(PostWizardStep::ThreadPart),
        "thread_edit" => {
            let locale = parse_locale(data.get("locale")).unwrap_or(Locale::Ru);
            parse_position(data.get("position")).map(|position| PostWizardStep::ThreadEdit { position, locale })
        }
        "schedule_confirm" => {
            let locale = parse_locale(data.get("locale"))?;
            let value = data
                .get("value")
                .and_then(Value::as_str)
                .and_then(|value| parse_iso_instant(value).ok())?;
            Some(PostWizardStep::ScheduleConfirm { locale, value })
        }
        _ => None,
    }
}
