import { describe, expect, it } from "bun:test";
import { eq } from "drizzle-orm";
import { registerChannel } from "../src/channels/registry.js";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { publicationEvents, videoTargets } from "../src/db/schema.js";
import { PROVIDER_CONFIRMATION_GRACE_MS, recordVideoCompletionIfFinal } from "../src/delivery/video-worker.js";
import { replaceVideoTargets, saveVideoMetadata, scheduleVideo } from "../src/publishing/video-service.js";
import { settleVideoTarget } from "../src/publishing/video-settle.js";
import { withDb } from "./helpers/db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoDraft } from "./helpers/video.js";

const config = Object.assign(loadTestConfig({ PUBLIC_BASE_URL: "https://maru.example" }), { ZERNIO_API_KEY: "z".repeat(16) });

function transport(post: Record<string, unknown>) {
  const calls: Array<{ url: string; requestId: string | null }> = [];
  const fetchImpl = (async (input: string | URL, init?: RequestInit) => {
    calls.push({ url: String(input), requestId: new Headers(init?.headers).get("x-request-id") });
    return Response.json(post);
  }) as typeof fetch;
  return { fetchImpl, calls };
}

function stuckReel(backendDb: UnsafeBackendDb): number {
  registerChannel(backendDb, { platform: "instagram", locale: "ru", provider: "zernio", providerAccountId: "maru-account" });
  const draftId = createTestVideoDraft(backendDb, 42, "/tmp/reel.mp4", 24);
  replaceVideoTargets(backendDb, draftId, ["instagram_reels"] as never);
  saveVideoMetadata(backendDb, draftId, "instagram_reels", { caption: "Clip" });
  scheduleVideo(backendDb, draftId, { instagram_reels: new Date(Date.now() + 60 * 60_000) }, { prepareLeadMinutes: 15 });
  backendDb.sqlite
    .prepare(
      "UPDATE video_targets SET status='verification_required', delivery_provider='zernio', provider_account_id='maru-account', last_error='worker_lost: video lock expired before completion'",
    )
    .run();
  return draftId;
}

