import type { BackendConfig } from "./config.js";

// Telegram callback_data is limited to 64 bytes. "deploy_rollback:" plus a
// seven-character profile name leaves room for a normal 40-character Git SHA.
const releasePattern = /^[a-f0-9]{7,40}$/i;
const targetPattern = /^[a-z][a-z0-9_-]{0,6}$/;
const deploymentRetryAttempts = 3;
const deploymentRetryBackoffMs = 5_000;
const retryableDeploymentStatuses = new Set([408, 425, 429, 502, 503, 504]);

type DeploymentRollbackResult = { ok: true; release: string; currentRevision: string } | { ok: false; message: string };

type Release = { image?: string; revision?: string; deployedAt?: string };
export type DeploymentReleases =
  | {
      ok: true;
      deploying: boolean;
      targets: { target: string; kind: string; current?: Release; previous?: Release; lastFailure?: unknown }[];
    }
  | { ok: false; message: string };
type FetchImplementation = (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
type SleepImplementation = (milliseconds: number) => Promise<void>;

const defaultSleep: SleepImplementation = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

/** What a deployment control may name. Telegram allows 64 bytes of callback
 * data, and "deploy_rollback:" plus a seven-character profile leaves room for a
 * full 40-character Git SHA -- so both are checked, at the button and at the tap. */
export function isDeploymentTarget(value: string): boolean {
  return targetPattern.test(value);
}

export function isDeploymentRevision(value: string): boolean {
  return releasePattern.test(value);
}

export async function requestDeploymentRollback(
  config: BackendConfig,
  target: string,
  revision: string,
  fetchImpl: FetchImplementation = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<DeploymentRollbackResult> {
  return requestDeploymentAgent(config, "rollback", target, revision, fetchImpl, sleepImpl);
}

/** Deploys to `target` the exact release already proven healthy on alex.
 * Only "alex" is auto-deployed by CI; every other target is promoted manually
 * from here so a vetted release never cascades to another environment unseen. */
export async function requestDeploymentPromote(
  config: BackendConfig,
  target: string,
  revision: string,
  fetchImpl: FetchImplementation = fetch,
  sleepImpl: SleepImplementation = defaultSleep,
): Promise<DeploymentRollbackResult> {
  return requestDeploymentAgent(config, "promote", target, revision, fetchImpl, sleepImpl);
}

/** What every target this agent drives is running, and what it would roll back
 * to. A read, so it is not retried: a deployment question asked twice during a
 * rollout answers differently, and the useful report is the one that says the
 * agent could not be reached rather than one stitched from two moments. */
export async function readDeploymentReleases(config: BackendConfig, fetchImpl: FetchImplementation = fetch): Promise<DeploymentReleases> {
  if (!config.DEPLOY_AGENT_URL || !config.DEPLOY_AGENT_TOKEN) return { ok: false, message: "Deployment agent is not configured." };
  try {
    const response = await fetchImpl(`${config.DEPLOY_AGENT_URL.replace(/\/$/, "")}/v1/releases`, {
      headers: { authorization: `Bearer ${config.DEPLOY_AGENT_TOKEN}` },
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await response.json().catch(() => null)) as DeploymentReleases | null;
    if (response.ok && body?.ok === true) return body;
    const message = body && body.ok === false && typeof body.message === "string" ? body.message : `Request failed (${response.status}).`;
    return { ok: false, message };
  } catch {
    return { ok: false, message: "Deployment agent is unavailable." };
  }
}

async function requestDeploymentAgent(
  config: BackendConfig,
  action: "rollback" | "promote",
  target: string,
  revision: string,
  fetchImpl: FetchImplementation,
  sleepImpl: SleepImplementation,
): Promise<DeploymentRollbackResult> {
  if (!config.DEPLOY_AGENT_URL || !config.DEPLOY_AGENT_TOKEN) return { ok: false, message: "Deployment agent is not configured." };
  if (!targetPattern.test(target) || !releasePattern.test(revision)) return { ok: false, message: "Invalid deployment request." };
  for (let attempt = 1; attempt <= deploymentRetryAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(`${config.DEPLOY_AGENT_URL.replace(/\/$/, "")}/v1/${action}/${target}`, {
        method: "POST",
        headers: { authorization: `Bearer ${config.DEPLOY_AGENT_TOKEN}`, "content-type": "application/json" },
        body: JSON.stringify({ release: revision }),
        // The agent's own healthcheck loop alone runs up to 90s; leave enough
        // margin for the image pull and container recreate around it so a slow
        // deploy reports its real outcome instead of a false "unavailable".
        signal: AbortSignal.timeout(150_000),
      });
      const body = (await response.json().catch(() => null)) as {
        ok?: unknown;
        release?: unknown;
        currentRevision?: unknown;
        message?: unknown;
      } | null;
      if (response.ok && body?.ok === true && typeof body.release === "string" && typeof body.currentRevision === "string") {
        return { ok: true, release: body.release, currentRevision: body.currentRevision };
      }
      const message = typeof body?.message === "string" ? body.message : `Request failed (${response.status}).`;
      if (attempt === deploymentRetryAttempts || !retryableDeploymentStatuses.has(response.status)) return { ok: false, message };
    } catch {
      if (attempt === deploymentRetryAttempts) return { ok: false, message: "Deployment agent is unavailable." };
    }
    await sleepImpl(deploymentRetryBackoffMs * 2 ** (attempt - 1));
  }
  return { ok: false, message: "Deployment agent is unavailable." };
}
