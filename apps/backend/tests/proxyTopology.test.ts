import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "../../..");

function read(path: string): string {
  return readFileSync(join(root, path), "utf8");
}

describe("host proxy topology", () => {
  it("hands every Studio the visitor's own address", () => {
    // Both Studios attribute and rate-limit by client address and read the
    // header named by TRUSTED_CLIENT_IP_HEADER. A proxy that forwards without
    // it collapses the whole internet onto one visitor identity, which turns
    // the public rate limit into a single global budget.
    const caddy = read("deploy/caddy/Caddyfile");
    const studio = read("deploy/studio.compose.yaml");

    expect(caddy).toContain("header_up X-Real-IP {remote_host}");
    expect(studio).toContain("TRUSTED_CLIENT_IP_HEADER: x-real-ip");
    // Every site block must import it, or one of them silently loses the address.
    expect(caddy.match(/import client_address/g)?.length).toBe(caddy.match(/reverse_proxy /g)?.length);
  });

  it("keeps a Studio without a site an allowlist, not a site", () => {
    // A Studio operated from another machine over MCP serves no public site.
    // The default is 404, so a route that is not named does not exist.
    const caddy = read("deploy/caddy/Caddyfile");

    expect(caddy).toContain("/api/mcp");
    expect(caddy).toContain("/api/studio/media");
    expect(caddy).toContain("/media/video/asset/*");
    expect(caddy).toContain("/media/staging/*");
    expect(caddy).toContain("/oauth/*");
    expect(caddy).toContain("respond 404");
  });

  it("describes every Studio with one file that names none of them", () => {
    // Two committed descriptions of one service is how they drifted: the
    // second one silently lost settings the first had. Every difference is a
    // value in the host's own .env, so there is nothing left to keep in sync.
    const studio = read("deploy/studio.compose.yaml");

    expect(studio).not.toContain("alexgetman");
    expect(studio).not.toContain("maru");
    // The identity, address and port a deployment answers on have no defaults.
    // A default would let a lost host env file publish media under another
    // Studio's domain, and the request that reveals it comes from Meta.
    expect(studio).toContain("${STUDIO:?");
    expect(studio).toContain("PUBLIC_BASE_URL: ${STUDIO_PUBLIC_BASE_URL:?");
    expect(studio).toContain("${STUDIO_PORT:?");
    // Backups leave as streams a backup host pulls; a Studio that wrote them
    // to a directory of its own would keep them where it loses them.
    expect(studio).not.toContain("/backups");
  });

  it("lets the second Studio reach every Command Center endpoint its dashboard calls", () => {
    // The allowlist named the endpoints one by one, so each new one was
    // unreachable on Maru until someone edited this file too. The dashboard
    // swallows the failure: "show more" fetched a Caddy 404 and simply did
    // nothing, and the live refresh poll died the same way.
    const caddy = read("deploy/caddy/Caddyfile");
    const routes = read("apps/backend/src/interfaces/http/command-center.ts");

    const allowed = (caddy.match(/@allowed path ([^\n]+)/)?.[1] ?? "").split(" ");
    const endpoints = [...routes.matchAll(/"(\/(?:api\/)?command-center\/[^"]+)"/g)].map((match) => match[1] ?? "");
    expect(endpoints.length).toBeGreaterThan(0);
    for (const endpoint of endpoints) {
      expect(allowed.some((pattern) => (pattern.endsWith("*") ? endpoint.startsWith(pattern.slice(0, -1)) : endpoint === pattern))).toBe(
        true,
      );
    }
  });

  it("keeps the proxy free of anything the application decides", () => {
    // Cache lifetimes, retired URLs, the Markdown twin, the Link header and the
    // noindex on the first Studio's operator surfaces ship in the image so they
    // reach self-hosted installs. Restating any of them here creates a second
    // place to change them, and the two drift apart silently.
    const caddy = read("deploy/caddy/Caddyfile");

    for (const leaked of ["Cache-Control", "try_files", "root ", "text/markdown", "rel=", "410"]) {
      expect(caddy).not.toContain(leaked);
    }
  });

  it("ships a self-host stack that names no personal domain", () => {
    // The point of publishing this is that someone else can run it. Every
    // default that is a live site of this deployment is a defect there.
    const compose = read("compose.yaml");
    const caddyfile = read("Caddyfile");
    const env = read(".env.example");

    for (const file of [compose, caddyfile, env]) {
      expect(file).not.toContain("alexgetman.com");
      expect(file).not.toContain("marux.ru");
      // The registry namespace is where the image is published and is fine; a
      // channel username is a live channel someone else would post into.
      expect(file).not.toContain("TELEGRAM_CHANNEL_USERNAME=alexgetmancom");
    }
    expect(compose).not.toContain("/backups");
    // The domain has no default at all: Caddy would request a certificate for
    // whatever it is told, and the application would publish it in its feeds.
    expect(compose).toContain("${DOMAIN:?");
    // Only the proxy is reachable from outside.
    expect(compose).not.toMatch(/ports:[\s\S]*?8788:8788/);
  });
});
