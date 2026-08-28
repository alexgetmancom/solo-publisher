import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { operationCatalog } from "../src/operations/registry.js";

const root = join(import.meta.dir, "../../..");

/** The methods a Studio service exposes, read off the object it returns. */
function serviceMethods(relativePath: string): string[] {
  const text = readFileSync(join(root, relativePath), "utf8");
  return [...text.matchAll(/^ {4}(?:async )?([a-zA-Z][a-zA-Z0-9]*)\(/gm)].map((match) => match[1] as string).sort();
}

/** What a Studio capability is answered by outside the bot.
 *
 * Every feature this system has grown was built where it was first needed --
 * usually a button -- and the CLI and the MCP tools learned about it later, or
 * never. `skip` sat behind a button next to `retry` for months while an
 * operator at the command line could only retry, so the way out of a
 * publication nothing could deliver was to keep sending it.
 *
 * A capability is answered by an operation, or it is deliberately bot-only, or
 * it is a gap nobody has closed yet -- and each of those is written down here.
 * The set below has to equal the methods the services actually expose, so a
 * capability added to the bot cannot reach `main` without someone saying, in
 * this file, which of the three it is. Reading it back is how the list of gaps
 * stays a list rather than a surprise. */
const READ = "read: answers a question, changes nothing";

const POSTS: Record<string, string> = {
  create: "bot-only: a draft is authored from Telegram messages; the CLI creates publications outright with publish and article-publish",
  get: READ,
  list: READ,
  validate: READ,
  preview: READ,
  history: READ,
  mediaAssets: READ,
  hasLocaleTargets: READ,
  slotTime: READ,
  attachMediaAssets: "bot-only: media arrives as a Telegram upload; the CLI replaces media on a publication with replace-media",
  removeMedia: "bot-only: the other half of attachMediaAssets, on a draft the CLI never holds",
  schedule: "gap: the CLI publishes immediately or reschedules an existing publication, and cannot schedule a draft",
  manualSchedule: "gap: same as schedule, with a time typed by hand",
  scheduleAt: "gap: same as schedule, with a time already resolved",
  rescheduleIfNeeded: "internal: replanning after an edit, not a capability anyone asks for",
  scheduleReminder: "internal: the reminder the scheduler sets for itself",
  cancel: "gap: a scheduled publication can only be called off from the bot; skip gives up on targets that already failed",
  cancelJobs: "gap: the delivery half of cancel",
  setStoryPublishMode: "gap: story mode is chosen on the draft card and nowhere else",
  replaceEntityCandidates: "bot-only: resolving link candidates is a conversation with the author",
  acceptEntityCandidates: "bot-only: the other half of replaceEntityCandidates",
  approveThreadsChain: "gap: waiving the single-post rule is a decision only the bot can record",
  publish: "gap: publishing a draft that already exists; the CLI publish creates a new publication from text",
  retryTarget: "retry",
  skipTarget: "skip",
  toggleTarget: "gap: the target set of an existing draft is edited only from the card",
  removeTarget: "gap: the other half of toggleTarget",
  cycleMode: "gap: publish mode is cycled on the card",
  edit: "edit",
};

const VIDEOS: Record<string, string> = {
  create: "bot-only: a video draft starts from a Telegram upload",
  get: READ,
  list: READ,
  preview: READ,
  status: READ,
  history: READ,
  slotTime: READ,
  assetTechnicalCheck: READ,
  sourceReplaceable: READ,
  metadataEditableTargets: READ,
  settleTarget: "video-settle",
  retryTarget: "video-retry",
  updateMetadata: "gap: video metadata is edited only from the card",
  editMetadataField: "gap: one field of the same",
  completeWizardTarget: "bot-only: a step of the upload conversation",
  rename: "gap: the card name of a video draft",
  replaceTargets: "gap: the platform set of a video draft",
  removeTarget: "gap: the other half of replaceTargets",
  toggleTarget: "gap: the other half of replaceTargets",
  manualSchedule: "gap: scheduling a video draft, as for posts",
  scheduleReminder: "internal: the reminder the scheduler sets for itself",
  cancel: "gap: calling off a video, which also has to hold its YouTube upload private",
  schedule: "gap: scheduling a video draft, as for posts",
  publish: "gap: publishing a video draft that already exists",
  replaceSource: "bot-only: the replacement video arrives as a Telegram upload",
  technicalCheck: READ,
  validate: READ,
};

describe("surface parity", () => {
  it("classifies every Studio post capability as an operation, bot-only, or a named gap", () => {
    expect(serviceMethods("apps/backend/src/studio/services/posts.ts")).toEqual(Object.keys(POSTS).sort());
  });

  it("classifies every Studio video capability as an operation, bot-only, or a named gap", () => {
    expect(serviceMethods("apps/backend/src/studio/services/videos.ts")).toEqual(Object.keys(VIDEOS).sort());
  });

  it("names operations that exist for the capabilities that claim one", () => {
    const catalog = new Set(operationCatalog().map((entry) => entry.name));
    const claimed = [...Object.values(POSTS), ...Object.values(VIDEOS)].filter(
      (answer) =>
        !answer.startsWith("read:") && !answer.startsWith("bot-only:") && !answer.startsWith("gap:") && !answer.startsWith("internal:"),
    );
    expect(claimed.length).toBeGreaterThan(0);
    for (const name of claimed) expect(catalog).toContain(name);
  });
});
