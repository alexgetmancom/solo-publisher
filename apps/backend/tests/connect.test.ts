import { describe, expect, it } from "bun:test";
import { startConnect } from "../src/channels/connect.js";
import { verifyMetaOauthState } from "../src/channels/meta-oauth.js";
import { exchangeYouTubeCode } from "../src/channels/youtube-oauth.js";
import { platformTokens } from "../src/db/schema.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const KEY = "ef".repeat(32);
const now = new Date("2026-08-16T09:00:00.000Z");
const config = loadTestConfig({
  PUBLIC_BASE_URL: "https://publisher.example.com",
  TOKEN_ENCRYPTION_KEY: KEY,
  THREADS_APP_ID: "threads-id",
  THREADS_APP_SECRET: "threads-secret",
  X_CLIENT_ID: "x-id",
  X_CLIENT_SECRET: "x-secret",
  YOUTUBE_RU_CLIENT_ID: "google-id",
  YOUTUBE_RU_CLIENT_SECRET: "google-secret",
});

function transport(...replies: unknown[]) {
  const calls: string[] = [];
  const queue = [...replies];
  const fetchImpl = (async (input: string | URL) => {
    calls.push(String(input));
    return Response.json(queue.length > 1 ? queue.shift() : queue[0]);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

describe("connecting an account", () => {
  it("hands every surface the same link, whichever platform it is", () =>
    withDb(async () => {
      const threads = await startConnect(config, "threads", "ru", now);
      expect(threads).toMatchObject({ platform: "threads", locale: "ru", kind: "redirect", expiresInMinutes: 10 });
      if (threads.kind !== "redirect") throw new Error("expected a link");
      const link = new URL(threads.url);
      expect(link.origin + link.pathname).toBe("https://publisher.example.com/oauth/threads/start");
      expect(verifyMetaOauthState(config, link.searchParams.get("state") ?? "", now)).toEqual({ platform: "threads", locale: "ru" });

      // X publishes as one account, so it has no language to name.
      const x = await startConnect(config, "x", "ru", now);
      expect(x.locale).toBeNull();
      if (x.kind !== "redirect") throw new Error("expected a link");
      expect(new URL(x.url).origin).toBe("https://x.com");
    }));

  it("sends YouTube to a consent screen that asks for the scope comments need", () =>
    withDb(async () => {
      const start = await startConnect(config, "youtube", "ru", now);

      expect(start).toMatchObject({ platform: "youtube", locale: "ru", kind: "redirect", expiresInMinutes: 10 });
      if (start.kind !== "redirect") throw new Error("expected a link");
      const link = new URL(start.url);
      expect(link.origin + link.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      // force-ssl is the only scope `commentThreads.list` accepts, and the only
      // reason this platform stopped using the device flow, which refuses it.
      // yt-analytics.readonly rides along because reporting is a separate API:
      // force-ssl alone publishes and reads comments, then refuses every report.
      expect(link.searchParams.get("scope")).toBe(
        "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
      );
      expect(link.searchParams.get("redirect_uri")).toBe("https://publisher.example.com/oauth/youtube");
      // Without both of these Google answers a reconnection with no refresh
      // token at all, and the connection silently stores nothing.
      expect(link.searchParams.get("access_type")).toBe("offline");
      expect(link.searchParams.get("prompt")).toBe("consent");
    }));

  it("files the token under the language its own sealed state names", () =>
    withDb(async (backendDb) => {
      const link = await startConnect(config, "youtube", "ru", now);
      if (link.kind !== "redirect") throw new Error("expected a link");
      const state = new URL(link.url).searchParams.get("state") ?? "";
      const granted = transport({
        refresh_token: "1//refresh",
        scope: "https://www.googleapis.com/auth/youtube.force-ssl https://www.googleapis.com/auth/yt-analytics.readonly",
      });

      expect(await exchangeYouTubeCode(config, backendDb, "google-code", state, granted.fetchImpl, now)).toEqual({ locale: "ru" });

      const stored = backendDb.db.select().from(platformTokens).get();
      expect(stored?.target).toBe("youtube_ru");
      expect(stored?.sealedToken).not.toContain("1//refresh");
      expect(config.YOUTUBE_RU_REFRESH_TOKEN).toBe("1//refresh");
    }));

  it("refuses a grant that came back short of a scope, instead of storing it", () =>
    withDb(async (backendDb) => {
      const link = await startConnect(config, "youtube", "ru", now);
      if (link.kind !== "redirect") throw new Error("expected a link");
      const state = new URL(link.url).searchParams.get("state") ?? "";
      // A token that publishes but cannot read comments, or reads comments but
      // cannot report, is the exact failure this flow replaced -- and it is
      // invisible for months once it is stored.
      const narrowed = transport({ refresh_token: "1//refresh", scope: "https://www.googleapis.com/auth/youtube.force-ssl" });

      await expect(exchangeYouTubeCode(config, backendDb, "google-code", state, narrowed.fetchImpl, now)).rejects.toThrow(
        "yt-analytics.readonly",
      );
      expect(backendDb.db.select().from(platformTokens).all()).toEqual([]);
    }));

  it("will not take a link that expired or was not sealed by this Studio", () =>
    withDb(async (backendDb) => {
      const link = await startConnect(config, "youtube", "ru", now);
      if (link.kind !== "redirect") throw new Error("expected a link");
      const state = new URL(link.url).searchParams.get("state") ?? "";
      const unused = transport({ refresh_token: "1//refresh" });

      const later = new Date(now.getTime() + 11 * 60_000);
      await expect(exchangeYouTubeCode(config, backendDb, "code", state, unused.fetchImpl, later)).rejects.toThrow("expired");
      await expect(exchangeYouTubeCode(config, backendDb, "code", "not-sealed", unused.fetchImpl, now)).rejects.toThrow("not valid");
      expect(unused.calls).toEqual([]);
    }));

  it("names what is missing instead of starting something that cannot finish", () =>
    withDb(async () => {
      await expect(startConnect(loadTestConfig({}), "youtube", "en", now)).rejects.toThrow(
        "YOUTUBE_EN_CLIENT_ID, YOUTUBE_EN_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY",
      );
      await expect(startConnect(loadTestConfig({}), "instagram", "ru", now)).rejects.toThrow("INSTAGRAM_APP_ID");
    }));
});
