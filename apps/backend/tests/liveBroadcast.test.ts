import { describe, expect, it } from "bun:test";
import { editYouTubeBroadcast, youtubeBroadcastInventory } from "../src/delivery/live-broadcast.js";
import { loadTestConfig } from "./helpers/studio-config.js";

/**
 * A live retitle is one read followed by one write against a channel with an
 * audience already watching. What is worth pinning is the shape of both calls:
 * a snippet update that drops the description wipes it on air, a second lookup
 * between read and write would rename whichever stream is live by then, and
 * `mine` alongside `broadcastStatus` is an error YouTube only reports at run
 * time. Which broadcast is chosen decides whether a rename reaches the current
 * audience or the next one, so every branch of that choice is pinned too.
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

const PERSISTENT = {
  id: "bc-default",
  snippet: { title: "Stream key title", description: "Key notes", isDefaultBroadcast: true },
  status: { lifeCycleStatus: "ready" },
};
const LIVE = {
  id: "bc-live",
  snippet: { title: "Old title", description: "Stream notes", scheduledStartTime: "2026-08-24T18:00:00Z" },
  status: { lifeCycleStatus: "live" },
};
const ONLY_LIVE = { items: [LIVE] };

describe("youtubeBroadcastInventory", () => {
  it("asks for every broadcast by status alone, without the incompatible mine filter", async () => {
    const { calls, fetchImpl } = stub(() => ONLY_LIVE);
    const result = await youtubeBroadcastInventory(config, "ru", fetchImpl);
    expect(result.chosen).toMatchObject({ id: "bc-live", title: "Old title", lifeCycleStatus: "live" });
    const list = calls.find((call) => call.url.includes("liveBroadcasts"));
    expect(list?.url).toContain("broadcastStatus=all");
    expect(list?.url).not.toContain("mine=");
  });

  it("renames the stream on the air rather than the persistent one behind the key", async () => {
    const { fetchImpl } = stub(() => ({ items: [PERSISTENT, LIVE] }));
    expect((await youtubeBroadcastInventory(config, "ru", fetchImpl)).chosen).toMatchObject({ id: "bc-live" });
  });

  /** The reusable-key channel: nothing is `active` between streams, and the
   * title set now is the one the next stream opens under. */
  it("falls back to the persistent broadcast when nothing is on the air", async () => {
    const { fetchImpl } = stub(() => ({ items: [PERSISTENT] }));
    expect((await youtubeBroadcastInventory(config, "ru", fetchImpl)).chosen).toMatchObject({ id: "bc-default", isDefault: true });
  });

  /** What "Go live" actually leaves on the channel between the click and the
   * first byte: no schedule, not the default broadcast, `ready`. Ordering by
   * start time alone left this one unreachable, so the stream could not be
   * named until it was already on the air. */
  it("chooses the stream waiting on the encoder, which carries no scheduled start at all", async () => {
    const starting = { id: "bc-starting", snippet: { title: "Стримс" }, status: { lifeCycleStatus: "ready" } };
    const scheduled = {
      id: "bc-later",
      snippet: { title: "Later", scheduledStartTime: "2026-08-26T18:00:00Z" },
      status: { lifeCycleStatus: "ready" },
    };
    const { fetchImpl } = stub(() => ({ items: [scheduled, starting] }));
    expect((await youtubeBroadcastInventory(config, "ru", fetchImpl)).chosen).toMatchObject({ id: "bc-starting" });
  });

  it("takes the soonest scheduled event when there is no persistent broadcast", async () => {
    const later = {
      id: "bc-later",
      snippet: { title: "Later", scheduledStartTime: "2026-08-26T18:00:00Z" },
      status: { lifeCycleStatus: "ready" },
    };
    const sooner = {
      id: "bc-sooner",
      snippet: { title: "Sooner", scheduledStartTime: "2026-08-25T18:00:00Z" },
      status: { lifeCycleStatus: "ready" },
    };
    const { fetchImpl } = stub(() => ({ items: [later, sooner] }));
    expect((await youtubeBroadcastInventory(config, "ru", fetchImpl)).chosen).toMatchObject({ id: "bc-sooner" });
  });

  it("never offers a finished stream, whose rename would reach an audience that already left", async () => {
    const done = { id: "bc-done", snippet: { title: "Yesterday", isDefaultBroadcast: true }, status: { lifeCycleStatus: "complete" } };
    const { fetchImpl } = stub(() => ({ items: [done] }));
    const result = await youtubeBroadcastInventory(config, "ru", fetchImpl);
    expect(result.chosen).toBeNull();
    expect(result.broadcasts).toHaveLength(1);
  });

  it("reports no broadcast on an empty channel rather than failing", async () => {
    const { fetchImpl } = stub(() => ({ items: [] }));
    expect((await youtubeBroadcastInventory(config, "ru", fetchImpl)).chosen).toBeNull();
  });
});

