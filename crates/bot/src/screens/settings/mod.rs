//! The settings area (`bot/settings/index.ts` + `shared.ts`):
//! the `⚙️` text trigger, the settings menus and the typed settings inputs
//! (time zone, YouTube signature) that claim the next message.
//!
//! Russian only (docs/decisions.md): there is no 🌐 Language screen, so
//! the System menu has no language button.

mod notifications;
mod publishing;
mod system;

use std::rc::Rc;

use domain::application::ports::{ConversationSessionKind, JsonObject};
use foundation::i18n::{Key, t};

use crate::Fut;
use crate::api::payload::{Field, Payload};
use crate::context::Ctx;
use crate::effects::show_screen;
use crate::menu::{MenuAction, MenuButton, MenuDef, MenuId, MenuLayout, action};
use crate::registry::{MessageResult, MessageStage, Registry};
use crate::screens::entry::{MAIN_MENU, MENU_BUTTON_EN, SETTINGS_MENU, main_menu_text};
use crate::session::ConversationStateInput;

const PUBLISHING_MENU: MenuId = "settings-publishing";
const NOTIFICATIONS_MENU: MenuId = "settings-notifications-category";
const SYSTEM_MENU: MenuId = "settings-system";
const NOTIFICATION_SETTINGS_MENU: MenuId = "settings-notifications";
const BACKUP_MENU: MenuId = "settings-backup";
const DEFAULT_TARGETS_MENU: MenuId = "settings-default-targets";
const YOUTUBE_SIGNATURE_MENU: MenuId = "settings-youtube";
const CHANNELS_MENU: MenuId = "settings-channels";
const CHANNEL_MENU: MenuId = "settings-channel";
const CHANNEL_DISABLE_MENU: MenuId = "settings-channel-disable";
const CHANNEL_CONNECT_MENU: MenuId = "settings-channel-connect";
const TIMEZONE_MENU: MenuId = "settings-timezone";

/// The typed values settings asks for (`SettingsInputStep`).
const TIMEZONE_STEP: &str = "timezone";
const YOUTUBE_SIGNATURE_STEP: &str = "youtube_signature";

pub fn register(registry: &mut Registry) {
    registry.hears(&["⚙️"], show_settings);
    registry.message_stage(MessageStage::Settings, settings_message);
    menu(registry, SETTINGS_MENU, MAIN_MENU, settings_layout);
    publishing::register(registry);
    notifications::register(registry);
    system::register(registry);
}

/// One settings menu, registered under `parent` (its `back` target).
fn menu(registry: &mut Registry, id: MenuId, parent: MenuId, layout: MenuLayout) {
    registry.menu(MenuDef {
        id,
        parent: Some(parent),
        fingerprint: None,
        auto_answer: false,
        layout,
    });
}

/// The plugin's `MenuRange` as one dynamic range renders it: the keyboard
/// starts with one empty row, a button joins the last row, and `row()` always
/// opens a new one (two in a row leave an empty row, as the plugin does).
struct Range {
    rows: Vec<Vec<MenuButton>>,
}

impl Range {
    fn new() -> Self {
        Self { rows: vec![Vec::new()] }
    }

    fn add(mut self, button: MenuButton) -> Self {
        self.rows.last_mut().expect("a range always has a row").push(button);
        self
    }

    fn text(self, label: impl Into<String>, action: MenuAction) -> Self {
        self.add(MenuButton::Text {
            label: label.into(),
            action: Some(action),
        })
    }

    fn submenu(self, label: impl Into<String>, target: MenuId, action: MenuAction) -> Self {
        self.add(MenuButton::Submenu {
            label: label.into(),
            target,
            action: Some(action),
        })
    }

    fn back(self, label: impl Into<String>, action: MenuAction) -> Self {
        self.add(MenuButton::Back {
            label: label.into(),
            action: Some(action),
        })
    }

    fn url(self, label: impl Into<String>, url: impl Into<String>) -> Self {
        self.add(MenuButton::Url {
            label: label.into(),
            url: url.into(),
        })
    }

    fn row(mut self) -> Self {
        self.rows.push(Vec::new());
        self
    }

    fn done(self) -> crate::Result<Vec<Vec<MenuButton>>> {
        Ok(self.rows)
    }
}

fn settings_layout(_: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    Range::new()
        .submenu(
            t(Key::SettingsCategoryPublishing, &[]),
            PUBLISHING_MENU,
            show(|_| Ok(t(Key::SettingsCategoryPublishingBody, &[]))),
        )
        .submenu(
            t(Key::SettingsCategoryNotifications, &[]),
            NOTIFICATIONS_MENU,
            show(|_| Ok(t(Key::SettingsCategoryNotificationsBody, &[]))),
        )
        .row()
        .submenu(
            t(Key::SettingsCategorySystem, &[]),
            SYSTEM_MENU,
            show(|_| Ok(t(Key::SettingsCategorySystemBody, &[]))),
        )
        .row()
        .back(t(Key::CommonMenu, &[]), show(|ctx| main_menu_text(ctx, ctx.actor_id())))
        .done()
}

