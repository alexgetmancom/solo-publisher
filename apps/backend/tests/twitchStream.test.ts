import { describe, expect, it } from "bun:test";
import { storePlatformToken } from "../src/channels/platform-token-store.js";
import { registerChannel } from "../src/channels/registry.js";
import { encryptionKey, seal } from "../src/foundation/secret-box.js";
import { streamService } from "../src/studio/services/streams.js";
import { registerTestChannels } from "./helpers/channels.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * Twitch and YouTube are not the same object under two names, and the whole
 * risk of steering both from one button is treating them as if they were. A
 * Twitch title belongs to the channel: it can be set with nothing on the air
 * and the next stream opens under it. A YouTube title belongs to a broadcast
 * that exists only around a stream, and carries a description Twitch has no
 * field for. So one typed line does different things in each place, and what
 * is pinned here is that each place says which.
 */

const TOKEN_KEY = "0".repeat(64);
const config = loadTestConfig({
  TWITCH_CLIENT_ID: "twitch-client",
  TOKEN_ENCRYPTION_KEY: TOKEN_KEY,
  YOUTUBE_RU_CLIENT_ID: "client",
  YOUTUBE_RU_CLIENT_SECRET: "secret",
  YOUTUBE_RU_REFRESH_TOKEN: "refresh-ru",
});

