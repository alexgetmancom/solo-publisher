import { expect, it } from "bun:test";
import { existsSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { OperationContext } from "../src/operations/registry.js";
import { runOperation } from "../src/operations/registry.js";
import { publicationTimeline } from "../src/operations/timeline.js";
import { createStudioServices } from "../src/studio/services/index.js";
import { registerTestChannels } from "./helpers/channels.js";
import { withDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";
import { loadTestConfig } from "./helpers/studio-config.js";
import { createTestVideoAsset, createTestVideoDraft } from "./helpers/video.js";

function context(db: ReturnType<typeof openBackendDb>, fetchImpl: typeof fetch = fetch): OperationContext {
  return {
    dbPath: ":memory:",
    config: () =>
      loadTestConfig({
        CONTROLLER_ADMIN_IDS: "42",
        INSTAGRAM_RU_ACCESS_TOKEN: "ru-token",
        INSTAGRAM_RU_USER_ID: "ru-user",
        THREADS_RU_ACCESS_TOKEN: "ru-threads-token",
      }),
    db: () => db,
    fetchImpl,
    actorType: "test",
  };
}

function connectThreads(backendDb: ReturnType<typeof openBackendDb>): void {
  createStudioServices(backendDb, loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" })).channels.connect({
    platform: "threads_ru",
    locale: "ru",
    provider: "native",
    targetId: "threads_ru",
    label: "Threads RU",
  });
}

it("publishes operator text to exactly the requested target in one operation", () =>
  withDb(async (backendDb) => {
    connectThreads(backendDb);
    const result = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Test publication",
    })) as { draft_id: number; post_id: number; ref: string };

    expect(result).toMatchObject({
      ref: `post:${result.post_id}`,
      targets: ["threads_ru"],
      queued: true,
    });
    const draft = backendDb.sqlite.query("SELECT targets_json FROM drafts WHERE id=?").get(result.draft_id) as { targets_json: string };
    expect(JSON.parse(draft.targets_json)).toEqual({
      telegram: false,
      site_ru: false,
      site_en: false,
      threads_ru: true,
      threads_en: false,
      x: false,
      discord: false,
      telegram_stories: false,
      instagram_stories_ru: false,
      instagram_stories: false,
    });
    expect(backendDb.sqlite.query("SELECT target FROM publish_jobs WHERE publication_key='post:'||?").all(result.post_id)).toEqual([
      { target: "threads_ru" },
    ]);
  }));

it("does not require a Story decision when every Story target is disabled", () => {
  const backendDb = openBackendDb(":memory:");
  registerTestChannels(backendDb, ["threads_ru", "threads_en"]);
  const ruCard = join(tmpdir(), `story-card-ru-${crypto.randomUUID()}.png`);
  const enCard = join(tmpdir(), `story-card-en-${crypto.randomUUID()}.png`);
  writeFileSync(ruCard, "ru");
  writeFileSync(enCard, "en");
  try {
    const config = loadTestConfig({ CONTROLLER_ADMIN_IDS: "42" });
    const posts = createStudioServices(backendDb, config).posts;
    const draftId = posts.create(
      42,
      {
        text: "No Stories",
        textEnApproved: "No Stories",
        entities: [],
        media: [],
      },
      { targets: ["threads_ru"] },
    );
    const now = new Date().toISOString();
    backendDb.sqlite
      .query("UPDATE draft_story_cards SET status='ready',local_path=?,updated_at=? WHERE draft_id=? AND locale='ru'")
      .run(ruCard, now, draftId);
    backendDb.sqlite
      .query("UPDATE draft_story_cards SET status='ready',local_path=?,updated_at=? WHERE draft_id=? AND locale='en'")
      .run(enCard, now, draftId);

    expect(posts.publish(42, draftId)).toBeGreaterThan(0);
  } finally {
    backendDb.close();
    rmSync(ruCard, { force: true });
    rmSync(enCard, { force: true });
  }
});

