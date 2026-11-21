//! What the bot tells the operator and when (`bot/settings/notifications.ts`),
//! and the database backup, which lives under System.

use domain::studio::services::settings::NotificationSettingsInput;
use foundation::i18n::{Key, t};

use super::{
    BACKUP_MENU, NOTIFICATION_SETTINGS_MENU, NOTIFICATIONS_MENU, Range, SETTINGS_MENU, SYSTEM_MENU, back_to_settings,
    choice_label, menu, on_off, settings_screen, settings_update, switch_label,
};
use crate::context::Ctx;
use crate::menu::{MenuAction, MenuButton};
use crate::registry::Registry;

const REMINDER_MINUTES: [i64; 5] = [1, 5, 10, 15, 30];

pub(super) fn register(registry: &mut Registry) {
    menu(registry, NOTIFICATIONS_MENU, SETTINGS_MENU, notifications_layout);
    menu(
        registry,
        NOTIFICATION_SETTINGS_MENU,
        NOTIFICATIONS_MENU,
        notification_settings_layout,
    );
    menu(registry, BACKUP_MENU, SYSTEM_MENU, backup_layout);
}

fn notifications_layout(_: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    Range::new()
        .submenu(
            t(Key::SettingsPublicationNotifications, &[]),
            NOTIFICATION_SETTINGS_MENU,
            settings_screen(notification_settings_text, false),
        )
        .row()
        .back(t(Key::SettingsBackToSettings, &[]), back_to_settings())
        .done()
}

/// A notification setting changed to `input`, then the screen re-rendered.
fn set_notifications(input: NotificationSettingsInput, toast: Option<String>) -> MenuAction {
    settings_update(
        move |ctx| {
            ctx.services().settings.set_notifications(ctx.actor_id(), &input)?;
            Ok(())
        },
        notification_settings_text,
        toast,
        false,
    )
}

fn notification_settings_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let settings = ctx.services().settings.notifications(ctx.actor_id())?;
    let mut range = Range::new()
        .text(
            switch_label(
                settings.video_reminders_enabled,
                &t(Key::SettingsVideoReminderLabel, &[]),
            ),
            set_notifications(
                NotificationSettingsInput {
                    video_reminders_enabled: Some(!settings.video_reminders_enabled),
                    ..NotificationSettingsInput::default()
                },
                None,
            ),
        )
        .text(
            switch_label(settings.post_reminders_enabled, &t(Key::SettingsPostReminderLabel, &[])),
            set_notifications(
                NotificationSettingsInput {
                    post_reminders_enabled: Some(!settings.post_reminders_enabled),
                    ..NotificationSettingsInput::default()
                },
                None,
            ),
        )
        .row()
        .text(
            switch_label(settings.completion_enabled, &t(Key::SettingsCompletionLabel, &[])),
            set_notifications(
                NotificationSettingsInput {
                    completion_enabled: Some(!settings.completion_enabled),
                    ..NotificationSettingsInput::default()
                },
                None,
            ),
        )
        .row();
    // Three to a row: the markers made every label wider, and five of them
    // squeezed the digits on a phone.
    for (index, minutes) in REMINDER_MINUTES.into_iter().enumerate() {
        range = range.text(
            choice_label(
                settings.reminder_minutes == minutes,
                &t(Key::SettingsMinutesOption, &[("minutes", &minutes)]),
            ),
            set_notifications(
                NotificationSettingsInput {
                    reminder_minutes: Some(minutes as f64),
                    ..NotificationSettingsInput::default()
                },
                Some(t(Key::SettingsMinutesToast, &[("minutes", &minutes)])),
            ),
        );
        if index % 3 == 2 {
            range = range.row();
        }
    }
    range
        .row()
        .back(
            t(Key::SettingsBackToNotifications, &[]),
            settings_screen(|_| Ok(t(Key::SettingsCategoryNotificationsBody, &[])), true),
        )
        .done()
}

/// A database copy is something the machine does, not something the bot
/// tells you about.
fn backup_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let enabled = ctx.services().settings.backup()?.enabled;
    Range::new()
        .text(
            switch_label(enabled, &t(Key::SettingsBackupEnabled, &[])),
            settings_update(
                move |ctx| {
                    ctx.services().settings.set_backup(!enabled)?;
                    Ok(())
                },
                backup_text,
                None,
                false,
            ),
        )
        .row()
        .back(
            t(Key::SettingsBackToSystem, &[]),
            settings_screen(|_| Ok(t(Key::SettingsCategorySystemBody, &[])), true),
        )
        .done()
}

fn notification_settings_text(ctx: &Ctx) -> crate::Result<String> {
    let settings = ctx.services().settings.notifications(ctx.actor_id())?;
    Ok(t(
        Key::SettingsNotifBody,
        &[
            ("videoReminders", &on_off(settings.video_reminders_enabled)),
            ("postReminders", &on_off(settings.post_reminders_enabled)),
            ("minutes", &settings.reminder_minutes),
            ("completion", &on_off(settings.completion_enabled)),
        ],
    ))
}

pub(super) fn backup_text(ctx: &Ctx) -> crate::Result<String> {
    Ok(t(
        Key::SettingsBackupBody,
        &[("status", &on_off(ctx.services().settings.backup()?.enabled))],
    ))
}
