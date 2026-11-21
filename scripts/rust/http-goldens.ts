import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createApiHandler } from "../../apps/backend/src/api.js";
import { openBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { clientIpHash } from "../../apps/backend/src/foundation/client-identity.js";
import { loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { commandAllowed, mcpStudioActor } from "../../apps/backend/src/foundation/http-auth.js";
import { streamUploadToFile } from "../../apps/backend/src/interfaces/http/media-upload.js";

/**
 * The TypeScript side of the Rust HTTP edge parity test (crates/http/tests/goldens.rs).
 * Every case builds the real Hono app (`createApiHandler`) over its own database and
 * DATA_DIR under a fixed clock, runs its steps and records every response: status,
 * every header, and the body (text, or sha256 + length for bytes). The request is
 * recorded as the app saw it, so the Rust side replays exactly those headers.
 *
 *   bun scripts/rust/http-goldens.ts      writes parity/http/goldens.json
 *
 * A step is
 *   {"sql": "<statements>"}                       `$DATA_DIR` is replaced by the case's directory
 *   {"write": "<path under DATA_DIR>", "base64": "<bytes>"}
 *   {"mkdir": "<path under DATA_DIR>"} | {"chmod": "<path under DATA_DIR>", "mode": <octal>}
 *   {"request": Req}                             a header value `$etag` is the last ETag answered
 *   {"held_uploads": [Req, Req], "meanwhile": Req}   two uploads whose bodies stay open while `meanwhile` runs
 * Response bodies and the recorded asset rows carry `$DATA_DIR` instead of the path.
 * The helpers without a route of their own in this slice (`commandAllowed`,
 * `mcpStudioActor`, `clientIpHash`, `streamUploadToFile`) are recorded as direct calls.
 */

type Req = { method?: string; target: string; headers?: [string, string][]; base64?: string };
type Step =
  | { sql: string }
  | { write: string; base64: string }
  | { mkdir: string }
  | { chmod: string; mode: number }
  | { request: Req }
  | { held_uploads: [Req, Req]; meanwhile: Req };
type Case = { name: string; env?: Record<string, string>; steps: Step[] };
type Body = { text: string } | { sha256: string; length: number } | null;
type Recorded = {
  request: { method: string; target: string; headers: [string, string][]; base64?: string };
  status: number;
  headers: Record<string, string>;
  body: Body;
};

const T0 = "2026-11-01T10:00:00.000Z";
const nowMs = Date.parse(T0);
const RealDate = Date;
class FixedDate extends RealDate {
  constructor(...args: unknown[]) {
    if (args.length === 0) super(nowMs);
    else super(...(args as [string]));
  }
  static override now(): number {
    return nowMs;
  }
}
globalThis.Date = FixedDate as DateConstructor;

const STUDIO_TOKEN = "studio-token-for-tests-0001";
const BASE_ENV = {
  PUBLIC_BASE_URL: "https://studio.example.com",
  MCP_STUDIO_TOKEN: STUDIO_TOKEN,
  MCP_STUDIO_ACTOR_ID: "7",
};
const SITE_ON = "UPDATE studio_profile SET site_enabled = 1;";
const HASH = `${"a".repeat(63)}1`;
const HEX32 = "0123456789abcdef".repeat(2);

const b64 = (bytes: Uint8Array | string) => Buffer.from(bytes).toString("base64");
/** 1000 bytes, each its offset modulo 256: a wrong slice shows in the digest. */
const VIDEO = b64(Uint8Array.from({ length: 1000 }, (_, index) => index % 256));
const PNG = b64(
  Buffer.from(
    "89504e470d0a1a0a0000000d4948445200000001000000010806000000" +
      "1f15c4890000000d49444154789c6360000002000154a24f5d0000000049454e44ae426082",
    "hex",
  ),
);
const get = (target: string, headers: [string, string][] = []): Step => ({ request: { target, headers } });
const head = (target: string, headers: [string, string][] = []): Step => ({ request: { method: "HEAD", target, headers } });
const ranged = (target: string, range: string): Step => get(target, [["range", range]]);
const bearer = (token = STUDIO_TOKEN): [string, string] => ["authorization", `Bearer ${token}`];
const upload = (headers: [string, string][], base64?: string): Req => ({
  method: "POST",
  target: "/api/studio/media",
  headers,
  ...(base64 === undefined ? {} : { base64 }),
});
const write = (file: string, base64 = b64("bytes")): Step => ({ write: file, base64 });

function cases(): Case[] {
  return [
    {
      name: "health, routing and unknown routes",
      steps: [
        get("/healthz"),
        get("/healthz/"),
        get("/healthz//"),
        head("/healthz"),
        get("/heal%74hz"),
        get("/tg-feed/healthz"),
        get("/tg-feed/healthz/"),
        { request: { method: "POST", target: "/healthz" } },
        { request: { method: "PUT", target: "/readyz" } },
        { request: { method: "DELETE", target: "/healthz" } },
        get("/"),
        get("/unknown"),
        head("/unknown"),
        { request: { method: "POST", target: "/unknown" } },
        get("/stats"),
        get("/stats/"),
        get("/stats/anything/deeper"),
        head("/stats/x"),
        get("/statsx"),
        get("/oauth"),
        get("/oauth/"),
        get("/oauth/unknown"),
        get("/oauthx"),
        get("/api/public/site"),
        get("/generated/responsive/media-a-360.webp"),
      ],
    },
    {
      name: "public site contract mounted",
      steps: [
        { sql: SITE_ON },
        get("/api/public/site"),
        get("/api/public/site", [["if-none-match", "$etag"]]),
        get("/api/public/site/", [["if-none-match", '"other"']]),
        head("/api/public/site", [["if-none-match", "$etag"]]),
        { request: { method: "POST", target: "/api/public/site" } },
      ],
    },
    {
      name: "discovery documents",
      steps: [
        get("/.well-known/oauth-protected-resource"),
        get("/.well-known/oauth-protected-resource/"),
        head("/.well-known/mcp/server-card.json"),
        get("/.well-known/mcp/server-card.json"),
        get("/.well-known/other"),
      ],
    },
    {
      name: "discovery documents with a port and a trailing slash",
      env: { PUBLIC_BASE_URL: "https://Studio.Example.com:8443/" },
      steps: [get("/.well-known/oauth-protected-resource"), get("/.well-known/mcp/server-card.json")],
    },
    {
      name: "readiness with heartbeats",
      steps: [
        { mkdir: "media-cache" },
        {
          sql: `INSERT INTO worker_state (name, state_json, updated_at) VALUES
            ('queue', '{"ok":true,"last_heartbeat_at":"2026-11-01T09:59:58.400Z","heartbeat_interval_ms":5000}', '2026-11-01T09:59:58.400Z'),
            ('video', '{"ok":true,"heartbeat_interval_ms":60000}', '2026-11-01T09:50:00.000Z'),
            ('site', '{"last_heartbeat_at":"not a date"}', '2026-11-01T09:00:00.000Z'),
            ('notifications', '[1,2]', '2026-11-01T10:00:01.000Z'),
            ('alerts', '{"heartbeat_interval_ms":"5000","last_heartbeat_at":"2026-10-31T10:00:00.000Z"}', '2026-11-01T10:00:00.000Z');`,
        },
        get("/readyz"),
        get("/readyz/"),
        head("/readyz"),
      ],
    },
    {
      name: "readiness fails on unwritable media directories",
      steps: [
        { sql: SITE_ON },
        { mkdir: "media-cache" },
        { mkdir: "video-media" },
        { mkdir: "site" },
        { chmod: "media-cache", mode: 0o555 },
        { chmod: "site", mode: 0o555 },
        get("/readyz"),
      ],
    },
    {
      name: "readiness ignores the site directory of a Studio without a site",
      steps: [{ mkdir: "site" }, { chmod: "site", mode: 0o555 }, get("/readyz")],
    },
    {
      name: "readiness fails on an unwritable data directory",
      steps: [{ chmod: ".", mode: 0o555 }, get("/readyz"), { chmod: ".", mode: 0o755 }],
    },
    {
      name: "readiness without the worker table is a handler error",
      steps: [{ sql: "DROP TABLE worker_state;" }, get("/readyz")],
    },
    {
      name: "staging media",
      steps: [
        write("media/a.mp4", VIDEO),
        write("media/sub/b.jpg"),
        write("media/a b.jpg"),
        write("media/x.json"),
        write("media/x.txt"),
        write("media/x.svg"),
        write("media/x.JPG"),
        write("media/x.webm"),
        write("media/x.unknownext"),
        write("media/noext"),
        write("media/.hidden"),
        write("media/empty.mp4", ""),
        get("/media/staging/a.mp4"),
        get("/media/staging/a.mp4?v=0123456789ab"),
        head("/media/staging/a.mp4"),
        get("/media/staging/a.mp4/"),
        get("/media/staging//a.mp4"),
        get("/media/staging%2Fa.mp4"),
        ranged("/media/staging/a.mp4", "bytes=0-9"),
        ranged("/media/staging/a.mp4", "bytes=10-"),
        ranged("/media/staging/a.mp4", "bytes=-100"),
        ranged("/media/staging/a.mp4", "bytes=-5000"),
        ranged("/media/staging/a.mp4", "bytes=990-2000"),
        ranged("/media/staging/a.mp4", "bytes=999-999"),
        ranged("/media/staging/a.mp4", " bytes=0-1 "),
        ranged("/media/staging/a.mp4", "bytes=1000-"),
        ranged("/media/staging/a.mp4", "bytes=5-2"),
        ranged("/media/staging/a.mp4", "bytes=-0"),
        ranged("/media/staging/a.mp4", "bytes=-"),
        ranged("/media/staging/a.mp4", "bytes=abc"),
        ranged("/media/staging/a.mp4", "items=0-1"),
        ranged("/media/staging/a.mp4", "bytes=0-1,3-4"),
        ranged("/media/staging/a.mp4", "bytes=00000000000000000000001-2"),
        ranged("/media/staging/a.mp4", ""),
        head("/media/staging/a.mp4", [["range", "bytes=0-9"]]),
        ranged("/media/staging/empty.mp4", "bytes=0-1"),
        get("/media/staging/empty.mp4"),
        get("/media/staging/sub/b.jpg"),
        get("/media/staging/a%20b.jpg"),
        get("/media/staging/a b.jpg"),
        get("/media/staging/x.json"),
        get("/media/staging/x.txt"),
        get("/media/staging/x.svg"),
        get("/media/staging/x.JPG"),
        get("/media/staging/x.webm"),
        get("/media/staging/x.unknownext"),
        get("/media/staging/noext"),
        get("/media/staging/.hidden"),
        get("/media/staging/missing.mp4"),
        get("/media/staging"),
        get("/media/staging/"),
        get("/media/staging/sub"),
        get("/media/staging/..%2F..%2Fpipeline.db"),
        get("/media/staging/sub/..%2F..%2F..%2Fpipeline.db"),
        get("/media/staging/sub/..%2Fa.mp4"),
        get("/media/staging/%2e%2e/pipeline.db"),
        get("/media/staging/../../pipeline.db"),
        get("/media/staging/%E0%A4%A.mp4"),
        get("/media/staging/%25E0.mp4"),
        get("/media/stagingx/a.mp4"),
        get("/media/posts/p.jpg"),
        get("/media"),
        get("/media/"),
        { request: { method: "POST", target: "/media/staging/a.mp4" } },
      ],
    },
    {
      name: "site media",
      steps: [
        { sql: SITE_ON },
        write("site/media/posts/p.jpg"),
        write("site/secret.txt"),
        write("media/a.mp4", VIDEO),
        get("/media/posts/p.jpg"),
        get("/media/posts/p.jpg?v=0123456789ab"),
        get("/media/posts/p.jpg?x=1&v=0123456789ab"),
        get("/media/posts/p.jpg?v=0123456789AB"),
        get("/media/posts/p.jpg?v=0123456789a"),
        get("/media/posts/p.jpg?v=0123456789ab&v=zz"),
        head("/media/posts/p.jpg?v=0123456789ab"),
        ranged("/media/posts/p.jpg?v=0123456789ab", "bytes=1-2"),
        get("/media/staging/a.mp4?v=0123456789ab"),
        get("/media/..%2Fsecret.txt"),
        get("/media/posts/..%2F..%2F..%2Fpipeline.db"),
        get("/media/posts"),
        get("/media"),
        get("/media/missing.jpg"),
        get("/media/video/asset/extra/p.jpg"),
      ],
    },
    {
      name: "video assets",
      steps: [
        write("video-media/7/clip.mp4", VIDEO),
        write("video-media/7/empty.mp4", ""),
        write("video-media/7/photo.jpg"),
        {
          sql: `INSERT INTO studio_media_assets (actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at) VALUES
            (7, 'video', 'video/quicktime', 'clip.mov', '$DATA_DIR/video-media/7/clip.mp4', 1000, '${HASH}', 'http_upload', '${T0}'),
            (7, 'video', '', 'blank.mp4', '$DATA_DIR/video-media/7/clip.mp4', 1000, '${"b".repeat(64)}', 'http_upload', '${T0}'),
            (7, 'video', 'video/mp4', 'empty.mp4', '$DATA_DIR/video-media/7/empty.mp4', 0, '${"c".repeat(64)}', 'http_upload', '${T0}'),
            (7, 'video', 'video/mp4', 'gone.mp4', '$DATA_DIR/video-media/7/gone.mp4', 10, '${"d".repeat(64)}', 'http_upload', '${T0}'),
            (7, 'photo', 'image/jpeg', 'photo.jpg', '$DATA_DIR/video-media/7/photo.jpg', 5, '${"e".repeat(64)}', 'http_upload', '${T0}');`,
        },
        get(`/media/video/asset/${HASH}`),
        head(`/media/video/asset/${HASH}`),
        ranged(`/media/video/asset/${HASH}`, "bytes=0-9"),
        get(`/media/video/asset/${HASH}/`),
        get(`/media/video/asset/${"b".repeat(64)}`),
        get(`/media/video/asset/${"c".repeat(64)}`),
        get(`/media/video/asset/${"d".repeat(64)}`),
        get(`/media/video/asset/${"e".repeat(64)}`),
        get(`/media/video/asset/${"f".repeat(64)}`),
        get(`/media/video/asset/${HASH.toUpperCase()}`),
        get(`/media/video/asset/${HASH.slice(1)}`),
        get(`/media/video/asset/${HASH}/extra`),
        get("/media/video/asset"),
      ],
    },
    {
      name: "IndexNow key",
      steps: [
        get(`/${HEX32}.txt`),
        write("indexnow.key", b64(`  ${HEX32}\n`)),
        get(`/${HEX32}.txt`),
        head(`/${HEX32}.txt`),
        get(`/${HEX32}.txt/`),
        get(`/${HEX32.replace("0", "1")}.txt`),
        get(`/${HEX32.toUpperCase()}.txt`),
        get(`/${HEX32}0.txt`),
        get(`/${HEX32}.TXT`),
        get(`/robots.txt`),
        get(`/x/${HEX32}.txt`),
        { request: { method: "POST", target: `/${HEX32}.txt` } },
      ],
    },
    {
      name: "IndexNow key that the route cannot name",
      steps: [write("indexnow.key", b64(HEX32.toUpperCase())), get(`/${HEX32}.txt`), get(`/${HEX32.toUpperCase()}.txt`)],
    },
    {
      name: "responsive variants",
      steps: [
        write("site/generated/responsive/media-abc-360.webp"),
        write("site/generated/responsive/media-abc-361.webp"),
        get("/generated/responsive/media-abc-360.webp"),
        { sql: SITE_ON },
        get("/generated/responsive/media-abc-360.webp"),
        get("/generated/responsive/media-abc-360.webp?v=0123456789ab"),
        head("/generated/responsive/media-abc-360.webp"),
        get("/generated/responsive/media-abc-360.webp/"),
        get("/generated/responsive/%6Dedia-abc-360.webp"),
        get("/generated/responsive/media-abc-361.webp"),
        get("/generated/responsive/media-abc-480.webp"),
        get("/generated/responsive/media-abc-360.png"),
        get("/generated/responsive/-360.webp"),
        get("/generated/responsive/a%20b-360.webp"),
        get("/generated/responsive/sub/media-abc-360.webp"),
        get("/generated/responsive"),
      ],
    },
    {
      name: "media uploads",
      steps: [
        { request: upload([["content-type", "image/png"]], PNG) },
        { request: upload([bearer("studio-token-for-tests-0002"), ["content-type", "image/png"]], PNG) },
        { request: upload([["authorization", `bearer ${STUDIO_TOKEN}`]], PNG) },
        { request: upload([["authorization", `Bearer  ${STUDIO_TOKEN}`]], PNG) },
        { request: upload([["authorization", STUDIO_TOKEN]], PNG) },
        { request: upload([bearer(), ["content-type", "image/png"], ["x-filename", "photo.png"]], PNG) },
        { request: upload([bearer(), ["content-type", "image/png"], ["x-filename", "again.png"]], PNG) },
        { request: upload([bearer(), ["content-type", "Image/PNG; charset=binary"], ["x-file-name", "café.png"]], b64("other")) },
        { request: upload([bearer(), ["x-filename", "clip.mp4"]], VIDEO) },
        { request: upload([bearer()], b64("no name")) },
        { request: upload([bearer(), ["content-type", "multipart/form-data; boundary=x"]], b64("--x--")) },
        { request: upload([bearer(), ["content-type", "image/png"]]) },
        { request: upload([bearer(), ["content-type", "image/png"]], "") },
        { request: upload([bearer(), ["content-type", "text/plain"], ["x-filename", "notes.txt"]], b64("text")) },
        { request: upload([bearer(), ["content-type", "image/png"], ["content-length", "1000000001"]], PNG) },
        { request: upload([bearer(), ["content-type", "image/png"], ["content-length", "1e10"]], PNG) },
        { request: upload([bearer(), ["content-type", "image/png"], ["content-length", "1000000000"]], b64("exact")) },
        { request: { ...upload([bearer()], PNG), target: "/api/studio/media/" } },
        { request: { method: "GET", target: "/api/studio/media", headers: [bearer()] } },
      ],
    },
    {
      name: "media uploads without Studio access configured",
      env: { MCP_STUDIO_TOKEN: "", MCP_STUDIO_ACTOR_ID: "" },
      steps: [{ request: upload([bearer(), ["content-type", "image/png"]], PNG) }],
    },
    {
      name: "media uploads beyond two at once",
      steps: [
        {
          held_uploads: [
            upload([bearer(), ["content-type", "image/png"], ["x-filename", "one.png"]], b64("first upload")),
            upload([bearer(), ["content-type", "image/png"], ["x-filename", "two.png"]], b64("second upload")),
          ],
          meanwhile: upload([bearer(), ["content-type", "image/png"], ["x-filename", "three.png"]], b64("third upload")),
        },
        { request: upload([bearer(), ["content-type", "image/png"], ["x-filename", "four.png"]], b64("fourth upload")) },
      ],
    },
  ];
}

// ------------------------------------------------------------------ replay

function execAll(sqlite: ReturnType<typeof unsafeDb>["sqlite"], sql: string): void {
  for (const statement of sql.split(/;\s*(?:\n|$)/)) if (statement.trim()) sqlite.run(statement);
}

function bodyOf(response: Response, bytes: Buffer, dataDir: string): Body {
  if (bytes.length === 0) return null;
  const type = response.headers.get("content-type") ?? "";
  if (type.startsWith("text/") || type.includes("json")) return { text: bytes.toString("utf8").replaceAll(dataDir, "$DATA_DIR") };
  return { sha256: crypto.createHash("sha256").update(bytes).digest("hex"), length: bytes.length };
}

/** An upload body that stays open until `release` is called. */
function heldBody(base64: string): { stream: ReadableStream<Uint8Array>; release: () => void } {
  let release = () => {};
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(new Uint8Array(Buffer.from(base64, "base64")));
      release = () => controller.close();
    },
  });
  return { stream, release: () => release() };
}

