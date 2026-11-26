//! The entry area: `/start`, the `☰ Меню` text triggers, the main menu
//! and the two screen buttons that only lead back to it (`menu_home`, `noop`).

use std::sync::LazyLock;

use foundation::i18n::{Key, t};
use foundation::js;
use foundation::text::truncate_unicode;
use foundation::time::{Zone, format_zoned_clock, zoned_day_distance};
use jiff::Timestamp;
use regex::Regex;

use crate::Fut;
use crate::api::payload::{Keyboard, Payload};
use crate::callback::{ScreenCallback, ScreenId};
use crate::context::Ctx;
use crate::effects::{Effect, execute, show_message, show_screen};
use crate::menu::{MenuButton, MenuDef, MenuId, action};
use crate::queue_time::format_queue_time;
use crate::registry::Registry;
use domain::studio::services::queue::StudioQueueHeadline;

pub const MAIN_MENU: MenuId = "main-menu";
/// The settings root, registered by the settings area under the main menu.
pub const SETTINGS_MENU: MenuId = "settings-menu";

/// The English `menu.button`: keyboards sent before the interface became
/// Russian-only still type it, so it stays a trigger.
pub(crate) const MENU_BUTTON_EN: &str = "☰ Menu";

pub fn register(registry: &mut Registry) {
    registry.command("start", show_bot_menu);
    registry.hears(&[MENU_BUTTON_EN, "☰ Меню"], show_main_menu);
    registry.screen(ScreenId::Noop, noop);
    registry.screen(ScreenId::MenuHome, menu_home);
    registry.menu(MenuDef {
        id: MAIN_MENU,
        parent: None,
        // A fingerprint instead of the per-label hash, so the live queue count
        // never makes the menu "outdated"; it names everything the shape
        // depends on. The interface is Russian only.
        fingerprint: Some(|_| "publishing:ru".to_owned()),
        auto_answer: true,
        layout: main_menu_layout,
    });
}

/// The reply keyboard with the one button that brings the menu back.
pub fn persistent_keyboard() -> Keyboard {
    Keyboard::new().text(t(Key::MenuButton, &[])).resized().persistent()
}

fn show_bot_menu(ctx: &Ctx) -> Fut<'_, crate::Result<()>> {
    Box::pin(async move {
        show_message(
            ctx,
            &t(Key::StartMenuHint, &[]),
            Payload::new().reply_markup(persistent_keyboard()),
        )
        .await?;
        show_main_menu(ctx).await
    })
}

/// `showMainMenu`: the menu as a screen (over the tapped message on a callback).
pub fn show_main_menu(ctx: &Ctx) -> Fut<'_, crate::Result<()>> {
    Box::pin(async move {
        let text = main_menu_text(ctx, ctx.actor_id())?;
        execute(ctx, vec![Effect::MainMenu { text }]).await
    })
}

fn noop<'a>(_: &'a Ctx, _: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async { Ok(true) })
}

fn menu_home<'a>(ctx: &'a Ctx, _: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        show_main_menu(ctx).await?;
        Ok(true)
    })
}

/// The handler a text trigger has, for a menu button that does the same.
async fn run_trigger(ctx: &Ctx, text: &str) -> crate::Result<()> {
    let handler = ctx
        .bot
        .registry()
        .hears_handler(text)
        .ok_or_else(|| crate::error(format!("no handler is registered for {text:?}")))?;
    handler(ctx).await
}

