//! Machine settings: the clock and database
//! backups. The interface language has no screen (Russian only).

use foundation::i18n::{Key, t};

use super::{
    BACKUP_MENU, Range, SETTINGS_MENU, SYSTEM_MENU, TIMEZONE_MENU, TIMEZONE_STEP, ask_input, back_to_settings,
    choice_label, clear_input, menu, notifications::backup_text, settings_screen, settings_update,
};
use crate::api::payload::{Field, Payload};
use crate::context::Ctx;
use crate::effects::show_screen;
use crate::menu::MenuButton;
use crate::registry::Registry;

const TIMEZONE_OPTIONS: [&str; 15] = [
    "UTC",
    "Europe/London",
    "Europe/Berlin",
    "Europe/Moscow",
    "Asia/Dubai",
    "Asia/Tashkent",
    "Asia/Kolkata",
    "Asia/Bangkok",
    "Asia/Singapore",
    "Asia/Tokyo",
    "Australia/Sydney",
    "America/New_York",
    "America/Chicago",
    "America/Denver",
    "America/Los_Angeles",
];

pub(super) fn register(registry: &mut Registry) {
    menu(registry, SYSTEM_MENU, SETTINGS_MENU, system_layout);
    menu(registry, TIMEZONE_MENU, SYSTEM_MENU, timezone_layout);
}

fn system_layout(_: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    Range::new()
        .submenu(
            t(Key::SettingsTimezone, &[]),
            TIMEZONE_MENU,
            settings_screen(timezone_text, false),
        )
        .row()
        .submenu(
            t(Key::SettingsBackup, &[]),
            BACKUP_MENU,
            settings_screen(backup_text, false),
        )
        .row()
        .back(t(Key::SettingsBackToSettings, &[]), back_to_settings())
        .done()
}

/// The zone the actor reads schedules in (`service.timezone(actorId, config.TIMEZONE)`).
fn current_timezone(ctx: &Ctx) -> crate::Result<String> {
    Ok(ctx.services().settings.time_config(ctx.actor_id())?.timezone)
}

fn timezone_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let current = current_timezone(ctx)?;
    let mut options: Vec<String> = TIMEZONE_OPTIONS.iter().map(|zone| (*zone).to_owned()).collect();
    if !TIMEZONE_OPTIONS.contains(&current.as_str()) {
        options.insert(0, current.clone());
    }
    let mut range = Range::new();
    for index in (0..options.len()).step_by(2) {
        for zone in &options[index..(index + 2).min(options.len())] {
            let toast = t(Key::SettingsTimezoneSet, &[("timezone", zone)]);
            let chosen = zone.clone();
            range = range.text(
                choice_label(*zone == current, zone),
                settings_update(
                    move |ctx| Ok(ctx.services().settings.set_timezone(ctx.actor_id(), &chosen)?),
                    timezone_text,
                    Some(toast),
                    false,
                ),
            );
        }
        if index + 2 < options.len() {
            range = range.row();
        }
    }
    range
        .row()
        .text(
            t(Key::SettingsTimezoneCustom, &[]),
            ask_input(TIMEZONE_STEP, TIMEZONE_MENU, Key::SettingsTimezoneInputPrompt),
        )
        .row()
        .back(
            t(Key::SettingsBackToSystem, &[]),
            settings_update(clear_input, |_| Ok(t(Key::SettingsCategorySystemBody, &[])), None, true),
        )
        .done()
}

/// `collectTimezone`: the typed zone, or why it was refused.
pub(super) async fn collect_timezone(ctx: &Ctx, text: &str) -> crate::Result<()> {
    let saved = async {
        ctx.services().settings.set_timezone(ctx.actor_id(), text)?;
        show_screen(
            ctx,
            &t(Key::SettingsTimezoneSet, &[("timezone", &text)]),
            Payload::new(),
        )
        .await?;
        show_screen(
            ctx,
            &timezone_text(ctx)?,
            Payload::new().markdown().reply_markup(Field::Menu(TIMEZONE_MENU)),
        )
        .await
    }
    .await;
    if saved.is_err() {
        show_screen(ctx, &t(Key::ErrTimezoneInvalid, &[]), Payload::new()).await?;
    }
    Ok(())
}

fn timezone_text(ctx: &Ctx) -> crate::Result<String> {
    Ok(t(Key::SettingsTimezoneBody, &[("timezone", &current_timezone(ctx)?)]))
}
