//! The operation handlers, one module per area of the catalog. Each handler
//! is the body of one `registry.ts` entry (or the module it called).

pub mod admin;
pub mod commands;
pub mod lifecycle;
pub mod media;
mod plan_schema;
pub mod reads;
mod site;
mod timeline;

/// A handler not ported yet answers with a refusal naming itself.
macro_rules! not_ported {
    ($($name:ident),* $(,)?) => {
        $(
            pub fn $name<'a>(
                _context: &'a $crate::context::OperationContext<'a>,
                _input: &'a $crate::context::Input,
            ) -> $crate::context::Fut<'a, $crate::context::OpResult> {
                Box::pin(async { Err($crate::context::OpError::failed(concat!("not ported: ", stringify!($name)))) })
            }
        )*
    };
}
pub(crate) use not_ported;