it("purges an absent publication and every stored publication path", () =>
  withDb(async (backendDb) => {
    connectThreads(backendDb);
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Disposable test",
    })) as { draft_id: number; post_id: number; ref: string };
    const now = new Date().toISOString();
    backendDb.sqlite
      .query(
        "INSERT INTO publication_targets(publication_key,target,status,url,updated_at) VALUES (?,'threads_ru','published','https://threads.example/deleted',?)",
      )
      .run(published.ref, now);
    backendDb.sqlite
      .query("INSERT INTO metric_schedule(publication_key,target,updated_at) VALUES (?,'threads_ru',?)")
      .run(published.ref, now);
    backendDb.sqlite
      .query(
        "INSERT INTO studio_notification_jobs(actor_id,ref,kind,run_at,status,created_at,updated_at) VALUES (42,?,'completion',?,'delivered',?,?)",
      )
      .run(published.ref, now, now, now);
    const stillLive = (async () => new Response("live", { status: 200 })) as unknown as typeof fetch;
    await expect(
      runOperation("purge", context(backendDb, stillLive), {
        ref: published.ref,
        apply: true,
      }),
    ).rejects.toThrow("threads_ru is still reachable");
    const notFound = (async () => new Response("gone", { status: 404 })) as unknown as typeof fetch;

    const plan = (await runOperation("purge", context(backendDb, notFound), {
      ref: published.ref,
    })) as {
      applied: boolean;
      rows: Record<string, number>;
    };
    expect(plan.applied).toBe(false);
    expect(plan.rows).toMatchObject({
      drafts: 1,
      post_locales: 2,
      publish_jobs: 1,
      publication_targets: 1,
      notification_jobs: 1,
    });

    const result = (await runOperation("purge", context(backendDb, notFound), {
      ref: published.ref,
      apply: true,
    })) as {
      applied: boolean;
    };
    expect(result.applied).toBe(true);
    expect(publicationTimeline(backendDb, published.ref)).toEqual({
      ref: published.ref,
      jobs: [],
      targets: [],
      events: [],
    });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM drafts WHERE id=?").get(published.draft_id)).toEqual({ count: 0 });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM metric_schedule WHERE publication_key=?").get(published.ref)).toEqual({
      count: 0,
    });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM studio_notification_jobs WHERE ref=?").get(published.ref)).toEqual({
      count: 0,
    });
  }));

it("purges a video publication whose reel is gone, and the source it was the last to hold", async () => {
  const backendDb = openBackendDb(":memory:");
  const source = join(tmpdir(), `purge-video-${Date.now()}.mp4`);
  try {
    writeFileSync(source, "video");
    const assetId = createTestVideoAsset(backendDb, 42, source);
    const draftId = createTestVideoDraft(backendDb, 42, assetId, 24);
    const ref = `video:${draftId}`;
    const now = new Date().toISOString();
    backendDb.sqlite
      .query(
        "INSERT INTO video_targets(video_draft_id,target,metadata_json,status,external_id,external_url,published_at,created_at,updated_at) VALUES (?,'instagram_reels','{}','published','18118759130310334','https://instagram.example/reel/deleted',?,?,?)",
      )
      .run(draftId, now, now, now);
    const targetId = Number(
      (backendDb.sqlite.query("SELECT id FROM video_targets WHERE video_draft_id=?").get(draftId) as { id: number }).id,
    );
    backendDb.sqlite
      .query("INSERT INTO video_metric_schedule(video_target_id,next_check_at,frozen_at,updated_at) VALUES (?,?,?,?)")
      .run(targetId, now, now, now);
    backendDb.sqlite
      .query(
        "INSERT INTO publication_events(publication_key,target,event_type,severity,message,created_at) VALUES (?,'instagram_reels','x','warn','y',?)",
      )
      .run(ref, now);

    // Absence is asked of the API by id, never of the public URL: Instagram
    // answers a logged-out request for any reel address with its login wall and
    // HTTP 200, which would read as "gone" for a reel that is still up.
    const stillLive = (async () => new Response('{"id":"18118759130310334"}', { status: 200 })) as unknown as typeof fetch;
    await expect(runOperation("purge", context(backendDb, stillLive), { ref, apply: true })).rejects.toThrow(
      "instagram_reels is still live on the platform",
    );

    // An unanswered question is not absence either: a revoked token must stop
    // the purge rather than erase a publication nobody could ask about.
    const unauthorized = (async () =>
      new Response('{"error":{"message":"Invalid OAuth token"}}', { status: 401 })) as unknown as typeof fetch;
    await expect(runOperation("purge", context(backendDb, unauthorized), { ref, apply: true })).rejects.toThrow(
      "cannot prove the publication is absent",
    );

    const notFound = (async () =>
      new Response('{"error":{"message":"Object with ID does not exist","code":100,"error_subcode":33}}', {
        status: 400,
      })) as unknown as typeof fetch;
    const plan = (await runOperation("purge", context(backendDb, notFound), { ref })) as {
      applied: boolean;
      rows: Record<string, number>;
      files: string[];
    };
    expect(plan.applied).toBe(false);
    expect(plan.rows).toMatchObject({ video_drafts: 1, video_targets: 1, video_metric_schedule: 1, publication_events: 1 });
    expect(plan.files).toEqual([source]);

    const result = (await runOperation("purge", context(backendDb, notFound), { ref, apply: true })) as {
      applied: boolean;
      removed_files: string[];
    };
    expect(result.applied).toBe(true);
    expect(result.removed_files).toEqual([source]);
    expect(existsSync(source)).toBe(false);
    expect(publicationTimeline(backendDb, ref)).toEqual({ ref, draft: null, jobs: [], targets: [], events: [] });
    for (const table of ["video_drafts", "video_targets", "video_metric_schedule", "studio_media_assets"])
      expect(backendDb.sqlite.query(`SELECT COUNT(*) AS count FROM ${table}`).get()).toEqual({ count: 0 });
  } finally {
    backendDb.close();
    rmSync(source, { force: true });
  }
});

