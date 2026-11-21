//! Process-wide primitives every other crate builds on: configuration, the
//! Russian interface catalog, text and Markdown helpers, zoned time, the
//! credential seal and the structured logger.
//!
//! The interface is Russian only, so the TypeScript `locale.ts` (the interface
//! locale switch) has no counterpart here: everything that took a locale renders
//! `ru-RU`.

pub mod config;
pub mod errors;
pub mod i18n;
mod js;
pub mod logger;
pub mod markdown;
pub mod redact;
pub mod secret_box;
pub mod text;
pub mod time;
