//! The operation handlers, one module per area of the catalog. Each handler
//! is the body of one `registry.ts` entry (or the module it called).

pub mod admin;
pub mod commands;
pub mod lifecycle;
pub mod media;
mod plan_schema;
pub(crate) mod publication_ref;
pub mod reads;
mod site;
mod timeline;
mod usage;