async function run(spec: Case, base: string) {
  const dataDir = path.join(base, spec.name.replace(/[^a-z0-9]+/gi, "-"));
  fs.mkdirSync(dataDir, { recursive: true });
  const env = { ...BASE_ENV, ...spec.env, DATA_DIR: dataDir };
  const backendDb = openBackendDb(path.join(dataDir, "pipeline.db"), 5000);
  const config = withStudioProfile(loadConfig(env), backendDb);
  const handler = createApiHandler({ config, backendDb });
  const results: Recorded[] = [];
  const chmodded: string[] = [];
  let etag = "";

  const build = (req: Req, body?: BodyInit) =>
    new Request(`http://localhost${req.target}`, {
      method: req.method ?? "GET",
      headers: (req.headers ?? []).map(([name, value]) => [name, value === "$etag" ? etag : value] as [string, string]),
      ...(body !== undefined ? { body } : req.base64 !== undefined ? { body: Buffer.from(req.base64, "base64") } : {}),
    });
  const record = async (req: Req, request: Request, pending: Promise<Response>) => {
    const response = await pending;
    const bytes = Buffer.from(await response.arrayBuffer());
    etag = response.headers.get("etag") ?? etag;
    results.push({
      request: {
        method: request.method,
        target: req.target,
        headers: [...request.headers],
        ...(req.base64 !== undefined ? { base64: req.base64 } : {}),
      },
      status: response.status,
      headers: Object.fromEntries([...response.headers].map(([name, value]) => [name, value.replaceAll(dataDir, "$DATA_DIR")])),
      body: bodyOf(response, bytes, dataDir),
    });
  };

  for (const item of spec.steps) {
    if ("sql" in item) execAll(unsafeDb(backendDb).sqlite, item.sql.replaceAll("$DATA_DIR", dataDir));
    else if ("write" in item) {
      const file = path.join(dataDir, item.write);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      fs.writeFileSync(file, Buffer.from(item.base64, "base64"));
    } else if ("mkdir" in item) fs.mkdirSync(path.join(dataDir, item.mkdir), { recursive: true });
    else if ("chmod" in item) {
      fs.chmodSync(path.join(dataDir, item.chmod), item.mode);
      chmodded.push(path.join(dataDir, item.chmod));
    } else if ("request" in item) {
      const request = build(item.request);
      await record(item.request, request, handler(request));
    } else {
      const held = item.held_uploads.map((req) => ({ req, ...heldBody(req.base64 ?? "") }));
      const requests = held.map(({ req, stream }) => build(req, stream));
      const pending = requests.map((request) => handler(request));
      await Bun.sleep(20);
      const meanwhile = build(item.meanwhile);
      await record(item.meanwhile, meanwhile, handler(meanwhile));
      // One at a time, so the asset ids do not depend on which import wins.
      for (const [index, { req, release }] of held.entries()) {
        release();
        await record(req, requests[index] as Request, pending[index] as Promise<Response>);
      }
    }
  }
  for (const dir of chmodded) fs.chmodSync(dir, 0o755);
  const assets = unsafeDb(backendDb)
    .sqlite.query(
      "SELECT actor_id, kind, mime_type, filename, local_path, byte_size, sha256, source, created_at FROM studio_media_assets ORDER BY id",
    )
    .all()
    .map((row: unknown) => JSON.parse(JSON.stringify(row).replaceAll(dataDir, "$DATA_DIR")));
  const incomingDir = path.join(config.STUDIO_MEDIA_DIR, ".incoming");
  const incoming = fs.existsSync(incomingDir) ? fs.readdirSync(incomingDir) : null;
  unsafeDb(backendDb).sqlite.close();
  return { name: spec.name, env: { ...BASE_ENV, ...spec.env }, steps: spec.steps, results, assets, incoming };
}

