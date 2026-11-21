/** The wire contract between the Rust Studio and this sidecar
 * (`crates/adapters/README.md`, "Stories sidecar contract"; the Rust half is
 * `HttpStoriesSidecar` in `crates/adapters/src/telegram_stories.rs`).
 *
 * Every refusal names whether `stories.sendStory` went out. The Rust client
 * treats only an explicit `sent: false` as a plain failure; anything else —
 * `sent: true`, a body it cannot read, no answer — settles the Story as
 * ambiguous, because a second Story is worse than an unclear one. */

type StoryMedia =
  | { type: "photo"; path: string }
  | { type: "video"; path: string; width: number; height: number; duration: number; supportsStreaming: boolean };

/** A hidden link of the caption (`messageEntityTextUrl`), in UTF-16 units. */
type CaptionLink = { offset: number; length: number; url: string };

export type StoryRequest = {
  peer: string;
  periodSeconds: number;
  media: StoryMedia;
  caption: { text: string; links: CaptionLink[] };
};

/** What the HTTP layer writes back: a status and the JSON body. */
export type Answer = { status: number; body: { id: number } | { error: { message: string; sent: boolean } } };

export const posted = (id: number): Answer => ({ status: 200, body: { id } });

/** `sent` is the whole point of a refusal: false only when nothing could have
 * reached the audience. */
export const refused = (status: number, message: string, sent: boolean): Answer => ({ status, body: { error: { message, sent } } });

type Parsed = { ok: true; request: StoryRequest } | { ok: false; reason: string };

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
}

const nonNegativeInteger = (value: unknown): value is number => Number.isSafeInteger(value) && (value as number) >= 0;
const positiveInteger = (value: unknown): value is number => nonNegativeInteger(value) && value > 0;
const finiteNonNegative = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0;

function parseMedia(value: unknown): StoryMedia | string {
  const media = record(value);
  if (!media) return "media must be an object";
  const path = media.path;
  if (typeof path !== "string" || !path.startsWith("/")) return "media.path must be an absolute path";
  if (media.type === "photo") return { type: "photo", path };
  if (media.type !== "video") return 'media.type must be "photo" or "video"';
  const { width, height, duration, supportsStreaming } = media;
  if (!finiteNonNegative(width) || !finiteNonNegative(height) || !finiteNonNegative(duration))
    return "media.width, media.height and media.duration must be non-negative numbers";
  if (typeof supportsStreaming !== "boolean") return "media.supportsStreaming must be a boolean";
  return { type: "video", path, width, height, duration, supportsStreaming };
}

function parseLinks(value: unknown, textLength: number): CaptionLink[] | string {
  if (!Array.isArray(value)) return "caption.links must be an array";
  const links: CaptionLink[] = [];
  for (const [index, item] of value.entries()) {
    const link = record(item);
    if (!link || !nonNegativeInteger(link.offset) || !positiveInteger(link.length) || typeof link.url !== "string" || !link.url)
      return `caption.links[${index}] must be {offset, length, url}`;
    if (link.offset + link.length > textLength) return `caption.links[${index}] runs past the caption`;
    links.push({ offset: link.offset, length: link.length, url: link.url });
  }
  return links;
}

/** Validates the request body. A refusal here is always "not sent". */
export function parseStoryRequest(body: unknown): Parsed {
  const fail = (reason: string): Parsed => ({ ok: false, reason });
  const input = record(body);
  if (!input) return fail("body must be a JSON object");
  if (typeof input.peer !== "string" || !input.peer.trim()) return fail("peer must be a non-empty string");
  if (!positiveInteger(input.periodSeconds)) return fail("periodSeconds must be a positive integer");
  const media = parseMedia(input.media);
  if (typeof media === "string") return fail(media);
  const caption = record(input.caption);
  if (!caption || typeof caption.text !== "string") return fail("caption.text must be a string");
  // String length is UTF-16 code units, the unit Telegram's entity offsets use.
  const links = parseLinks(caption.links, caption.text.length);
  if (typeof links === "string") return fail(links);
  return { ok: true, request: { peer: input.peer, periodSeconds: input.periodSeconds, media, caption: { text: caption.text, links } } };
}
