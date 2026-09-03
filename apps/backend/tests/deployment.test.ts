import { describe, expect, it, mock } from "bun:test";
import { parseScreenCallback, screenCallback } from "../src/bot/screen-callback.js";
import {
  isDeploymentRevision,
  isDeploymentTarget,
  readDeploymentReleases,
  requestDeploymentPromote,
  requestDeploymentRollback,
} from "../src/foundation/deployment.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const revision = "a".repeat(40);
const agent = { DEPLOY_AGENT_URL: "http://host.docker.internal:9899", DEPLOY_AGENT_TOKEN: "t".repeat(16) };

describe("deployment callbacks", () => {
  it("refuses anything but a Git SHA as the release to deploy", () => {
    // A rollback target is executed verbatim by the agent. "latest" would move
    // the release pointer to whatever happens to be newest at that moment.
    expect(isDeploymentRevision("latest")).toBe(false);
    expect(isDeploymentRevision(revision)).toBe(true);
    expect(isDeploymentTarget("maru")).toBe(true);
    expect(isDeploymentTarget("a-very-long-profile-name")).toBe(false);
  });

  it("keeps the confirmation tap and the executing tap on separate screens", () => {
    // One shared name would make the first tap deploy instead of asking.
    expect(parseScreenCallback(screenCallback("deploy_rb_ask", ["maru", revision]))).toEqual({
      id: "deploy_rb_ask",
      args: { target: "maru", revision },
    });
    expect(parseScreenCallback(screenCallback("deploy_rollback", ["maru", revision]))?.id).toBe("deploy_rollback");
  });

  it("keeps a deployment button inside Telegram's 64 bytes", () => {
    expect(screenCallback("deploy_rollback", ["worker", revision]).length).toBeLessThanOrEqual(64);
  });
});

describe("deployment agent requests", () => {
  it("forwards an authenticated request to the per-action agent endpoint", async () => {
    const calls: Array<{ url: string; init: RequestInit | undefined }> = [];
    const fetchImpl = mock(async (input: RequestInfo | URL, init?: RequestInit) => {
      calls.push({ url: String(input), init });
      return Response.json({ ok: true, release: revision, currentRevision: revision });
    });

    await requestDeploymentRollback(loadTestConfig(agent), "maru", revision, fetchImpl);
    await requestDeploymentPromote(loadTestConfig(agent), "maru", revision, fetchImpl);

    expect(calls.map((call) => call.url)).toEqual([
      "http://host.docker.internal:9899/v1/rollback/maru",
      "http://host.docker.internal:9899/v1/promote/maru",
    ]);
    expect(calls[0]?.init?.headers).toMatchObject({ authorization: `Bearer ${"t".repeat(16)}` });
    expect(calls[0]?.init?.body).toBe(JSON.stringify({ release: revision }));
  });

  it("does not issue network requests when deployment control is disabled", async () => {
    const fetchImpl = mock(fetch);

    await expect(requestDeploymentRollback(loadTestConfig({}), "maru", revision, fetchImpl)).resolves.toEqual({
      ok: false,
      message: "Deployment agent is not configured.",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("retries a transient agent failure before reporting deployment failure", async () => {
    let attempts = 0;
    const sleeps: number[] = [];
    const fetchImpl = mock(async () => {
      attempts += 1;
      if (attempts === 1) return Response.json({ ok: false, message: "Deploy failed and was rolled back" }, { status: 502 });
      return Response.json({ ok: true, release: revision, currentRevision: revision });
    });

    await expect(
      requestDeploymentPromote(loadTestConfig(agent), "worker", revision, fetchImpl, async (milliseconds) => {
        sleeps.push(milliseconds);
      }),
    ).resolves.toEqual({
      ok: true,
      release: revision,
      currentRevision: revision,
    });
    expect(attempts).toBe(2);
    expect(sleeps).toEqual([5_000]);
  });

  it("does not retry a stale deployment request", async () => {
    let attempts = 0;
    const fetchImpl = mock(async () => {
      attempts += 1;
      return Response.json({ ok: false, message: "This button belongs to an older source release." }, { status: 409 });
    });

    await expect(requestDeploymentPromote(loadTestConfig(agent), "worker", revision, fetchImpl, async () => {})).resolves.toEqual({
      ok: false,
      message: "This button belongs to an older source release.",
    });
    expect(attempts).toBe(1);
  });

  /** Until this, nothing but a deploy ever learned a revision: the question
   * "what is actually running" had no read that could answer it. */
  it("reads what every target is running, and says so when it cannot", async () => {
    const requests: { url: string; method: string; authorization: string | null }[] = [];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      requests.push({
        url: String(input),
        method: init?.method ?? "GET",
        authorization: new Headers(init?.headers).get("authorization"),
      });
      return Response.json({
        ok: true,
        deploying: false,
        targets: [{ target: "maru", kind: "compose", current: { revision, deployedAt: "2026-01-01T00:00:00.000Z" } }],
      });
    }) as typeof fetch;

    await expect(readDeploymentReleases(loadTestConfig(agent), fetchImpl)).resolves.toMatchObject({
      ok: true,
      targets: [{ target: "maru", current: { revision } }],
    });
    expect(requests).toEqual([
      { url: "http://host.docker.internal:9899/v1/releases", method: "GET", authorization: `Bearer ${"t".repeat(16)}` },
    ]);

    // An unconfigured agent and an unreachable one are different answers, and
    // neither is an empty list of deployments.
    await expect(readDeploymentReleases(loadTestConfig({}), fetchImpl)).resolves.toEqual({
      ok: false,
      message: "Deployment agent is not configured.",
    });
    const failing = (async () => {
      throw new Error("connection refused");
    }) as unknown as typeof fetch;
    await expect(readDeploymentReleases(loadTestConfig(agent), failing)).resolves.toEqual({
      ok: false,
      message: "Deployment agent is unavailable.",
    });
  });
});
