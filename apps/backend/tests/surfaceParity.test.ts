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
 * A capability is answered by an operation, or it is deliberately bot-only with
 * a reason, or it only answers a question. The set below has to equal the
 * methods the services actually expose, so a capability added to the bot cannot
 * reach `main` without someone saying here which of those it is.
 *
 * There was a fourth answer while the debt was being paid -- "a gap nobody has
 * closed yet" -- and it is deliberately gone. A category for "later" is where
 * later goes to live: with it removed, the only way to add a capability the
 * command line cannot reach is to write down why it belongs on a card, which
 * is a claim someone can disagree with. */
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
  schedule: "draft-schedule",
  manualSchedule: "draft-schedule",
  scheduleAt: "draft-schedule",
  rescheduleIfNeeded: "internal: replanning after an edit, not a capability anyone asks for",
  scheduleReminder: "internal: the reminder the scheduler sets for itself",
  cancel: "draft-cancel",
  cancelJobs: "draft-cancel",
  setStoryPublishMode: "bot-only: how a story is composed, decided on the card while looking at it",
  replaceEntityCandidates: "bot-only: resolving link candidates is a conversation with the author",
  acceptEntityCandidates: "bot-only: the other half of replaceEntityCandidates",
  approveThreadsChain: "bot-only: the author waiving a rule after seeing what it costs, which is a conversation and not an argument",
  publish: "draft-publish",
  publishArticle: "article-publish",
  retryTarget: "retry",
  skipTarget: "skip",
  toggleTarget: "bot-only: choosing where a publication goes, on the card that shows where it goes",
  removeTarget: "bot-only: the other half of toggleTarget",
  cycleMode: "bot-only: the publish mode, cycled on the card that displays it",
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
  updateMetadata: "bot-only: writing a title and a description, which is authoring",
  editMetadataField: "bot-only: one field of updateMetadata",
  completeWizardTarget: "bot-only: a step of the upload conversation",
  rename: "bot-only: the name a card carries for its author",
  replaceTargets: "bot-only: choosing where a video goes, on the card that shows where it goes",
  removeTarget: "bot-only: the other half of replaceTargets",
  toggleTarget: "bot-only: the other half of replaceTargets",
  manualSchedule: "video-schedule",
  scheduleReminder: "internal: the reminder the scheduler sets for itself",
  cancel: "video-cancel",
  schedule: "video-schedule",
  publish: "video-publish",
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
      (answer) => !answer.startsWith("read:") && !answer.startsWith("bot-only:") && !answer.startsWith("internal:"),
    );
    expect(claimed.length).toBeGreaterThan(0);
    for (const name of claimed) expect(catalog).toContain(name);
  });

  it("has no category for a capability the command line cannot reach yet", () => {
    expect([...Object.values(POSTS), ...Object.values(VIDEOS)].filter((answer) => answer.startsWith("gap:"))).toEqual([]);
  });
});
