import type { BackendConfig } from "../../foundation/config.js";
import { deepSeekChat } from "../../foundation/external/deepseek.js";
import type { StudioLocale } from "../../foundation/locale.js";
import type { EditorialProfile } from "../profile.js";
import type { CandidateInput } from "../store.js";
import { languageName } from "./language.js";
import { parseProducedItems } from "./parse.js";

/** This Studio's own archive, read for what it is missing.
 *
 * Not a source in the sense the search is: it leaves nothing and finds nothing
 * new, it re-reads what has already been published and names the page that is
 * not there yet. It produces candidates into the same list because the decision
 * the operator makes about one is the same decision, and keeping it in a second
 * inbox is what made both of them unanswerable. */

const IDEAS_TIMEOUT_MS = 45_000;
const MAX_ITEMS = 3;

export async function findArchiveIdeas(
  config: BackendConfig,
  profile: EditorialProfile,
  locale: StudioLocale,
  fetchImpl: typeof fetch = fetch,
): Promise<CandidateInput[]> {
  if (profile.posts.length === 0) return [];
  const content = await deepSeekChat(
    config,
    [
      {
        role: "system",
        content: [
          "You are an editorial research assistant for a solo AI news creator.",
          `Write the title, summary and reason in ${languageName(locale)}.`,
          "Using only the supplied published posts and entity clusters, propose at most three useful next pages: a hub update, a page that answers one real question, a comparison, a practical guide, an official-data update, or a weekly roundup.",
          "Prefer one concrete query-shaped page over generic SEO. A cluster is not enough by itself: name the question the page would answer.",
          "Do not invent facts, demand a conclusion, write publication copy, or use generic SEO ideas.",
          "Each reason must name the concrete cluster or gap found in the supplied posts.",
          "posts lists the ids of the supplied posts the idea grew out of.",
          'Return strict JSON only: {"items":[{"title":"...","summary":"...","reason":"...","posts":[1,2]}]}.',
        ].join("\n"),
      },
      {
        role: "user",
        content: JSON.stringify({
          posts: profile.posts.map((post) => ({
            id: post.id,
            date: post.date,
            text: locale === "en" ? post.textEn || post.textRu : post.textRu || post.textEn,
          })),
          clusters: profile.clusters.map((cluster) => ({
            slug: cluster.slug,
            count: cluster.count,
            title: locale === "en" ? cluster.titleEn || cluster.titleRu : cluster.titleRu,
          })),
          usuallyAccepts: profile.favoured,
          usuallyDeclines: profile.declined,
        }),
      },
    ],
    { temperature: 0.2, timeoutMs: IDEAS_TIMEOUT_MS, json: true },
    fetchImpl,
  );
  return parseProducedItems(content, MAX_ITEMS);
}
