//! The messages the bot sends on its own (spec §7): one function per tick of
//! each Telegram loop (`interfaces/telegram/worker.ts`). The loops' scheduler
//! (intervals, single flight, wake-ups) is the application's; every tick here
//! does one pass and returns. The area has no screens: the buttons on its
//! notices are the post and video areas' controls.
//!
//! | loop | tick |
//! |---|---|
//! | `telegram-events` | [`consume_telegram_events`] |
//! | `telegram-translations` | Content's translation cycle, then [`refresh_translated_drafts`] |
//! | `telegram-alerts` | [`deliver_alerts`] |
//! | `telegram-daily-backup` | [`send_daily_backup`] |
//! | `telegram-albums` | [`crate::albums::finalize_pending_albums`] |

mod backup;
mod events;
mod notifications;

use crate::api::payload::Payload;
use crate::bot::Bot;
use crate::context::Ctx;
use crate::registry::Registry;
use crate::screens::post::refresh_post_preview_card;

pub use backup::{BackupDeliveryStatus, send_daily_backup};
pub use events::consume_telegram_events;

pub fn register(_: &mut Registry) {}

/// The `telegram-translations` tick after Content's cycle: a draft's English
/// is made after its card is on screen, and this puts it into the card.
pub async fn refresh_translated_drafts(bot: &Bot, draft_ids: &[i64]) -> crate::Result<()> {
    let ctx = Ctx::worker(bot);
    for &draft_id in draft_ids {
        refresh_post_preview_card(&ctx, draft_id).await?;
    }
    Ok(())
}

/// The `telegram-alerts` tick: Observability's pending alerts, sent to the
/// first administrator (none configured: the alerts wait).
pub async fn deliver_alerts(bot: &Bot) -> crate::Result<usize> {
    let ctx = Ctx::worker(bot);
    let api = ctx.bot.api();
    let send = ctx.config.controller_admin_ids.first().map(|&actor_id| {
        move |text: String| async move {
            api.send_message(actor_id, &text, Payload::new())
                .await
                .map(|_| ())
                .map_err(|error| error.js_string())
        }
    });
    Ok(domain::observability::alerts::deliver_pending_alerts(ctx.db(), ctx.clock(), send).await?)
}
