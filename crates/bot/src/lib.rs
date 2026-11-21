//! The Studio Telegram bot (`apps/backend/src/bot.ts`, `bot/**`), Russian only.
//!
//! The core lives here: the Bot API client and its transformer stack
//! ([`api`]), update intake ([`runner`], [`bot`]: the middleware chain in the
//! order `bot.ts` installs it), the callback boundary, the callback grammar,
//! effects and the screen anchor, conversation state, card bindings, the menu
//! plugin's wire format ([`menu`]) and the main menu ([`screens::entry`]).
//! Every other screen is an area module under [`screens`], registered through
//! [`registry::Registry`]; see `README.md`.
//!
//! Everything runs on one thread (a tokio `LocalSet`), as the TypeScript bot
//! ran on one event loop: handlers borrow the database connection across
//! awaits, and the per-chat ordering is the only ordering there is.

pub mod action_lock;
pub mod albums;
pub mod api;
pub mod bot;
mod boundary;
pub mod callback;
pub mod cards;
pub mod context;
pub mod deployment;
pub mod dialog_ui;
pub mod effects;
pub mod error_text;
pub mod media_ingress;
pub mod menu;
pub mod message;
pub mod publication;
pub mod queue_time;
pub mod registry;
pub mod runner;
pub mod screens;
mod sequentialize;
pub mod session;
pub mod tap;

use std::future::Future;
use std::pin::Pin;

pub use bot::{Adapters, Bot, BotDeps, DynAdapters, Host};
pub use context::Ctx;

/// A boxed future on the bot's thread.
pub type Fut<'a, T> = Pin<Box<dyn Future<Output = T> + 'a>>;

/// Whatever a handler fails with: a `StudioError` (rendered through the
/// catalog), a domain error, a Bot API error, or a plain message.
pub type Error = Box<dyn std::error::Error>;
pub type Result<T, E = Error> = std::result::Result<T, E>;

/// A plain error with this message (TypeScript's `throw new Error(message)`).
pub fn error(message: impl Into<String>) -> Error {
    message.into().into()
}