// -------------------------------------------------------- direct helpers

type HelperRequest = { method: string; target: string; headers: [string, string][] };

/** The helpers read only environment settings; the profile they are layered
 * over comes from a scratch database. */
function helperConfig(base: string, env: Record<string, string>) {
  const dataDir = path.join(base, "helpers");
  fs.mkdirSync(dataDir, { recursive: true });
  return withStudioProfile(loadConfig({ ...env, DATA_DIR: dataDir }), openBackendDb(path.join(dataDir, "pipeline.db"), 5000));
}

function commandCases(base: string) {
  const requests: (HelperRequest & { payload?: string | null })[] = [
    { method: "GET", target: "/x", headers: [] },
    { method: "GET", target: "/x", headers: [["x-command-token", "command-token-for-tests"]] },
    { method: "POST", target: "/x", headers: [["x-command-token", "command-token-for-tests"]] },
    { method: "GET", target: "/x", headers: [["x-command-token", "command-token-for-test"]] },
    { method: "GET", target: "/x", headers: [["x-command-token", "command-token-for-tests "]] },
    { method: "GET", target: "/x", headers: [["x-admin-token", "command-token-for-tests"]] },
    {
      method: "GET",
      target: "/x",
      headers: [
        ["x-command-token", "wrong"],
        ["x-admin-token", "command-token-for-tests"],
      ],
    },
    {
      method: "GET",
      target: "/x",
      headers: [
        ["x-command-token", ""],
        ["x-admin-token", "command-token-for-tests"],
      ],
    },
    { method: "GET", target: "/x?token=command-token-for-tests", headers: [] },
    { method: "HEAD", target: "/x?token=command-token-for-tests", headers: [] },
    { method: "head", target: "/x?token=command-token-for-tests", headers: [] },
    { method: "POST", target: "/x?token=command-token-for-tests", headers: [] },
    { method: "GET", target: "/x?token=command%2Dtoken+for-tests", headers: [] },
    { method: "GET", target: "/x?token=wrong&token=command-token-for-tests", headers: [] },
    { method: "GET", target: "/x?token=wrong", headers: [["cookie", "command_token=command-token-for-tests"]] },
    { method: "POST", target: "/x", headers: [["cookie", "a=1; command_token=command-token-for-tests; b=2"]] },
    { method: "POST", target: "/x", headers: [["cookie", "command_token=command%2Dtoken-for-tests"]] },
    { method: "POST", target: "/x", headers: [["cookie", "command_token=command-token-for-tests%"]] },
    { method: "POST", target: "/x", headers: [["cookie", "command_token=%E0%A4%A"]] },
    { method: "POST", target: "/x", headers: [["cookie", "command_token=a=b"]] },
    { method: "POST", target: "/x", headers: [["cookie", " command_token = command-token-for-tests"]] },
    { method: "POST", target: "/x", headers: [], payload: " command-token-for-tests " },
    { method: "POST", target: "/x", headers: [["x-command-token", "command-token-for-tests"]], payload: "wrong" },
    { method: "POST", target: "/x", headers: [["x-command-token", "command-token-for-tests"]], payload: "   " },
    { method: "POST", target: "/x", headers: [["x-command-token", "ÿcommand-token-for-test"]] },
  ];
  const out = [];
  for (const token of ["command-token-for-tests", undefined, "ÿcommand-token-for-test"]) {
    const config = helperConfig(base, token ? { COMMAND_CENTER_TOKEN: token } : {});
    for (const request of requests) {
      const raw = new Request(`http://localhost${request.target}`, { method: request.method, headers: request.headers });
      out.push({ token: token ?? null, ...request, headers: [...raw.headers], result: commandAllowed(raw, config, request.payload) });
    }
  }
  return out;
}

