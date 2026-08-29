import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Context } from "grammy";
import { runCallbackBoundary } from "../src/bot/callback-boundary.js";
import type { BackendDb } from "../src/db/client.js";
import { withDb } from "./helpers/db.js";

const root = join(import.meta.dir, "../../..");

function source(relativePath: string): string {
  return readFileSync(join(root, relativePath), "utf8");
}

function sourceFiles(relativeDirectory: string): string[] {
  return readdirSync(join(root, relativeDirectory), { withFileTypes: true }).flatMap((entry) => {
    const relativePath = join(relativeDirectory, entry.name);
    if (entry.isDirectory()) return sourceFiles(relativePath);
    return entry.isFile() && entry.name.endsWith(".ts") ? [relativePath] : [];
  });
}

const backendSources = sourceFiles("apps/backend/src");

/** Answering an update -- with `ctx` -- is what the anchor owns. Sending on the
 * bot's own initiative (`bot.api`) is a different thing entirely: a reminder, a
 * failure notice, an hourly dashboard refresh. There is no tapped message to
 * write over, and those keep their direct calls. */
const CONTEXT_SEND = /\bctx\.(reply|editMessage|sendMessage|replyWith)/;

/** The executor itself, the preview renderer that sends media Telegram cannot
 * edit, and the analytics dashboard, whose rich message Telegram can only edit
 * -- `reply` takes plain text, so it has no fallback to fall back to. */
const CONTEXT_SEND_ALLOWED = new Set([
  "apps/backend/src/bot/effects.ts",
  "apps/backend/src/bot/analytics-screen.ts",
  "apps/backend/src/interfaces/telegram/delivery-previews.ts",
]);

describe("telegram interface contour", () => {
  /** Whether an answer replaces the screen it came from or arrives below it is
   * one decision, and it belongs to one place. Spread across call sites it was
   * made differently in forty-four of them: "← Back" answered below the question
   * it came from, and tapping a field on the edit menu left a dead screen above
   * the prompt it asked. Nothing here is a matter of taste any more, so nothing
   * here is a call site's to get wrong. */
  it("sends nothing to Telegram outside the one executor", () => {
    const offenders = backendSources.filter((file) => !CONTEXT_SEND_ALLOWED.has(file) && CONTEXT_SEND.test(source(file)));
    expect(offenders).toEqual([]);
  });

  /** Callback data that is not built by one of the two builders arrives at a
   * router that has never heard of it: the button is dead, and it is dead only
   * at runtime, in a chat. Both builders check their own arity where the button
   * is written. */
  it("builds every button's callback data through the declared namespaces", () => {
    const literalCallback = /\.text\(\s*[^,()]*(?:\([^()]*\))?[^,()]*,\s*["'`]/;
    const offenders = backendSources.filter((file) => literalCallback.test(source(file)));
    expect(offenders).toEqual([]);
  });

  /** English-only in code is a house rule, and a house rule is not a border.
   * What a rule cannot tell apart, this can: product copy the audience reads is
   * data and lives in the catalogue; a word the bot matches on input, a name
   * written in its own language, a column heading in somebody else's CSV export
   * are data too, and they live where they are used.
   *
   * The exceptions are the copy that never made it into the catalogue and so
   * reads Russian to an English operator. Keep the list explicit and shrinking;
   * a new file carrying Russian copy fails here until the string is a key. */
  const RUSSIAN_LITERALS_ALLOWED = new Set([
    // The catalogue itself, and a language named in its own language.
    "apps/backend/src/foundation/i18n/catalog.ts",
    "apps/backend/src/foundation/locale.ts",
    // Data, not copy: input the bot recognises, a Cyrillic range in a regex,
    // the column headings X writes into its own analytics export, and the
    // example values the operations catalogue prints in its usage strings.
    "apps/backend/src/bot/post-flow.ts",
    "apps/backend/src/content/text.ts",
    "apps/backend/src/analytics/import-x-csv.ts",
    "apps/backend/src/operations/registry.ts",
    // Copy that still bypasses the catalogue. Each one renders Russian to an
    // English operator, and each one is a key waiting to be written.
    "apps/backend/src/publishing/preflight.ts",
    "apps/backend/src/bot/settings/shared.ts",
    "apps/backend/src/analytics/audience-milestones.ts",
    "apps/backend/src/analytics/collection/video-metrics.ts",
    "apps/backend/src/analytics/reports/video-archive.ts",
    "apps/backend/src/interfaces/web/dashboard/video-overview.ts",
  ]);

  it("keeps Russian copy out of the code and inside the catalogue", () => {
    const offenders = backendSources.filter((file) => !RUSSIAN_LITERALS_ALLOWED.has(file) && russianLiterals(source(file)).length > 0);
    expect(offenders).toEqual([]);
  });

  /** The exceptions above are a debt, not a shape: this fails when one of them
   * stops carrying Russian, so the list cannot outlive what it excuses. */
  it("keeps no exception that has nothing left to excuse", () => {
    const stale = [...RUSSIAN_LITERALS_ALLOWED].filter((file) => russianLiterals(source(file)).length === 0);
    expect(stale).toEqual([]);
  });

  /** A tap Telegram never hears back about spins its button for ten seconds and
   * leaves nothing behind. Every handler answering for itself was a rule with
   * twenty-seven copies; this is the one that cannot be forgotten. */
  it("answers a tap that its handler did not answer", async () => {
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      from: { id: 42 },
      callbackQuery: { id: "cb-1", data: "noop" },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    await withDb(async (backendDb: BackendDb) => runCallbackBoundary(ctx, backendDb, async () => undefined));

    expect(answers).toEqual([undefined]);
  });

  it("leaves a handler's own answer alone", async () => {
    const answers: Array<{ text?: string } | undefined> = [];
    const ctx = {
      from: { id: 42 },
      callbackQuery: { id: "cb-2", data: "noop" },
      answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    } as unknown as Context;

    await withDb(async (backendDb: BackendDb) =>
      runCallbackBoundary(ctx, backendDb, async () => {
        await ctx.answerCallbackQuery({ text: "Cancelled" });
      }),
    );

    expect(answers).toEqual([{ text: "Cancelled" }]);
  });
});

/** String literals carrying Russian, with comments removed first: an English
 * comment quoting what a screen said is not copy. */
function russianLiterals(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
  return [...code.matchAll(/(["'`])((?:\\.|(?!\1)[^\\])*)\1/g)].map((match) => match[2] ?? "").filter((value) => /[А-Яа-яЁё]/.test(value));
}
