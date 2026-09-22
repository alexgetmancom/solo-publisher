import type { ThreadPart } from "../application/ports.js";

/** One post of a thread in one language, as every consumer reads it. */
export type LocalizedThreadPart = { text: string; entities: Record<string, unknown>[]; media: Record<string, unknown>[] };

/** The posts after the first, in one language. English is the machine
 * translation; a part whose English has not arrived yet has no text, which
 * preflight refuses rather than publishing an empty reply. */
export function localizedThread(thread: readonly ThreadPart[], locale: "ru" | "en"): LocalizedThreadPart[] {
  return thread.map((part) => ({
    text: locale === "ru" ? part.textRu : (part.textEn ?? ""),
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
