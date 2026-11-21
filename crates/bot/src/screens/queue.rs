//! The queue area: the work queue and its "needs attention" list
//! (`bot/queue.ts`, spec §4.2–4.3). Items open their post or video card.

use domain::application::conversation_flow::PublicationKind;
use domain::studio::services::queue::{StudioQueueItem, StudioQueueSnapshot};
use foundation::i18n::{Key, t};
use foundation::markdown::escape_markdown;
use foundation::text::truncate_unicode;
use foundation::time::{Zone, zoned_calendar_day};
use jiff::Timestamp;

use crate::Fut;
use crate::api::payload::{InlineKeyboard, Payload};
use crate::callback::{ScreenCallback, ScreenId, publication_callback, screen, screen_callback, screen_number};
use crate::context::Ctx;
use crate::effects::show_screen;
use crate::queue_time::format_queue_time;
use crate::registry::Registry;

const QUEUE_PAGE_SIZE: usize = 10;
const ATTENTION_PAGE_SIZE: usize = 10;

pub fn register(registry: &mut Registry) {
    registry.screen(ScreenId::QueueHome, queue_home);
    registry.screen(ScreenId::QueuePage, queue_page);
    registry.screen(ScreenId::QueueAttention, queue_attention);
    registry.screen(ScreenId::QueueAttentionPage, queue_attention_page);
}

fn queue_home<'a>(ctx: &'a Ctx, _: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        show_queue(ctx, 0).await?;
        Ok(true)
    })
}

fn queue_page<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        let Some(page) = screen_number(callback.arg("page"), 0) else {
            return Ok(false);
        };
        show_queue(ctx, page).await?;
        Ok(true)
    })
}

fn queue_attention<'a>(ctx: &'a Ctx, _: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        show_queue_attention(ctx, 0).await?;
        Ok(true)
    })
}

fn queue_attention_page<'a>(ctx: &'a Ctx, callback: &'a ScreenCallback) -> Fut<'a, crate::Result<bool>> {
    Box::pin(async move {
        let Some(page) = screen_number(callback.arg("page"), 0) else {
            return Ok(false);
        };
        show_queue_attention(ctx, page).await?;
        Ok(true)
    })
}

/// `showQueue`.
pub async fn show_queue(ctx: &Ctx, page: i64) -> crate::Result<()> {
    let (text, keyboard) = queue_view(ctx, ctx.actor_id(), page)?;
    replace_queue_message(ctx, &text, keyboard).await
}

/// `showQueueAttention`.
pub async fn show_queue_attention(ctx: &Ctx, page: i64) -> crate::Result<()> {
    let (text, keyboard) = attention_view(ctx, ctx.actor_id(), page)?;
    replace_queue_message(ctx, &text, keyboard).await
}

async fn replace_queue_message(ctx: &Ctx, text: &str, keyboard: InlineKeyboard) -> crate::Result<()> {
    show_screen(ctx, text, Payload::new().markdown().reply_markup(keyboard)).await
}

/// The snapshot, the actor's zone and the clock a queue screen is drawn from.
fn queue_state(ctx: &Ctx, actor_id: i64) -> crate::Result<(StudioQueueSnapshot, Zone, Timestamp)> {
    let services = ctx.services();
    let timezone = services.settings.time_config(actor_id)?.timezone;
    let zone =
        Zone::parse(&timezone).ok_or_else(|| crate::error(format!("Invalid time zone specified: {timezone}")))?;
    let snapshot = services.queue.snapshot(actor_id, None)?;
    Ok((snapshot, zone, ctx.now()))
}

/// `queueView`: the queue as text and buttons, without a Telegram call.
pub fn queue_view(ctx: &Ctx, actor_id: i64, page: i64) -> crate::Result<(String, InlineKeyboard)> {
    let (snapshot, zone, now) = queue_state(ctx, actor_id)?;
    let pages = queue_pages(&snapshot, &zone);
    let current_page = clamp_page(page, pages.len());
    let items = &pages[current_page];
    let mut keyboard = InlineKeyboard::new();
    for item in &items.upcoming {
        keyboard = keyboard
            .text(item_button(item, now, &zone), item_callback(item.kind, item.id)?)
            .row();
    }
    for item in &items.drafts {
        keyboard = keyboard
            .text(
                format!("{} {}", kind_icon(item.kind), item.label),
                item_callback(item.kind, item.id)?,
            )
            .row();
    }
    if !snapshot.attention.is_empty() {
        keyboard = keyboard
            .text(
                t(Key::QueueAttentionBtn, &[("count", &snapshot.attention.len())]),
                screen(ScreenId::QueueAttention),
            )
            .row();
    }
    keyboard = pager(keyboard, ScreenId::QueuePage, current_page, pages.len())?;
    // Every row above closes itself, so the footer opens no empty one: Telegram
    // renders a blank row as a gap the operator can tap into.
    keyboard = keyboard.text(t(Key::CommonMenu, &[]), screen(ScreenId::MenuHome));
    Ok((format!("📋 *{}*", t(Key::QueueTitle, &[])), keyboard))
}

