import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import type { StudioLocale } from "../../foundation/locale.js";
import type { EditorialProfile } from "../profile.js";
import type { CandidateInput } from "../store.js";
import { languageName } from "./language.js";
import { parseProducedItems } from "./parse.js";

/** Grok's prose, read into candidates.
 *
 * Two models, two jobs. Grok searches and will not do so under a schema; this
 * one never searches and has no trouble with one. Splitting them is what
 * removed the regular expressions that used to pick numbered items apart, and
 * it is why the raw report is stored: a bad reading can be redone from it
 * without paying for the search again. */

const STRUCTURE_TIMEOUT_MS = 90_000;
const MAX_ITEMS = 12;

export async function structureFindings(
  config: BackendConfig,
  markdown: string,
  profile: EditorialProfile,
  locale: StudioLocale,
  fetchImpl: typeof fetch = fetch,
): Promise<CandidateInput[]> {
  const content = await deepSeekChat(
    config,
    [
      {
        role: "system",
        content: [
          "You convert one editorial research report into structured candidates for a solo AI news creator.",
          `Write title, summary and reason in ${languageName(locale)}.`,
          "Use only what the report says. Do not add facts, do not merge two findings into one, and do not invent links.",
          "url is the source link the report gives for that finding, or null when it gives none.",
          "summary is what happened, one or two sentences.",
          "reason says why this creator specifically should cover it, naming the subject it connects to in their published work or saying plainly that it is new ground for them. Never write generic importance.",
          'Return strict JSON only: {"items":[{"title":"...","summary":"...","reason":"...","url":"https://..."}]}.',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          report: markdown,
          publishesAbout: profile.clusters.map((cluster) => cluster.titleRu),
          usuallyAccepts: profile.favoured,
          usuallyDeclines: profile.declined,
        }),
      },
    ],
    { temperature: 0.2, timeoutMs: STRUCTURE_TIMEOUT_MS, json: true },
    fetchImpl,
  );
  return parseProducedItems(content, MAX_ITEMS);
}
