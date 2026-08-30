/** What makes two findings the same story.
 *
 * Every producer here returns the same subject repeatedly -- Grok searches the
 * same window daily, and one story reaches X, a newsroom and an official blog
 * under three headlines and four links. The digest hid this by writing a fresh
 * file every morning that nobody compared with yesterday's; a stored candidate
 * cannot hide it, so the collapse has to be real.
 *
 * Three layers, cheapest first: the canonical link, an exact fingerprint of the
 * distinctive words in the headline, and a similarity pass over recent
 * candidates for the headlines that share a subject but no exact fingerprint.
 * The first two are unique indexes -- the database refuses the duplicate rather
 * than a reader remembering to check. */

/** Parameters a link carries that identify the referrer, not the page. */
const TRACKING_PARAMETERS = /^(utm_|fbclid$|gclid$|yclid$|igshid$|mc_[ce]id$|ref$|ref_src$|ref_url$|s$|t$|si$|source$|cmpid$)/i;

/** Words too common to identify a subject. Small on purpose: this is not a
 * language model, it is a way of keeping "the", "новый" and "as" from being
 * the words two unrelated headlines are matched on. */
const STOPWORDS = new Set([
  "the",
  "and",
  "for",
  "with",
  "from",
  "that",
  "this",
  "into",
  "after",
  "over",
  "about",
  "says",
  "said",
  "new",
  "its",
  "has",
  "have",
  "will",
  "how",
  "why",
  "what",
  "who",
  "are",
  "was",
  "were",
  "been",
  "not",
  "but",
  "you",
  "your",
  "their",
  "they",
  "them",
  "out",
  "now",
  "can",
  "could",
  "would",
  "may",
  "might",
  "more",
  "most",
  "than",
  "then",
  "when",
  "where",
  "which",
  "while",
  "also",
  "just",
  "only",
  "one",
  "two",
  "first",
  "last",
  "next",
  "что",
  "как",
  "для",
  "при",
  "это",
  "этот",
  "эта",
  "эти",
  "под",
  "над",
  "без",
  "его",
  "её",
  "их",
  "они",
  "она",
  "оно",
  "был",
  "была",
  "было",
  "были",
  "есть",
  "будет",
  "будут",
  "может",
  "могут",
  "новый",
  "новая",
  "новое",
  "новые",
  "после",
  "перед",
  "между",
  "через",
  "около",
  "всё",
  "все",
  "уже",
  "ещё",
  "так",
  "там",
  "тут",
  "или",
  "если",
  "чтобы",
  "который",
  "которая",
  "которые",
  "своих",
  "свою",
  "свой",
  "года",
  "году",
  "лет",
  "млн",
  "млрд",
]);

export function canonicalUrl(value: string | null | undefined): string | null {
  const raw = value?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") return null;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  for (const key of [...url.searchParams.keys()]) if (TRACKING_PARAMETERS.test(key)) url.searchParams.delete(key);
  const query = url.searchParams.toString();
  const path = url.pathname.replace(/\/+$/, "");
  return `https://${host}${path}${query ? `?${query}` : ""}`;
}

export function sourceHost(url: string | null): string | null {
  if (!url) return null;
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

/** The distinctive words of a headline, lower-cased and de-duplicated. */
function titleTokens(title: string): string[] {
  const tokens = title
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => (token.length >= 3 || /\d/.test(token)) && !STOPWORDS.has(token));
  return [...new Set(tokens)];
}

/** One headline's exact key: its five most distinctive words, in a fixed order
 * so that word order and everything around them stops mattering. Longest first
 * because that is where product names, companies and versions are. */
export function clusterKey(title: string): string {
  const tokens = titleTokens(title);
  const distinctive = [...tokens].sort((a, b) => b.length - a.length || (a < b ? -1 : 1)).slice(0, 5);
  return distinctive.sort().join("-") || title.trim().toLowerCase().slice(0, 80);
}

/** How much two headlines are about the same thing, 0 to 1. */
export function titleSimilarity(left: string, right: string): number {
  const a = new Set(titleTokens(left));
  const b = new Set(titleTokens(right));
  if (a.size === 0 || b.size === 0) return 0;
  let shared = 0;
  for (const token of a) if (b.has(token)) shared += 1;
  return shared / (a.size + b.size - shared);
}

/** Above this two headlines are the same story. Chosen against the shape of the
 * data rather than a theory: a restated headline keeps most of its names and
 * numbers, and two genuinely different stories about one company share the
 * company and little else. */
export const SAME_STORY_SIMILARITY = 0.6;
