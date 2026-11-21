import { readFileSync } from "node:fs";
import type { Clock } from "../../apps/backend/src/application/ports.js";
import { openBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { createActionableIssueStore } from "../../apps/backend/src/db/repositories/actionable-issues.js";
import { createChannelStore } from "../../apps/backend/src/db/repositories/channels.js";
import { createConversationSessionStore } from "../../apps/backend/src/db/repositories/conversation-sessions.js";
import { createDraftTranslationStore } from "../../apps/backend/src/db/repositories/draft-translations.js";
import { createDraftStore } from "../../apps/backend/src/db/repositories/drafts.js";
import { createEntityEnrichmentStore } from "../../apps/backend/src/db/repositories/entity-enrichment.js";
import { createEventStore } from "../../apps/backend/src/db/repositories/events.js";
import { createStudioMediaAssetStore } from "../../apps/backend/src/db/repositories/studio-media-assets.js";
import { createStudioPostStore } from "../../apps/backend/src/db/repositories/studio-posts.js";
import { createStudioQueueStore } from "../../apps/backend/src/db/repositories/studio-queue.js";
import { createStudioSettingsStore } from "../../apps/backend/src/db/repositories/studio-settings.js";
import { createStudioVideoStore } from "../../apps/backend/src/db/repositories/studio-videos.js";
import { createThreadPartStore } from "../../apps/backend/src/db/repositories/thread-parts.js";
import { dump, lookup, resolve } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust `domain` crate's SQL equivalence test: it
 * runs each scenario of a scenario file through the real repositories on a
 * fresh in-memory database (migrated by `openBackendDb`) under a fixed clock,
 * and prints every step's result and a dump of every non-empty table.
 *
 *   bun scripts/rust/domain-scenarios.ts crates/domain/tests/scenarios.json
 *
 * `setup` statements run first in every scenario, on both sides: they pin what
 * the migrations stamp with the wall clock. A scenario is
 * `{name, steps, nondeterministic?}`; a step is one of
 *   {"clock": "<ISO instant>"}                 the time every later call sees
 *   {"sql": "<statement>"}                     seed or disturb state behind the repositories
 *   {"call": "<store>.<method>", "args": [...], "bind"?: "<name>", "error"?: "any"}
 * An argument `{"$": "<name>.<field>"}` is a field of a bound result. Every
 * value named in `nondeterministic` (a `<name>.<field>`) is replaced by
 * `<name.field>` wherever it appears in the output. `"error": "any"` reports a
 * failure as `<any>` instead of its message, for errors whose wording belongs
 * to the runtime (JSON parse errors).
 */

type Step = { clock?: string; sql?: string; call?: string; args?: unknown[]; bind?: string; error?: "any" };
type Scenario = { name: string; steps: Step[]; nondeterministic?: string[] };
type Spec = { clock: string; setup: string[]; scenarios: Scenario[] };
type Method = (...args: unknown[]) => unknown;

const path = process.argv[2];
if (!path) {
  console.error("usage: domain-scenarios.ts <scenarios.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(path, "utf8")) as Spec;

function run(scenario: Scenario) {
  const backendDb = openBackendDb(":memory:");
  const { db, sqlite } = unsafeDb(backendDb);
  let now = spec.clock;
  const clock: Clock = { now: () => new Date(now) };
  const stores: Record<string, Record<string, Method>> = {
    drafts: createDraftStore(db, clock),
    threadParts: createThreadPartStore(db, clock),
    draftTranslations: createDraftTranslationStore(db, clock),
    events: createEventStore(db, clock),
    entityEnrichment: createEntityEnrichmentStore(db),
    channels: createChannelStore(db),
    studioSettings: createStudioSettingsStore(db),
    studioMediaAssets: createStudioMediaAssetStore(db),
    studioPosts: createStudioPostStore(db),
    conversationSessions: createConversationSessionStore(db),
    studioQueue: createStudioQueueStore(db),
    actionableIssues: createActionableIssueStore(db),
    studioVideos: createStudioVideoStore(db),
  } as unknown as Record<string, Record<string, Method>>;
  const vars: Record<string, unknown> = {};
  const results: { call: string; result: unknown }[] = [];
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) now = step.clock;
      else if (step.sql !== undefined) sqlite.run(step.sql);
      else if (step.call !== undefined) {
        const [store = "", method = ""] = step.call.split(".");
        const target = stores[store]?.[method];
        if (!target) throw new Error(`unknown call ${step.call}`);
        let result: unknown;
        try {
          const value = target(...(resolve(step.args ?? [], vars) as unknown[]));
          if (step.bind) vars[step.bind] = value;
          result = value === undefined ? null : value;
        } catch (error) {
          result = { error: step.error === "any" ? "<any>" : (error as Error).message };
        }
        results.push({ call: step.call, result });
      } else throw new Error(`step without clock, sql or call in ${scenario.name}`);
    }
    let text = JSON.stringify({ name: scenario.name, results, tables: dump(sqlite) });
    for (const reference of scenario.nondeterministic ?? []) {
      const value = lookup(vars, reference);
      if (typeof value !== "string" || !value) throw new Error(`${reference} is not a bound string`);
      text = text.replaceAll(value, `<${reference}>`);
    }
    return JSON.parse(text) as unknown;
  } finally {
    backendDb.close();
  }
}

console.log(JSON.stringify({ scenarios: spec.scenarios.map(run) }));