/// `attentionView`.
pub fn attention_view(ctx: &Ctx, actor_id: i64, page: i64) -> crate::Result<(String, InlineKeyboard)> {
    let (snapshot, zone, now) = queue_state(ctx, actor_id)?;
    let pages = snapshot.attention.len().div_ceil(ATTENTION_PAGE_SIZE).max(1);
    let current_page = clamp_page(page, pages);
    let items: Vec<_> = snapshot
        .attention
        .iter()
        .skip(current_page * ATTENTION_PAGE_SIZE)
        .take(ATTENTION_PAGE_SIZE)
        .collect();
    let mut keyboard = InlineKeyboard::new();
    for item in &items {
        keyboard = keyboard
            .text(
                format!("{} {}", kind_icon(item.kind), item.label),
                item_callback(item.kind, item.id)?,
            )
            .row();
    }
    keyboard = pager(keyboard, ScreenId::QueueAttentionPage, current_page, pages)?;
    keyboard = keyboard
        .text(t(Key::CommonBack, &[]), screen(ScreenId::QueueHome))
        .text(t(Key::CommonMenu, &[]), screen(ScreenId::MenuHome));
    let mut lines = vec![format!("⚠️ *{}*", t(Key::QueueAttentionTitle, &[])), String::new()];
    if items.is_empty() {
        lines.push(t(Key::QueueNoAttention, &[]));
    } else {
        for item in &items {
            lines.push(format!(
                "• {} — {} {}",
                format_queue_time(item.time, now, &zone),
                kind_icon(item.kind),
                escape_markdown(&item.label)
            ));
        }
    }
    if pages > 1 {
        lines.push(String::new());
        lines.push(t(Key::QueuePage, &[("page", &(current_page + 1)), ("pages", &pages)]));
    }
    Ok((lines.join("\n"), keyboard))
}

/// `Math.max(0, Math.min(page, pages - 1))`.
fn clamp_page(page: i64, pages: usize) -> usize {
    usize::try_from(page).unwrap_or(0).min(pages.saturating_sub(1))
}

/// `← n/m →`, closed as its own row; nothing for a single page.
fn pager(keyboard: InlineKeyboard, id: ScreenId, current: usize, pages: usize) -> crate::Result<InlineKeyboard> {
    if pages <= 1 {
        return Ok(keyboard);
    }
    let mut keyboard = keyboard;
    if current > 0 {
        keyboard = keyboard.text("←", screen_callback(id, &[&(current - 1)])?);
    }
    keyboard = keyboard.text(format!("{}/{pages}", current + 1), screen(ScreenId::Noop));
    if current < pages - 1 {
        keyboard = keyboard.text("→", screen_callback(id, &[&(current + 1)])?);
    }
    Ok(keyboard.row())
}

#[derive(Default)]
struct QueuePage<'a> {
    upcoming: Vec<&'a StudioQueueItem>,
    drafts: Vec<&'a StudioQueueItem>,
}

impl QueuePage<'_> {
    fn len(&self) -> usize {
        self.upcoming.len() + self.drafts.len()
    }
}

/// `queuePages`: upcoming items grouped by calendar day, a day kept on one
/// page when it fits, then the drafts; always at least one (empty) page.
fn queue_pages<'a>(snapshot: &'a StudioQueueSnapshot, zone: &Zone) -> Vec<QueuePage<'a>> {
    let mut pages = Vec::new();
    let mut current = QueuePage::default();
    fn flush<'a>(pages: &mut Vec<QueuePage<'a>>, current: &mut QueuePage<'a>) {
        let page = std::mem::take(current);
        if page.len() > 0 {
            pages.push(page);
        }
    }
    let mut groups: Vec<(String, Vec<&StudioQueueItem>)> = Vec::new();
    for item in &snapshot.upcoming {
        let key = zoned_calendar_day(item.time, zone);
        match groups.iter_mut().find(|(day, _)| *day == key) {
            Some((_, group)) => group.push(item),
            None => groups.push((key, vec![item])),
        }
    }
    for (_, group) in groups {
        if group.len() <= QUEUE_PAGE_SIZE
            && !current.upcoming.is_empty()
            && current.upcoming.len() + group.len() > QUEUE_PAGE_SIZE
        {
            flush(&mut pages, &mut current);
        }
        for item in group {
            if current.len() >= QUEUE_PAGE_SIZE {
                flush(&mut pages, &mut current);
            }
            current.upcoming.push(item);
        }
    }
    for item in &snapshot.drafts {
        if current.len() >= QUEUE_PAGE_SIZE {
            flush(&mut pages, &mut current);
        }
        current.drafts.push(item);
    }
    flush(&mut pages, &mut current);
    if pages.is_empty() {
        pages.push(QueuePage::default());
    }
    pages
}

fn item_button(item: &StudioQueueItem, now: Timestamp, zone: &Zone) -> String {
    let targets = if item.targets > 0 {
        format!(" · {} {}", item.targets, t(Key::QueuePlatformsSuffix, &[]))
    } else {
        String::new()
    };
    // A publication whose time has gone by is marked where the operator reads it,
    // not only sorted to the top where it looks like the next one due.
    let overdue = if item.overdue { "⏰ " } else { "" };
    let button = format!(
        "{overdue}{} · {} {}{targets}",
        format_queue_time(item.time, now, zone),
        kind_icon(item.kind),
        item.label
    );
    truncate_unicode(&button, 60).to_owned()
}

fn kind_icon(kind: PublicationKind) -> &'static str {
    match kind {
        PublicationKind::Post => "📝",
        PublicationKind::Video => "🎬",
    }
}

/// The item's card: `p:<kind>:view:<id>:overview`.
fn item_callback(kind: PublicationKind, id: i64) -> crate::Result<String> {
    Ok(publication_callback(kind, "view", &[&id, &"overview"], None)?)
}
