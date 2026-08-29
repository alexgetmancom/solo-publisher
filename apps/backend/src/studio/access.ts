import type { BackendConfig } from "../foundation/config.js";

/** One self-hosted Studio installation is one trusted editorial boundary.
 * Every configured Studio actor can operate work created by another actor in
 * that same installation; actor IDs remain on rows for attribution and audit.
 *
 * The MCP actor is on the roster by construction rather than by being listed
 * twice: the token already authorizes it, so requiring it in STUDIO_ACTOR_IDS
 * granted nothing and only made an agent-operated Studio — no Telegram bot, no
 * roster — refuse to boot on its first `docker compose up`. */
function studioActorIds(config: BackendConfig): number[] {
  const roster = config.STUDIO_ACTOR_IDS.length > 0 ? config.STUDIO_ACTOR_IDS : config.CONTROLLER_ADMIN_IDS;
  const mcpActor = config.MCP_STUDIO_ACTOR_ID;
  if (!mcpActor || roster.includes(mcpActor)) return roster;
  return [mcpActor, ...roster];
}

/** The owner used by surfaces that authenticate the installation rather than
 * one person, such as the Command Center and the operations CLI. */
export function primaryStudioActorId(config: BackendConfig): number | null {
  return config.MCP_STUDIO_ACTOR_ID ?? studioActorIds(config)[0] ?? null;
}

export function hasStudioAuthoringInterface(config: BackendConfig): boolean {
  const telegram = Boolean(config.controllerBotToken && config.CONTROLLER_ADMIN_IDS.length);
  const mcp = Boolean(config.MCP_STUDIO_TOKEN && config.MCP_STUDIO_ACTOR_ID);
  return telegram || mcp;
}

export function accessibleStudioActorIds(config: BackendConfig, actorId: number): number[] {
  const roster = studioActorIds(config);
  return roster.includes(actorId) ? roster : [actorId];
}

export function canAccessStudioOwner(config: BackendConfig, actorId: number, ownerId: number): boolean {
  return accessibleStudioActorIds(config, actorId).includes(ownerId);
}
