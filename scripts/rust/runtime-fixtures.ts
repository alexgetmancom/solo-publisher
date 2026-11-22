import { setSystemTime } from "bun:test";
import { chmodSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import path from "node:path";
import { openBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import type { JsonValue } from "../../apps/backend/src/db/schema.js";
import { type BackendConfig, loadConfig } from "../../apps/backend/src/foundation/config.js";
import { deepSeekChat } from "../../apps/backend/src/foundation/external/deepseek.js";
import { materializeTelegramFile } from "../../apps/backend/src/foundation/external/telegram-files.js";
import { youtubeAccessToken } from "../../apps/backend/src/foundation/external/youtube.js";
import { listZernioAccounts, zernioAccount } from "../../apps/backend/src/foundation/external/zernio.js";
import {
  ExternalHttpError,
  ExternalTransportError,
  externalFetch,
  formBody,
  requestJson,
  retryAfterSecondsFromHeaders,
} from "../../apps/backend/src/foundation/http.js";
import { formatFfmpegFailure, probeMediaMetadata } from "../../apps/backend/src/foundation/runtime/ffmpeg.js";
import {
  expectedWorkerNames,
  heartbeatLoop,
  recordWorkerState,
  workerLiveness,
} from "../../apps/backend/src/foundation/runtime/worker-state.js";
import { startLoop } from "../../apps/backend/src/foundation/scheduler.js";

/**
 * Reference behaviour of the TypeScript runtime foundation (`foundation/http.ts`,
 * `foundation/runtime/*`, `foundation/scheduler.ts`, `foundation/external/*`),
 * recorded for the Rust `runtime` crate's parity tests under
 * crates/runtime/tests/fixtures/runtime.json. HTTP goes through a recording
 * `fetchImpl` that answers canned responses; ffprobe's JSON mapping runs
 * against a fake ffprobe placed first on PATH in a child of this script.
 *
 *   bun scripts/rust/runtime-fixtures.ts
 */
const root = path.join(import.meta.dir, "../..");
const fixtures = path.join(root, "crates/runtime/tests/fixtures");
const scratch = path.join(root, "_trash-rust/tmp/runtime-fixtures");

// ---- fake ffprobe child --------------------------------------------------

if (process.argv[2] === "--probe") {
  const outcome = await probeMediaMetadata("/fixture/clip.mp4").then(
    (ok) => ({ ok }),
    (error: Error) => ({ error: error.message }),
  );
  console.log(JSON.stringify(outcome));
  process.exit(0);
}

const NOW_MS = Date.parse("2026-11-21T10:00:00.000Z");
setSystemTime(new Date(NOW_MS));

const json = (value: unknown) => JSON.stringify(value, (_key, item) => (item === undefined ? null : item));

function errorShape(error: unknown): Record<string, unknown> {
  if (error instanceof ExternalHttpError)
    return { kind: "http", message: error.message, status: error.status, body: error.body, retryAfterSeconds: error.retryAfterSeconds };
  if (error instanceof ExternalTransportError) return { kind: "transport", message: error.message };
  return { kind: "message", message: error instanceof Error ? error.message : String(error) };
}

async function outcome(run: () => Promise<unknown>): Promise<Record<string, unknown>> {
  try {
    return { ok: await run() };
  } catch (error) {
    return { error: errorShape(error) };
  }
}

type Canned = { status: number; headers?: [string, string][]; body?: string } | { throws: string } | { hang: true };

/** A `fetchImpl` that records each request as `fetch` would send it and
 * answers the next canned response. */
function recorder(responses: Canned[]) {
  const requests: Record<string, unknown>[] = [];
  const fetchImpl = (async (input: string, init: RequestInit = {}) => {
    const request = new Request(input, init);
    requests.push({
      method: request.method,
      url: request.url,
      headers: [...request.headers],
      body: await request.text(),
    });
    const next = responses.shift();
    if (!next) throw new Error("no canned response left");
    if ("throws" in next) throw new TypeError(next.throws);
    if ("hang" in next)
      return new Promise<Response>((_, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    return new Response(next.body ?? "", { status: next.status, headers: next.headers ?? [] });
  }) as typeof fetch;
  return { requests, fetchImpl };
}

// ---- http ----------------------------------------------------------------

const retryAfterCases: [string, string][][] = [
  [["retry-after", "120"]],
  [["retry-after", "1.5"]],
  [["retry-after", "-5"]],
  [["retry-after", " "]],
  [["retry-after", ""]],
  [["retry-after", "0x10"]],
  [["retry-after", "Sat, 21 Nov 2026 10:02:00 GMT"]],
  [["retry-after", "Sat, 21 Nov 2026 09:58:00 GMT"]],
  [["retry-after", "Sat, 21 Nov 2026 10:00:00 GMT"]],
  [["retry-after", "2026-11-21T10:05:30Z"]],
  [["retry-after", "2026-11-21T10:05:30.600Z"]],
  [["retry-after", "soon"]],
  [
    ["retry-after", "soon"],
    ["x-ratelimit-reset", String(NOW_MS / 1000 + 42)],
  ],
  [["x-ratelimit-reset", String(NOW_MS / 1000 + 42.4)]],
  [["x-ratelimit-reset", String(NOW_MS / 1000 + 42.5)]],
  [["x-ratelimit-reset", String(NOW_MS / 1000 - 42)]],
  [["x-ratelimit-reset", "0"]],
  [["x-ratelimit-reset", "abc"]],
  [["x-ratelimit-reset", ""]],
  [],
  [["Retry-After", "7"]],
];
const retryAfter = retryAfterCases.map((headers) => ({
  headers,
  nowMs: NOW_MS,
  seconds: retryAfterSecondsFromHeaders(new Headers(headers)),
}));

type JsonCase = { request: { method?: string; url: string; headers?: Record<string, string>; body?: string }; responses: Canned[] };
const requestJsonCases: JsonCase[] = [
  { request: { url: "https://api.example.com/v1/items?id=1" }, responses: [{ status: 200, body: '{"a":1,"b":[true,null],"c":"é"}' }] },
  { request: { url: "https://api.example.com/v1/empty", method: "POST", body: "x=1" }, responses: [{ status: 204 }] },
  { request: { url: "https://api.example.com/v1/array" }, responses: [{ status: 200, body: "[1,2]" }] },
  {
    request: { url: "https://api.example.com/v1/html?access_token=fixture-secret&page=2" },
    responses: [{ status: 200, body: "<html>bad gateway token=fixture-secret Bearer abc.def</html>" }],
  },
  {
    request: { url: "https://api.telegram.org/bot123456789:fixture-token_x/sendMessage", method: "POST" },
    responses: [{ status: 429, headers: [["retry-after", "17"]], body: '{"ok":false,"description":"Too Many Requests"}' }],
  },
  {
    request: { url: "https://graph.threads.net/v1.0/me?fields=id&access_token=fixture-secret&token=two&token=three" },
    responses: [{ status: 401, body: '{"error":{"message":"Invalid OAuth access token: fixture-secret"}}' }],
  },
  {
    request: { url: "https://api.example.com/v1/x?api_key=k%20v&q=a+b&api-key=z&password=p" },
    responses: [{ status: 503, headers: [["retry-after", "30"]], body: "" }],
  },
  { request: { url: "https://api.example.com/v1/long" }, responses: [{ status: 200, body: `<p>${"й".repeat(300)}</p>` }] },
  { request: { url: "https://api.example.com/v1/bom" }, responses: [{ status: 200, body: '﻿{"bom":true}' }] },
  { request: { url: "https://api.example.com/v1/bad\nurl token=raw-secret" }, responses: [{ throws: "Failed to parse URL" }] },
  {
    request: { url: "https://api.telegram.org/bot123456789:fixture-token_x/getMe", method: "POST" },
    responses: [{ throws: "Unable to connect" }],
  },
  {
    request: {
      url: "https://api.example.com/v1/create",
      method: "PUT",
      headers: { Authorization: "Bearer fixture", "Content-Type": "application/json" },
      body: '{"x":1}',
    },
    responses: [{ status: 500, body: "Internal error for Bearer fixture-abc.123" }],
  },
  { request: { url: "https://api.example.com/v1/text", method: "POST", body: "plain body" }, responses: [{ status: 200, body: "{}" }] },
];
const requestJsonResults = [];
for (const { request, responses } of requestJsonCases) {
  const { requests, fetchImpl } = recorder([...responses]);
  const { url, ...init } = request;
  const result = await outcome(() => requestJson(fetchImpl, url, init));
  requestJsonResults.push({ request, responses, sent: requests, result });
}
{
  const { requests, fetchImpl } = recorder([{ hang: true }]);
  const result = await outcome(() => externalFetch(fetchImpl, "https://api.example.com/v1/slow?token=fixture", { method: "POST" }, 5));
  requestJsonResults.push({
    request: { url: "https://api.example.com/v1/slow?token=fixture", method: "POST" },
    responses: [{ hang: true }],
    ceilingMs: 5,
    sent: requests,
    result,
  });
}

const formCases: [string, string | null][][] = [
  [
    ["client_id", "id.apps.example"],
    ["client_secret", null],
    ["refresh_token", "1//a+b/c=d&e"],
    ["grant_type", "refresh_token"],
  ],
  [
    ["text", "Привет, мир! *-._~'()"],
    ["empty", ""],
  ],
  [],
];
const forms = formCases.map((fields) => ({ fields, body: formBody(Object.fromEntries(fields)).toString() }));

// ---- ffmpeg / ffprobe ----------------------------------------------------

const progress = Array.from(
  { length: 40 },
  (_, index) => `frame=  ${index * 10} fps= 25 q=28.0 size=  ${index}kB time=00:00:0${index % 10}.00`,
).join("\r");
const ffmpegFailureCases: [number, string][] = [
  [1, ""],
  [1, "   \n\r\n  "],
  [137, "frame=  10 fps=1\nKilled"],
  [1, `${progress}\r[libx264 @ 0x1] error\nline a\nline b\nline c\nline d\nline e\nline f\nline g\n`],
  [234, "  Error opening input files: No such file or directory  \n"],
  [1, `${"Слишком длинная строка ".repeat(80)}`],
  [-1, "frame=1 fps=2 x\nframe=   7   fps=0.0 q=0.0\nframe=x fps=1\n\tframe=  3 fps=1"],
];
const ffmpegFailures = ffmpegFailureCases.map(([code, stderr]) => ({ code, stderr, message: formatFfmpegFailure(code, stderr) }));

const fakeBin = path.join(scratch, "fakebin");
mkdirSync(fakeBin, { recursive: true });
writeFileSync(
  path.join(fakeBin, "ffprobe"),
  '#!/bin/sh\ncat "$FAKE_PROBE_STDOUT"\ncat "$FAKE_PROBE_STDERR" >&2\nexit "$FAKE_PROBE_EXIT"\n',
);
chmodSync(path.join(fakeBin, "ffprobe"), 0o755);

const stream = (fields: Record<string, unknown>) => fields;
const probeCases: { stdout: string; stderr: string; exit: number }[] = [
  {
    stdout: JSON.stringify({
      streams: [
        stream({ codec_name: "h264", codec_type: "video", width: 1080, height: 1920, avg_frame_rate: "30000/1001", duration: "12.5" }),
        stream({ codec_name: "aac", codec_type: "audio", bit_rate: "128000" }),
      ],
      format: { duration: "12.533333" },
    }),
    stderr: "",
    exit: 0,
  },
  {
    stdout: JSON.stringify({ streams: [stream({ codec_type: "video", width: 640, height: 360, avg_frame_rate: "0/0", duration: "3.2" })] }),
    stderr: "",
    exit: 0,
  },
  {
    stdout: JSON.stringify({
      streams: [
        stream({ codec_type: "audio", codec_name: "opus", bit_rate: "N/A" }),
        stream({ codec_type: "video", codec_name: "vp9", width: 720, height: 1280, avg_frame_rate: "25" }),
      ],
      format: { duration: "-4" },
    }),
    stderr: "",
    exit: 0,
  },
  {
    stdout: JSON.stringify({ streams: [stream({ codec_type: "video", codec_name: "png", width: 0, height: 10 })], format: {} }),
    stderr: "",
    exit: 0,
  },
  { stdout: JSON.stringify({ streams: [stream({ codec_type: "audio", codec_name: "mp3", bit_rate: "320000" })] }), stderr: "", exit: 0 },
  { stdout: "", stderr: "", exit: 0 },
  { stdout: "{not json", stderr: "", exit: 0 },
  { stdout: "", stderr: "/fixture/clip.mp4: Invalid data found when processing input\n", exit: 1 },
  { stdout: "", stderr: "   ", exit: 1 },
  { stdout: "", stderr: `${"ж".repeat(900)}tail`, exit: 2 },
  {
    stdout: JSON.stringify({
      streams: [
        stream({ codec_type: "video", codec_name: "hevc", width: "1920", height: 1080, avg_frame_rate: "60/1/2" }),
        stream({ codec_type: "audio", bit_rate: "0" }),
      ],
      format: { duration: null },
    }),
    stderr: "",
    exit: 0,
  },
];
const probes = [];
for (const [index, probe] of probeCases.entries()) {
  const stdoutFile = path.join(scratch, `probe-${index}.stdout`);
  const stderrFile = path.join(scratch, `probe-${index}.stderr`);
  writeFileSync(stdoutFile, probe.stdout);
  writeFileSync(stderrFile, probe.stderr);
  const child = Bun.spawnSync([process.execPath, import.meta.path, "--probe"], {
    env: {
      ...process.env,
      PATH: `${fakeBin}:${process.env.PATH}`,
      FAKE_PROBE_STDOUT: stdoutFile,
      FAKE_PROBE_STDERR: stderrFile,
      FAKE_PROBE_EXIT: String(probe.exit),
    },
    stdout: "pipe",
    stderr: "inherit",
  });
  if (child.exitCode !== 0) throw new Error(`probe child ${index} failed`);
  probes.push({ ...probe, result: JSON.parse(new TextDecoder().decode(child.stdout)) });
}

// A real clip, probed by the ffprobe on PATH. It is committed rather than
// encoded here: the AAC bitrate ffprobe reports is the encoder's, and it moved
// from 97167 to 97550 between ffmpeg 7.0.2 and 6.1.1.
const realProbe = { metadata: await probeMediaMetadata(path.join(fixtures, "real-probe.mp4")) };

// ---- worker state --------------------------------------------------------

const backendDb = openBackendDb(":memory:");
const sqlite = unsafeDb(backendDb).sqlite;
const rows = () => sqlite.query("SELECT name, state_json, updated_at FROM worker_state ORDER BY name").all();
const hooks = new Map<string, { onStart: () => void; onHeartbeat: () => void; onFinish: (error: unknown) => void }>();
const startWorkerLoop = heartbeatLoop(backendDb, (name, _interval, _task, loopHooks) => {
  hooks.set(name, loopHooks);
  return name;
});
type WorkerStep =
  | { op: "state"; name: string; state: Record<string, JsonValue>; error: string | null; at: string }
  | { op: "start" | "heartbeat"; name: string; at: string }
  | { op: "finish"; name: string; error: string | null; at: string };
const workerSteps: WorkerStep[] = [
  { op: "start", name: "queue", at: "2026-11-21T10:00:00.000Z" },
  { op: "heartbeat", name: "queue", at: "2026-11-21T10:01:00.000Z" },
  {
    op: "state",
    name: "queue",
    state: { processed: 3, ok: "kept-position", note: 'é   "q"' },
    error: null,
    at: "2026-11-21T10:01:30.000Z",
  },
  { op: "start", name: "queue", at: "2026-11-21T10:02:00.000Z" },
  { op: "heartbeat", name: "queue", at: "2026-11-21T10:03:00.000Z" },
  { op: "finish", name: "queue", error: "database is locked", at: "2026-11-21T10:03:10.000Z" },
  { op: "start", name: "queue", at: "2026-11-21T10:03:15.000Z" },
  { op: "finish", name: "queue", error: null, at: "2026-11-21T10:03:20.000Z" },
  { op: "state", name: "video", state: {}, error: "ffprobe failed", at: "2026-11-21T10:04:00.000Z" },
  { op: "heartbeat", name: "video", at: "2026-11-21T10:05:00.000Z" },
  { op: "heartbeat", name: "site", at: "2026-11-21T10:06:00.000Z" },
];
const workerState = [];
for (const step of workerSteps) {
  setSystemTime(new Date(step.at));
  if (!hooks.has(step.name)) startWorkerLoop(step.name, 5_000, () => {});
  const loop = hooks.get(step.name);
  if (step.op === "state") recordWorkerState(backendDb, step.name, step.state, step.error);
  else if (step.op === "start") loop?.onStart();
  else if (step.op === "heartbeat") loop?.onHeartbeat();
  else if (step.op === "finish") loop?.onFinish(step.error == null ? null : new Error(step.error));
  workerState.push({ step, rows: rows() });
}
setSystemTime(new Date(NOW_MS));

const livenessCases: { state: Record<string, unknown>; updatedAt: string }[] = [
  { state: { last_heartbeat_at: "2026-11-21T09:59:00.000Z", heartbeat_interval_ms: 60_000 }, updatedAt: "2026-11-21T09:00:00.000Z" },
  { state: { last_heartbeat_at: "2026-11-21T09:56:59.000Z", heartbeat_interval_ms: 60_000 }, updatedAt: "2026-11-21T09:00:00.000Z" },
  { state: { last_heartbeat_at: "2026-11-21T09:56:59.400Z", heartbeat_interval_ms: 10_000 }, updatedAt: "2026-11-21T09:00:00.000Z" },
  { state: { heartbeat_interval_ms: 100_000 }, updatedAt: "2026-11-21T09:55:00.000Z" },
  { state: {}, updatedAt: "2026-11-21T08:00:00.000Z" },
  { state: { last_heartbeat_at: "2026-11-21T10:00:30.000Z", heartbeat_interval_ms: 1 }, updatedAt: "2026-11-21T09:00:00.000Z" },
  { state: { last_heartbeat_at: 5, heartbeat_interval_ms: "60000" }, updatedAt: "2026-11-21T09:58:00.000Z" },
];
const liveness = livenessCases.map((item) => ({ ...item, nowMs: NOW_MS, result: workerLiveness(item.state, item.updatedAt) }));

// ---- scheduler -----------------------------------------------------------

type Action = "wake" | "release-ok" | "release-error" | "stop";
const actions: Action[] = [
  "wake",
  "wake",
  "release-ok",
  "release-error",
  "wake",
  "wake",
  "release-ok",
  "release-ok",
  "wake",
  "stop",
  "release-ok",
  "wake",
];
const trace: string[] = [];
const pending: { resolve: () => void; reject: (error: Error) => void }[] = [];
let taskNumber = 0;
const loop = startLoop(
  "demo",
  1_000_000_000,
  () => {
    taskNumber += 1;
    trace.push(`task ${taskNumber}`);
    return new Promise<void>((resolve, reject) => pending.push({ resolve, reject }));
  },
  {
    onStart: () => trace.push("start"),
    onFinish: (error) => trace.push(`finish ${error instanceof Error ? error.message : "ok"}`),
  },
);
const settle = async () => {
  for (let turn = 0; turn < 5; turn += 1) await Bun.sleep(0);
};
await settle();
const scheduler = [{ action: "begin", trace: trace.splice(0) }];
let stopping: Promise<void> | null = null;
for (const action of actions) {
  if (action === "wake") loop.wake();
  else if (action === "stop") stopping = loop.stop().then(() => void trace.push("stopped"));
  else {
    const next = pending.shift();
    if (action === "release-ok") next?.resolve();
    else next?.reject(new Error("boom"));
  }
  await settle();
  scheduler.push({ action, trace: trace.splice(0) });
}
await stopping;

// ---- external helpers ----------------------------------------------------

const env = {
  DATA_DIR: path.join(scratch, "data"),
  DEEPSEEK_API_KEY: "fixture-deepseek-key",
  YOUTUBE_RU_CLIENT_ID: "ru-client.apps.example",
  YOUTUBE_RU_CLIENT_SECRET: "ru-secret",
  YOUTUBE_RU_REFRESH_TOKEN: "1//ru-refresh",
  YOUTUBE_EN_CLIENT_ID: "en-client.apps.example",
  YOUTUBE_EN_CLIENT_SECRET: "en-secret",
  YOUTUBE_EN_REFRESH_TOKEN: "1//en-refresh",
  CONTROLLER_BOT_TOKEN: "123456789:fixture-controller",
  TELEGRAM_API_BASE_URL: "https://bot-api.example/",
};
const configFor = (extra: Record<string, string> = {}) => ({ ...loadConfig(env), ...extra }) as BackendConfig;
const downloads = path.join(scratch, "downloads");
rmSync(downloads, { recursive: true, force: true });
mkdirSync(downloads, { recursive: true });

type ExternalCase = {
  name: string;
  zernioKey?: boolean;
  responses: Canned[];
  run: (config: BackendConfig, fetchImpl: typeof fetch) => Promise<unknown>;
};
const messages = [
  { role: "system" as const, content: "Translate to English." },
  { role: "user" as const, content: "Привет" },
];
const externalCases: ExternalCase[] = [
  {
    name: "deepseek-json",
    responses: [{ status: 200, body: JSON.stringify({ choices: [{ message: { content: '  {"title":"Hi"}\n' } }] }) }],
    run: (config, fetchImpl) => deepSeekChat(config, messages, { temperature: 0.1, timeoutMs: 40_000, json: true }, fetchImpl),
  },
  {
    name: "deepseek-text",
    responses: [{ status: 200, body: JSON.stringify({ choices: [] }) }],
    run: (config, fetchImpl) => deepSeekChat(config, messages, { temperature: 1, timeoutMs: 40_000 }, fetchImpl),
  },
  {
    name: "deepseek-refused",
    responses: [{ status: 402, body: '{"error":{"message":"Insufficient Balance"}}' }],
    run: (config, fetchImpl) => deepSeekChat(config, messages, { temperature: 0, timeoutMs: 40_000 }, fetchImpl),
  },
  {
    name: "youtube-token-ru",
    responses: [{ status: 200, body: '{"access_token":"fixture-access","expires_in":3599}' }],
    run: (config, fetchImpl) => youtubeAccessToken(config, fetchImpl, "ru"),
  },
  {
    name: "youtube-token-en",
    responses: [{ status: 400, body: '{"error":"invalid_grant"}' }],
    run: (config, fetchImpl) => youtubeAccessToken(config, fetchImpl, "en"),
  },
  {
    name: "zernio-accounts-object",
    zernioKey: true,
    responses: [
      {
        status: 200,
        body: JSON.stringify({
          accounts: [{ _id: "a1", username: "alex", displayName: "Alex", platform: "tiktok", followersCount: 12 }, { _id: "a2" }],
        }),
      },
    ],
    run: (config, fetchImpl) => listZernioAccounts(config, fetchImpl),
  },
  {
    name: "zernio-accounts-array",
    zernioKey: true,
    responses: [{ status: 200, body: JSON.stringify([{ _id: "b1", platform: "youtube" }]) }],
    run: (config, fetchImpl) => listZernioAccounts(config, fetchImpl),
  },
  {
    name: "zernio-account-missing",
    zernioKey: true,
    responses: [{ status: 200, body: "{}" }],
    run: (config, fetchImpl) => zernioAccount(config, "nope", fetchImpl),
  },
  { name: "zernio-no-key", responses: [], run: (config, fetchImpl) => listZernioAccounts(config, fetchImpl) },
  {
    name: "telegram-file-by-id",
    responses: [
      { status: 200, body: '{"ok":true,"result":{"file_id":"F1","file_path":"videos/file_7.mp4"}}' },
      { status: 200, body: "video bytes" },
    ],
    run: async (config, fetchImpl) => {
      const placed = await materializeTelegramFile(
        config,
        { fileId: "F1", token: "987654321:fixture-other" },
        { target: path.join(downloads, "by-id.mp4"), fetchImpl },
      );
      return { name: path.basename(placed.path), temporary: placed.temporary, content: readFileSync(placed.path, "utf8") };
    },
  },
  {
    name: "telegram-file-get-file-refused",
    responses: [{ status: 200, body: '{"ok":false}' }],
    run: (config, fetchImpl) =>
      materializeTelegramFile(config, { fileId: "F2" }, { target: path.join(downloads, "refused.mp4"), fetchImpl }),
  },
  {
    name: "telegram-file-download-status",
    responses: [{ status: 404, body: "gone" }],
    run: (config, fetchImpl) =>
      materializeTelegramFile(config, { filePath: "photos/file_1.jpg" }, { target: path.join(downloads, "gone.jpg"), fetchImpl }),
  },
  {
    name: "telegram-file-download-failed",
    responses: [{ throws: "socket closed" }],
    run: (config, fetchImpl) =>
      materializeTelegramFile(config, { filePath: "photos/file_1.jpg" }, { target: path.join(downloads, "lost.jpg"), fetchImpl }),
  },
  {
    name: "telegram-file-absolute",
    responses: [],
    run: (config, fetchImpl) => materializeTelegramFile(config, { filePath: "/var/lib/telegram-bot-api/file.mp4" }, { fetchImpl }),
  },
];
const external = [];
for (const item of externalCases) {
  const { requests, fetchImpl } = recorder([...item.responses]);
  const config = configFor(item.zernioKey ? { ZERNIO_API_KEY: "fixture-zernio-key" } : {});
  const result = await outcome(() => item.run(config, fetchImpl));
  external.push({ name: item.name, responses: item.responses, sent: requests, result });
}

// ---- write ---------------------------------------------------------------

const sections: Record<string, unknown[]> = {
  retry_after: retryAfter,
  request_json: requestJsonResults,
  form_body: forms,
  ffmpeg_failure: ffmpegFailures,
  ffprobe: probes,
  real_probe: [realProbe],
  worker_state: workerState,
  expected_worker_names: [
    { telegram: false, names: expectedWorkerNames(false) },
    { telegram: true, names: expectedWorkerNames(true) },
  ],
  liveness,
  scheduler,
  external,
};
const body = `{\n${Object.entries(sections)
  .map(([key, items]) => `  ${json(key)}: [\n${items.map((item) => `    ${json(item)}`).join(",\n")}\n  ]`)
  .join(",\n")}\n}\n`;
mkdirSync(fixtures, { recursive: true });
const output = path.join(fixtures, "runtime.json");
writeFileSync(output, body);
// The pre-commit hook formats JSON; formatting here keeps a rerun diff-free.
Bun.spawnSync(["bunx", "biome", "format", "--write", output], { cwd: root, stdout: "ignore", stderr: "inherit" });
console.log("wrote runtime.json");
