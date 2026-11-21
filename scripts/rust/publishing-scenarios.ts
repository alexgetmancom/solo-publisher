import { readFileSync } from "node:fs";
import { channelUploadLimits } from "../../apps/backend/src/channels/platform-token-store.js";
import { registeredPostTargetIds } from "../../apps/backend/src/channels/registry.js";
import { openBackendDb, type UnsafeBackendDb, unsafeDb } from "../../apps/backend/src/db/client.js";
import { loadConfig, withStudioProfile } from "../../apps/backend/src/foundation/config.js";
import { StudioError } from "../../apps/backend/src/foundation/errors.js";
import { abandonPublicationTargets } from "../../apps/backend/src/publishing/abandon.js";
import { publishArticle } from "../../apps/backend/src/publishing/article-publish.js";
import { cancelRemainingDelivery, pendingDeliveryTargets } from "../../apps/backend/src/publishing/cancellation.js";
import { plannedTargetDeliveries } from "../../apps/backend/src/publishing/chain-plan.js";
import { cancelDraft, scheduledDrafts } from "../../apps/backend/src/publishing/draft-lifecycle.js";
import { HttpPublishError } from "../../apps/backend/src/publishing/errors.js";
import { deliverExtraTarget } from "../../apps/backend/src/publishing/extra-delivery.js";
import { publicationPreflight } from "../../apps/backend/src/publishing/preflight.js";
import { refreshPublicationOwner } from "../../apps/backend/src/publishing/publication-owner.js";
import { publishDraftToQueue } from "../../apps/backend/src/publishing/publication-workflow.js";
import {
  claimDuePublishJobs,
  claimPublishJob,
  completePublishJob,
  duePublishJobs,
  enqueuePublishJobTx,
  failPublishJob,
  forcePublishJobVerification,
  recoverStalePublishJobs,
  requirePublishVerification,
} from "../../apps/backend/src/publishing/queue.js";
import { RETRY_UNLESS_HELD, requeuePublicationTargets } from "../../apps/backend/src/publishing/requeue.js";
import { mutateScheduledDraft } from "../../apps/backend/src/publishing/scheduled-draft-mutation.js";
import { publicationPlanFromDb, publicationSourceFromDb } from "../../apps/backend/src/publishing/source-store.js";
import { refreshVideoDraftStatus } from "../../apps/backend/src/publishing/video-data.js";
import {
  cancelVideo,
  createVideoDraft,
  removeVideoTarget,
  replaceVideoSource,
  replaceVideoTargets,
  retryVideoTarget,
  saveVideoMetadata,
  scheduleVideo,
  updateVideoLabel,
  updateVideoScript,
} from "../../apps/backend/src/publishing/video-service.js";
import { settleVideoTarget } from "../../apps/backend/src/publishing/video-settle.js";
import type { VideoTarget } from "../../apps/backend/src/publishing/video-types.js";
import { dump, resolve } from "./scenario-support.js";

/**
 * The TypeScript side of the Rust publishing equivalence test
 * (crates/domain/tests/publishing_scenarios.rs): every scenario runs through
 * the real publishing modules on a fresh in-memory database under a fixed
 * clock and a fixed `Math.random`, and prints every step's result and a dump
 * of every non-empty table but the `ignoredTables` the spec names. The
 * `beforeDump` statements pin what SQLite's own triggers stamp with its clock.
 *
 *   bun scripts/rust/publishing-scenarios.ts crates/domain/tests/publishing_scenarios.json
 *
 * Publishing reads the wall clock (`new Date()`, `Date.now()`), so the clock
 * here replaces the global `Date` for calls without arguments. A step is
 *   {"clock": "<ISO instant>"} | {"sql": "<statement>"}
 *   {"call": "<name>", "args": [...], "bind"?: "<name>", "error"?: "any"}
 * with `{"$": "<name>.<field>"}` naming a field of a bound result. A thrown
 * StudioError reports its code and parameters; `"error": "any"` reports any
 * failure as `<any>`, for messages that belong to the runtime (SQLite).
 */

type Step = { clock?: string; sql?: string; call?: string; args?: unknown[]; bind?: string; error?: "any" };
type Scenario = { name: string; steps: Step[] };
type Spec = {
  clock: string;
  jitter: number;
  config: Record<string, string>;
  ignoredTables: string[];
  setup: string[];
  beforeDump: string[];
  scenarios: Scenario[];
};
type Args = unknown[];
type Scope = { postId: number | null; publicationKey: string };

