import { postLocales } from "../channels/locales.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { deepSeekChat } from "../foundation/external/deepseek.js";
import { log } from "../foundation/logger.js";

async function translateToEnglish(text: string, config: BackendConfig): Promise<string> {
  const source = text.trim();
  if (!source || !config.DEEPSEEK_API_KEY || !hasCyrillic(source)) return source;
  const system = [
    "Translate the user message into English, adapted for Twitter: informal and natural, the way someone who knows the subject writes for an audience that follows it.",
    "Translate only. Keep the author's structure, order, length, facts and numbers. Do not rewrite, reorder, shorten, expand, or add anything of your own.",
    "Output only the translation. No explanations, no hashtags, no commentary, no asking for more input.",
    "Preserve product names, version numbers, commands, URLs, emojis, paragraph breaks, and the bullet character •.",
    "Keep lowercase list items lowercase. Avoid em dashes and word-for-word phrasing that reads translated.",
    "For every term, use the established English word that people in that subject already use, whatever the subject is. Never invent a term and never translate a term literally when the field has its own name for it.",
  ].join("\n");
  const translated = await deepSeekChat(
    config,
    [
      { role: "system", content: system },
      { role: "user", content: source },
    ],
    { temperature: 0.1, timeoutMs: 40_000 },
  );
  if (!translated || /please provide|i'd be happy to help/i.test(translated)) throw new Error("translation returned an invalid response");
  return translated;
}

function hasCyrillic(value: string): boolean {
  return /[\u0400-\u04FF]/.test(value);
}

/** Whether this Studio would translate this text at all: it publishes English,
 * there is a translator to ask, and the text is Russian. The queue is only
 * written when the answer is yes, so a row waiting to be worked is exactly the
 * drafts whose English is still coming. */
export function translationWanted(backendDb: BackendDb, text: string, config: BackendConfig): boolean {
  return Boolean(text.trim()) && Boolean(config.DEEPSEEK_API_KEY) && hasCyrillic(text) && postLocales(backendDb).includes("en");
}

/** The English text for a new draft, or nothing when this Studio has no English
 * to publish or the translator could not produce one.
 *
 * Both answers are "no English text", and that is deliberate: a draft with none
 * says so, and preflight refuses to publish that locale until it has one. It
 * used to answer with the Russian text it was given, which is the one answer
 * that cannot be told apart from a real translation.
 *
 * The connected languages are checked before the model is called, not after: a
 * Studio that publishes only Russian was still paying for a translation of
 * every post it wrote, and the only place that text ever surfaced was a
 * dashboard that showed English because nothing had told it not to. */
export async function translateDraftText(backendDb: BackendDb, text: string, config: BackendConfig): Promise<string | undefined> {
  if (!postLocales(backendDb).includes("en")) return undefined;
  try {
    return await translateToEnglish(text, config);
  } catch (error) {
    log("warn", "draft translation failed", { error: String(error) });
    return undefined;
  }
}
