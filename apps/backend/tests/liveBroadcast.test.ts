import { describe, expect, it } from "bun:test";
import { currentYouTubeBroadcast, retitleYouTubeBroadcast } from "../src/delivery/live-broadcast.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * A live retitle is one read followed by one write against a channel with an
 * audience already watching. What is worth pinning is the shape of both calls:
 * a snippet update that drops the description wipes it on air, a second lookup
 * between read and write would rename whichever stream is live by then, and
 * `mine` alongside `broadcastStatus` is an error YouTube only reports at run
 * time.
 */

const config = loadTestConfig({
  YOUTUBE_RU_CLIENT_ID: "client",
  YOUTUBE_RU_CLIENT_SECRET: "secret",
  YOUTUBE_RU_REFRESH_TOKEN: "refresh",
});

type Call = { url: string; method: string; body: string | null };

function stub(responses: (call: Call) => unknown): { calls: Call[]; fetchImpl: typeof fetch } {
  const calls: Call[] = [];
  const fetchImpl = (async (url: string | URL | Request, init: RequestInit = {}) => {
    const call = { url: String(url), method: init.method ?? "GET", body: init.body == null ? null : String(init.body) };
    calls.push(call);
    if (call.url.includes("oauth2.googleapis.com")) return Response.json({ access_token: "token" });
    return Response.json(responses(call));
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

const ACTIVE = {
  items: [
    {
      id: "bc-live",
      snippet: { title: "Old title", description: "Stream notes", scheduledStartTime: "2026-08-24T18:00:00Z" },
    },
  ],
};

describe("currentYouTubeBroadcast", () => {
  it("asks for the live stream by status alone, without the incompatible mine filter", async () => {
    const { calls, fetchImpl } = stub(() => ACTIVE);
    const broadcast = await currentYouTubeBroadcast(config, "ru", fetchImpl);
    expect(broadcast).toMatchObject({ id: "bc-live", status: "active", title: "Old title" });
    const list = calls.find((call) => call.url.includes("liveBroadcasts"));
    expect(list?.url).toContain("broadcastStatus=active");
    expect(list?.url).not.toContain("mine=");
  });

  it("falls back to the next scheduled stream when nothing is on the air", async () => {
    const { fetchImpl } = stub((call) => (call.url.includes("broadcastStatus=active") ? { items: [] } : ACTIVE));
    expect(await currentYouTubeBroadcast(config, "ru", fetchImpl)).toMatchObject({ id: "bc-live", status: "upcoming" });
  });

  it("reports no broadcast between streams rather than failing", async () => {
    const { fetchImpl } = stub(() => ({ items: [] }));
    expect(await currentYouTubeBroadcast(config, "ru", fetchImpl)).toBeNull();
  });
});

describe("retitleYouTubeBroadcast", () => {
  it("writes the broadcast the read returned and resends the fields the update would clear", async () => {
    const { calls, fetchImpl } = stub(() => ACTIVE);
    const result = await retitleYouTubeBroadcast(config, "  New title  ", "ru", fetchImpl);
    expect(result).toMatchObject({ id: "bc-live", title: "New title" });
    const update = calls.find((call) => call.method === "PUT");
    expect(JSON.parse(String(update?.body))).toEqual({
      id: "bc-live",
      snippet: { title: "New title", description: "Stream notes", scheduledStartTime: "2026-08-24T18:00:00Z" },
    });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  it("refuses a title YouTube would reject before touching the channel", async () => {
    const { calls, fetchImpl } = stub(() => ACTIVE);
    await expect(retitleYouTubeBroadcast(config, "x".repeat(101), "ru", fetchImpl)).rejects.toThrow("100 characters");
    expect(calls).toHaveLength(0);
  });

  it("changes nothing when there is no broadcast to rename", async () => {
    const { calls, fetchImpl } = stub(() => ({ items: [] }));
    expect(await retitleYouTubeBroadcast(config, "New title", "ru", fetchImpl)).toBeNull();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