const path = process.argv[2];
if (!path) {
  console.error("usage: publishing-scenarios.ts <publishing_scenarios.json>");
  process.exit(2);
}
const spec = JSON.parse(readFileSync(path, "utf8")) as Spec;

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
Math.random = () => spec.jitter;

/** The scenarios settle videos from what the operator observed; none reaches a provider. */
const noProvider = (() => {
  throw new Error("the scenarios never reach a provider");
}) as unknown as typeof fetch;

/** A failure as the queue is handed one: an HTTP refusal or a plain error. */
function failure(value: unknown): Error {
  const { message, status, retryAfterSeconds } = value as { message: string; status?: number; retryAfterSeconds?: number };
  return status == null ? new Error(message) : new HttpPublishError(message, status, undefined, retryAfterSeconds ?? null);
}

function call(backendDb: UnsafeBackendDb, name: string, args: Args): unknown {
  const db = backendDb.db;
  const config = withStudioProfile(loadConfig(spec.config), backendDb);
  const source = (postId: number) => () => publicationSourceFromDb(db, postId);
  const scope = (value: unknown) => value as Scope;
  switch (name) {
    case "enqueue": {
      const input = args[0] as { publicationKey: string; target: string; payload: Record<string, unknown>; publishAt?: string | null };
      return enqueuePublishJobTx(db, input as Parameters<typeof enqueuePublishJobTx>[1]);
    }
    case "due":
      return duePublishJobs(backendDb, args[0] as number);
    case "claimDue":
      return claimDuePublishJobs(backendDb, args[0] as number, args[1] as string);
    case "claim":
      return claimPublishJob(backendDb, args[0] as number, args[1] as string);
    case "complete":
      return completePublishJob(
        backendDb,
        args[0] as number,
        args[1] as Record<string, unknown>,
        args[2] as string,
        (args[3] as string | null) ?? null,
      );
    case "fail":
      return failPublishJob(backendDb, args[0] as number, failure(args[1]), args[2] as string);
    case "requireVerification":
      return requirePublishVerification(backendDb, args[0] as number, new Error(args[1] as string), args[2] as string);
    case "forceVerification":
      return forcePublishJobVerification(
        backendDb,
        args[0] as number,
        new Error(args[1] as string),
        args[2] as string,
        (args[3] as Record<string, unknown> | null) ?? null,
      );
    case "recoverStale":
      return recoverStalePublishJobs(backendDb, args[0] as number);
    case "pending":
      return pendingDeliveryTargets(backendDb, args[0] as number);
    case "cancelRemaining":
      return cancelRemainingDelivery(backendDb, args[0] as number, args[1] as number);
    case "requeue": {
      const options = args[2] as { from: string[] | "unlessHeld"; createMissing?: boolean; audienceReached: "resume" | "republish" };
      return requeuePublicationTargets(backendDb, scope(args[0]), args[1] as string[], {
        from: options.from === "unlessHeld" ? RETRY_UNLESS_HELD : options.from,
        ...(options.createMissing ? { createMissing: true } : {}),
        audienceReached: options.audienceReached,
        source: source(scope(args[0]).postId as number),
      });
    }
    case "abandon":
      return abandonPublicationTargets(backendDb, scope(args[0]), args[1] as string[]);
    case "extraDelivery": {
      const extra = args[0] as { draftId: number; postId: number; publicationKey: string };
      return deliverExtraTarget(backendDb, extra, args[1] as string, source(extra.postId));
    }
    case "publishDraft": {
      const options = (args[1] ?? {}) as { mode?: "immediate" | "scheduled"; ruAt?: string; enAt?: string; immediateLocale?: "ru" | "en" };
      return publishDraftToQueue(backendDb, args[0] as number, {
        ...(options.mode ? { mode: options.mode } : {}),
        ...(options.ruAt ? { ruAt: new Date(options.ruAt) } : {}),
        ...(options.enAt ? { enAt: new Date(options.enAt) } : {}),
        ...(options.immediateLocale ? { immediateLocale: options.immediateLocale } : {}),
      });
    }
    case "cancelDraft":
      return cancelDraft(backendDb, args[0] as number, args[1] as number);
    case "scheduledDrafts":
      return scheduledDrafts(backendDb);
    case "mutateScheduled": {
      const draft = backendDb.drafts.get(args[0] as number);
      if (!draft) throw new Error(`draft ${args[0]} not found`);
      const mutation = args[1] as Parameters<typeof mutateScheduledDraft>[2];
      return mutateScheduledDraft(backendDb, draft, mutation);
    }
    case "refreshOwner":
      return refreshPublicationOwner(backendDb, args[0] as string);
    case "publishArticle":
      return publishArticle(backendDb, config, args[0] as Parameters<typeof publishArticle>[2]);
    case "source":
      return publicationSourceFromDb(db, args[0] as number);
    case "plan":
      return publicationPlanFromDb(db, args[0] as number, registeredPostTargetIds(backendDb));
    case "preflight": {
      const draft = backendDb.drafts.get(args[0] as number);
      if (!draft) throw new Error(`draft ${args[0]} not found`);
      return publicationPreflight(draft, channelUploadLimits(backendDb));
    }
    case "deliveries": {
      const draft = backendDb.drafts.get(args[0] as number);
      if (!draft) throw new Error(`draft ${args[0]} not found`);
      return plannedTargetDeliveries(draft);
    }
    case "video.create":
      return createVideoDraft(backendDb, args[0] as number, args[1] as number, args[2] as number, args[3] as "ru" | "en");
    case "video.replaceTargets":
      return replaceVideoTargets(backendDb, args[0] as number, args[1] as VideoTarget[]);
    case "video.removeTarget":
      return removeVideoTarget(backendDb, args[0] as number, args[1] as VideoTarget, args[2] as number);
    case "video.saveMetadata":
      return saveVideoMetadata(backendDb, args[0] as number, args[1] as VideoTarget, args[2] as Parameters<typeof saveVideoMetadata>[3]);
    case "video.schedule": {
      const schedule = Object.fromEntries(Object.entries(args[1] as Record<string, string>).map(([target, at]) => [target, new Date(at)]));
      return scheduleVideo(
        backendDb,
        args[0] as number,
        schedule,
        { prepareLeadMinutes: args[2] as number },
        args[3] as number | undefined,
      );
    }
    case "video.cancel":
      return cancelVideo(backendDb, args[0] as number, args[1] as number);
    case "video.retry":
      return retryVideoTarget(config, backendDb, args[0] as number, args[1] as VideoTarget, noProvider);
    case "video.settle":
      return settleVideoTarget(config, backendDb, args[0] as Parameters<typeof settleVideoTarget>[2], noProvider);
    case "video.updateLabel":
      return updateVideoLabel(backendDb, args[0] as number, args[1] as string);
    case "video.updateScript":
      return updateVideoScript(backendDb, args[0] as number, args[1] as string, args[2] as string);
    case "video.replaceSource":
      return replaceVideoSource(backendDb, args[0] as number, args[1] as number, args[2] as number);
    case "video.refreshStatus":
      return refreshVideoDraftStatus(backendDb, args[0] as number, args[1] as number);
    default:
      throw new Error(`unknown call ${name}`);
  }
}

