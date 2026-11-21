import { mock } from "bun:test";
import * as nodeCrypto from "node:crypto";
import fs from "node:fs";
import type { UnsafeBackendDb } from "../../apps/backend/src/db/client.js";
import type { BackendConfig } from "../../apps/backend/src/foundation/config.js";
import { dump, resolve } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust channels equivalence test
 * (crates/channels/tests/channels_scenarios.rs): token renewal and refresh,
 * OAuth links, exchanges and callback routes, API keys, Zernio connections,
 * stored-credential application and the observability probes, each driven on
 * a fresh in-memory database under a fixed clock against a recording
 * `fetch` that answers canned responses.
 *
 *   bun scripts/rust/channels-goldens.ts crates/channels/tests/channels_scenarios.json
 *
 * Per step it records the result, the requests sent and the credential
 * settings of the live config; per scenario every table but `ignoredTables`,
 * and `platform_tokens` with its sealed values opened (their IVs are random).
 * `randomBytes` is scripted — every draw but the 12-byte IV fills its buffer
 * with a counter that restarts per scenario — so signed states and PKCE
 * challenges compare bit for bit; a sealed `state=` in a URL is shown opened.
 *
 * A step is {"clock": "<ISO>"} | {"sql": "<statement>"} |
 * {"call": "<name>", "args": [...], "responses"?: [<canned>], "bind"?: "<name>"},
 * a canned response {"status", "headers"?, "body"? | "json"?} | {"throws": "<message>"}.
 * `route` runs the real Hono app: `["<path>", {<query>}, <sends the command token>]`.
 */

type Canned = { status: number; headers?: [string, string][]; body?: string; json?: unknown } | { throws: string };
type Step = { clock?: string; sql?: string; call?: string; args?: unknown[]; responses?: Canned[]; bind?: string };
type Scenario = { name: string; config?: Record<string, string>; steps: Step[] };
type Spec = { clock: string; config: Record<string, string>; ignoredTables: string[]; setup: string[]; scenarios: Scenario[] };
type Args = unknown[];

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: channels-goldens.ts <channels_scenarios.json>");
  process.exit(2);
}
const spec = JSON.parse(fs.readFileSync(specPath, "utf8")) as Spec;

// ---- determinism ----------------------------------------------------------

// Captured before the mock: the module namespace follows it.
const realCrypto = { ...nodeCrypto };
let draws = 0;
mock.module("node:crypto", () => ({
  ...realCrypto,
  default: realCrypto,
  randomBytes: (size: number) => {
    if (size === 12) return realCrypto.randomBytes(size);
    draws += 1;
    return Buffer.alloc(size, draws & 0xff);
  },
}));
const BOOT_ID = "00000000-0000-4000-8000-000000000001";
(globalThis.crypto as { randomUUID: () => string }).randomUUID = () => BOOT_ID;
(process as { uptime: () => number }).uptime = () => 0;
let rss = 1024 * 1024;
const realMemoryUsage = process.memoryUsage.bind(process);
(process as { memoryUsage: () => NodeJS.MemoryUsage }).memoryUsage = () => ({ ...realMemoryUsage(), rss });

let nowMs = Date.parse(spec.clock);
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

// Logs go to stderr: stdout carries the result.
console.log = console.error;
console.info = console.error;
console.warn = console.error;

// ---- recording fetch ------------------------------------------------------

let responses: Canned[] = [];
let requests: Record<string, unknown>[] = [];
const recordingFetch = (async (input: string | Request, init: RequestInit = {}) => {
  const request = new Request(input, init);
  const headers = [...request.headers].sort((left, right) => (left[0] < right[0] ? -1 : left[0] > right[0] ? 1 : 0));
  requests.push({ method: request.method, url: request.url, headers, body: await request.text() });
  const next = responses.shift();
  if (!next) throw new TypeError("no canned response left");
  if ("throws" in next) throw new TypeError(next.throws);
  const body = next.json === undefined ? (next.body ?? "") : JSON.stringify(next.json);
  return new Response(body, { status: next.status, headers: next.headers ?? [] });
}) as typeof fetch;
globalThis.fetch = recordingFetch;

// ---- the modules, imported after the mocks --------------------------------

