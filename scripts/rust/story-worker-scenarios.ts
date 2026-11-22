import fs from "node:fs";
import path from "node:path";
import type { DraftMessage } from "../../apps/backend/src/content/message.js";
import { openBackendDb, type UnsafeBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { type BackendConfig, loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { configureLogging } from "../../apps/backend/src/foundation/logger.js";
import { storyCardsForDraft } from "../../apps/backend/src/story-cards/store.js";
import { recoverStoryCardJobs, runStoryCardCycle } from "../../apps/backend/src/story-cards/worker.js";
import { createStudioServices } from "../../apps/backend/src/studio/services/index.js";
import { dump, resolve } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust Story-card worker equivalence test
 * (crates/story_render/tests/worker_scenarios.rs): every scenario runs the
 * real worker (`runStoryCardCycle`, `recoverStoryCardJobs`, the sharp renderer
 * process) and the Studio post services that queue and schedule cards, on a
 * fresh in-memory database under a fixed clock; it prints every step's result,
 * the files left in the Story-card directory and a dump of every non-empty
 * table but the `ignoredTables` the spec names, after the spec's `beforeDump`.
 *
 *   bun scripts/rust/story-worker-scenarios.ts crates/story_render/tests/worker_scenarios.json
 *
 * `{FILES}` names a scratch directory under `_trash-rust/tmp`, emptied before
 * each scenario; `{ASSETS}` the Story-card assets. A step is
 *   {"clock": "<ISO instant>"} | {"sql": "<statement>"}
 *   {"call": "<name>", "args": [...], "bind"?: "<name>"}
 *
 * A cycle's result is its claim count and the worker state it recorded, the
 * error cut at its first ": " — past it are the renderer's own words, sharp's
 * here and resvg's there. `fontconfig.xml`, which only the sharp process
 * reads, is left out of the files.
 */

type Step = { clock?: string; sql?: string; call?: string; args?: unknown[]; bind?: string };
type Scenario = { name: string; config?: Record<string, string>; steps: Step[] };
type Spec = {
  clock: string;
  config: Record<string, string>;
  ignoredTables: string[];
  setup: string[];
  beforeDump: string[];
  scenarios: Scenario[];
};
type Args = unknown[];

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: story-worker-scenarios.ts <worker_scenarios.json>");
  process.exit(2);
}
const files = path.resolve("_trash-rust/tmp/story-worker-scenarios");
const assets = path.resolve("apps/backend/assets/story-card");
const renderer = path.resolve("apps/backend/src/story-cards/renderer-process.ts");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8").replaceAll("{FILES}", files).replaceAll("{ASSETS}", assets)) as Spec;

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
// The worker logs every render's timing; stdout carries the result.
configureLogging("error");

const WORKER_STATE_FIELDS = ["ok", "last_run_at", "last_error", "scheduler_error", "last_heartbeat_at"];

async function call(backendDb: UnsafeBackendDb, config: BackendConfig, name: string, args: Args): Promise<unknown> {
  const { posts } = createStudioServices(backendDb, config);
  const { db, sqlite } = unsafeDb(backendDb);
  const int = (index: number) => args[index] as number;
  switch (name) {
    case "posts.create":
      return posts.create(int(0), args[1] as DraftMessage, (args[2] ?? undefined) as Parameters<typeof posts.create>[2]);
    case "posts.setStoryPublishMode":
      return posts.setStoryPublishMode(int(0), int(1), args[2] as "all" | "site_only");
    case "posts.schedule": {
      const input = args[2] as { ruAt?: string; enAt?: string };
      return posts.schedule(int(0), int(1), {
        ruAt: input.ruAt ? new Date(input.ruAt) : null,
        enAt: input.enAt ? new Date(input.enAt) : null,
      });
    }
    case "storyCards.forDraft":
      return storyCardsForDraft(db, int(0)).map((card) => ({ locale: card.locale, status: card.status, localPath: card.localPath }));
    case "worker.recover":
      return recoverStoryCardJobs(backendDb);
    case "worker.cycle": {
      const claimed = await runStoryCardCycle(config, backendDb);
      const row = sqlite.query("SELECT state_json FROM worker_state WHERE name = 'story-cards'").get() as { state_json: string };
      const state = JSON.parse(row.state_json) as Record<string, unknown>;
      const counters = Object.fromEntries(Object.entries(state).filter(([key]) => !WORKER_STATE_FIELDS.includes(key)));
      const error = state.last_error as string | null;
      return { claimed, state: counters, error: error?.split(": ")[0] ?? null };
    }
    default:
      throw new Error(`unknown call ${name}`);
  }
}

async function run(scenario: Scenario) {
  nowMs = Date.parse(spec.clock);
  const backendDb = openBackendDb(":memory:") as UnsafeBackendDb;
  const { sqlite } = unsafeDb(backendDb);
  const config = withStudioProfile(loadConfig({ ...spec.config, ...scenario.config, STORY_CARD_RENDERER_ENTRY: renderer }), backendDb);
  const vars: Record<string, unknown> = {};
  const results: { call: string; result: unknown }[] = [];
  fs.rmSync(files, { recursive: true, force: true });
  fs.mkdirSync(files, { recursive: true });
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) nowMs = Date.parse(step.clock);
      else if (step.sql !== undefined) sqlite.run(step.sql);
      else if (step.call !== undefined) {
        let result: unknown;
        try {
          const value = await call(backendDb, config, step.call, resolve(step.args ?? [], vars) as Args);
          if (step.bind) vars[step.bind] = value;
          result = value === undefined ? null : value;
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        results.push({ call: step.call, result });
      } else throw new Error(`step without clock, sql or call in ${scenario.name}`);
    }
    for (const statement of spec.beforeDump) sqlite.run(statement);
    const cardDir = config.STORY_CARD_DIR;
    const existing = fs.existsSync(cardDir)
      ? fs
          .readdirSync(cardDir)
          .filter((file) => file !== "fontconfig.xml")
          .sort()
      : [];
    return JSON.parse(
      JSON.stringify({ name: scenario.name, results, files: existing, tables: dump(sqlite, spec.ignoredTables) }),
    ) as unknown;
  } finally {
    backendDb.close();
  }
}

const scenarios = [];
for (const scenario of spec.scenarios) scenarios.push(await run(scenario));
// The result goes to the file named by argv[3]: a large stdout write is cut short on a CI pipe.
fs.writeFileSync(process.argv[3] as string, JSON.stringify({ scenarios }));