function errorResult(error: unknown, mode: Step["error"]): unknown {
  if (mode === "any") return { error: "<any>" };
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof StudioError && error.params)
    return { error: message, params: Object.fromEntries(Object.entries(error.params).map(([key, value]) => [key, String(value)])) };
  return { error: message };
}

async function run(scenario: Scenario) {
  nowMs = Date.parse(spec.clock);
  const backendDb = openBackendDb(":memory:") as UnsafeBackendDb;
  const { sqlite } = unsafeDb(backendDb);
  const vars: Record<string, unknown> = {};
  const results: { call: string; result: unknown }[] = [];
  try {
    for (const statement of spec.setup) sqlite.run(statement);
    for (const step of scenario.steps) {
      if (step.clock !== undefined) nowMs = Date.parse(step.clock);
      else if (step.sql !== undefined) sqlite.run(step.sql);
      else if (step.call !== undefined) {
        let result: unknown;
        try {
          const value = await call(backendDb, step.call, resolve(step.args ?? [], vars) as Args);
          if (step.bind) vars[step.bind] = value;
          result = value === undefined ? null : value;
        } catch (error) {
          result = errorResult(error, step.error);
        }
        results.push({ call: step.call, result });
      } else throw new Error(`step without clock, sql or call in ${scenario.name}`);
    }
    for (const statement of spec.beforeDump) sqlite.run(statement);
    return JSON.parse(JSON.stringify({ name: scenario.name, results, tables: dump(sqlite, spec.ignoredTables) })) as unknown;
  } finally {
    backendDb.close();
  }
}

const scenarios = [];
for (const scenario of spec.scenarios) scenarios.push(await run(scenario));
console.log(JSON.stringify({ scenarios }));
