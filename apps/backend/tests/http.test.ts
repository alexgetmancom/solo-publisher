import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "../src/api.js";
import { listChannels } from "../src/channels/registry.js";
import { createDraftFromMessage } from "../src/content/drafts.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import type { BackendConfig } from "../src/foundation/config.js";
import { publishDraftToQueue } from "../src/publishing/publication-workflow.js";
import { channelService } from "../src/studio/services/channels.js";
import { registerTestChannels, TEXT_TEST_CHANNELS } from "./helpers/channels.js";
import { withOpenDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const tempDirs: string[] = [];

function tempDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function tempDb() {
  const backendDb = openBackendDb(join(tempDir("alexgetman-http-"), "pipeline.db"), 5000);
  registerTestChannels(backendDb, TEXT_TEST_CHANNELS);
  return backendDb;
}

const withTempDb = <T>(fn: (backendDb: UnsafeBackendDb) => T | Promise<T>): Promise<T> => withOpenDb(tempDb, fn);

function createApiApp(config: BackendConfig, backendDb: ReturnType<typeof openBackendDb>) {
  const handler = createApiHandler({ config, backendDb });
  return {
    request(path: string, init?: RequestInit) {
      return handler(new Request(`http://localhost${path}`, init));
    },
  };
}

describe("Astro endpoint controller", () => {
  it("reports readiness from a real database query and writable data directory", async () => {
    const dataDir = tempDir("alexgetman-ready-");
    const backendDb = openBackendDb(join(dataDir, "pipeline.db"), 5000);
    try {
      const app = createApiApp(loadTestConfig({ DATA_DIR: dataDir }), backendDb);
      const response = await app.request("/readyz");
      const body = (await response.json()) as { ok: boolean; checks: Record<string, { ok: boolean }> };
      expect(response.status).toBe(200);
      expect(body.ok).toBe(true);
      expect(body.checks.database?.ok).toBe(true);
      expect(body.checks.data_dir_writable?.ok).toBe(true);
    } finally {
      backendDb.close();
    }
  });

  it("fails readiness when the data directory is not writable", async () => {
    const dataDir = tempDir("alexgetman-ready-ro-");
    const backendDb = openBackendDb(join(dataDir, "pipeline.db"), 5000);
    try {
      // The deploy gate curls /readyz with --fail, so an unwritable volume has
      // to surface as a non-2xx status, not as a green body field.
      chmodSync(dataDir, 0o500);
      const response = await createApiApp(loadTestConfig({ DATA_DIR: dataDir }), backendDb).request("/readyz");
      expect(response.status).toBe(503);
      expect(((await response.json()) as { checks: Record<string, { ok: boolean }> }).checks.data_dir_writable?.ok).toBe(false);
    } finally {
      chmodSync(dataDir, 0o700);
      backendDb.close();
    }
  });

  it("does not gate a site-disabled Studio on its unused site directory", async () => {
    const dataDir = tempDir("alexgetman-ready-no-site-");
    const siteDir = tempDir("alexgetman-unused-site-");
    const backendDb = openBackendDb(join(dataDir, "pipeline.db"), 5000);
    try {
      const config = loadTestConfig({
        DATA_DIR: dataDir,
        SITE_PUBLIC_DIR: siteDir,
      });
      const response = await createApiApp(config, backendDb).request("/readyz");
      const body = (await response.json()) as { checks: Record<string, { ok: boolean }> };
      expect(response.status).toBe(200);
      expect(body.checks.site_public_dir).toBeUndefined();
    } finally {
      backendDb.close();
    }
  });

  it("does not let a URL token authorize command-center mutations", () =>
    withTempDb(async (backendDb) => {
      const app = createApiApp(loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      // A URL token is readable in proxy logs and Referer headers, so it
      // authorizes reads only: a mutation has to carry a header, form field or
      // the HttpOnly cookie.
      expect(
        (
          await app.request("/api/command-center/action?token=secret", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ action: "retry", ref: "post:1" }),
          })
        ).status,
      ).toBe(403);
    }));

  it("connects a direct publication target from an authenticated Command Center form", async () => {
    const backendDb = openBackendDb(join(tempDir("alexgetman-channel-connect-"), "pipeline.db"), 5000);
    try {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const app = createApiApp(config, backendDb);
      const body = new FormData();
      body.set("target", "telegram_stories");
      const response = await app.request("/command-center/channels/connect", {
        method: "POST",
        body,
        headers: { cookie: "command_token=secret", origin: new URL(config.COMMAND_CENTER_URL).origin },
      });

      expect(response.status).toBe(303);
      expect(response.headers.get("location")).toBe("/command-center?tab=studio");
      expect(listChannels(backendDb).map(({ id }) => id)).toEqual(["telegram_stories"]);
    } finally {
      backendDb.close();
    }
  });

  it("rejects a cross-origin channel connection form", async () => {
    const backendDb = openBackendDb(join(tempDir("alexgetman-channel-csrf-"), "pipeline.db"), 5000);
    try {
      const app = createApiApp(loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      const body = new FormData();
      body.set("target", "telegram");
      const response = await app.request("/command-center/channels/connect", {
        method: "POST",
        body,
        headers: { cookie: "command_token=secret", origin: "https://attacker.example" },
      });

      expect(response.status).toBe(403);
      expect(listChannels(backendDb)).toEqual([]);
    } finally {
      backendDb.close();
    }
  });

  it("disables a channel from an authenticated Command Center form", async () => {
    const backendDb = openBackendDb(join(tempDir("alexgetman-channel-disable-"), "pipeline.db"), 5000);
    try {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const app = createApiApp(config, backendDb);
      channelService(backendDb, config).connectTarget("telegram");
      const body = new FormData();
      body.set("channel", "telegram");
      const response = await app.request("/command-center/channels/disable", {
        method: "POST",
        body,
        headers: { cookie: "command_token=secret", origin: new URL(config.COMMAND_CENTER_URL).origin },
      });

      expect(response.status).toBe(303);
      expect(listChannels(backendDb)).toEqual([]);
      expect(listChannels(backendDb, false)).toMatchObject([{ id: "telegram", enabled: 0 }]);
    } finally {
      backendDb.close();
    }
  });

  it("stops a run of command-center login guesses", () =>
    withTempDb(async (backendDb) => {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const app = createApiApp(config, backendDb);
      const origin = new URL(config.COMMAND_CENTER_URL).origin;
      const guess = () => {
        const body = new FormData();
        body.set("token", "wrong");
        return app.request("/command-center", { method: "POST", body, headers: { origin } });
      };

      // No HTTP Basic stands in front of this form any more, so the limiter is
      // the only thing making a guess cost wall-clock time.
      const statuses: number[] = [];
      for (let attempt = 0; attempt < 12; attempt += 1) statuses.push((await guess()).status);
      expect(statuses.at(-1)).toBe(429);

      // The owner is not collateral damage: a correct token still signs in
      // while a stranger's guesses are being refused on the same bucket.
      const correct = new FormData();
      correct.set("token", "secret");
      const signIn = await app.request("/command-center", { method: "POST", body: correct, headers: { origin } });
      expect(signIn.status).toBe(303);
    }));

  it("serves a stable compact command-center fingerprint", () =>
    withTempDb(async (backendDb) => {
      const app = createApiApp(loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      const firstResponse = await app.request("/api/command-center/fingerprint", { headers: { "X-Command-Token": "secret" } });
      const secondResponse = await app.request("/api/command-center/fingerprint", { headers: { "X-Command-Token": "secret" } });
      const first = await firstResponse.json();
      const second = await secondResponse.json();

      expect(firstResponse.status).toBe(200);
      expect(secondResponse.status).toBe(200);
      expect(first).toEqual({
        pipelineUpdatedAt: null,
        latestJobUpdatedAt: null,
        latestEventAt: null,
        videoRevision: null,
        analyticsRevision: null,
        studioRevision: expect.any(String),
      });
      expect(second).toEqual(first);
      expect(JSON.stringify(first).length).toBeLessThan(200);
      expect((await app.request("/api/command-center/fingerprint")).status).toBe(403);
    }));

  it("loads publication details in bounded authenticated batches", () =>
    withTempDb(async (backendDb) => {
      const app = createApiApp(loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      expect((await app.request("/api/command-center/publication-details")).status).toBe(403);
      const response = await app.request("/api/command-center/publication-details?period=1&offset=0&limit=50", {
        headers: { "X-Command-Token": "secret" },
      });
      const payload = (await response.json()) as { html: string; total: number; loaded: number; remaining: number };
      expect(response.status).toBe(200);
      expect(payload).toEqual({ html: "", total: 0, loaded: 0, remaining: 0 });
    }));

  it("serves engagement and MCP routes", () =>
    withTempDb(async (backendDb) => {
      const app = createApiApp(
        loadTestConfig({
          CLIENT_IP_HASH_SALT: "test-salt-value!",
          TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
        }),
        backendDb,
      );
      expect(
        (
          await app.request("/stats/pageview", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ path: "/post/" }),
          })
        ).status,
      ).toBe(204);
      expect(backendDb.sqlite.prepare("SELECT count FROM site_pageviews WHERE path=?").get("/post/")).toEqual({ count: 1 });

      const initialized = await app.request("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      });
      expect(await initialized.json()).toMatchObject({ jsonrpc: "2.0", id: 1, result: { protocolVersion: "2024-11-05" } });
      for (let index = 0; index < 5; index++) {
        const response = await app.request("/api/mcp", {
          method: "POST",
          headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1", "x-forwarded-for": `198.51.100.${index + 1}` },
          body: JSON.stringify({
            jsonrpc: "2.0",
            id: index,
            method: "tools/call",
            params: { name: "submit_feedback", arguments: { message: `Feedback ${index}` } },
          }),
        });
        expect(await response.json()).toMatchObject({ result: { content: [{ type: "text" }] } });
      }
      const limitedFeedback = await app.request("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json", "x-real-ip": "203.0.113.1", "x-forwarded-for": "198.51.100.99" },
        body: JSON.stringify({
          jsonrpc: "2.0",
          id: 99,
          method: "tools/call",
          params: { name: "submit_feedback", arguments: { message: "Too many requests" } },
        }),
      });
      expect(await limitedFeedback.json()).toMatchObject({ error: { code: -32000, message: "rate limit exceeded" } });
    }));

  it("runs authenticated command-center repair actions", () =>
    withTempDb(async (backendDb) => {
      const draftId = createDraftFromMessage(backendDb, 42, { text: "Исходник", textEn: "Original", entities: [], media: [] });
      const postId = publishDraftToQueue(backendDb, draftId);
      const app = createApiApp(loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" }), backendDb);
      const response = await app.request("/api/command-center/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          action: "edit",
          ref: `post:${postId}`,
          locale: "en",
          text: "Edited <English>",
          apply: true,
          token: "secret",
        }),
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, post_id: postId, locale: "en", text: true });
      expect(
        backendDb.sqlite
          .prepare(
            "SELECT approved_text, html, entities_json FROM post_locales JOIN drafts ON drafts.id=post_locales.draft_id WHERE post_id=? AND locale='en'",
          )
          .get(postId),
      ).toEqual({
        approved_text: "Edited <English>",
        html: "Edited &lt;English&gt;",
        entities_json: "[]",
      });
      expect((backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM ops_actions").get() as { count: number }).count).toBe(1);
      // And the same mutation journal: a repair used to leave the timeline
      // empty when it was done from the card and full when it was done from the
      // command line, which made the history depend on where the operator was
      // standing.
      expect(
        backendDb.sqlite.prepare("SELECT publication_key, target FROM publication_events WHERE event_type='operations.command'").all(),
      ).toEqual([{ publication_key: `post:${postId}`, target: "command-center" }]);
      expect(
        (
          backendDb.sqlite.prepare("SELECT COUNT(*) AS count FROM site_jobs WHERE publication_key='post:'||?").get(postId) as {
            count: number;
          }
        ).count,
      ).toBe(3);

      const failed = await app.request("/api/command-center/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "unknown", ref: `post:${postId}`, token: "secret" }),
      });
      expect(failed.status).toBe(400);
      // The card runs the same dispatch the CLI and the MCP tools do, so it
      // gets the same answer instead of a shrug. "Action failed" was every
      // failure at once: a bad field, a publication with nothing to retry, and
      // a platform refusing a delete all read identically.
      expect(await failed.json()).toEqual({ detail: "unknown command: unknown" });

      // Not only the registry's input errors: a failure from inside the repair
      // reaches the operator with the sentence the command line would print.
      const missing = await app.request("/api/command-center/action", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action: "retry", ref: "post:999999", apply: true, token: "secret" }),
      });
      expect(missing.status).toBe(400);
      expect(await missing.json()).toEqual({ detail: "publication not found: post:999999" });
    }));

  it("renders the full command center through the framework-neutral controller", async () => {
    const backendDb = tempDb();
    const dir = tempDir("alexgetman-markdown-");
    try {
      backendDb.sqlite
        .prepare(
          "INSERT INTO credential_checks(target,status,required_env_json,missing_env_json,last_checked_at) VALUES ('telegram','ready','[]','[]',?)",
        )
        .run(new Date().toISOString());
      const app = createApiApp(
        loadTestConfig({
          COMMAND_CENTER_TOKEN: "secret",
          PUBLIC_BASE_URL: "https://marux.ru",
          SITE_PUBLIC_DIR: dir,
        }),
        backendDb,
      );
      const login = await app.request("/command-center");
      expect(login.status).toBe(200);
      expect(await login.text()).toContain("Введите токен Command Center");
      const signIn = await app.request("/command-center", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://marux.ru" },
        body: "token=secret",
      });
      expect(signIn.status).toBe(303);
      const cookie = signIn.headers.get("set-cookie");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("Max-Age=15552000");
      const crossSiteSignIn = await app.request("/command-center", {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded", origin: "https://example.com" },
        body: "token=secret",
      });
      expect(crossSiteSignIn.status).toBe(403);
      const dashboard = await app.request("/command-center", { headers: { cookie: cookie ?? "" } });
      const html = await dashboard.text();
      expect(dashboard.status).toBe(200);
      expect(html).toContain("Обзор");
      expect(html).not.toContain("Аудитория и profile metrics");
      expect(html).toContain('href="/command-center?tab=posts&panel=health"');
      expect(html).toContain("Исправление");
      const englishDashboard = await app.request("/command-center?locale=en", { headers: { cookie: cookie ?? "" } });
      const englishHtml = await englishDashboard.text();
      expect(englishHtml).toContain('<html lang="en">');
      expect(englishHtml).toContain(">Overview</a>");
      expect(englishHtml).toContain('aria-label="Language"');
      expect(englishHtml).not.toContain("ПУБЛИКАЦИИ");
      expect(html).toContain("const navigateDashboard = async");
      expect(html).toContain("history.pushState");
      expect(html).not.toContain("window.location.reload");
      expect(html).not.toContain("Health: credentials и diagnostics");
      expect(html).toContain('font:400 16px ui-sans-serif,-apple-system,"Inter"');
      expect(html).not.toContain("width: 22px; text-align: center; font-family: monospace");
    } finally {
      backendDb.close();
    }
  });
});
