import { afterEach, describe, expect, it, spyOn } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import sharp from "sharp";
import { seedSiteFixture } from "../../../scripts/fixtures/site-fixture.js";
import { createApiHandler } from "../src/api.js";
import type { StudioProfileRecord } from "../src/application/ports.js";
import { applySiteMetadata, textHash } from "../src/operations/site-metadata.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

/** The Studio's half of the contract with the public site (alexgetman-site):
 * `/api/public/site` and the files it links to. */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

it("serves the smoke fixture images under the paths listed in its public feed", async () => {
  const { dataDir, request } = studio();
  const { imagePaths } = seedSiteFixture({ dbPath: join(dataDir, "pipeline.db"), publicDir: join(dataDir, "site") });
  const feed = await (await request("/api/public/site")).text();
  expect(imagePaths.length).toBeGreaterThan(0);
  for (const image of imagePaths) {
    expect(feed).toContain(image);
    expect((await request(`/${image}`)).status).toBe(200);
  }
});

function studio(profile: Partial<StudioProfileRecord> = SITE_STUDIO_PROFILE) {
  const dataDir = mkdtempSync(join(tmpdir(), "public-site-"));
  const backendDb = openBackendDb(join(dataDir, "pipeline.db"), 5000);
  cleanups.push(() => {
    backendDb.close();
    rmSync(dataDir, { recursive: true, force: true });
  });
  const config = loadTestConfig({ DATA_DIR: dataDir, PUBLIC_BASE_URL: "https://studio.example.com" }, profile);
  const handler = createApiHandler({ config, backendDb });
  return {
    backendDb,
    dataDir,
    request: (path: string, init?: RequestInit) => handler(new Request(`http://localhost${path}`, init)),
    writeSiteFile(relative: string, body: string | Uint8Array = "bytes") {
      const file = join(config.SITE_PUBLIC_DIR, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
      return file;
    },
  };
}

type PublicSite = {
  site: Record<"en" | "ru", { name: string; timezone: string }>;
  items: {
    post_id: number;
    image_en: string | null;
    media_en: {
      type?: string;
      path: string;
      poster?: string;
      width?: number;
      height?: number;
      responsive?: { path: string; width: number; height: number }[];
      poster_responsive?: { path: string; width: number; height: number }[];
    }[];
  }[];
};

function image(width: number, height: number) {
  return sharp({ create: { width, height, channels: 3, background: "white" } })
    .webp()
    .toBuffer();
}

describe("GET /api/public/site", () => {
  it("publishes reviewed alt and search titles and changes the ETag", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "An unchanged article",
      siteEn: true,
      siteMediaEn: [{ type: "image", path: "media/posts/1-en.jpg?v=one" }],
    });
    writeSiteFile("media/posts/1-en.jpg");
    const before = await request("/api/public/site");
    applySiteMetadata(
      backendDb,
      {
        version: 1,
        items: [
          {
            post_id: 1,
            locale: "en",
            text_sha256: textHash("An unchanged article"),
            seo_title: "A concise search title",
            images: [{ path: "media/posts/1-en.jpg?v=one", alt: "A chart comparing the two models." }],
          },
        ],
      },
      true,
    );
    const after = await request("/api/public/site", { headers: { "if-none-match": before.headers.get("etag") ?? "" } });
    expect(after.status).toBe(200);
    expect(after.headers.get("etag")).not.toBe(before.headers.get("etag"));
    const body = (await after.json()) as { items: { seo_title_en: string; media_en: { alt: string }[] }[] };
    expect(body.items[0]?.seo_title_en).toBe("A concise search title");
    expect(body.items[0]?.media_en[0]?.alt).toBe("A chart comparing the two models.");
  });
  it("does not exist on a Studio without a public site", async () => {
    const { request } = studio({ siteEnabled: 0 });
    expect((await request("/api/public/site")).status).toBe(404);
  });

  it("answers with the identity in both languages and the published posts", async () => {
    const { backendDb, request } = studio({ ...SITE_STUDIO_PROFILE, siteTimezoneJson: { en: "America/New_York", ru: "" } });
    seedTextPost(backendDb, { postId: 1, ru: "Русский", en: "English", siteRu: true, siteEn: true });

    const body = (await (await request("/api/public/site")).json()) as PublicSite;

    // An unnamed install is named by its own domain; an unset site zone is the operator's.
    expect(body.site.en).toEqual(expect.objectContaining({ name: "studio.example.com", timezone: "America/New_York" }));
    expect(body.site.ru.timezone).toBe("UTC");
    expect(body.items.map((item) => item.post_id)).toEqual([1]);
  });

  it("lists only the media this Studio has written, since the site cannot check", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: [
        { type: "image", path: "media/posts/1-en-0-vertical.jpg?v=abc" },
        { type: "image", path: "media/posts/1-en-1-vertical.jpg" },
      ],
    });
    writeSiteFile("media/posts/1-en-1-vertical.jpg");

    const [item] = ((await (await request("/api/public/site")).json()) as PublicSite).items;

    expect(item?.media_en.map((media) => media.path)).toEqual(["media/posts/1-en-1-vertical.jpg"]);
    expect(item?.image_en).toBe("media/posts/1-en-1-vertical.jpg");
  });

  it("answers 304 to a site that already has this answer", async () => {
    const { backendDb, request } = studio();
    seedTextPost(backendDb, { postId: 1, en: "English", siteEn: true });

    const first = await request("/api/public/site");
    const etag = first.headers.get("etag");
    expect(etag).toBeTruthy();
    const again = await request("/api/public/site", { headers: { "if-none-match": etag ?? "" } });
    expect(again.status).toBe(304);
  });

  it("waits only for a matching conditional request and ends an unchanged wait with 304", async () => {
    const { request } = studio();
    const first = await request("/api/public/site", { headers: { prefer: "wait=25" } });
    const etag = first.headers.get("etag") ?? "";
    expect(first.status).toBe(200);
    expect((await request("/api/public/site", { headers: { prefer: "wait=25", "if-none-match": '"older"' } })).status).toBe(200);
    expect((await request("/api/public/site", { headers: { prefer: "wait=invalid", "if-none-match": etag } })).status).toBe(304);
    const start = performance.now();
    const unchanged = await request("/api/public/site", { headers: { prefer: "wait=1", "if-none-match": etag } });
    expect(performance.now() - start).toBeGreaterThanOrEqual(900);
    expect(unchanged.status).toBe(304);
    expect(unchanged.headers.get("etag")).toBe(etag);
    expect(await unchanged.text()).toBe("");
  });

  it("stops a wait when its client disconnects", async () => {
    const { request } = studio();
    const first = await request("/api/public/site");
    const controller = new AbortController();
    let settled = false;
    const waiting = request("/api/public/site", {
      headers: { prefer: "wait=25", "if-none-match": first.headers.get("etag") ?? "" },
      signal: controller.signal,
    }).then((response) => {
      settled = true;
      return response;
    });
    try {
      await Bun.sleep(20);
      expect(settled).toBe(false);
    } finally {
      controller.abort();
      await waiting;
    }
    expect(settled).toBe(true);
  });

  it.each(["database", "scheduled publication", "late media"] as const)("returns a %s change during the wait", async (kind) => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: kind === "late media" ? [{ type: "image", path: "media/posts/wait.jpg?v=abcdef012345" }] : [],
    });
    if (kind === "scheduled publication")
      seedTextPost(backendDb, { postId: 2, en: "Scheduled", siteEn: true, publishedAt: new Date(Date.now() + 1000).toISOString() });
    const first = await request("/api/public/site");
    const controller = new AbortController();
    const waiting = request("/api/public/site", {
      headers: { prefer: "wait=10", "if-none-match": first.headers.get("etag") ?? "" },
      signal: controller.signal,
    });
    try {
      await Bun.sleep(20);
      if (kind === "database") seedTextPost(backendDb, { postId: 2, en: "New post", siteEn: true });
      if (kind === "late media") writeSiteFile("media/posts/wait.jpg");
      const changed = await waiting;
      expect(changed.status).toBe(200);
      expect(changed.headers.get("etag")).not.toBe(first.headers.get("etag"));
      const body = (await changed.json()) as PublicSite;
      if (kind === "late media") expect(body.items[0]?.media_en).toEqual([{ type: "image", path: "media/posts/wait.jpg?v=abcdef012345" }]);
      else expect(body.items.map((item) => item.post_id)).toContain(2);
    } finally {
      controller.abort();
      await waiting;
    }
  });

  it("keeps the serialized archive across expired quiet polls", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: [{ type: "image", path: "media/posts/stable.jpg?v=abcdef012345" }],
    });
    const bytes = await image(100, 100);
    writeSiteFile("media/posts/stable.jpg", bytes);
    writeSiteFile("generated/responsive/media-posts-stable-360.webp", bytes);
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    const serialize = spyOn(JSON, "stringify");
    try {
      const first = await request("/api/public/site");
      const etag = first.headers.get("etag") ?? "";
      serialize.mockClear();
      clock.mockReturnValue(now + 3001);
      expect((await request("/api/public/site", { headers: { "if-none-match": etag } })).status).toBe(304);
      // The remaining nominal sizes have the same actual dimensions. Becoming
      // complete must enable reuse without changing public bytes or the ETag.
      for (const width of [480, 640, 720, 800, 960, 1280]) writeSiteFile(`generated/responsive/media-posts-stable-${width}.webp`, bytes);
      clock.mockReturnValue(now + 6002);
      expect((await request("/api/public/site", { headers: { "if-none-match": etag } })).status).toBe(304);
      expect(serialize.mock.calls.filter(([value]) => Array.isArray(value) && value[0]?.post_id === 1)).toHaveLength(0);
    } finally {
      clock.mockRestore();
      serialize.mockRestore();
    }
  });

  it("discovers late media, posters and derivatives without a database change", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: [
        { type: "image", path: "media/posts/late.jpg?v=abcdef012345" },
        { type: "video", path: "media/posts/late.mp4?v=abcdef012345", poster: "media/posts/poster.jpg?v=abcdef012345" },
      ],
    });
    writeSiteFile("media/posts/late.mp4");
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    let step = 0;
    async function read() {
      clock.mockReturnValue(now + step++ * 3001);
      const response = await request("/api/public/site");
      return { etag: response.headers.get("etag"), body: (await response.json()) as PublicSite };
    }
    try {
      const first = await read();
      expect(first.body.items[0]?.media_en).toEqual([{ type: "video", path: "media/posts/late.mp4?v=abcdef012345" }]);
      writeSiteFile("media/posts/late.jpg", await image(1080, 1920));
      const source = await read();
      expect(source.etag).not.toBe(first.etag);
      expect(source.body.items[0]?.media_en).toHaveLength(2);
      expect((await read()).etag).toBe(source.etag);
      writeSiteFile("media/posts/poster.jpg", await image(640, 360));
      const poster = await read();
      expect(poster.etag).not.toBe(source.etag);
      expect(poster.body.items[0]?.media_en[1]).toMatchObject({ width: 640, height: 360 });
      writeSiteFile("generated/responsive/media-posts-late-640.webp", await image(640, 1138));
      const variant = await read();
      expect(variant.etag).not.toBe(poster.etag);
      expect(variant.body.items[0]?.media_en[0]?.responsive).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it("rechecks an unversioned image after it is replaced", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: [{ type: "image", path: "media/posts/historical.jpg" }],
    });
    const file = writeSiteFile("media/posts/historical.jpg", await image(1080, 1920));
    const now = Date.now();
    const clock = spyOn(Date, "now").mockReturnValue(now);
    try {
      const first = await request("/api/public/site");
      writeSiteFile("media/posts/historical.jpg", await image(640, 360));
      utimesSync(file, (now + 5000) / 1000, (now + 5000) / 1000);
      clock.mockReturnValue(now + 3001);
      const second = await request("/api/public/site");
      expect(second.headers.get("etag")).not.toBe(first.headers.get("etag"));
      expect(((await second.json()) as PublicSite).items[0]?.media_en[0]).toMatchObject({ width: 640, height: 360 });
    } finally {
      clock.mockRestore();
    }
  });

  it("publishes only renderer media fields, including missing-poster and unreadable-image fallbacks", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    const internal = { file_id: "upload-id", asset_id: 42, local_path: "/private/upload.jpg", future_worker_field: "internal" };
    const entries = [
      { type: "image", path: "media/posts/allowlist.jpg?v=allowlist", width: 12, height: 34, ...internal },
      { type: "image", path: "media/posts/unreadable.jpg", width: 12, height: 34, ...internal },
      { type: "video", path: "media/posts/missing-poster.mp4", poster: "media/posts/missing.jpg", ...internal },
      { type: "video", path: "media/posts/video.mp4", poster: "media/posts/allowlist.jpg?v=allowlist", ...internal },
    ];
    seedTextPost(backendDb, {
      postId: 1,
      ru: "Localized post",
      en: "English",
      siteRu: true,
      siteEn: true,
      siteMediaRu: entries,
      siteMediaEn: entries,
    });
    writeSiteFile("media/posts/allowlist.jpg", await image(1080, 1920));
    writeSiteFile("generated/responsive/media-posts-allowlist-640.webp", await image(640, 1138));
    for (const file of ["unreadable.jpg", "missing-poster.mp4", "video.mp4"]) writeSiteFile(`media/posts/${file}`);

    const body = (await (await request("/api/public/site")).json()) as { items: { media: unknown[]; media_en: unknown[] }[] };
    const expected = [
      {
        type: "image",
        path: entries[0]?.path,
        width: 1080,
        height: 1920,
        responsive: [{ path: "/generated/responsive/media-posts-allowlist-640.webp?v=allowlist", width: 640, height: 1138 }],
      },
      { type: "image", path: entries[1]?.path, width: 12, height: 34 },
      { type: "video", path: entries[2]?.path },
      {
        type: "video",
        path: entries[3]?.path,
        poster: "media/posts/allowlist.jpg?v=allowlist",
        width: 1080,
        height: 1920,
        poster_responsive: [{ path: "/generated/responsive/media-posts-allowlist-640.webp?v=allowlist", width: 640, height: 1138 }],
      },
    ];
    expect(body.items[0]?.media).toEqual(expected);
    expect(body.items[0]?.media_en).toEqual(expected);
  });

  it("describes the served image and only its existing responsive variants", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: [{ type: "image", path: "media/posts/1-en-0.jpg?v=abc", width: 2560, height: 1440 }],
    });
    writeSiteFile("media/posts/1-en-0.jpg", await image(1080, 1920));
    writeSiteFile("generated/responsive/media-posts-1-en-0-360.webp", await image(360, 640));
    writeSiteFile("generated/responsive/media-posts-1-en-0-640.webp", await image(640, 1138));

    const [item] = ((await (await request("/api/public/site")).json()) as PublicSite).items;
    expect(item?.media_en[0]).toMatchObject({
      width: 1080,
      height: 1920,
      responsive: [
        { path: "/generated/responsive/media-posts-1-en-0-360.webp?v=abc", width: 360, height: 640 },
        { path: "/generated/responsive/media-posts-1-en-0-640.webp?v=abc", width: 640, height: 1138 },
      ],
    });
  });

  it("reserves a materialized video's dimensions from its served poster", async () => {
    const { backendDb, request, writeSiteFile } = studio();
    seedTextPost(backendDb, {
      postId: 1,
      en: "English",
      siteEn: true,
      siteMediaEn: [{ type: "video", path: "media/posts/1.mp4", poster: "media/posts/1-poster.jpg?v=poster", width: 1920, height: 1080 }],
    });
    writeSiteFile("media/posts/1.mp4");
    writeSiteFile("media/posts/1-poster.jpg", await image(1080, 1920));
    writeSiteFile("generated/responsive/media-posts-1-poster-640.webp", await image(640, 1138));

    const [item] = ((await (await request("/api/public/site")).json()) as PublicSite).items;
    expect(item?.media_en[0]).toMatchObject({
      width: 1080,
      height: 1920,
      poster_responsive: [{ path: "/generated/responsive/media-posts-1-poster-640.webp?v=poster", width: 640, height: 1138 }],
    });
  });
});

