import { escapeHtml } from "../foundation/html.js";
import { isHttpUrl } from "../foundation/url.js";

type Wrapper = { open: string; close: string };

/** Renders Telegram entities over `text` in a single left-to-right pass,
 * emitting close tags before open tags at each boundary.
 *
 * The obvious alternative — wrapping one entity at a time by slicing the
 * accumulated HTML — is wrong for nested entities (Telegram routinely sends
 * bold and text_link over the same range): the first wrap shifts every later
 * offset, but those offsets are still computed against the original plain
 * text, so the second wrap slices in the wrong place and tears the markup.
 * Offsets here are only ever read against `text`, never against the output. */
export function entitiesToHtml(text: string, entities: Record<string, unknown>[]): string {
  const spans = entities
    .map((entity) => ({ entity, offset: Number(entity.offset), length: Number(entity.length) }))
    .filter((item) => Number.isInteger(item.offset) && Number.isInteger(item.length) && item.offset >= 0 && item.length > 0)
    .filter((item) => item.offset + item.length <= text.length)
    .flatMap((item) => {
      const wrapper = entityWrapper(String(item.entity.type ?? ""), item.entity, text.slice(item.offset, item.offset + item.length));
      return wrapper ? [{ start: item.offset, end: item.offset + item.length, wrapper }] : [];
    })
    // Outermost first at a shared start, so a longer span opens before the
    // shorter one it contains and the close order stays a mirror image.
    .sort((left, right) => left.start - right.start || right.end - left.end);

  const opens = new Map<number, Wrapper[]>();
  const closes = new Map<number, Wrapper[]>();
  for (const span of spans) {
    opens.set(span.start, [...(opens.get(span.start) ?? []), span.wrapper]);
    // Innermost closes first: prepend, mirroring the open order at this point.
    closes.set(span.end, [span.wrapper, ...(closes.get(span.end) ?? [])]);
  }

  const parts: string[] = [];
  let cursor = 0;
  for (const boundary of [...new Set([...opens.keys(), ...closes.keys()])].sort((left, right) => left - right)) {
    parts.push(renderText(text.slice(cursor, boundary)));
    for (const wrapper of closes.get(boundary) ?? []) parts.push(wrapper.close);
    for (const wrapper of opens.get(boundary) ?? []) parts.push(wrapper.open);
    cursor = boundary;
  }
  parts.push(renderText(text.slice(cursor)));
  return parts.join("");
}

function entityWrapper(type: string, entity: Record<string, unknown>, raw: string): Wrapper | null {
  // Block entities an article body carries. Telegram cannot express them, so
  // they only ever arrive from a Markdown file -- but they render here, beside
  // every inline style, because the site must show the same document the X
  // Article renderer builds from the same text and entities.
  if (type === "heading") {
    const level = Math.min(Math.max(Number(entity.level ?? 2), 1), 6);
    return { open: `<h${level}>`, close: `</h${level}>` };
  }
  if (type === "quote") return { open: "<blockquote>", close: "</blockquote>" };
  if (type === "list_item") return { open: "<li>", close: "</li>" };
  if (type === "bold") return { open: "<strong>", close: "</strong>" };
  if (type === "italic") return { open: "<em>", close: "</em>" };
  if (type === "underline") return { open: "<u>", close: "</u>" };
  if (type === "strikethrough") return { open: "<s>", close: "</s>" };
  if (type === "spoiler") return { open: '<span class="spoiler">', close: "</span>" };
  if (type === "code") return { open: "<code>", close: "</code>" };
  if (type === "pre") return { open: "<pre><code>", close: "</code></pre>" };
  if (type === "text_link" && typeof entity.url === "string" && isHttpUrl(entity.url))
    return { open: `<a href="${escapeHtml(entity.url)}" rel="noopener noreferrer">`, close: "</a>" };
  // A bare `url` entity's href is its own text. Telegram also auto-detects
  // schemeless domains, so it gets the same protocol check as text_link.
  if (type === "url" && isHttpUrl(raw)) return { open: `<a href="${escapeHtml(raw)}" rel="noopener noreferrer">`, close: "</a>" };
  if (type === "url" && isHttpUrl(`https://${raw}`))
    return { open: `<a href="https://${escapeHtml(raw)}" rel="noopener noreferrer">`, close: "</a>" };
  return null;
}