const { openBackendDb, unsafeDb } = await import("../../apps/backend/src/db/client.js");
const { loadConfig, withStudioProfile } = await import("../../apps/backend/src/foundation/config.js");
const { encryptionKey, fingerprint, open, seal } = await import("../../apps/backend/src/foundation/secret-box.js");
const { storePlatformToken } = await import("../../apps/backend/src/channels/platform-token-store.js");
const { applyStoredCredentials } = await import("../../apps/backend/src/runtime/config.js");
const metaOauth = await import("../../apps/backend/src/channels/meta-oauth.js");
const metaTokens = await import("../../apps/backend/src/channels/meta-tokens.js");
const xOauth = await import("../../apps/backend/src/channels/x-oauth.js");
const youtubeOauth = await import("../../apps/backend/src/channels/youtube-oauth.js");
const youtubeTokens = await import("../../apps/backend/src/channels/youtube-tokens.js");
const apiKeys = await import("../../apps/backend/src/channels/api-keys.js");
const { startConnect } = await import("../../apps/backend/src/channels/connect.js");
const registry = await import("../../apps/backend/src/channels/registry.js");
const destinations = await import("../../apps/backend/src/channels/destinations.js");
const { createApiHandler } = await import("../../apps/backend/src/api.js");
const { createStudioServices } = await import("../../apps/backend/src/studio/services/index.js");
const { checkTokenHealth } = await import("../../apps/backend/src/observability/token-health.js");
const { updateCredentialChecks } = await import("../../apps/backend/src/observability/credentials.js");
const { recordPublicationFailures } = await import("../../apps/backend/src/observability/failures.js");
const { recordMemoryPressure, recordProcessRestart } = await import("../../apps/backend/src/observability/runtime-health.js");
const { dateIntegrity } = await import("../../apps/backend/src/observability/date-integrity.js");
const { repairStoredDates } = await import("../../apps/backend/src/observability/date-repair.js");
const { runObservabilityCycle } = await import("../../apps/backend/src/observability/cycle.js");

const CREDENTIALS = [
  "THREADS_RU_ACCESS_TOKEN",
  "THREADS_EN_ACCESS_TOKEN",
  "INSTAGRAM_RU_ACCESS_TOKEN",
  "INSTAGRAM_EN_ACCESS_TOKEN",
  "INSTAGRAM_RU_USER_ID",
  "INSTAGRAM_EN_USER_ID",
  "X_ACCESS_TOKEN",
  "X_REFRESH_TOKEN",
  "ZERNIO_API_KEY",
  "DISCORD_BOT_TOKEN",
  "YOUTUBE_RU_REFRESH_TOKEN",
  "YOUTUBE_EN_REFRESH_TOKEN",
] as const;

function credentials(config: BackendConfig): Record<string, string | null> {
  const values = config as unknown as Record<string, string | undefined>;
  return Object.fromEntries(CREDENTIALS.map((name) => [name, values[name] ?? null]));
}

/** A sealed value, alone or as a URL's `state=`, shown as what it opens to;
 * anything else as it is. */
function normalize(value: unknown, key: Buffer | null): unknown {
  if (typeof value === "string" && key && SEALED.test(value))
    try {
      return `SEALED(${open(value, key)})`;
    } catch {
      return value;
    }
  if (typeof value === "string")
    return value.replace(/([?&]state=)([^&]*)/g, (whole, prefix: string, raw: string) => {
      if (!key) return whole;
      try {
        return `${prefix}SEALED(${open(decodeURIComponent(raw.replaceAll("+", " ")), key)})`;
      } catch {
        return whole;
      }
    });
  if (Array.isArray(value)) return value.map((item) => normalize(item, key));
  if (value && typeof value === "object")
    return Object.fromEntries(Object.entries(value).map(([name, item]) => [name, normalize(item, key)]));
  return value;
}

const SEALED = /^[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}\.[A-Za-z0-9+/]+={0,2}$/;

type TokenSeed = {
  token: string;
  refreshToken?: string;
  seed?: string;
  seedFingerprint?: string;
  accountId?: string;
  expiresAt?: string;
  refreshedAt: string;
  uploadLimitBytes?: number;
};