describe("public files", () => {
  it("serves post media with byte ranges, and not on a Studio without a site", async () => {
    const site = studio();
    site.writeSiteFile("media/posts/1-en-0.mp4", "0123456789");
    const ranged = await site.request("/media/posts/1-en-0.mp4", { headers: { range: "bytes=2-4" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("234");
    expect((await site.request("/media/posts/1-en-0.mp4?v=abcdef012345")).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await site.request("/media/posts/1-en-0.mp4")).headers.get("cache-control")).not.toContain("immutable");

    const noSite = studio({ siteEnabled: 0 });
    noSite.writeSiteFile("media/posts/1-en-0.mp4");
    expect((await noSite.request("/media/posts/1-en-0.mp4")).status).toBe(404);
  });

  it("refuses a path that climbs out of the media root", async () => {
    const { request } = studio();
    expect((await request("/media/..%2F..%2Fpipeline.db")).status).toBe(403);
  });

  it("answers IndexNow's fetch of its key at the root, and no other key", async () => {
    const { dataDir, request } = studio();
    const key = "ab".repeat(16);
    expect((await request(`/${key}.txt`)).status).toBe(404);
    writeFileSync(join(dataDir, "indexnow.key"), `${key}\n`);
    const served = await request(`/${key}.txt`);
    expect(served.status).toBe(200);
    expect(await served.text()).toBe(`${key}\n`);
    expect((await request(`/${"0".repeat(32)}.txt`)).status).toBe(404);
  });

  it("serves a cached responsive variant and nothing it did not generate", async () => {
    const { request, writeSiteFile } = studio();
    writeSiteFile("generated/responsive/media-posts-1-en-0-640.webp");
    writeSiteFile("generated/responsive/media-posts-1-en-0-1280.webp");
    expect((await request("/generated/responsive/media-posts-1-en-0-640.webp")).headers.get("content-type")).toBe("image/webp");
    expect((await request("/generated/responsive/media-posts-1-en-0-640.webp?v=abcdef012345")).headers.get("cache-control")).toBe(
      "public, max-age=31536000, immutable",
    );
    expect((await request("/generated/responsive/media-posts-1-en-0-641.webp")).status).toBe(404);
    expect((await request("/generated/responsive/media-posts-1-en-0-1280.webp")).status).toBe(200);
  });
});

describe("discovery and operator surfaces", () => {
  it("describes its MCP endpoint at its own origin", async () => {
    const { request } = studio({ siteEnabled: 0 });
    const card = (await (await request("/.well-known/mcp/server-card.json")).json()) as { transport: { endpoint: string } };
    expect(card.transport.endpoint).toBe("/api/mcp");
    const resource = (await (await request("/.well-known/oauth-protected-resource")).json()) as { resource: string };
    expect(resource.resource).toBe("https://studio.example.com/api/mcp");
  });

  it("advertises the actual MCP handshake and only implemented authentication", async () => {
    const { request } = studio();
    const card = await (await request("/.well-known/mcp/server-card.json")).json();
    const handshake = await (
      await request("/api/mcp", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }),
      })
    ).json();
    expect(card.protocolVersion).toBe(handshake.result.protocolVersion);
    expect(card.serverInfo).toEqual(handshake.result.serverInfo);
    expect(card.capabilities).toEqual(handshake.result.capabilities);
    expect(card.capabilities.resources).toBeUndefined();
    const resource = await (await request("/.well-known/oauth-protected-resource")).json();
    expect(resource.scopes_supported).toBeUndefined();
    expect(resource.authorization_servers).toBeUndefined();
    expect((await request("/.well-known/oauth-authorization-server")).status).toBe(404);
    const denied = await request("/api/mcp");
    expect(denied.status).toBe(401);
    expect(denied.headers.get("www-authenticate")).toContain("/.well-known/oauth-protected-resource");
  });

  it("keeps operator pages out of search engines and shared caches", async () => {
    const { request } = studio();
    const stats = await request("/stats");
    expect(stats.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(stats.headers.get("cache-control")).toBe("no-store");
  });
});