it("keeps a source another draft still points at, and the asset row with it", async () => {
  const backendDb = openBackendDb(":memory:");
  const source = join(tmpdir(), `purge-shared-${Date.now()}.mp4`);
  try {
    writeFileSync(source, "video");
    const assetId = createTestVideoAsset(backendDb, 42, source);
    const draftId = createTestVideoDraft(backendDb, 42, assetId, 24);
    const other = createTestVideoDraft(backendDb, 42, assetId, 24);

    const plan = (await runOperation("purge", context(backendDb), { ref: `video:${draftId}` })) as { files: string[] };
    expect(plan.files).toEqual([]);
    await runOperation("purge", context(backendDb), { ref: `video:${draftId}`, apply: true });
    expect(existsSync(source)).toBe(true);
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM studio_media_assets WHERE id=?").get(assetId)).toEqual({ count: 1 });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM video_drafts WHERE id=?").get(other)).toEqual({ count: 1 });
  } finally {
    backendDb.close();
    rmSync(source, { force: true });
  }
});

it("shows the operator every target the command would touch, not only the delivered ones", () =>
  withDb(async (backendDb) => {
    connectThreads(backendDb);
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Сегодня разобрал, как мы используем React и Bun в проде",
    })) as { ref: string };

    // Nothing has been claimed yet, so there is no publication_targets row — and the
    // plan used to read only that table. It reported "nothing is in scope" for
    // a publication whose target `--apply` then requeued.
    const plan = (await runOperation("retry", context(backendDb), { ref: published.ref })) as {
      targets: Array<{ target: string; status: string; url: string | null; published: boolean }>;
      hint: string;
    };

    expect(plan.targets).toEqual([{ target: "threads_ru", status: "queued", url: null, published: false }]);
    expect(plan.hint).toBe("re-run with apply to perform it");
  }));

