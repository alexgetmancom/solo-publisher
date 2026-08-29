import { jsonRecordArray } from "../json.js";

/** Transport-neutral content captured from any interface before it becomes a draft. */
export type DraftMessage = {
  text: string;
  /** Absent when the translator could not produce one; never the Russian text. */
  textEn?: string | undefined;
  /** Explicit human approval is separate from the machine translation. */
  textEnApproved?: string | null;
  media: Record<string, unknown>[];
  entities: unknown[];
};

export function parseArrayValue(value: unknown): Record<string, unknown>[] {
  return jsonRecordArray(value);
}

/** The fallback is explicit at every call site: there is no generic name for a
 * post that would not be one installation's name on another's permanent URL. */
export function firstLine(text: string | null | undefined, fallback: string): string {
  return text?.split(/\r?\n/, 1)[0]?.trim() || fallback;
}

export function firstNonEmptyLine(text: string | null | undefined, fallback = ""): string {
  return (
    text
      ?.split(/\r?\n/)
      .find((line) => line.trim())
      ?.trim() || fallback
  );
}

/** Mobile keyboards occasionally autocorrect "/" to "\" inside a pasted URL.
 * Straighten only the slashes inside recognized http(s) links, so unrelated
 * backslashes elsewhere in free text (captions, signatures) are untouched. */
export function fixUrlSlashes(text: string): string {
  return text.replace(/https?:[\\/]{1,2}[^\s]*/gi, (url) => url.replace(/\\/g, "/"));
}

export function slugify(text: string, postId: number): string {
  const slug = text
    // NFC keeps Cyrillic letters such as "й" and "ё" intact. NFKD splits
    // "й" into "и" plus a combining breve, which was then discarded below.
    .normalize("NFC")
    .toLowerCase()
    .replace(/[^a-z0-9\u0400-\u04ff]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
  return slug || `post-${postId}`;
}
