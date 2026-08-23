import type { Bot } from "grammy";
import { InputFile } from "grammy";
import { claimSync, markSynced } from "../../analytics/snapshots/creator-store.js";
import type { BackendDb } from "../../db/client.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import { log } from "../../foundation/logger.js";
import { zonedDateTimeParts } from "../../foundation/time.js";
import { type NewsDigestEffort, settingsService } from "../../studio/services/settings.js";

/** The Grok CLI is a subprocess; past this it is not coming back. */
const GROK_CLI_TIMEOUT_SECONDS = 900;
/** Enough of Grok's answer to see whether it wrote a report or a promise. */
const NEWS_DIGEST_LOG_SAMPLE = 600;

type GrokProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

export type GrokSpawn = (command: string[], options: { stdout: "pipe"; stderr: "pipe" }) => GrokProcess;

export type NewsDigestRunResult =
  | { status: "sent" }
  | { status: "disabled" | "not_due" | "missing_prompt" | "already_sent" }
  | { status: "failed"; error: string };

/** No `--json-schema`. A schema obliges the model to produce the object as its
 * answer, and it can satisfy that obligation without searching at all: the runs
 * that failed all returned one sentence about the report they were going to
 * write, with zero tool calls, while a run that searched made thirty-two. Asked
 * for plain Markdown instead, the same prompt on the same Studio searched and
 * answered. */
const NEWS_DIGEST_OUTPUT_INSTRUCTIONS =
  "Search X first, then answer with the finished report only: a numbered Markdown list of 10 items, one X source URL per item, no introduction or closing remarks.";
const MIN_NEWS_DIGEST_CHARACTERS = 2_582;
const MIN_NEWS_DIGEST_ITEMS = 10;
const MIN_NEWS_DIGEST_SOURCE_LINKS = 10;
/** Two runs at the effort the operator chose. A ladder that quietly changed the
 * effort between them made one job look like two, and neither of them was the
 * one the settings screen described. */
const NEWS_DIGEST_ATTEMPTS = 2;

/** Runs one shared daily Grok report and delivers it as a Markdown document. */
export async function sendDailyNewsDigest(
  config: BackendConfig,
  backendDb: BackendDb,
  bot: Bot | null,
  now = new Date(),
  options: { force?: boolean; spawn?: GrokSpawn } = {},
): Promise<NewsDigestRunResult> {
  if (!bot || config.CONTROLLER_ADMIN_IDS.length === 0) return { status: "disabled" };
  const settings = settingsService(backendDb).newsDigest();
  if (!options.force && !settings.enabled) return { status: "disabled" };
  if (!settings.prompt) return { status: "missing_prompt" };

  // The Studio's own zone, not the primary administrator's personal override:
  // this schedule belongs to the installation and is delivered to everyone, so
  // one operator changing their display zone must not move it for the others.
  const date = zonedDateTimeParts(now, config.TIMEZONE);
  if (!options.force && date.hour * 60 + date.minute < settings.hour * 60 + settings.minute) return { status: "not_due" };

  const key = `news_digest:${date.day}`;
  const claimOwner = "telegram:news-digest";
  if (
    !options.force &&
    !claimSync(backendDb, key, {
      intervalSeconds: 24 * 60 * 60,
      leaseSeconds: NEWS_DIGEST_ATTEMPTS * GROK_CLI_TIMEOUT_SECONDS + 60,
      owner: claimOwner,
    })
  )
    return { status: "already_sent" };

  try {
    const markdown = await runGrok(config, settings.prompt, settings.effort, options.spawn ?? (Bun.spawn as unknown as GrokSpawn));
    const filename = `news-digest-${date.day}.md`;
    let delivered = 0;
    for (const actorId of config.CONTROLLER_ADMIN_IDS) {
      const locale = settingsService(backendDb).locale(actorId);
      try {
        await bot.api.sendDocument(actorId, new InputFile(Buffer.from(markdown, "utf8"), filename), {
          caption: t(locale, "settings.news-digest-document-caption"),
        });
        delivered += 1;
      } catch (error) {
        log("warn", "news digest was not delivered", { actorId, error: String(error) });
      }
    }
    if (delivered === 0) throw new Error("Telegram rejected the news digest for every administrator");
    if (!options.force) markSynced(backendDb, key, null, claimOwner);
    return { status: "sent" };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    if (!options.force) markSynced(backendDb, key, message.slice(0, 500), claimOwner);
    log("warn", "daily news digest failed", { error: message });
    // Silence reads as "no news today". Whatever happened, the administrators
    // hear about it on the day it happened, with what Grok actually returned.
    for (const actorId of config.CONTROLLER_ADMIN_IDS) {
      const locale = settingsService(backendDb).locale(actorId);
      try {
        await bot.api.sendMessage(actorId, t(locale, "settings.news-digest-failed-notice", { error: message.slice(0, 1_000) }));
      } catch (notifyError) {
        log("warn", "news digest failure notice was not delivered", { actorId, error: String(notifyError) });
      }
    }
    return { status: "failed", error: message };
  }
}