it("keeps the identity of a live post it was told to publish again", () =>
  withDb(async (backendDb) => {
    connectThreads(backendDb);
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Сегодня разобрал, как мы используем React и Bun в проде",
    })) as { ref: string };
    const now = new Date().toISOString();
    backendDb.sqlite
      .prepare(
        "INSERT INTO publication_targets(publication_key,target,status,external_id,url,published_at,updated_at) VALUES (?,'threads_ru','published','LIVE-1','https://threads.net/p/LIVE-1',?,?)",
      )
      .run(published.ref, now, now);
    backendDb.sqlite.prepare("UPDATE publish_jobs SET status='published' WHERE target='threads_ru'").run();

    await runOperation("retry", context(backendDb), { ref: published.ref, target: "threads_ru", apply: true });

    // The row now names a different post, which is right — but the one it used
    // to name is still live, and nothing else remembers how to reach it.
    expect(backendDb.sqlite.prepare("SELECT external_id, status FROM publication_targets WHERE target='threads_ru'").get()).toEqual({
      external_id: null,
      status: "queued",
    });
    expect(
      backendDb.sqlite.prepare("SELECT details_json FROM publication_events WHERE event_type='publish.target.identity_dropped'").get() as {
        details_json: string;
      },
    ).toEqual({ details_json: JSON.stringify({ external_id: "LIVE-1", url: "https://threads.net/p/LIVE-1" }) });
  }));

it("refuses to purge when a target changed while it was being verified", () =>
  withDb(async (backendDb) => {
    connectThreads(backendDb);
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Disposable test",
    })) as { draft_id: number; post_id: number; ref: string };
    const now = new Date().toISOString();
    backendDb.sqlite
      .query(
        "INSERT INTO publication_targets(publication_key,target,status,url,updated_at) VALUES (?,'threads_ru','published','https://threads.example/deleted',?)",
      )
      .run(published.ref, now);

    // The proof is gathered over HTTP, which takes long enough for a worker to
    // finish publishing another target. Erasing the record then would leave a
    // post live with nothing in the database that knows about it.
    const publishesMidVerification = (async () => {
      backendDb.sqlite
        .query(
          "INSERT INTO publication_targets(publication_key,target,status,url,updated_at) VALUES (?,'telegram','published','https://t.me/c/1/2',?)",
        )
        .run(published.ref, new Date().toISOString());
      return new Response("gone", { status: 404 });
    }) as unknown as typeof fetch;

    await expect(runOperation("purge", context(backendDb, publishesMidVerification), { ref: published.ref, apply: true })).rejects.toThrow(
      "changed while it was being verified",
    );
    // Nothing may have been deleted: the whole cascade rolls back together.
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM drafts WHERE id=?").get(published.draft_id)).toEqual({ count: 1 });
    expect(backendDb.sqlite.query("SELECT COUNT(*) AS count FROM publication_targets WHERE publication_key=?").get(published.ref)).toEqual({
      count: 2,
    });
  }));

it("proves a Threads post absent by asking Threads, not by its login-walled permalink", () =>
  withDb(async (backendDb) => {
    connectThreads(backendDb);
    const published = (await runOperation("publish", context(backendDb), {
      locale: "ru",
      targets: "threads_ru",
      text: "Disposable test",
    })) as { ref: string };
    const now = new Date().toISOString();
    backendDb.sqlite
      .query(
        "INSERT INTO publication_targets(publication_key,target,status,url,external_id,updated_at) VALUES (?,'threads_ru','published','https://www.threads.com/@studio/post/A','18332651503276467',?)",
      )
      .run(published.ref, now);
    // What Threads serves a logged-out reader either way: its login wall, HTTP
    // 200. Left to the permalink alone the purge could never prove anything.
    const loginWall = new Response("log in", { status: 200 });
    const graph = (body: string, status: number) =>
      (async (input: string | URL | Request) => {
        const url = String(input instanceof Request ? input.url : input);
        if (!url.includes("graph.threads.net")) return loginWall.clone();
        return new Response(body, { status, headers: { "content-type": "application/json" } });
      }) as unknown as typeof fetch;

    const live = graph(JSON.stringify({ id: "18332651503276467", permalink: "https://www.threads.net/@studio/post/A" }), 200);
    await expect(runOperation("purge", context(backendDb, live), { ref: published.ref, apply: true })).rejects.toThrow(
      "threads_ru is still live on the platform",
    );

    const gone = graph(JSON.stringify({ error: { message: "Object with ID does not exist", code: 100 } }), 400);
    const result = (await runOperation("purge", context(backendDb, gone), { ref: published.ref, apply: true })) as { applied: boolean };
    expect(result.applied).toBe(true);
    expect(publicationTimeline(backendDb, published.ref).targets).toEqual([]);
  }));
