//! The operation handlers, one module per area of the catalog. Each handler
//! is the body of one registry entry (or the module it calls).

pub mod admin;
pub mod commands;
pub mod lifecycle;
pub mod media;
pub(crate) mod publication_ref;
pub mod reads;
mod reviewed_plan;
mod rows;
mod site;
mod timeline;
mod usage;