function studioDb(options: { youtube?: boolean } = {}) {
  const backendDb = openBackendDb(":memory:");
  if (options.youtube) registerTestChannels(backendDb, ["youtube_ru"]);
  registerChannel(backendDb, { platform: "twitch", locale: "ru", provider: "native", source: "interface", label: "Twitch · Marux" });
  const key = encryptionKey(TOKEN_KEY);
  if (!key) throw new Error("test key");
  storePlatformToken(backendDb, "twitch", {
    sealedToken: seal("access", key),
    sealedRefreshToken: seal("refresh", key),
    seedFingerprint: null,
    accountId: "1234",
    // Far from expiry, so no renewal request is made and the calls under test
    // are the only ones the stub has to answer.
    expiresAt: new Date(Date.now() + 4 * 60 * 60_000).toISOString(),
    refreshedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  return backendDb;
}

function stub(answers: { twitchLive?: boolean; twitchTitle?: string; youtube?: unknown; fail?: string }): {
  calls: Array<{ url: string; method: string; body: string }>;
  restore: () => void;
} {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; method: string; body: string }> = [];
  globalThis.fetch = Object.assign(
    async (url: string | URL | Request, init: RequestInit = {}) => {
      const href = String(url);
      calls.push({ url: href, method: init.method ?? "GET", body: init.body ? String(init.body) : "" });
      if (href.includes("oauth2.googleapis.com")) return Response.json({ access_token: "token" });
      if (href.includes("helix/channels"))
        return init.method === "PATCH"
          ? answers.fail
            ? new Response(JSON.stringify({ message: answers.fail }), { status: 400 })
            : new Response(null, { status: 204 })
          : Response.json({
              data: [
                { title: answers.twitchTitle ?? "Стрим на Twitch", game_id: "1", game_name: "Just Chatting", broadcaster_login: "marux" },
              ],
            });
      if (href.includes("helix/streams")) return Response.json({ data: answers.twitchLive ? [{ id: "s1" }] : [] });
      if (href.includes("helix/chat/messages")) return new Response(null, { status: 204 });
      return Response.json(answers.youtube ?? { items: [] });
    },
    { preconnect: original.preconnect },
  ) as typeof fetch;
  return { calls, restore: () => (globalThis.fetch = original) };
}

const liveOnYouTube = {
  items: [
    { id: "bc-live", snippet: { title: "Стрим на YouTube", description: "", liveChatId: "chat-1" }, status: { lifeCycleStatus: "live" } },
  ],
};

describe("streams across Twitch and YouTube", () => {
  it("reads a Twitch channel that is not streaming, which YouTube has no equivalent of", async () => {
    const backendDb = studioDb();
    const twitch = stub({ twitchLive: false });
    try {
      const { places } = await streamService(backendDb, config).current();
      expect(places).toHaveLength(1);
      // Off the air and still editable: the title is the channel's, not a
      // broadcast's, so setting it now is what the next stream opens under.
      expect(places[0]).toMatchObject({ surface: "twitch", title: "Стрим на Twitch", live: false, editable: true, description: null });
    } finally {
      twitch.restore();
      backendDb.close();
    }
  });

  it("sends one title to both surfaces and reports each separately", async () => {
    const backendDb = studioDb({ youtube: true });
    const both = stub({ twitchLive: true, youtube: liveOnYouTube });
    try {
      const outcomes = await streamService(backendDb, config).apply("title", "Пилим бота");
      expect(outcomes.map((outcome) => [outcome.label, outcome.status])).toEqual([
        ["Twitch", "done"],
        ["YouTube RU", "done"],
      ]);
      expect(both.calls.find((call) => call.method === "PATCH")?.body).toContain('"title":"Пилим бота"');
      expect(both.calls.find((call) => call.method === "PUT")?.body).toContain('"title":"Пилим бота"');
    } finally {
      both.restore();
      backendDb.close();
    }
  });

  /** The case that makes a single "done" a lie: Twitch takes the rename, and
   * YouTube has no broadcast to rename until a stream exists. */
  it("renames Twitch off the air and says plainly that YouTube had nothing to rename", async () => {
    const backendDb = studioDb({ youtube: true });
    const idle = stub({ twitchLive: false, youtube: { items: [] } });
    try {
      const outcomes = await streamService(backendDb, config).apply("title", "Скоро начнём");
      expect(outcomes).toEqual([
        { label: "Twitch", status: "done", detail: "" },
        { label: "YouTube RU", status: "skipped", detail: "nothing to edit until a stream starts" },
      ]);
    } finally {
      idle.restore();
      backendDb.close();
    }
  });

  it("does not offer Twitch a description it has no field for", async () => {
    const backendDb = studioDb({ youtube: true });
    const both = stub({ twitchLive: true, youtube: liveOnYouTube });
    try {
      const outcomes = await streamService(backendDb, config).apply("description", "Ссылки под эфиром");
      expect(outcomes).toEqual([
        { label: "Twitch", status: "skipped", detail: "no description field" },
        { label: "YouTube RU", status: "done", detail: "" },
      ]);
      expect(both.calls.some((call) => call.method === "PATCH")).toBe(false);
    } finally {
      both.restore();
      backendDb.close();
    }
  });

  it("says a line in both chats, and only where a stream is on the air", async () => {
    const backendDb = studioDb({ youtube: true });
    const both = stub({ twitchLive: true, youtube: liveOnYouTube });
    try {
      const outcomes = await streamService(backendDb, config).apply("chat", "Погнали");
      expect(outcomes.every((outcome) => outcome.status === "done")).toBe(true);
      expect(both.calls.find((call) => call.url.includes("helix/chat/messages"))?.body).toContain('"sender_id":"1234"');
      expect(both.calls.find((call) => call.url.includes("liveChat/messages"))?.body).toContain("Погнали");
    } finally {
      both.restore();
      backendDb.close();
    }
  });

  it("reports a refusal from one surface without losing what the other did", async () => {
    const backendDb = studioDb({ youtube: true });
    const refusing = stub({ twitchLive: true, youtube: liveOnYouTube, fail: "Missing scope" });
    try {
      const outcomes = await streamService(backendDb, config).apply("title", "Пилим бота");
      expect(outcomes[0]).toMatchObject({ label: "Twitch", status: "failed", detail: "Missing scope" });
      expect(outcomes[1]).toMatchObject({ label: "YouTube RU", status: "done" });
    } finally {
      refusing.restore();
      backendDb.close();
    }
  });

  it("takes the stricter of the two title limits, because one line goes to both", async () => {
    const { FIELD_LIMIT } = await import("../src/studio/services/streams.js");
    // Twitch allows 140 and YouTube 100; a line written to the larger would be
    // refused by the smaller after the operator already pressed send.
    expect(FIELD_LIMIT.title).toBe(100);
  });
});
