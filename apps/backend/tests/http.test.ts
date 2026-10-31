import { afterEach, describe, expect, it } from "bun:test";
import { chmodSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createApiHandler } from "../src/api.js";
import { listChannels } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import type { BackendConfig } from "../src/foundation/config.js";
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

describe("Studio HTTP surface", () => {
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

  it("retires the dashboard and its APIs without changing connected publishing channels", () =>
    withTempDb(async (backendDb) => {
      const config = loadTestConfig({ COMMAND_CENTER_TOKEN: "secret" });
      const app = createApiApp(config, backendDb);
      const channels = listChannels(backendDb, false);
      const paths = [
        "/command-center",
        "/command-center/",
        "/command-center?tab=studio",
        "/command-center?token=secret",
        "/command-center/channels/connect",
        "/command-center/channels/disable",
        "/command-center/channels/zernio?locale=ru",
        "/api/command-center/fingerprint",
        "/api/command-center/publication-details?period=7&offset=0&limit=50",
      ];
      for (const path of paths) {
        for (const authenticated of [false, true]) {
          for (const method of ["GET", "POST"]) {
            const response = await app.request(path, {
              method,
              headers: authenticated ? { "X-Command-Token": "secret", "X-Admin-Token": "secret", cookie: "command_token=secret" } : {},
              ...(method === "POST" ? { body: "target=telegram_stories&channel=telegram&token=secret" } : {}),
            });
            expect(response.status).toBe(404);
            expect(response.headers.get("set-cookie")).toBeNull();
            expect(response.headers.get("location")).toBeNull();
          }
        }
      }
      expect(listChannels(backendDb, false)).toEqual(channels);
    }));

  it("serves MCP and rate-limits feedback by client", () =>
    withTempDb(async (backendDb) => {
      const app = createApiApp(
        loadTestConfig({
          CLIENT_IP_HASH_SALT: "test-salt-value!",
          TRUSTED_CLIENT_IP_HEADER: "x-real-ip",
        }),
        backendDb,
      );
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
});
