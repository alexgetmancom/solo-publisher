//! Process-wide primitives every other crate builds on: configuration, the
//! Russian interface catalog, text and Markdown helpers, zoned time, the
//! credential seal and the structured logger.
//!
//! The interface is Russian only, so there is no interface locale switch:
//! everything that takes a locale renders `ru-RU`.

pub mod config;
pub mod errors;
pub mod html;
pub mod i18n;
pub mod js;
pub mod json;
pub mod logger;
pub mod markdown;
pub mod media_types;
pub mod redact;
pub mod secret_box;
pub mod text;
pub mod time;
pub mod url;