function studioActorCases(base: string) {
  const headers: [string, string][][] = [
    [],
    [["authorization", `Bearer ${STUDIO_TOKEN}`]],
    [["authorization", `Bearer ${STUDIO_TOKEN}x`]],
    [["authorization", `bearer ${STUDIO_TOKEN}`]],
    [["authorization", `Bearer  ${STUDIO_TOKEN}`]],
    [["authorization", "Bearer "]],
    [["authorization", STUDIO_TOKEN]],
  ];
  const out = [];
  for (const env of [BASE_ENV, { MCP_STUDIO_TOKEN: "", MCP_STUDIO_ACTOR_ID: "" }]) {
    const config = helperConfig(base, env);
    for (const list of headers) {
      const raw = new Request("http://localhost/api/studio/media", { method: "POST", headers: list });
      out.push({ env, headers: [...raw.headers], result: mcpStudioActor(raw, config) });
    }
  }
  return out;
}

function clientIdentityCases(base: string) {
  const out = [];
  for (const env of [
    { CLIENT_IP_HASH_SALT: "salt-for-tests-0001" },
    { CLIENT_IP_HASH_SALT: "salt-for-tests-0001", TRUSTED_CLIENT_IP_HEADER: "cf-connecting-ip" },
    {},
  ]) {
    const config = helperConfig(base, env);
    for (const headers of [
      [],
      [["x-real-ip", "203.0.113.7"]],
      [["x-real-ip", "  203.0.113.7  "]],
      [["x-real-ip", "   "]],
      [["cf-connecting-ip", "2001:db8::1"]],
      [["x-forwarded-for", "198.51.100.1"]],
    ] as [string, string][][]) {
      const raw = new Request("http://localhost/", { headers });
      out.push({ env, headers: [...raw.headers], result: clientIpHash(raw, config) });
    }
  }
  return out;
}