function renderText(value: string): string {
  return escapeHtml(value).replace(/\n/g, "<br>");
}

/** The first hidden link in reading order, for platforms that append at most one.
 * Telegram sends entities in offset order, but a payload can be re-serialized on
 * the way here, so the order is established rather than assumed. */
export function firstTextLinkUrl(entities: Record<string, unknown>[]): string | null {
  return (
    [...entities]
      .sort((left, right) => Number(left.offset ?? 0) - Number(right.offset ?? 0))
      .flatMap((entity) => (entity.type === "text_link" && typeof entity.url === "string" && isHttpUrl(entity.url) ? [entity.url] : []))
      .at(0) ?? null
  );
}

/** Canonical leading-emoji stripper, imported directly by the social payload
 * builder and by the web app's Layout so a post's headline strips identically in
 * both. It lives in Content rather than in delivery/social because
 * the site is its only other caller and presentation code must not reach into a
 * delivery adapter for a string helper. Handles flag pairs and ZWJ sequences; a
 * bare "#"/digit is not treated as an emoji so hashtags and numbered lists
 * survive. */
export function stripLeadingEmojis(text: string): string {
  if (!text) return "";
  const cleaned = text.trim();
  const flagGroup = cleaned.match(/^(\p{RI}{2})\s*/u)?.[1];
  if (flagGroup) return cleaned.slice(flagGroup.length).trim();
  const baseEmojiPart = `(?:[^\\s\\w\\d.,!?;:()""''«»а-яА-ЯёЁa-zA-Z][\\ufe00-\\ufe0f\\u20e3]?|[\\ud83c][\\udffb-\\udfff]?)`;
  const zwjRegex = new RegExp(`^(?:${baseEmojiPart}(?:\\u200d${baseEmojiPart})*)`, "u");
  const matched = cleaned.match(zwjRegex)?.[0];
  if (matched && /\p{Emoji}/u.test(matched) && !/^[#*0-9]$/.test(matched[0] ?? "")) return cleaned.slice(matched.length).trim();
  return cleaned;
}

/** One text as the posts a chain platform carries it in: cut at the last
 * boundary that ends a thought -- a paragraph, then a sentence, then a word --
 * because a cut in the middle of a sentence is what makes a thread read like a
 * machine wrote it. Every piece fits `limit`, and nothing is dropped. */
export function splitText(text: string, limit: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [""];
  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const take = cutPoint(remaining, limit);
    parts.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.length > 0 ? parts : [normalized];
}

/** A piece shorter than this much of the budget is a worse read than a cut
 * closer to the limit, so a boundary that early is not taken. */
const MIN_FILL = 0.5;

function cutPoint(text: string, limit: number): number {
  const window = text.slice(0, limit + 1);
  const floor = Math.floor(limit * MIN_FILL);
  for (const boundary of [window.lastIndexOf("\n\n"), lastSentenceEnd(window, limit), window.lastIndexOf("\n"), window.lastIndexOf(" ")])
    if (boundary > floor && boundary <= limit) return boundary;
  // No boundary at all -- a single unbroken run of characters. The cut lands on
  // `limit` exactly, which can fall between the halves of a surrogate pair and
  // send a broken character to the API. Back off one unit; the orphaned half
  // travels with the next part.
  return isHighSurrogate(text[limit - 1]) ? limit - 1 : limit;
}

/** Where the last sentence ending inside the window finishes, its closing
 * quotes and brackets included. A dot followed by a lowercase letter ends an
 * abbreviation rather than a sentence, and cutting there splits one. */
function lastSentenceEnd(window: string, limit: number): number {
  let end = -1;
  for (const match of window.matchAll(/[.!?\u2026]+["'\u00bb\u201d\u2019)\]]*(?=\s)/gu)) {
    const after = window.slice(match.index + match[0].length).trimStart()[0];
    if (after && after.toLowerCase() === after && after.toUpperCase() !== after) continue;
    if (match.index + match[0].length <= limit) end = match.index + match[0].length;
  }
  return end;
}

function isHighSurrogate(char: string | undefined): boolean {
  const code = char?.charCodeAt(0);
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
}
