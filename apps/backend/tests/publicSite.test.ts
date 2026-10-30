import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createApiHandler } from "../src/api.js";
import type { StudioProfileRecord } from "../src/application/ports.js";
import { openBackendDb } from "./helpers/open-db.js";
import { seedTextPost } from "./helpers/post.js";
import { loadTestConfig, SITE_STUDIO_PROFILE } from "./helpers/studio-config.js";

/** The Studio's half of the contract with the public site (alexgetman-site):
 * `/api/public/site` and the files it links to. */

const cleanups: (() => void)[] = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
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
    writeSiteFile(relative: string, body = "bytes") {
      const file = join(config.SITE_PUBLIC_DIR, relative);
      mkdirSync(dirname(file), { recursive: true });
      writeFileSync(file, body);
    },
  };
}

type PublicSite = {
  site: Record<"en" | "ru", { name: string; timezone: string }>;
  items: { post_id: number; image_en: string | null; media_en: { path: string }[] }[];
};

describe("GET /api/public/site", () => {
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
});

describe("public files", () => {
  it("serves post media with byte ranges, and not on a Studio without a site", async () => {
    const site = studio();
    site.writeSiteFile("media/posts/1-en-0.mp4", "0123456789");
    const ranged = await site.request("/media/posts/1-en-0.mp4", { headers: { range: "bytes=2-4" } });
    expect(ranged.status).toBe(206);
    expect(await ranged.text()).toBe("234");

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
    expect((await request("/generated/responsive/media-posts-1-en-0-640.webp")).headers.get("content-type")).toBe("image/webp");
    expect((await request("/generated/responsive/media-posts-1-en-0-641.webp")).status).toBe(404);
  });
});

describe("discovery and operator surfaces", () => {
  it("describes its MCP endpoint at its own origin", async () => {
    const { request } = studio({ siteEnabled: 0 });
    const card = (await (await request("/.well-known/mcp/server-card.json")).json()) as { transport: { endpoint: string } };
    expect(card.transport.endpoint).toBe("/api/mcp");
    const resource = (await (await request("/.well-known/oauth-protected-resource")).json()) as { resource: string };
    expect(resource.resource).toBe("https://studio.example.com");
  });

  it("keeps operator pages out of search engines and shared caches", async () => {
    const { request } = studio();
    const stats = await request("/stats");
    expect(stats.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    expect(stats.headers.get("cache-control")).toBe("no-store");
  });
});
