import type { BackendConfig } from "../../foundation/config.js";
import { log } from "../../foundation/logger.js";
import type { RadarEffort } from "../../studio/services/settings.js";

/** The outside world, searched.
 *
 * Grok is the only producer here that leaves the building, and it is driven as
 * a subprocess of its own CLI. What it returns is Markdown prose: reading that
 * into fields is a separate step with a separate model, because asking Grok
 * itself for structure is what stops it searching. */

/** The Grok CLI is a subprocess; past this it is not coming back. */
const GROK_CLI_TIMEOUT_SECONDS = 900;
/** Enough of Grok's answer to see whether it wrote a report or a promise. */
const GROK_LOG_SAMPLE = 600;

type GrokProcess = {
  stdout: ReadableStream<Uint8Array>;
  stderr: ReadableStream<Uint8Array>;
  exited: Promise<number>;
  kill: () => void;
};

export type GrokSpawn = (command: string[], options: { stdout: "pipe"; stderr: "pipe" }) => GrokProcess;

/** No `--json-schema`. A schema obliges the model to produce the object as its
 * answer, and it can satisfy that obligation without searching at all: the runs
 * that failed all returned one sentence about the report they were going to
 * write, with zero tool calls, while a run that searched made thirty-two. Asked
 * for plain Markdown instead, the same prompt on the same Studio searched and
 * answered. */
const OUTPUT_INSTRUCTIONS =
  "Search X first, then answer with the finished report only: a numbered Markdown list of 10 items, one X source URL per item, no introduction or closing remarks.";
const MIN_ITEMS = 10;
const MIN_SOURCE_LINKS = 10;
/** Two runs at the effort the operator chose. A ladder that quietly changed the
 * effort between them made one job look like two, and neither of them was the
 * one the settings screen described. */
const ATTEMPTS = 2;
/** Long enough for both attempts, so a lease covers the whole run. */
export const GROK_RUN_BUDGET_SECONDS = ATTEMPTS * GROK_CLI_TIMEOUT_SECONDS + 60;

/** Runs the search and returns what Grok wrote, or throws with what it said. */
export async function searchWithGrok(config: BackendConfig, prompt: string, effort: RadarEffort, spawn: GrokSpawn): Promise<string> {
  let lastShape = { items: 0, sourceLinks: 0 };
  let lastMarkdown = "";
  for (let attempt = 0; attempt < ATTEMPTS; attempt += 1) {
    const retryInstructions =
      attempt === 0
        ? ""
        : `\n\nYour previous result was incomplete: ${lastShape.items} numbered items and ${lastShape.sourceLinks} X source links. Start over and return the finished report.`;
    const attemptPrompt = `${prompt.trim()}\n\n${OUTPUT_INSTRUCTIONS}${retryInstructions}`;
    const markdown = await runAttempt(config, attemptPrompt, effort, spawn);
    lastShape = reportShape(markdown);
    lastMarkdown = markdown;
    // What Grok said, not only how it was measured: every stub so far was a
    // sentence about the report it was going to write, and that is only
    // visible if it is written down.
    log("info", "radar search attempt", { attempt: attempt + 1, effort, ...lastShape, answer: markdown.slice(0, GROK_LOG_SAMPLE) });
    if (lastShape.items >= MIN_ITEMS && lastShape.sourceLinks >= MIN_SOURCE_LINKS) return markdown;
  }
  throw new Error(
    `Grok search is incomplete at effort ${effort}: ${lastShape.items} numbered items and ${lastShape.sourceLinks} X source links; minimum ${MIN_ITEMS} and ${MIN_SOURCE_LINKS}. Grok answered: ${lastMarkdown.slice(0, GROK_LOG_SAMPLE)}`,
  );
}

async function runAttempt(config: BackendConfig, prompt: string, effort: RadarEffort, spawn: GrokSpawn): Promise<string> {
  const child = spawn(
    [config.GROK_CLI_PATH, "--no-leader", "--reasoning-effort", effort, "--output-format", "json", "--always-approve", "--single", prompt],
    { stdout: "pipe", stderr: "pipe" },
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
      throw new Error(`Grok CLI returned invalid JSON: ${stdout.trim().slice(0, GROK_LOG_SAMPLE)}`);
    }
    if (!response || typeof response !== "object")
      throw new Error(`Grok CLI returned invalid JSON: ${stdout.trim().slice(0, GROK_LOG_SAMPLE)}`);
    const markdown = readMarkdown(response);
    if (markdown === null) throw new Error("Grok CLI did not return news markdown");
    if (markdown.length === 0) throw new Error("Grok returned an empty search result");
    return markdown;
  } finally {
    clearTimeout(timeout);
  }
}

/** Whether this looks like a report at all, asked before a second model is paid
 * to read it. The character count this used to also demand is gone: it was a
 * proxy for "did it search", and the items and links answer that directly. */
function reportShape(markdown: string): { items: number; sourceLinks: number } {
  const itemNumbers = [...markdown.matchAll(/^(\d+)\.\s+/gm)].map((match) => Number(match[1]));
  let items = 0;
  while (itemNumbers[items] === items + 1) items += 1;
  return { items, sourceLinks: [...markdown.matchAll(/https:\/\/x\.com\/[^\s)]+/g)].length };
}

/**
 * The report, cut out of the reply. While it searches, Grok narrates its progress
 * ("Ищу свежие посты…"), and that narration is concatenated straight onto the front of
 * the answer without a line break — so the report starts at the first numbered item,
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