fn main_menu_layout(ctx: &Ctx) -> crate::Result<Vec<Vec<MenuButton>>> {
    let pending = ctx.services().queue.headline(ctx.actor_id())?.pending;
    let queue_label = if pending > 0 {
        t(Key::MenuWorkQueueCount, &[("count", &pending)])
    } else {
        t(Key::MenuWorkQueue, &[])
    };
    Ok(vec![
        vec![
            MenuButton::Text {
                label: t(Key::MenuText, &[]),
                action: Some(action(|ctx| Box::pin(run_trigger(ctx, "📝 Текст")))),
            },
            MenuButton::Text {
                label: t(Key::MenuVideo, &[]),
                action: Some(action(|ctx| Box::pin(run_trigger(ctx, "🎬 Видео")))),
            },
        ],
        vec![
            MenuButton::Text {
                label: queue_label,
                action: Some(action(|ctx| {
                    Box::pin(async move {
                        let route = ctx
                            .bot
                            .registry()
                            .screen_route(ScreenId::QueueHome)
                            .ok_or_else(|| crate::error("screen queue_home is not routed"))?;
                        let callback = ScreenCallback {
                            id: ScreenId::QueueHome,
                            args: Vec::new(),
                        };
                        route(ctx, &callback).await?;
                        Ok(())
                    })
                })),
            },
            MenuButton::Submenu {
                label: t(Key::SettingsTitle, &[]),
                target: SETTINGS_MENU,
                action: Some(action(|ctx| {
                    Box::pin(async move { show_screen(ctx, &t(Key::SettingsTitle, &[]), Payload::new()).await })
                })),
            },
        ],
    ])
}

/// `mainMenuText`: the queue headline in the actor's time zone.
pub fn main_menu_text(ctx: &Ctx, actor_id: i64) -> crate::Result<String> {
    let services = ctx.services();
    let timezone = services.settings.time_config(actor_id)?.timezone;
    let zone = Zone::parse(&timezone).ok_or_else(|| crate::error(format!("Invalid time zone specified: {timezone}")))?;
    let headline = services.queue.headline(actor_id)?;
    Ok(render_main_menu_headline(&headline, &zone, ctx.now()))
}

/// `renderMainMenuHeadline`.
pub fn render_main_menu_headline(headline: &StudioQueueHeadline, zone: &Zone, now: Timestamp) -> String {
    let (prefix, time, label) = match (&headline.upcoming, &headline.published) {
        (Some(upcoming), _) => (if upcoming.overdue { "⏰" } else { "⏭" }, upcoming.time, &upcoming.label),
        (None, Some(published)) => ("✅", published.time, &published.label),
        (None, None) => return t(Key::MenuQueueEmpty, &[]),
    };
    format!("{prefix} {} · {}", headline_time(time, now, zone), headline_label(label))
}

/// Today needs no name on the headline; other days read as the queue writes them.
fn headline_time(time: Timestamp, now: Timestamp, zone: &Zone) -> String {
    if zoned_day_distance(time, now, zone) == 0 {
        return format_zoned_clock(time, zone);
    }
    format_queue_time(time, now, zone)
}

static LEADING_EMOJI: LazyLock<Regex> =
    LazyLock::new(|| Regex::new(r"^\p{Extended_Pictographic}(?:\x{FE0F}|\p{Emoji_Modifier})*").unwrap());

/// `headlineLabel`: without its leading emoji, cut to 20 characters at a word.
fn headline_label(value: &str) -> String {
    let stripped = match LEADING_EMOJI.find(value) {
        Some(emoji) => js::trim_start(&value[emoji.end()..]),
        None => value,
    };
    let label = match js::trim(stripped) {
        "" => value,
        label => label,
    };
    const LIMIT: usize = 20;
    let characters: Vec<char> = label.chars().collect();
    if characters.len() <= LIMIT {
        return label.to_owned();
    }
    let clipped = truncate_unicode(label, LIMIT);
    let whole = js::trim_end(clipped).len() < clipped.len() || characters[LIMIT] == ' ';
    let last_space = clipped.rfind(' ');
    let kept = match last_space {
        Some(index) if !whole && index > 0 => &clipped[..index],
        _ => js::trim_end(clipped),
    };
    format!("{kept}...")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn headline_labels_are_cut_at_a_word() {
        assert_eq!(headline_label("📝 Запуск"), "Запуск");
        assert_eq!(headline_label("✅️ Done"), "Done");
        assert_eq!(headline_label("🔥"), "🔥");
        assert_eq!(headline_label("Первый пост о запуске нового продукта"), "Первый пост о...");
        assert_eq!(headline_label("Первый пост о запуске"), "Первый пост о...");
        assert_eq!(headline_label("Первый пост о запуск нового"), "Первый пост о запуск...");
        assert_eq!(headline_label("Оченьдлинноесловобезпробелов"), "Оченьдлинноесловобез...");
    }
}