describe("editYouTubeBroadcast", () => {
  it("writes the broadcast the read returned and resends the fields the update would clear", async () => {
    const { calls, fetchImpl } = stub(() => ONLY_LIVE);
    const result = await editYouTubeBroadcast(config, { title: "  New title  " }, "ru", fetchImpl);
    expect(result).toMatchObject({ id: "bc-live", title: "New title" });
    const update = calls.find((call) => call.method === "PUT");
    expect(JSON.parse(String(update?.body))).toEqual({
      id: "bc-live",
      snippet: { title: "New title", description: "Stream notes", scheduledStartTime: "2026-08-24T18:00:00Z" },
    });
    expect(calls.filter((call) => call.method === "PUT")).toHaveLength(1);
  });

  /** A persistent broadcast has no scheduled start, and sending an empty one
   * back is a 400 rather than a no-op. */
  it("omits the scheduled start the persistent broadcast does not have", async () => {
    const { calls, fetchImpl } = stub(() => ({ items: [PERSISTENT] }));
    await editYouTubeBroadcast(config, { title: "New title" }, "ru", fetchImpl);
    expect(JSON.parse(String(calls.find((call) => call.method === "PUT")?.body))).toEqual({
      id: "bc-default",
      snippet: { title: "New title", description: "Key notes" },
    });
  });

  it("changes the description without disturbing the title beside it in the same snippet", async () => {
    const { calls, fetchImpl } = stub(() => ONLY_LIVE);
    const result = await editYouTubeBroadcast(config, { description: "  Ссылки под эфиром  " }, "ru", fetchImpl);
    expect(result).toMatchObject({ title: "Old title", description: "Ссылки под эфиром" });
    expect(JSON.parse(String(calls.find((call) => call.method === "PUT")?.body))).toEqual({
      id: "bc-live",
      snippet: { title: "Old title", description: "Ссылки под эфиром", scheduledStartTime: "2026-08-24T18:00:00Z" },
    });
  });

  it("refuses an edit that names neither field rather than rewriting the snippet with itself", async () => {
    const { calls, fetchImpl } = stub(() => ONLY_LIVE);
    await expect(editYouTubeBroadcast(config, {}, "ru", fetchImpl)).rejects.toThrow("Nothing to change");
    expect(calls).toHaveLength(0);
  });

  it("refuses a title YouTube would reject before touching the channel", async () => {
    const { calls, fetchImpl } = stub(() => ONLY_LIVE);
    await expect(editYouTubeBroadcast(config, { title: "x".repeat(101) }, "ru", fetchImpl)).rejects.toThrow("100 characters");
    expect(calls).toHaveLength(0);
  });

  it("changes nothing when there is no broadcast to rename", async () => {
    const { calls, fetchImpl } = stub(() => ({ items: [] }));
    expect(await editYouTubeBroadcast(config, { title: "New title" }, "ru", fetchImpl)).toBeNull();
    expect(calls.some((call) => call.method === "PUT")).toBe(false);
  });
});
