import { describe, expect, it } from "bun:test";
import { createApiHandler } from "../src/api.js";

import { exchangeMetaCode, metaOauthAuthorizeUrl, metaOauthConnectUrl, verifyMetaOauthState } from "../src/channels/meta-oauth.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

const KEY = "cd".repeat(32);
const now = new Date("2026-08-14T20:00:00.000Z");
const config = loadTestConfig({
  PUBLIC_BASE_URL: "https://publisher.example.com",
  TOKEN_ENCRYPTION_KEY: KEY,
  THREADS_APP_ID: "threads-id",
  THREADS_APP_SECRET: "threads-secret",
  INSTAGRAM_APP_ID: "instagram-id",
  INSTAGRAM_APP_SECRET: "instagram-secret",
  COMMAND_CENTER_TOKEN: "command-secret",
});

describe("Meta browser OAuth", () => {
  it("signs a short-lived connect link and carries the destination through provider authorization", () => {
    const connect = new URL(metaOauthConnectUrl(config, "threads", "ru", now));
    expect(connect.origin + connect.pathname).toBe("https://publisher.example.com/oauth/threads/start");
    const state = connect.searchParams.get("state") ?? "";
    expect(verifyMetaOauthState(config, state, now)).toEqual({ platform: "threads", locale: "ru" });
    const authorize = new URL(metaOauthAuthorizeUrl(config, state, now));
    expect(authorize.origin + authorize.pathname).toBe("https://threads.net/oauth/authorize");
    expect(authorize.searchParams.get("redirect_uri")).toBe("https://publisher.example.com/oauth/threads");
    expect(authorize.searchParams.get("state")).toBe(state);
  });

  it("asks for the permissions this Studio actually uses, insights and replies included", () => {
    // A Threads token minted without insights publishes fine and fails every
    // metrics call for the life of the token, which reads as "analytics are
    // broken" rather than "this token cannot read them". Without
    // `threads_manage_replies` the same token publishes the first message of a
    // chain and is refused on every continuation, with an empty HTTP 500.
    const threadsState = new URL(metaOauthConnectUrl(config, "threads", "ru", now)).searchParams.get("state") ?? "";
    const threads = new URL(metaOauthAuthorizeUrl(config, threadsState, now));
    expect(threads.searchParams.get("scope")?.split(",")).toEqual([
      "threads_basic",
      "threads_content_publish",
      "threads_manage_replies",
      "threads_manage_insights",
    ]);

    const instagramState = new URL(metaOauthConnectUrl(config, "instagram", "ru", now)).searchParams.get("state") ?? "";
    const instagram = new URL(metaOauthAuthorizeUrl(config, instagramState, now));
    expect(instagram.searchParams.get("scope")?.split(",")).toContain("instagram_business_manage_insights");
  });

  it("rejects tampered and expired links", () => {
    const state = new URL(metaOauthConnectUrl(config, "instagram", "en", now)).searchParams.get("state") ?? "";
    expect(() => verifyMetaOauthState(config, `${state}x`, now)).toThrow("invalid");
    expect(() => verifyMetaOauthState(config, state, new Date(now.getTime() + 11 * 60_000))).toThrow("expired");
  });

  it("serves a signed start route instead of leaving the browser on a dead callback", () =>
    withDb(async (backendDb) => {
      const state = new URL(metaOauthConnectUrl(config, "threads", "en")).searchParams.get("state") ?? "";
      const app = createApiHandler({ config, backendDb });
      const response = await app(new Request(`https://publisher.example.com/oauth/threads/start?state=${encodeURIComponent(state)}`));
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe("https://threads.net/oauth/authorize");
      expect(location.searchParams.get("state")).toBe(state);
    }));

  it("mints a fresh state when an authenticated Command Center link is clicked", () =>
    withDb(async (backendDb) => {
      const app = createApiHandler({ config, backendDb });
      const denied = await app(new Request("https://publisher.example.com/oauth/instagram/start?locale=ru"));
      expect(denied.status).toBe(400);
      const response = await app(
        new Request("https://publisher.example.com/oauth/instagram/start?locale=ru", {
          headers: { "X-Command-Token": "command-secret" },
        }),
      );
      expect(response.status).toBe(302);
      const location = new URL(response.headers.get("location") ?? "");
      expect(location.origin + location.pathname).toBe("https://www.instagram.com/oauth/authorize");
      expect(location.searchParams.get("redirect_uri")).toBe("https://publisher.example.com/oauth/instagram");
      expect(location.searchParams.get("state")).not.toBeEmpty();
      expect(location.searchParams.get("force_reauth")).toBe("true");
      expect(location.searchParams.has("force_authentication")).toBe(false);
    }));

  it("exchanges an Instagram code, upgrades the token and verifies the account", async () => {
    const calls: Array<{ url: string; body: string }> = [];
    const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: String(init?.body ?? "") });
      if (url === "https://api.instagram.com/oauth/access_token") return Response.json({ access_token: "short", user_id: "ig-7" });
      if (url.startsWith("https://graph.instagram.com/access_token?")) return Response.json({ access_token: "long" });
      if (url.startsWith("https://graph.instagram.com/me?")) return Response.json({ id: "ig-7", username: "publisher" });
      return new Response("{}", { status: 404 });
    }) as typeof fetch;

    expect(await exchangeMetaCode(config, "instagram", "one-time-code", fetchImpl)).toEqual({
      accessToken: "long",
      userId: "ig-7",
      username: "publisher",
    });
    expect(calls[0]?.body).toContain("redirect_uri=https%3A%2F%2Fpublisher.example.com%2Foauth%2Finstagram");
    expect(calls[0]?.body).toContain("code=one-time-code");
    expect(calls[1]?.url).toContain("grant_type=ig_exchange_token");
    expect(calls[2]?.url).toContain("fields=id%2Cusername");
  });
});
