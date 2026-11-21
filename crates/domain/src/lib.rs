//! The persistence layer Studio, publishing and the bot sit on: the
//! application vocabulary (`application`) and the SQLite repositories that
//! implement it against the shared schema (`repositories`).
//!
//! Every statement keeps the semantics of the Drizzle query it replaces — the
//! same `WHERE` (a check that guards a write lives in that write), the same
//! ordering, `RETURNING` and transaction kind — which
//! `tests/scenarios.rs` checks by running identical scenarios through both.

pub mod application;
pub mod channels;
mod error;
pub mod json;
pub mod publishing;
pub mod repositories;
pub mod studio;
pub mod targets;

pub use error::{Error, Result};