/// A button that only shows one screen over the tapped message (`showScreen(ctx, text)`).
fn show(body: impl Fn(&Ctx) -> crate::Result<String> + 'static) -> MenuAction {
    let body = Rc::new(body);
    action(move |ctx| {
        let body = Rc::clone(&body);
        Box::pin(async move { show_screen(ctx, &body(ctx)?, Payload::new()).await })
    })
}

/// `settingsUpdate`: apply the change, acknowledge the tap (with the toast,
/// when there is one), and re-render the screen it lives on, as Markdown
/// unless `plain` (screens built from channel and account names).
fn settings_update(
    apply: impl Fn(&Ctx) -> crate::Result<()> + 'static,
    body: impl Fn(&Ctx) -> crate::Result<String> + 'static,
    toast: Option<String>,
    plain: bool,
) -> MenuAction {
    let apply = Rc::new(apply);
    let body = Rc::new(body);
    action(move |ctx| {
        let (apply, body, toast) = (Rc::clone(&apply), Rc::clone(&body), toast.clone());
        Box::pin(async move {
            apply(ctx)?;
            ctx.answer_callback_query(toast.as_deref(), false).await?;
            let options = if plain {
                Payload::new()
            } else {
                Payload::new().markdown()
            };
            show_screen(ctx, &body(ctx)?, options).await
        })
    })
}

/// `settingsScreen`: the same, for a control that only navigates.
fn settings_screen(body: impl Fn(&Ctx) -> crate::Result<String> + 'static, plain: bool) -> MenuAction {
    settings_update(|_| Ok(()), body, None, plain)
}

/// `backToSettings`: every category returns to the same root screen.
fn back_to_settings() -> MenuAction {
    action(|ctx| {
        Box::pin(async move {
            clear_input(ctx)?;
            show_screen(ctx, &t(Key::SettingsTitle, &[]), Payload::new()).await
        })
    })
}

fn clear_input(ctx: &Ctx) -> crate::Result<()> {
    Ok(ctx
        .sessions()
        .clear(ctx.actor_id(), ConversationSessionKind::Settings)?)
}

/// `askSettingsInput`: asks for one typed value on the screen the question
/// was tapped on, keeping that screen's own menu under it.
fn ask_input(step: &'static str, menu: MenuId, prompt: Key) -> MenuAction {
    action(move |ctx| {
        Box::pin(async move {
            ctx.sessions().save(
                ctx.actor_id(),
                &ConversationStateInput {
                    kind: ConversationSessionKind::Settings,
                    draft_id: None,
                    step: step.to_owned(),
                    data: JsonObject::new(),
                    control_message_id: None,
                    revision: None,
                },
            )?;
            show_screen(ctx, &t(prompt, &[]), Payload::new().reply_markup(Field::Menu(menu))).await
        })
    })
}

/// One vocabulary for the state of a control (`switchLabel`, `choiceLabel`).
fn switch_label(on: bool, label: &str) -> String {
    format!("{} {label}", if on { "✅" } else { "⬜" })
}

fn choice_label(chosen: bool, label: &str) -> String {
    format!("{} {label}", if chosen { "●" } else { "○" })
}

fn on_off(value: bool) -> String {
    t(if value { Key::SettingsOn } else { Key::SettingsOff }, &[])
}

/// `showSettings`: the `⚙️` trigger.
fn show_settings(ctx: &Ctx) -> Fut<'_, crate::Result<()>> {
    Box::pin(async move {
        show_screen(
            ctx,
            &t(Key::SettingsTitle, &[]),
            Payload::new().reply_markup(Field::Menu(SETTINGS_MENU)),
        )
        .await
    })
}

/// Commands and persistent keyboard navigation leave an open settings input.
fn is_navigation_message(text: &str) -> bool {
    text.starts_with('/') || text == MENU_BUTTON_EN || text == t(Key::MenuButton, &[])
}

/// `handleSettingsMessage`: the open settings input claims the next message.
fn settings_message(ctx: &Ctx) -> Fut<'_, crate::Result<MessageResult>> {
    Box::pin(async move {
        let actor_id = ctx.actor_id();
        let Some(state) = ctx.sessions().get(actor_id, ConversationSessionKind::Settings)? else {
            return Ok(MessageResult::declined());
        };
        let text = ctx
            .update
            .message
            .as_ref()
            .and_then(|message| message.text.as_deref())
            .map(foundation::js::trim)
            .unwrap_or_default();
        clear_input(ctx)?;
        if is_navigation_message(text) {
            return Ok(MessageResult::declined());
        }
        match state.step.as_str() {
            TIMEZONE_STEP => system::collect_timezone(ctx, text).await?,
            YOUTUBE_SIGNATURE_STEP => publishing::collect_youtube_signature(ctx, text).await?,
            _ => return Ok(MessageResult::declined()),
        }
        Ok(MessageResult::handled(Vec::new()))
    })
}
