import { expect, test } from "bun:test";
import { games, videoDrafts, videoTargets } from "../src/db/schema.js";
import { operationDef } from "../src/operations/registry.js";
import { videoLibrary } from "../src/operations/video-library.js";
import { withDb } from "./helpers/db.js";

test("exports original scripts intact, distinguishes transcripts and links copies without private fields", () =>
  withDb(async (backendDb) => {
    const script = "What if…\n\nA second paragraph (pronunciation).";
    const now = "2026-11-02T12:00:00.000Z";
    backendDb.db
      .insert(videoDrafts)
      .values([
        { id: 1, actorId: 42, script, scriptSource: "operator", openingLine: "What if…", createdAt: now, updatedAt: now },
        { id: 2, actorId: 42, script: "Machine heard this", scriptSource: "youtube_captions", createdAt: now, updatedAt: now },
        { id: 3, actorId: 42, createdAt: now, updatedAt: now },
      ])
      .run();
    backendDb.db
      .insert(videoTargets)
      .values([
        {
          videoDraftId: 1,
          target: "youtube_shorts",
          status: "published",
          externalId: "abc",
          externalUrl: "https://youtu.be/abc",
          publishedAt: now,
          metadataJson: { privatePath: "/private/file.mp4" },
          createdAt: now,
          updatedAt: now,
        },
        {
          videoDraftId: 1,
          target: "instagram_reels",
          status: "published",
          externalId: "def",
          metadataJson: {},
          createdAt: now,
          updatedAt: now,
        },
      ])
      .run();
    backendDb.db
      .insert(games)
      .values({
        name: "Town to City",
        steamAppId: "123",
        genres: ["Simulation"],
        playerModes: ["Single-player"],
        source: "steam",
        capturedAt: now,
      })
      .run();

    const result = videoLibrary(backendDb);
    expect(result.videos).toHaveLength(3);
    expect(result.videos[0]).toMatchObject({
      script,
      script_source: "operator",
      opening_line: "What if…",
      targets: [{ external_id: "abc" }, { external_id: "def" }],
    });
    expect(result.videos[1]).toMatchObject({ script_source: "youtube_captions", targets: [] });
    expect(result.videos[2]?.script).toBeNull();
    expect(result.games).toEqual([expect.objectContaining({ name: "Town to City", steam_app_id: "123", genres: ["Simulation"] })]);
    expect(JSON.stringify(result)).not.toContain("/private/");
    expect(JSON.stringify(result)).not.toContain("actor_id");
    expect(backendDb.db.select().from(videoDrafts).all()[0]?.script).toBe(script);
    expect(operationDef("video-library")).toMatchObject({ mutates: false, agent: true });
  }));
