import type { ThreadPart } from "../application/ports.js";
import { splitText } from "./text.js";

/** One post of a thread in one language, as every consumer reads it. */
export type LocalizedThreadPart = { text: string; entities: Record<string, unknown>[]; media: Record<string, unknown>[] };

/** The posts after the first, in one language. English is the machine
 * translation; a part whose English has not arrived yet has no text, which
 * preflight refuses rather than publishing an empty reply. */
export function localizedThread(thread: readonly ThreadPart[], locale: "ru" | "en"): LocalizedThreadPart[] {
  return thread.map((part) => ({
    text: locale === "ru" ? part.textRu : (part.textEnApproved ?? part.textEn ?? ""),
    entities: locale === "ru" ? part.entitiesRu : [],
    media: part.media,
  }));
}

/** The whole thread as one text, for the places that publish a single post:
 * the parts become paragraphs, and each part's entities move with it. */
export function joinedThread(
  first: { text: string; entities: Record<string, unknown>[] },
  rest: readonly LocalizedThreadPart[],
): { text: string; entities: Record<string, unknown>[] } {
  let text = first.text.trimEnd();
  const entities = [...first.entities];
  for (const part of rest) {
    const body = part.text.trim();
    if (!body) continue;
    const lead = part.text.length - part.text.trimStart().length;
    const offset = text.length + 2;
    text = `${text}\n\n${body}`;
    for (const entity of part.entities) {
      const start = Number(entity.offset) - lead;
      const length = Number(entity.length);
      if (!Number.isInteger(start) || !Number.isInteger(length) || start < 0 || start + length > body.length) continue;
      entities.push({ ...entity, offset: offset + start });
    }
  }
  return { text, entities };
}

/** The posts a chain platform actually sends for one locale: every written post
 * cut to the platform's own budget, in order.
 *
 * The author writes and edits Russian that fits; the English is a machine
 * translation of it and is routinely longer than the Russian it renders, so a
 * post the author made fit went out as a refusal in the other language. A
 * platform that carries a reply chain can carry that overflow as the reply it
 * would have been, and this is the one place that decides where the cut falls
 * -- preflight counts these posts and delivery sends them.
 *
 * Media and entities stay with the first piece: they point into the text that
 * was written, and only that piece still holds it.
 */
export function chainPosts<M>(
  posts: readonly { text: string; entities: Record<string, unknown>[]; media: M[] }[],
  limit: number,
): Array<{ text: string; entities: Record<string, unknown>[]; media: M[] }> {
  return posts.flatMap((post) =>
    splitText(post.text, limit).map((text, index) => ({
      text,
      entities: index === 0 ? post.entities.filter((entity) => Number(entity.offset) + Number(entity.length) <= text.length) : [],
      media: index === 0 ? post.media : [],
    })),
  );
}
