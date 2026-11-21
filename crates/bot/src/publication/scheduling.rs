//! The schedule protocol both publication kinds share (`bot/scheduling.ts`):
//! the three schedule callbacks, the slot grid and the confirmation screen.
//! The kind supplies its axis keys and slot values; what the axis means
//! (`capabilities.scheduleAxis`) is the pipeline's, not the keyboard's.

use domain::application::conversation_flow::PublicationKind;
use jiff::Timestamp;

use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{publication_callback, versioned_callback};
use crate::effects::{CardRef, Effect};

/// The values along which a scheduling screen lets an operator move.
pub struct ScheduleAxis<'a> {
    pub values: &'a [&'a str],
    pub label: &'a dyn Fn(&str) -> String,
    pub callback: &'a dyn Fn(&str) -> crate::Result<String>,
}

/// `createPublicationScheduleEngine`: every schedule callback of one
/// publication, emitted from one place.
pub struct ScheduleEngine<'a> {
    pub kind: PublicationKind,
    pub publication_id: i64,
    pub axis_keys: &'a [&'a str],
    pub slot_values: &'a [&'a str],
}

impl ScheduleEngine<'_> {
    fn args(&self, key: Option<&str>, clock: Option<&str>) -> Vec<String> {
        let mut args = vec![self.publication_id.to_string()];
        args.extend(key.map(str::to_owned));
        args.extend(clock.map(|clock| clock.replacen(':', "", 1)));
        args
    }

    fn callback(&self, action: &str, args: &[String]) -> crate::Result<String> {
        let args: Vec<&dyn std::fmt::Display> = args.iter().map(|arg| arg as &dyn std::fmt::Display).collect();
        Ok(publication_callback(self.kind, action, &args, None)?)
    }

    pub fn pick_callback(&self, key: Option<&str>, clock: &str) -> crate::Result<String> {
        self.callback("sched_pick", &self.args(key, Some(clock)))
    }

    /// The axis's own callback: a pick along the first key.
    pub fn axis_callback(&self, clock: &str) -> crate::Result<String> {
        self.pick_callback(self.axis_keys.first().copied(), clock)
    }

    pub fn manual_callback(&self, key: Option<&str>) -> crate::Result<String> {
        self.callback("sched_manual", &self.args(key, None))
    }

    pub fn confirm_callback(&self) -> crate::Result<String> {
        self.callback("sched_confirm", &[self.publication_id.to_string()])
    }
}

/// `appendScheduleAxisButtons`: the axis as two-column slot rows.
pub fn append_schedule_axis_buttons(
    mut keyboard: InlineKeyboard,
    axis: &ScheduleAxis,
    revision: Option<i64>,
) -> crate::Result<InlineKeyboard> {
    for (index, pair) in axis.values.chunks(2).enumerate() {
        for value in pair {
            keyboard = keyboard.text(
                (axis.label)(value),
                versioned_callback(&(axis.callback)(value)?, revision),
            );
        }
        if index * 2 + 2 < axis.values.len() {
            keyboard = keyboard.row();
        }
    }
    Ok(keyboard)
}

/// Shared posting-hour presets used by the flat video schedule axis.
pub const SCHEDULE_SLOT_PRESETS: [&str; 6] = ["08:00", "11:00", "13:00", "18:00", "20:00", "22:00"];

/// A label and the callback it sends.
pub struct ScheduleButton {
    pub label: String,
    pub callback: String,
}

/// `scheduleTimeKeyboard`: an optional "send now" row, the slots, manual
/// entry and a versioned cancel.
pub fn schedule_time_keyboard(
    axis: &ScheduleAxis,
    revision: Option<i64>,
    now: Option<ScheduleButton>,
    manual: ScheduleButton,
    cancel: ScheduleButton,
) -> crate::Result<InlineKeyboard> {
    let mut keyboard = InlineKeyboard::new();
    if let Some(now) = now {
        keyboard = keyboard
            .text(now.label, versioned_callback(&now.callback, revision))
            .row();
    }
    keyboard = append_schedule_axis_buttons(keyboard, axis, revision)?.row();
    Ok(keyboard
        .text(manual.label, versioned_callback(&manual.callback, revision))
        .row()
        .text(cancel.label, versioned_callback(&cancel.callback, revision)))
}

/// What `scheduleConfirmationEffects` renders.
pub struct ScheduleConfirmation<'a> {
    pub kind: PublicationKind,
    pub publication_id: i64,
    pub intro: Option<String>,
    pub title: String,
    pub title_prefix: &'a str,
    pub entries: Vec<(String, Timestamp)>,
    pub label: &'a dyn Fn(&str) -> String,
    pub format_value: &'a dyn Fn(Timestamp) -> String,
    pub keyboard: InlineKeyboard,
    pub effects: Vec<Effect>,
}

/// `scheduleConfirmationEffects`: the one confirmation screen of locale and
/// target schedules, after whatever the caller shows ahead of it.
pub fn schedule_confirmation_effects(confirmation: ScheduleConfirmation) -> Vec<Effect> {
    let mut summary = vec![format!("{} *{}*", confirmation.title_prefix, confirmation.title)];
    summary.extend(
        confirmation
            .entries
            .iter()
            .map(|(key, value)| format!("{}: {}", (confirmation.label)(key), (confirmation.format_value)(*value))),
    );
    let summary = summary.join("\n");
    let text = match confirmation.intro.filter(|intro| !intro.is_empty()) {
        Some(intro) => format!("{intro}\n\n{summary}"),
        None => summary,
    };
    let card = match confirmation.kind {
        PublicationKind::Post => CardRef::Post {
            draft_id: confirmation.publication_id,
            view: None,
        },
        PublicationKind::Video => CardRef::Video {
            draft_id: confirmation.publication_id,
        },
    };
    let mut effects = confirmation.effects;
    effects.push(Effect::Screen {
        text,
        options: Payload::new().markdown().reply_markup(confirmation.keyboard),
        card: Some(card),
    });
    effects
}
