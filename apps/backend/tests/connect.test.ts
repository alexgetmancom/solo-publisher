import { describe, expect, it } from "bun:test";
import { redeemDeviceAuthorizations, startConnect } from "../src/channels/connect.js";
import { verifyMetaOauthState } from "../src/channels/meta-oauth.js";
import { listChannels } from "../src/channels/registry.js";
import { exchangeYouTubeCode } from "../src/channels/youtube-oauth.js";
import { deviceAuthorizations, platformTokens } from "../src/db/schema.js";
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
  TWITCH_CLIENT_ID: "twitch-client",
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
    withDb(async (backendDb) => {
      const threads = await startConnect(config, backendDb, "threads", "ru", fetch, now);
      expect(threads).toMatchObject({ platform: "threads", locale: "ru", kind: "redirect", expiresInMinutes: 10 });
      if (threads.kind !== "redirect") throw new Error("expected a link");
      const link = new URL(threads.url);
      expect(link.origin + link.pathname).toBe("https://publisher.example.com/oauth/threads/start");
      expect(verifyMetaOauthState(config, link.searchParams.get("state") ?? "", now)).toEqual({ platform: "threads", locale: "ru" });

      // X publishes as one account, so it has no language to name.
      const x = await startConnect(config, backendDb, "x", "ru", fetch, now);
      expect(x.locale).toBeNull();
      if (x.kind !== "redirect") throw new Error("expected a link");
      expect(new URL(x.url).origin).toBe("https://x.com");
    }));

  it("sends YouTube to a consent screen that asks for the scope comments need", () =>
    withDb(async (backendDb) => {
      const start = await startConnect(config, backendDb, "youtube", "ru", fetch, now);

      expect(start).toMatchObject({ platform: "youtube", locale: "ru", kind: "redirect", expiresInMinutes: 10 });
      if (start.kind !== "redirect") throw new Error("expected a link");
      const link = new URL(start.url);
      expect(link.origin + link.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
      // force-ssl is the only scope `commentThreads.list` accepts, and the only
      // reason this platform stopped using the device flow, which refuses it.
      expect(link.searchParams.get("scope")).toBe("https://www.googleapis.com/auth/youtube.force-ssl");
      expect(link.searchParams.get("redirect_uri")).toBe("https://publisher.example.com/oauth/youtube");
      // Without both of these Google answers a reconnection with no refresh
      // token at all, and the connection silently stores nothing.
      expect(link.searchParams.get("access_type")).toBe("offline");
      expect(link.searchParams.get("prompt")).toBe("consent");
    }));

  it("files the token under the language its own sealed state names", () =>
    withDb(async (backendDb) => {
      const link = await startConnect(config, backendDb, "youtube", "ru", fetch, now);
      if (link.kind !== "redirect") throw new Error("expected a link");
      const state = new URL(link.url).searchParams.get("state") ?? "";
      const granted = transport({ refresh_token: "1//refresh", scope: "https://www.googleapis.com/auth/youtube.force-ssl" });

      expect(await exchangeYouTubeCode(config, backendDb, "google-code", state, granted.fetchImpl, now)).toEqual({ locale: "ru" });

      const stored = backendDb.db.select().from(platformTokens).get();
      expect(stored?.target).toBe("youtube_ru");
      expect(stored?.sealedToken).not.toContain("1//refresh");
      expect(config.YOUTUBE_RU_REFRESH_TOKEN).toBe("1//refresh");
    }));

  it("refuses a grant that came back without the scope, instead of storing it", () =>
    withDb(async (backendDb) => {
      const link = await startConnect(config, backendDb, "youtube", "ru", fetch, now);
      if (link.kind !== "redirect") throw new Error("expected a link");
      const state = new URL(link.url).searchParams.get("state") ?? "";
      // A token that publishes but cannot read comments is the exact failure
      // this flow replaced, and it is invisible for months once it is stored.
      const narrowed = transport({ refresh_token: "1//refresh", scope: "https://www.googleapis.com/auth/youtube" });

      await expect(exchangeYouTubeCode(config, backendDb, "google-code", state, narrowed.fetchImpl, now)).rejects.toThrow(
        "cannot read comments",
      );
      expect(backendDb.db.select().from(platformTokens).all()).toEqual([]);
    }));

  it("will not take a link that expired or was not sealed by this Studio", () =>
    withDb(async (backendDb) => {
      const link = await startConnect(config, backendDb, "youtube", "ru", fetch, now);
      if (link.kind !== "redirect") throw new Error("expected a link");
      const state = new URL(link.url).searchParams.get("state") ?? "";
      const unused = transport({ refresh_token: "1//refresh" });

      const later = new Date(now.getTime() + 11 * 60_000);
      await expect(exchangeYouTubeCode(config, backendDb, "code", state, unused.fetchImpl, later)).rejects.toThrow("expired");
      await expect(exchangeYouTubeCode(config, backendDb, "code", "not-sealed", unused.fetchImpl, now)).rejects.toThrow("not valid");
      expect(unused.calls).toEqual([]);
    }));

  it("finishes an approved device authorization without anyone holding a terminal open", () =>
    withDb(async (backendDb) => {
      const started = transport({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://www.twitch.tv/activate",
        expires_in: 1800,
      });
      const start = await startConnect(config, backendDb, "twitch", "ru", started.fetchImpl, now);
      expect(start).toMatchObject({ platform: "twitch", locale: null, kind: "device", userCode: "ABCD-EFGH" });
      // Sealed: it is what redeems the grant until the operator approves.
      const pending = backendDb.db.select().from(deviceAuthorizations).get();
      expect(pending?.target).toBe("twitch");
      expect(pending?.sealedDeviceCode).not.toContain("device-secret");

      // Still waiting is the ordinary answer, and it changes nothing.
      const waiting = transport({ message: "authorization_pending" });
      expect(await redeemDeviceAuthorizations(config, backendDb, waiting.fetchImpl, now)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toHaveLength(1);

      const approved = transport(
        { access_token: "twitch-access", refresh_token: "twitch-refresh", expires_in: 3600 },
        { data: [{ id: "42", login: "marux" }] },
      );
      expect(await redeemDeviceAuthorizations(config, backendDb, approved.fetchImpl, now)).toBe(1);
      expect(listChannels(backendDb).map((channel) => channel.id)).toContain("twitch_ru");
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toEqual([]);
    }));

  it("keeps a pending authorization when the network drops or the platform faults", () =>
    withDb(async (backendDb) => {
      const started = transport({
        device_code: "device-secret",
        user_code: "ABCD-EFGH",
        verification_uri: "https://www.twitch.tv/activate",
        expires_in: 1800,
      });
      await startConnect(config, backendDb, "twitch", "ru", started.fetchImpl, now);

      // The operator is standing at the activation screen typing the code. A
      // reset or a 503 in that window is not a refusal, and used to delete the
      // code out from under them.
      const dropped = (async () => {
        throw new TypeError("fetch failed");
      }) as unknown as typeof fetch;
      expect(await redeemDeviceAuthorizations(config, backendDb, dropped, now)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toHaveLength(1);

      const faulting = (async () => new Response("upstream unavailable", { status: 503 })) as unknown as typeof fetch;
      expect(await redeemDeviceAuthorizations(config, backendDb, faulting, now)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toHaveLength(1);

      // An authoritative refusal still ends it.
      const refused = transport({ message: "access_denied" });
      expect(await redeemDeviceAuthorizations(config, backendDb, refused.fetchImpl, now)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toEqual([]);
    }));

  it("forgets an authorization nobody approved in time", () =>
    withDb(async (backendDb) => {
      const started = transport({ device_code: "d", user_code: "c", verification_uri: "https://www.twitch.tv/activate", expires_in: 60 });
      await startConnect(config, backendDb, "twitch", "ru", started.fetchImpl, now);

      const later = new Date(now.getTime() + 120_000);
      const unused = transport({ error: "should not be asked" });
      expect(await redeemDeviceAuthorizations(config, backendDb, unused.fetchImpl, later)).toBe(0);
      expect(backendDb.db.select().from(deviceAuthorizations).all()).toEqual([]);
      expect(unused.calls).toEqual([]);
    }));

  it("names what is missing instead of starting something that cannot finish", () =>
    withDb(async (backendDb) => {
      await expect(startConnect(loadTestConfig({}), backendDb, "youtube", "en", fetch, now)).rejects.toThrow(
        "YOUTUBE_EN_CLIENT_ID, YOUTUBE_EN_CLIENT_SECRET, TOKEN_ENCRYPTION_KEY",
      );
      await expect(startConnect(loadTestConfig({}), backendDb, "instagram", "ru", fetch, now)).rejects.toThrow("INSTAGRAM_APP_ID");
    }));
});
