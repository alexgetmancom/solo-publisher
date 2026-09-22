import * as z from "zod";
import { fileExtension, mediaContentType } from "../../foundation/media-types.js";

type MediaKind = "IMAGE" | "VIDEO";

export type PublishMediaItem = {
  type: MediaKind;
  localPath?: string;
  fileId?: string;
  token?: string;
  vpsUrl?: string;
  storyLocalPath?: string;
  telegramStoryLocalPath?: string;
  storyVpsUrl?: string;
  [key: string]: unknown;
};

const mediaRecordSchema = z
  .object({
    type: z.unknown().optional(),
    localPath: z.string().optional(),
    fileId: z.string().optional(),
    token: z.string().optional(),
    vpsUrl: z.string().optional(),
    storyLocalPath: z.string().optional(),
    telegramStoryLocalPath: z.string().optional(),
    storyVpsUrl: z.string().optional(),
  })
  .passthrough();

const publishPayloadSchema = z
  .object({
    text: z.string().optional(),
    title: z.string().optional(),
    locale: z.string().optional(),
    postId: z.union([z.string(), z.number()]).optional(),
    draftId: z.union([z.string(), z.number()]).optional(),
    slug: z.string().optional(),
    media: z.unknown().optional(),
    entities: z.array(z.record(z.string(), z.unknown())).optional(),
    thread: z.array(z.object({ text: z.string(), entities: z.array(z.record(z.string(), z.unknown())), media: z.unknown() })).optional(),
  })
  .passthrough();

function parsePublishPayload(value: unknown): Record<string, unknown> {
  const parsed = publishPayloadSchema.safeParse(value);
  return parsed.success ? parsed.data : {};
}

export function payloadText(payload: Record<string, unknown>): string {
  const parsed = parsePublishPayload(payload);
  return stringValue(parsed.text);
}

export type PayloadThreadPart = { text: string; entities: Record<string, unknown>[]; media: PublishMediaItem[] };

/** The posts after the first. Empty for an ordinary post. */
export function payloadThread(payload: Record<string, unknown>): PayloadThreadPart[] {
  const thread = parsePublishPayload(payload).thread;
  if (!Array.isArray(thread)) return [];
  return (thread as Array<{ text: string; entities: Record<string, unknown>[]; media: unknown }>).map((part) => ({
    text: part.text,
    entities: part.entities,
    media: payloadMedia({ media: part.media }),
  }));
}

export function payloadMedia(payload: Record<string, unknown>): PublishMediaItem[] {
  payload = parsePublishPayload(payload);
  const raw = payload.media;
  const values = Array.isArray(raw) ? raw : raw && typeof raw === "object" ? [raw] : [];
  return values.flatMap((value) => {
    const parsed = mediaRecordSchema.safeParse(value);
    if (!parsed.success) return [];
    const record = parsed.data;
    const type = normalizeMediaType(record.type);
    if (!type) return [];
    const localPath = stringValue(record.localPath);
    const fileId = stringValue(record.fileId);
    const vpsUrl = stringValue(record.vpsUrl);
    if (!localPath && !fileId && !vpsUrl) return [];
    const item: PublishMediaItem = { type };
    if (localPath) item.localPath = localPath;
    if (fileId) item.fileId = fileId;
    const token = stringValue(record.token);
    if (token) item.token = token;
    if (vpsUrl) item.vpsUrl = vpsUrl;
    const storyLocalPath = stringValue(record.storyLocalPath);
    if (storyLocalPath) item.storyLocalPath = storyLocalPath;
    const telegramStoryLocalPath = stringValue(record.telegramStoryLocalPath);
    if (telegramStoryLocalPath) item.telegramStoryLocalPath = telegramStoryLocalPath;
    const storyVpsUrl = stringValue(record.storyVpsUrl);
    if (storyVpsUrl) item.storyVpsUrl = storyVpsUrl;
    return [item];
  });
}

function isHighSurrogate(char: string | undefined): boolean {
  const code = char?.charCodeAt(0);
  return code !== undefined && code >= 0xd800 && code <= 0xdbff;
}

export function splitText(text: string, limit: number): string[] {
  const normalized = text.trim();
  if (!normalized) return [""];
  const parts: string[] = [];
  let remaining = normalized;
  while (remaining.length > limit) {
    const window = remaining.slice(0, limit + 1);
    const breakAt = Math.max(window.lastIndexOf("\n\n"), window.lastIndexOf("\n"), window.lastIndexOf(". "), window.lastIndexOf(" "));
    const wordBreak = breakAt > Math.floor(limit * 0.5) ? breakAt + (window[breakAt] === "." ? 1 : 0) : limit;
    // Without a word boundary the cut lands on `limit` exactly, which can fall
    // between the halves of a surrogate pair and send a broken character to the
    // API. Back off one unit; the orphaned half travels with the next part.
    const take = isHighSurrogate(remaining[wordBreak - 1]) ? wordBreak - 1 : wordBreak;
    parts.push(remaining.slice(0, take).trim());
    remaining = remaining.slice(take).trim();
  }
  if (remaining) parts.push(remaining);
  return parts.length > 0 ? parts : [normalized];
}

export function mediaExtension(item: PublishMediaItem): string {
  if (item.localPath) {
    const ext = fileExtension(item.localPath);
    if (ext) return ext;
  }
  return item.type === "VIDEO" ? ".mp4" : ".jpg";
}

export function guessContentType(filePath: string): string {
  return mediaContentType(filePath) ?? "application/octet-stream";
}

function stringValue(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

function normalizeMediaType(value: unknown): MediaKind | null {
  const text = String(value ?? "").toLowerCase();
  if (text === "image" || text === "photo") return "IMAGE";
  if (text === "video") return "VIDEO";
  return null;
}
