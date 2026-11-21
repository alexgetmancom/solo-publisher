//! The bot's screens, one module per area of the bot. Each area module has a
//! `pub fn register(registry: &mut Registry)` and is listed here once; adding
//! an area is that one line (see `crates/bot/README.md`).

use crate::registry::Registry;

macro_rules! areas {
    ($($area:ident,)*) => {
        $(pub mod $area;)*

        /// Every area's registrations, in this order.
        pub(crate) fn register(registry: &mut Registry) {
            $($area::register(registry);)*
        }
    };
}

areas! {
    entry,
    intake,
    queue,
    deploy,
    settings,
    post,
}
