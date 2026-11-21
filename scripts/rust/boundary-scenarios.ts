import fs from "node:fs";
import path from "node:path";
import { openBackendDb, type UnsafeBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { recordVideoCompletionIfFinal } from "../../apps/backend/src/delivery/video-worker.js";
import { type BackendConfig, loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { cancelScheduledNotifications, scheduleReminder } from "../../apps/backend/src/notifications/jobs.js";
import { authCircuitStates, recordAuthFailure, recordAuthSuccess } from "../../apps/backend/src/observability/auth-circuit.js";
import { capabilityReport } from "../../apps/backend/src/observability/capabilities.js";
import { flushUsage, recordUsage } from "../../apps/backend/src/observability/usage.js";
import { buildStoryCardCopy } from "../../apps/backend/src/story-cards/copy.js";
import {
  discardDraftStoryCards,
  queueDraftStoryCards,
  readyStoryCardMedia,
  setStoryPublishMode,
  storyCardsForDraft,
} from "../../apps/backend/src/story-cards/store.js";
import { dump, resolve } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust boundary equivalence test
 * (crates/domain/tests/boundary_scenarios.rs): the stores the Studio reaches
 * through its boundaries (Story cards, reminders, the credential breaker, the
 * readiness report, the video completion notice, runtime usage) driven on a
 * fresh in-memory database under a fixed clock; every step's result and a
 * dump of every non-empty table but the `ignoredTables` the spec names.
 *
 *   bun scripts/rust/boundary-scenarios.ts crates/domain/tests/boundary_scenarios.json
 *
 * `{FILES}` in the spec names a scratch directory under `_trash-rust/tmp`,
 * which this script empties before it runs. A step is
 *   {"clock": "<ISO instant>"} | {"sql": "<statement>"} | {"file": "<path>"}
 *   {"call": "<name>", "args": [...], "bind"?: "<name>"}
 * and a scenario may carry `config`, laid over the spec's.
 */

type Step = { clock?: string; sql?: string; file?: string; call?: string; args?: unknown[]; bind?: string };
type Scenario = { name: string; config?: Record<string, string>; steps: Step[] };
type Spec = { clock: string; config: Record<string, string>; ignoredTables: string[]; setup: string[]; scenarios: Scenario[] };
type Args = unknown[];

const specPath = process.argv[2];
if (!specPath) {
  console.error("usage: boundary-scenarios.ts <boundary_scenarios.json>");
  process.exit(2);
}
const files = path.resolve("_trash-rust/tmp/boundary-scenarios");
const spec = JSON.parse(fs.readFileSync(specPath, "utf8").replaceAll("{FILES}", files)) as Spec;

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

function call(backendDb: UnsafeBackendDb, config: BackendConfig, name: string, args: Args): unknown {
  const { db } = unsafeDb(backendDb);
  const int = (index: number) => args[index] as number;
  const text = (index: number) => args[index] as string;
  switch (name) {
    case "storyCards.copy": {
      const copy = buildStoryCardCopy(text(0));
      return { headline: copy.headline, emoji: copy.emoji };
    }
    case "storyCards.queue":
      return queueDraftStoryCards(db, int(0));
    case "storyCards.forDraft":
      return storyCardsForDraft(db, int(0)).map((card) => ({ locale: card.locale, status: card.status, localPath: card.localPath }));
    case "storyCards.readyMedia":
      return readyStoryCardMedia(db, int(0));
    case "storyCards.setPublishMode":
      return setStoryPublishMode(db, int(0), args[1] as "all" | "site_only");
    case "storyCards.discard":
      return discardDraftStoryCards(db, int(0));
    case "reminders.schedule": {
      const input = args[0] as Parameters<typeof scheduleReminder>[1] & { publishAt: string };
      return scheduleReminder(backendDb, { ...input, publishAt: new Date(input.publishAt) });
    }
    case "reminders.cancel":
      return cancelScheduledNotifications(backendDb, text(0));
    case "authCircuit.recordFailure":
      return recordAuthFailure(backendDb, text(0));
    case "authCircuit.recordSuccess":
      return recordAuthSuccess(backendDb, text(0));
    case "authCircuit.states":
      return authCircuitStates(backendDb);
    case "readiness.report":
      return capabilityReport(config, backendDb);
    case "videoCompletion.recordIfFinal":
      return recordVideoCompletionIfFinal(backendDb, int(0));
    case "usage.record":
      return recordUsage(backendDb, text(0), Boolean(args[1]), int(2));
    case "usage.flush":
      return flushUsage(backendDb);
    default:
      throw new Error(`unknown call ${name}`);
  }
}

function run(scenario: Scenario) {
  nowMs = Date.parse(spec.clock);
  const backendDb = openBackendDb(":memory:") as UnsafeBackendDb;
  const { sqlite } = unsafeDb(backendDb);
  const config = withStudioProfile(loadConfig({ ...spec.config, ...scenario.config }), backendDb);
  const vars: Record<string, unknown> = {};
  const results: { call: string; result: unknown }[] = [];
  fs.rmSync(files, { recursive: true, force: true });
  fs.mkdirSync(files, { recursive: true });
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) nowMs = Date.parse(step.clock);
      else if (step.sql !== undefined) sqlite.run(step.sql);
      else if (step.file !== undefined) fs.writeFileSync(step.file, "card");
      else if (step.call !== undefined) {
        let result: unknown;
        try {
          const value = call(backendDb, config, step.call, resolve(step.args ?? [], vars) as Args);
          if (step.bind) vars[step.bind] = value;
          result = value === undefined ? null : value;
        } catch (error) {
          result = { error: error instanceof Error ? error.message : String(error) };
        }
        results.push({ call: step.call, result });
      } else throw new Error(`step without clock, sql, file or call in ${scenario.name}`);
    }
    const existing = fs.readdirSync(files).sort();
    return JSON.parse(
      JSON.stringify({ name: scenario.name, results, files: existing, tables: dump(sqlite, spec.ignoredTables) }),
    ) as unknown;
  } finally {
    backendDb.close();
  }
}

const scenarios = [];
for (const scenario of spec.scenarios) scenarios.push(run(scenario));
console.log(JSON.stringify({ scenarios }));