async function streamUploadCases(base: string) {
  const out = [];
  for (const [chunks, max] of [
    [["AQI=", "AwQ="], 4],
    [["AQID", "BA=="], 3],
    [["AQID"], 3],
    [[], 3],
    [[""], 3],
    [["AQID", "", "BA=="], 2_000_000],
  ] as [string[], number][]) {
    const target = path.join(base, `stream-${out.length}`);
    const body = new ReadableStream<Uint8Array>({
      start(controller) {
        for (const chunk of chunks) controller.enqueue(new Uint8Array(Buffer.from(chunk, "base64")));
        controller.close();
      },
    });
    let result: { size: number; written: string } | { error: string };
    try {
      const size = await streamUploadToFile(body, target, max);
      result = { size, written: fs.readFileSync(target).toString("base64") };
    } catch (error) {
      result = { error: (error as Error).message };
    }
    out.push({ chunks, max, result });
  }
  return out;
}

const base = path.resolve("_trash-rust/tmp/http-goldens-ts");
fs.rmSync(base, { recursive: true, force: true });
fs.mkdirSync(base, { recursive: true });
const out = [];
for (const spec of cases()) out.push(await run(spec, base));
const goldens = {
  cases: out,
  command_allowed: commandCases(base),
  studio_actor: studioActorCases(base),
  client_identity: clientIdentityCases(base),
  stream_upload: await streamUploadCases(base),
};
const target = path.resolve("parity/http/goldens.json");
fs.mkdirSync(path.dirname(target), { recursive: true });
fs.writeFileSync(target, `${JSON.stringify(goldens, null, 1)}\n`);
console.error(`${out.length} cases, ${out.reduce((sum, item) => sum + item.results.length, 0)} responses -> ${target}`);
