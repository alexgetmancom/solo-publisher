//! One self-hosted Studio installation is one trusted editorial boundary
//! (`studio/access.ts`). Every configured Studio actor can operate work
//! created by another actor in the same installation; actor ids remain on
//! rows for attribution and audit.

use foundation::config::Config;

/// The roster, with the MCP actor on it by construction: its token already
/// authorizes it.
fn studio_actor_ids(config: &Config) -> Vec<i64> {
    let roster = if config.studio_actor_ids.is_empty() {
        config.controller_admin_ids.clone()
    } else {
        config.studio_actor_ids.clone()
    };
    match config.mcp_studio_actor_id.filter(|actor| *actor != 0) {
        Some(actor) if !roster.contains(&actor) => std::iter::once(actor).chain(roster).collect(),
        _ => roster,
    }
}

/// The owner used by surfaces that authenticate the installation rather than
/// one person, such as the Command Center and the operations CLI.
pub fn primary_studio_actor_id(config: &Config) -> Option<i64> {
    config
        .mcp_studio_actor_id
        .or_else(|| studio_actor_ids(config).first().copied())
}

pub fn accessible_studio_actor_ids(config: &Config, actor_id: i64) -> Vec<i64> {
    let roster = studio_actor_ids(config);
    if roster.contains(&actor_id) {
        roster
    } else {
        vec![actor_id]
    }
}

pub fn can_access_studio_owner(config: &Config, actor_id: i64, owner_id: i64) -> bool {
    accessible_studio_actor_ids(config, actor_id).contains(&owner_id)
}
