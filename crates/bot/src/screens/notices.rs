//! The messages the bot sends on its own: what a tick of the
//! Telegram event and daily-backup loops sends. The loops themselves (tasks,
//! intervals, wake-ups) are [`crate::workers`]. The area has no screens: the
//! buttons on its notices are the post and video areas' controls.

mod backup;
mod events;
mod notifications;

use crate::registry::Registry;

pub use backup::{BackupDeliveryStatus, send_daily_backup};
pub use events::consume_telegram_events;

pub fn register(_: &mut Registry) {}
