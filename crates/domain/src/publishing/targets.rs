//! The target selection a draft persists, as publishing reads it.

use crate::targets::{TargetMap, is_known_target};
use crate::{Error, Result};

/// Unknown enabled keys must fail before a durable job can be materialized.
pub fn assert_known_targets(targets: &TargetMap) -> Result<()> {
    let mut unknown: Vec<&str> = targets.enabled().filter(|target| !is_known_target(target)).collect();
    unknown.sort_unstable();
    if unknown.is_empty() {
        return Ok(());
    }
    Err(Error::message(format!(
        "Unknown publication target(s): {}",
        unknown.join(", ")
    )))
}