describe("answering a video publication that lost its worker", () => {
  it("asks the provider with the fenced request id and settles what came back", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      const { fetchImpl, calls } = transport({
        _id: "zernio-post",
        platforms: [{ platform: "instagram", platformPostId: "ig-1", platformPostUrl: "https://instagram.com/reel/ig-1" }],
      });

      const result = await settleVideoTarget(
        config,
        backendDb,
        { videoDraftId: draftId, target: "instagram_reels", apply: true },
        fetchImpl,
      );

      expect(result.status).toBe("published");
      expect(calls[0]?.requestId).toStartWith("video-job:");
      const row = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
      expect(row).toMatchObject({ status: "published", externalId: "ig-1", providerPostId: "zernio-post" });
      expect(row?.verifiedAt).not.toBeNull();
    }));

  it("keeps a publication the platform has not confirmed inside the sweep that can confirm it", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      // The provider publishes asynchronously: a create with no platform link is
      // unfinished. Calling it published took the row out of the reconciliation
      // sweep — the only thing that fills the link — and it stayed linkless.
      const { fetchImpl } = transport({ _id: "zernio-post" });

      const result = await settleVideoTarget(
        config,
        backendDb,
        { videoDraftId: draftId, target: "instagram_reels", apply: true },
        fetchImpl,
      );

      expect(result.status).toBe("verification_required");
      const row = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
      expect(row).toMatchObject({ status: "verification_required", providerPostId: "zernio-post", externalId: null });
    }));

  it("puts a publication the provider could not deliver back where a retry can pick it up", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      backendDb.sqlite.prepare("UPDATE video_targets SET provider_post_id='zernio-post'").run();
      // The provider accepts before the platform takes it, so a created post can
      // still be `failed` with nothing published. Calling that published is how
      // a card claims a Reel the account does not have.
      const { fetchImpl } = transport({
        _id: "zernio-post",
        status: "failed",
        platforms: [{ platform: "instagram", status: "failed", error: "Instagram couldn't download your video" }],
      });

      const result = await settleVideoTarget(
        config,
        backendDb,
        { videoDraftId: draftId, target: "instagram_reels", apply: true },
        fetchImpl,
      );

      expect(result.status).toBe("failed");
      const row = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
      expect(row).toMatchObject({ status: "failed", externalId: null, publishedAt: null });
      expect(row?.lastError).toContain("download your video");
    }));

  it("takes what the operator can see on the platform over what the provider recorded", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      backendDb.sqlite.prepare("UPDATE video_targets SET provider_post_id='failed-post'").run();
      // The provider can hold a publication as failed while the account shows it
      // live — a later attempt landed, or it recovered on its own. The account is
      // the fact, and recording it must not cost another call.
      const { fetchImpl, calls } = transport({ _id: "failed-post", status: "failed" });

      const result = await settleVideoTarget(
        config,
        backendDb,
        {
          videoDraftId: draftId,
          target: "instagram_reels",
          apply: true,
          known: { providerPostId: "live-post", externalId: "DcEdQDZDCaq", url: "https://www.instagram.com/reel/DcEdQDZDCaq/" },
        },
        fetchImpl,
      );

      expect(result.status).toBe("published");
      expect(calls).toEqual([]);
      const row = backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get();
      expect(row).toMatchObject({ status: "published", externalId: "DcEdQDZDCaq", providerPostId: "live-post" });
    }));

  it("refuses a target that already carries its platform publication", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      backendDb.sqlite.prepare("UPDATE video_targets SET status='published', external_id='ig-1'").run();
      const { fetchImpl, calls } = transport({ _id: "zernio-post" });

      await expect(
        settleVideoTarget(config, backendDb, { videoDraftId: draftId, target: "instagram_reels", apply: true }, fetchImpl),
      ).rejects.toThrow("already has its platform publication");
      expect(calls).toEqual([]);
    }));

  /** The check above runs before a provider round-trip, and the reconciliation
   * sweep answers the same target from the same provider while it is in
   * flight. Without the state in the write's own `WHERE`, this settlement --
   * decided from a reading taken before that answer -- would overwrite it. */
  it("discards its own answer when the target was settled while the provider was being asked", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      const fetchImpl = (async (_input: string | URL, _init?: RequestInit) => {
        backendDb.sqlite
          .prepare("UPDATE video_targets SET status='published', external_id='ig-reconciled', external_url='https://instagram.com/reel/x'")
          .run();
        return Response.json({ _id: "zernio-post", platforms: [{ platform: "instagram", platformPostId: "ig-late" }] });
      }) as unknown as typeof fetch;

      await expect(
        settleVideoTarget(config, backendDb, { videoDraftId: draftId, target: "instagram_reels", apply: true }, fetchImpl),
      ).rejects.toThrow("settled by something else");

      expect(backendDb.db.select().from(videoTargets).where(eq(videoTargets.videoDraftId, draftId)).get()).toMatchObject({
        status: "published",
        externalId: "ig-reconciled",
      });
    }));
});

describe("a publication the provider never answers", () => {
  it("stops being in flight and is reported once the grace runs out", () =>
    withDb(async (backendDb) => {
      const draftId = stuckReel(backendDb);
      backendDb.sqlite.prepare("UPDATE video_targets SET provider_post_id='zernio-post'").run();
      // Withholding the outcome while the provider still owes an answer left a
      // third ending nobody had covered: no answer, no report, silence.
      recordVideoCompletionIfFinal(backendDb, draftId);
      expect(completionEvents(backendDb)).toEqual([]);

      const later = new Date(Date.now() + PROVIDER_CONFIRMATION_GRACE_MS + 60_000);
      recordVideoCompletionIfFinal(backendDb, draftId, later);

      expect(completionEvents(backendDb)).toHaveLength(1);
    }));
});

function completionEvents(backendDb: UnsafeBackendDb) {
  return backendDb.db
    .select()
    .from(publicationEvents)
    .all()
    .filter((event) => event.eventType === "delivery.video.completed");
}
