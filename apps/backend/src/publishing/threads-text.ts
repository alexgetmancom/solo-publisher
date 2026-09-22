import { firstTextLinkUrl } from "../content/text.js";
import { platformProfile } from "./platform-profiles.js";

type ThreadsBody = {
  /** Exactly what will be sent, link included or not. */
  text: string;
  url: string | null;
  /** Set when a link existed but had to be dropped, with how many characters
   * short it was. The number is the point: it turns "the bot ate my link" into
   * "cut 68 characters and it stays". */
  droppedUrl: string | null;
  shortfall: number;
};

const THREADS_TEXT_LIMIT = 500;

export function threadsTextLimit(target: string): number {
  return platformProfile(target)?.limits?.text ?? THREADS_TEXT_LIMIT;
}

/**
 * The single place that decides what a Threads post contains. Preflight, the
 * Telegram preview and delivery all call it: when the counter on screen and the
 * text on the wire are computed twice, they eventually disagree, and that
 * disagreement is silent.
 *
 * A hidden Telegram text_link has no visible URL, so Threads would show a word
 * that links nowhere. Exactly one such link is appended, the first one, and only
 * if it fits the 500 characters — it is a postscript, not part of a sentence.
 * URLs the author typed into the text stay untouched and count as text: dropping
 * those by budget would break the sentence holding them.
 */
export function threadsBody(target: string, text: string, entities: Record<string, unknown>[] = []): ThreadsBody {
  const body = text.trim();
  const url = firstTextLinkUrl(entities);
  if (!url) return { text: body, url: null, droppedUrl: null, shortfall: 0 };
  const withUrl = `${body}\n\n🔗 ${url}`;
  if (withUrl.length <= threadsTextLimit(target)) return { text: withUrl, url, droppedUrl: null, shortfall: 0 };
  return { text: body, url: null, droppedUrl: url, shortfall: withUrl.length - threadsTextLimit(target) };
}

export function isThreadsTarget(target: string): boolean {
  return target === "threads_ru" || target === "threads_en";
}
