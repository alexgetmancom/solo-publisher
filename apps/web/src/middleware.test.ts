import { describe, expect, it, mock } from "bun:test";
import { onRequest } from "./middleware";

// The middleware asks the runtime whether this Studio serves a site. These tests
// are about the routing, so they answer for it.
let siteEnabled = true;
mock.module("./server/runtime", () => ({ getRuntime: () => ({ config: { studio: { siteEnabled } } }) }));

type Rewritten = { rewrote: string | undefined; response: Response };

async function handle(pathname: string, accept?: string): Promise<Rewritten> {
  let rewrote: string | undefined;
  const context = {
    url: new URL(`https://studio.example.com${pathname}`),
    request: new Request(`https://studio.example.com${pathname}`, accept ? { headers: { accept } } : undefined),
    rewrite: (target: string) => {
      rewrote = target;
      return new Response("rewritten");
    },
  } as never;
  const response = await (onRequest as (c: never, n: () => Promise<Response>) => Promise<Response>)(
    context,
    async () => new Response("page"),
  );
  return { rewrote, response };
}

describe("site middleware", () => {
  it("serves nothing but the operator surfaces when the site is off", async () => {
    // site_enabled: false used to switch off the workers while the pages, feeds
    // and sitemap carried on being served — one deployment's proxy hid that.
    siteEnabled = false;
    try {
      for (const path of ["/", "/ru/", "/42/some-slug/", "/feed.xml", "/sitemap.xml", "/llms.txt"]) {
        expect((await handle(path)).response.status).toBe(404);
      }
      for (const path of [
        "/command-center",
        "/oauth/threads",
        "/oauth/instagram/start",
        "/healthz",
        "/readyz",
        "/api/mcp",
        "/api/studio/media",
        "/media/staging/cache-image.jpg",
        "/media/video/asset/7",
        "/stats",
      ]) {
        expect((await handle(path)).response.status).toBe(200);
      }
    } finally {
      siteEnabled = true;
    }
  });

  it("serves the Markdown twin at the canonical URL", async () => {
    // The host proxy did this with four rewrites. Moved here it ships in the image, so a
    // self-hosted Studio gets the behaviour the README promises.
    expect((await handle("/", "text/markdown")).rewrote).toBe("/index.md");
    expect((await handle("/ru/", "text/markdown")).rewrote).toBe("/ru/index.md");
    expect((await handle("/42/some-slug/", "text/markdown")).rewrote).toBe("/42/some-slug.md");
    expect((await handle("/ru/42/some-slug", "text/markdown")).rewrote).toBe("/ru/42/some-slug.md");
  });

  it("does not rewrite a twin into itself", async () => {
    // The rewrite re-enters this middleware, and "/42/some-slug.md" matches the
    // post pattern with ".md" inside the slug. This answered 508 once.
    expect((await handle("/42/some-slug.md", "text/markdown")).rewrote).toBeUndefined();
    expect((await handle("/index.md", "text/markdown")).rewrote).toBeUndefined();
  });

  it("leaves anything without a Markdown twin alone", async () => {
    expect((await handle("/42/some-slug/")).rewrote).toBeUndefined();
    expect((await handle("/command-center", "text/markdown")).rewrote).toBeUndefined();
    expect((await handle("/feed.xml", "text/markdown")).rewrote).toBeUndefined();
  });

  it("advertises the discovery entry points on the home pages only", async () => {
    expect((await handle("/")).response.headers.get("link")).toContain('rel="api-catalog"');
    expect((await handle("/ru/")).response.headers.get("link")).toContain('rel="service-doc"');
    expect((await handle("/42/some-slug/")).response.headers.get("link")).toBeNull();
  });

  it("keeps operator surfaces out of search results", async () => {
    for (const path of [
      "/command-center",
      "/oauth/threads",
      "/oauth/instagram/start",
      "/stats",
      "/stats/pageview",
      "/api/command-center/fingerprint",
    ]) {
      expect((await handle(path)).response.headers.get("x-robots-tag")).toBe("noindex, nofollow");
    }
    expect((await handle("/")).response.headers.get("x-robots-tag")).toBeNull();
  });
});
