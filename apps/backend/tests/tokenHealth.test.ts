import { afterAll, describe, expect, it, mock } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { credentialChecks, publicationEvents } from "../src/db/schema.js";
import { checkTokenHealth } from "../src/observability/token-health.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withOpenDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const tempDirectories: string[] = [];

afterAll(() => {
  for (const dir of tempDirectories) rmSync(dir, { recursive: true, force: true });
});

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-token-health-"));
  tempDirectories.push(dir);
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

const withTempDb = <T>(fn: (backendDb: UnsafeBackendDb) => T | Promise<T>): Promise<T> => withOpenDb(tempDb, fn);

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status });
}

describe("token health probes", () => {
  it("warns when a Graph API token is close to expiring", () =>
    withTempDb(async (backendDb) => {
      const soon = new Date(Date.now() + 24 * 60 * 60 * 1000);
      const fetchMock = mock(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("debug_token")) return jsonResponse({ data: { expires_at: Math.floor(soon.getTime() / 1000) } });
        return jsonResponse({ id: "123" });
      });
      const config = loadTestConfig({ INSTAGRAM_RU_ACCESS_TOKEN: "EAAtoken", INSTAGRAM_RU_USER_ID: "123" });
      registerTestChannels(backendDb, ["instagram_ru"]);

      await checkTokenHealth(config, backendDb, fetchMock as unknown as typeof fetch);

      const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "instagram_ru")).get();
      expect(row?.expiresAt).toBe(new Date(Math.floor(soon.getTime() / 1000) * 1000).toISOString());

      const event = backendDb.db
        .select()
        .from(publicationEvents)
        .where(and(eq(publicationEvents.eventType, "credential.token_expiring_soon"), eq(publicationEvents.target, "instagram_ru")))
        .get();
      expect(event).not.toBeUndefined();
      expect(event?.target).toBe("instagram_ru");
    }));

  it("warns when a token authenticates but was never granted a permission the code needs", () =>
    withTempDb(async (backendDb) => {
      // Exactly the Threads chain failure: `me` answers, publishing the first
      // message works, and only the reply is refused -- with an empty HTTP 500
      // that reads as the platform being down rather than as a missing grant.
      const fetchMock = mock(async (url: string | URL | Request) => {
        const href = String(url);
        if (href.includes("debug_token"))
          return jsonResponse({ data: { scopes: ["threads_basic", "threads_content_publish", "threads_manage_insights"] } });
        return jsonResponse({ id: "123" });
      });
      const config = loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "THtoken" });

      await checkTokenHealth(config, backendDb, fetchMock as unknown as typeof fetch);

      const event = backendDb.db
        .select()
        .from(publicationEvents)
        .where(and(eq(publicationEvents.eventType, "credential.token_missing_scope"), eq(publicationEvents.target, "threads_ru")))
        .get();
      expect(event?.message).toContain("threads_manage_replies");
    }));

  it("says nothing about a complete grant, or about a provider that will not list one", () =>
    withTempDb(async (backendDb) => {
      const scopes = ["threads_basic", "threads_content_publish", "threads_manage_replies", "threads_manage_insights"];
      const complete = mock(async (url: string | URL | Request) =>
        String(url).includes("debug_token") ? jsonResponse({ data: { scopes } }) : jsonResponse({ id: "123" }),
      );
      const config = loadTestConfig({ THREADS_RU_ACCESS_TOKEN: "THtoken" });
      await checkTokenHealth(config, backendDb, complete as unknown as typeof fetch);

      // Instagram Login tokens are refused by debug_token, and an unanswered
      // question must not be reported as a missing permission.
      const silent = mock(async (url: string | URL | Request) =>
        String(url).includes("debug_token") ? jsonResponse({ error: "no" }, 403) : jsonResponse({ id: "123" }),
      );
      const igConfig = loadTestConfig({ INSTAGRAM_RU_ACCESS_TOKEN: "EAAtoken", INSTAGRAM_RU_USER_ID: "123" });
      registerTestChannels(backendDb, ["instagram_ru"]);
      await checkTokenHealth(igConfig, backendDb, silent as unknown as typeof fetch);

      const events = backendDb.db
        .select()
        .from(publicationEvents)
        .where(eq(publicationEvents.eventType, "credential.token_missing_scope"))
        .all();
      expect(events).toHaveLength(0);
    }));

  it("checks the YouTube refresh token against the authenticated channel before publishing is due", () =>
    withTempDb(async (backendDb) => {
      const calls: string[] = [];
      const fetchMock = mock(async (url: string | URL | Request) => {
        const href = String(url);
        calls.push(href);
        if (href === "https://oauth2.googleapis.com/token") return jsonResponse({ access_token: "youtube-access-token" });
        if (href.startsWith("https://www.googleapis.com/youtube/v3/channels")) return jsonResponse({ items: [{ id: "channel-1" }] });
        return jsonResponse({});
      });
      const config = loadTestConfig({
        YOUTUBE_RU_CLIENT_ID: "client-id",
        YOUTUBE_RU_CLIENT_SECRET: "client-secret",
        YOUTUBE_RU_REFRESH_TOKEN: "refresh-token",
      });
      registerTestChannels(backendDb, ["youtube_ru"]);

      await checkTokenHealth(config, backendDb, fetchMock as unknown as typeof fetch);

      expect(calls).toEqual(["https://oauth2.googleapis.com/token", "https://www.googleapis.com/youtube/v3/channels?part=id&mine=true"]);
      expect(backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "youtube_ru")).get()).toBeDefined();
    }));

  it("checks each enabled Instagram Story locale with its own account", () =>
    withTempDb(async (backendDb) => {
      const calls: string[] = [];
      const fetchMock = mock(async (url: string | URL | Request) => {
        calls.push(String(url));
        return jsonResponse({ id: String(url).includes("en-user") ? "en-user" : "ru-user" });
      });
      const config = loadTestConfig({
        INSTAGRAM_RU_ACCESS_TOKEN: "EAAtoken",
        INSTAGRAM_RU_USER_ID: "ru-user",
        INSTAGRAM_EN_ACCESS_TOKEN: "IGtoken",
        INSTAGRAM_EN_USER_ID: "en-user",
      });

      await checkTokenHealth(config, backendDb, fetchMock as unknown as typeof fetch);

      expect(backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "instagram_stories")).get()).toBeDefined();
      expect(backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "instagram_stories_ru")).get()).toBeDefined();
      expect(calls.some((url) => url.includes("/ru-user?fields=id"))).toBe(true);
      expect(calls.some((url) => url.includes("/en-user?fields=id"))).toBe(true);
    }));
});