async function route(
  handler: (request: Request) => Promise<Response>,
  config: BackendConfig,
  path: string,
  query: Record<string, string>,
  commandToken: boolean,
): Promise<unknown> {
  const headers: Record<string, string> = commandToken ? { "X-Command-Token": config.commandCenterToken ?? "" } : {};
  const search = new URLSearchParams(query).toString();
  const response = await handler(new Request(`http://studio.test${path}${search ? `?${search}` : ""}`, { headers }));
  const wanted = ["cache-control", "content-type", "location", "x-robots-tag"];
  return {
    status: response.status,
    headers: [...response.headers].filter(([name]) => wanted.includes(name)).sort(),
    body: response.status === 302 ? null : await response.text(),
  };
}

async function call(backendDb: UnsafeBackendDb, config: BackendConfig, key: Buffer | null, name: string, args: Args): Promise<unknown> {
  const text = (index: number) => args[index] as string;
  const studio = createStudioServices(backendDb, config);
  switch (name) {
    case "tokens.seed": {
      const seed = args[1] as TokenSeed;
      if (!key) throw new Error("tokens.seed needs TOKEN_ENCRYPTION_KEY");
      return storePlatformToken(backendDb, text(0), {
        sealedToken: seal(seed.token, key),
        seedFingerprint: seed.seed !== undefined ? fingerprint(seed.seed) : (seed.seedFingerprint ?? null),
        accountId: seed.accountId ?? null,
        sealedRefreshToken: seed.refreshToken === undefined ? null : seal(seed.refreshToken, key),
        expiresAt: seed.expiresAt ?? null,
        refreshedAt: seed.refreshedAt,
        uploadLimitBytes: seed.uploadLimitBytes ?? null,
        updatedAt: seed.refreshedAt,
      });
    }
    case "credentials.apply":
      return applyStoredCredentials(config, backendDb);
    case "meta.renew":
      return metaTokens.renewMetaTokens(config, backendDb, recordingFetch);
    case "meta.install":
      return metaTokens.installMetaToken(config, backendDb, text(0) as "threads_ru", text(1), text(2));
    case "meta.connectUrl":
      return metaOauth.metaOauthConnectUrl(config, text(0) as "threads", text(1) as "ru");
    case "meta.connectPath":
      return metaOauth.metaOauthConnectPath(config, text(0) as "threads", text(1) as "ru");
    case "meta.authorizeUrl":
      return metaOauth.metaOauthAuthorizeUrl(config, text(0));
    case "meta.authorize":
      return metaOauth.metaAuthorizeUrl(config, text(0) as "threads", args[1] as string | undefined);
    case "meta.verify":
      return metaOauth.verifyMetaOauthState(config, text(0));
    case "meta.exchange":
      return metaOauth.exchangeMetaCode(config, text(0) as "threads", text(1), recordingFetch);
    case "x.connectUrl":
      return xOauth.xOauthConnectUrl(config);
    case "x.connectPath":
      return xOauth.xOauthConnectPath(config);
    case "x.authorizeUrl":
      return xOauth.xOauthAuthorizeUrl(config);
    case "x.exchange":
      return xOauth.exchangeXCode(config, backendDb, text(0), text(1), recordingFetch);
    case "x.refresh":
      return xOauth.refreshXToken(config, backendDb, recordingFetch);
    case "youtube.authorizeUrl":
      return youtubeOauth.youtubeOauthAuthorizeUrl(config, text(0) as "ru");
    case "youtube.exchange":
      return youtubeOauth.exchangeYouTubeCode(config, backendDb, text(0), text(1), recordingFetch);
    case "youtube.install":
      return youtubeTokens.installYouTubeToken(config, backendDb, text(0) as "ru", text(1));
    case "apiKeys.store":
      return apiKeys.storeApiKey(config, backendDb, text(0) as "zernio", text(1), recordingFetch);
    case "connect.start":
      return startConnect(config, text(0) as "x", text(1) as "ru");
    case "route":
      return route(
        createApiHandler({ config, backendDb, studio }),
        config,
        text(0),
        (args[1] ?? {}) as Record<string, string>,
        Boolean(args[2]),
      );
    case "util.stateOf":
      return { state: new URL(text(0)).searchParams.get("state") };
    case "util.tamper": {
      // The signature's first character changed: same length, wrong value.
      const [encoded, signature = ""] = text(0).split(".");
      return { value: `${encoded}.${signature.startsWith("A") ? "B" : "A"}${signature.slice(1)}` };
    }
    case "channels.connect":
      return studio.channels.connect(args[0] as Parameters<typeof studio.channels.connect>[0]);
    case "zernio.discover":
      return studio.channels.discoverZernioConnections(text(0) as "ru");
    case "zernio.connect":
      return studio.channels.connectZernio(text(0), text(1) as "ru", text(2) as "threads");
    case "registry.routing":
      return registry.targetRouting(backendDb);
    case "registry.videoDestinations":
      return destinations.videoDestinations(backendDb);
    case "registry.videoIdentity":
      return destinations.videoChannelIdentity(backendDb, text(0) as "youtube_shorts", text(1) as "ru");
    case "tokenHealth.check":
      return checkTokenHealth(config, backendDb, recordingFetch);
    case "credentialChecks.update":
      return updateCredentialChecks(config, backendDb);
    case "failures.record":
      return recordPublicationFailures(backendDb);
    case "runtime.restart":
      return recordProcessRestart(backendDb, args[0] as string | null);
    case "runtime.memory":
      rss = args[0] as number;
      return recordMemoryPressure(backendDb, args[1] as number | null);
    case "dates.integrity":
      return dateIntegrity(backendDb);
    case "dates.repair":
      return repairStoredDates(backendDb, Boolean(args[0]));
    case "observability.cycle":
      rss = 1024 * 1024;
      return runObservabilityCycle(config, backendDb);
    default:
      throw new Error(`unknown call ${name}`);
  }
}

