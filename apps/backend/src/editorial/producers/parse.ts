import { truncateUnicode } from "../../foundation/text.js";
import type { CandidateInput } from "../store.js";

/** One shape both producers answer in, and the one place a model's JSON is read.
 *
 * Neither producer's output is trusted: fields are truncated, ids are checked
 * for being integers, and anything without a title and a reason is dropped
 * rather than stored as a card with a blank half. */

type ProducedItem = { title?: unknown; summary?: unknown; reason?: unknown; url?: unknown; posts?: unknown };

const TITLE_LIMIT = 180;
const SUMMARY_LIMIT = 600;
const REASON_LIMIT = 400;
const RELATED_POSTS_LIMIT = 6;

export function parseProducedItems(content: string, limit: number): CandidateInput[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch {
    return [];
  }
  const items = parsed && typeof parsed === "object" && "items" in parsed ? (parsed as { items: unknown }).items : null;
  if (!Array.isArray(items)) return [];
  return items.flatMap((item) => readItem(item as ProducedItem)).slice(0, limit);
}

function readItem(item: ProducedItem): CandidateInput[] {
  const title = text(item.title, TITLE_LIMIT);
  const reason = text(item.reason, REASON_LIMIT);
  if (!title || !reason) return [];
  return [
    {
      title,
      summary: text(item.summary, SUMMARY_LIMIT) ?? "",
      reason,
      url: typeof item.url === "string" && item.url.trim() ? item.url.trim() : null,
      relatedPostIds: Array.isArray(item.posts)
        ? item.posts.filter((id): id is number => Number.isSafeInteger(id)).slice(0, RELATED_POSTS_LIMIT)
        : [],
      entitySlugs: [],
    },
  ];
}

function text(value: unknown, limit: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim().replace(/\s+/g, " ");
  return trimmed ? truncateUnicode(trimmed, limit) : null;
}