async function runGrok(config: BackendConfig, prompt: string, effort: NewsDigestEffort, spawn: GrokSpawn): Promise<string> {
  let lastResult = { characters: 0, items: 0, sourceLinks: 0 };
  let lastMarkdown = "";
  for (let attempt = 0; attempt < NEWS_DIGEST_ATTEMPTS; attempt += 1) {
    const retryInstructions =
      attempt === 0
        ? ""
        : `\n\nYour previous result was incomplete: ${lastResult.characters} characters, ${lastResult.items} numbered items and ${lastResult.sourceLinks} X source links. Start over and return the finished report.`;
    const attemptPrompt = `${prompt.trim()}\n\n${NEWS_DIGEST_OUTPUT_INSTRUCTIONS}${retryInstructions}`;
    const markdown = await runGrokAttempt(config, attemptPrompt, effort, spawn);
    lastResult = digestShape(markdown);
    lastMarkdown = markdown;
    // What Grok said, not only how it was measured: every stub so far was a
    // sentence about the report it was going to write, and that is only
    // visible if it is written down.
    log("info", "news digest attempt", {
      attempt: attempt + 1,
      effort,
      ...lastResult,
      answer: markdown.slice(0, NEWS_DIGEST_LOG_SAMPLE),
    });
    if (
      lastResult.characters >= MIN_NEWS_DIGEST_CHARACTERS &&
      lastResult.items >= MIN_NEWS_DIGEST_ITEMS &&
      lastResult.sourceLinks >= MIN_NEWS_DIGEST_SOURCE_LINKS
    )
      return `${markdown}\n`;
  }
  throw new Error(
    `Grok news digest is incomplete at effort ${effort}: ${lastResult.characters} characters, ${lastResult.items} numbered items and ${lastResult.sourceLinks} X source links; minimum ${MIN_NEWS_DIGEST_CHARACTERS}, ${MIN_NEWS_DIGEST_ITEMS} and ${MIN_NEWS_DIGEST_SOURCE_LINKS}. Grok answered: ${lastMarkdown.slice(0, NEWS_DIGEST_LOG_SAMPLE)}`,
  );
}

async function runGrokAttempt(config: BackendConfig, prompt: string, effort: NewsDigestEffort, spawn: GrokSpawn): Promise<string> {
  const child = spawn(
    [config.GROK_CLI_PATH, "--no-leader", "--reasoning-effort", effort, "--output-format", "json", "--always-approve", "--single", prompt],
    {
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  let timedOut = false;
  const timeout = setTimeout(() => {
    timedOut = true;
    child.kill();
  }, GROK_CLI_TIMEOUT_SECONDS * 1000);
  try {
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
      child.exited,
    ]);
    if (timedOut) throw new Error(`Grok CLI timed out after ${GROK_CLI_TIMEOUT_SECONDS} seconds`);
    if (exitCode !== 0) throw new Error(`Grok CLI exited with code ${exitCode}: ${stderr.trim().slice(0, 500)}`);
    let response: unknown;
    try {
      response = JSON.parse(stdout);
    } catch {
      throw new Error(`Grok CLI returned invalid JSON: ${stdout.trim().slice(0, NEWS_DIGEST_LOG_SAMPLE)}`);
    }
    if (!response || typeof response !== "object")
      throw new Error(`Grok CLI returned invalid JSON: ${stdout.trim().slice(0, NEWS_DIGEST_LOG_SAMPLE)}`);
    const markdown = readMarkdown(response);
    if (markdown === null) throw new Error("Grok CLI did not return news markdown");
    if (markdown.length === 0) throw new Error("Grok returned an empty news digest");
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

function digestShape(markdown: string): { characters: number; items: number; sourceLinks: number } {
  const itemNumbers = [...markdown.matchAll(/^(\d+)\.\s+/gm)].map((match) => Number(match[1]));
  let items = 0;
  while (itemNumbers[items] === items + 1) items += 1;
  return {
    characters: [...markdown].length,
    items,
    sourceLinks: [...markdown.matchAll(/https:\/\/x\.com\/[^\s)]+/g)].length,
  };
}

/**
 * The report, cut out of the reply. While it searches, Grok narrates its progress
 * ("Ищу свежие посты…"), and that narration is concatenated straight onto the front of
 * the answer without a line break — so the digest starts at the first numbered item,
 * wherever in the text that falls. A reply with no numbered item at all is returned
 * whole: the shape check rejects it, and the operator gets to read what came back.
 */
function readMarkdown(response: object): string | null {
  if (!("text" in response) || typeof response.text !== "string") return null;
  const value = response.text.trim();
  const narrated = value.search(/(?:^|[^\d])1\.\s+\*\*/);
  if (narrated < 0) return value;
  return value.slice(value.indexOf("1.", narrated)).trim();
}