/** `platform_tokens` with the sealed values opened. */
function tokens(backendDb: UnsafeBackendDb, key: Buffer | null): unknown[] {
  type Row = Record<string, string | number | null>;
  const rows = unsafeDb(backendDb).sqlite.query("SELECT * FROM platform_tokens ORDER BY rowid").all() as Row[];
  const opened = (sealed: string | number | null | undefined) => {
    if (sealed === null || sealed === undefined || !key) return sealed;
    try {
      return open(String(sealed), key);
    } catch {
      return `unopenable:${sealed}`;
    }
  };
  return rows.map((row) => ({ ...row, sealed_token: opened(row.sealed_token), sealed_refresh_token: opened(row.sealed_refresh_token) }));
}

async function run(scenario: Scenario) {
  nowMs = Date.parse(spec.clock);
  draws = 0;
  const backendDb = openBackendDb(":memory:") as UnsafeBackendDb;
  const { sqlite } = unsafeDb(backendDb);
  const config = withStudioProfile(loadConfig({ ...spec.config, ...scenario.config }), backendDb);
  const key = (() => {
    try {
      return encryptionKey(config.TOKEN_ENCRYPTION_KEY);
    } catch {
      return null;
    }
  })();
  const vars: Record<string, unknown> = {};
  const results: unknown[] = [];
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) nowMs = Date.parse(step.clock);
      else if (step.sql !== undefined) sqlite.run(step.sql);
      else if (step.call !== undefined) {
        responses = [...(step.responses ?? [])];
        requests = [];
        let result: unknown;
        try {
          const value = await call(backendDb, config, key, step.call, resolve(step.args ?? [], vars) as Args);
          // A plain value is bound as `{value}`, so `{"$": "<name>.value"}` names it.
          if (step.bind) vars[step.bind] = value !== null && typeof value === "object" ? value : { value };
          result = value === undefined ? null : value;
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        results.push(normalize({ call: step.call, result, requests, unanswered: responses.length, config: credentials(config) }, key));
      } else throw new Error(`step without clock, sql or call in ${scenario.name}`);
    }
    return JSON.parse(
      JSON.stringify({
        name: scenario.name,
        results,
        tables: dump(sqlite, [...spec.ignoredTables, "platform_tokens"]),
        tokens: tokens(backendDb, key),
      }),
    ) as unknown;
  } finally {
    backendDb.close();
  }
}

const scenarios = [];
for (const scenario of spec.scenarios) scenarios.push(await run(scenario));
process.stdout.write(`${JSON.stringify({ scenarios })}\n`);
