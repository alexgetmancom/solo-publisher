import path from "node:path";
import { entitiesToHtml } from "../../content/text.js";
import type { BackendConfig } from "../../foundation/config.js";
import { requestJson } from "../../foundation/http.js";
import type { PublishResult } from "../../publishing/errors.js";
import { selectMediaForTarget } from "../../publishing/media-policy.js";
import { ambiguousExternalMutation } from "../ambiguous-publication.js";
import { type PublishMediaItem, payloadMedia, payloadText, payloadThread } from "./payload.js";

type TelegramResponse = {
  ok?: boolean;
  result?: unknown;
  description?: string;
};

export async function publishToTelegram(
  payload: Record<string, unknown>,
  config: BackendConfig,
  fetchImpl: typeof fetch = fetch,
): Promise<PublishResult> {
  const token = config.controllerBotToken;
  if (!token) return { skipped: true, reason: "missing Telegram bot token" };
  // Named alongside the token it travels with: without this the chat id would
  // be a bare "@", and the failure would come back from Telegram as a generic
  // bad-request rather than as the missing setting it is.
  const channel = config.TELEGRAM_CHANNEL_USERNAME.replace(/^@/, "");
  if (!channel) return { skipped: true, reason: "missing TELEGRAM_CHANNEL_USERNAME" };
  const chatId = `@${channel}`;
  const text = payloadText(payload);
  const media = payloadMedia(payload);
  const entities = Array.isArray(payload.entities) ? payload.entities : undefined;
  const thread = payloadThread(payload);
  if (thread.length)
    return publishRichThread(
      config,
      token,
      chatId,
      [{ text, entities: (entities ?? []) as Record<string, unknown>[], media }, ...thread],
      fetchImpl,
    );
  const caption = telegramCaption(text, entities);

  if (media.length > 1) {
    const attachments: TelegramAttachment[] = [];
    const items = selectMediaForTarget("telegram", media).map((item, index) => ({
      type: item.type === "VIDEO" ? "video" : "photo",
      media: telegramMediaSource(item.fileId, item.vpsUrl, item.localPath, `media-${index}`, attachments),
      caption: index === 0 ? caption.text : undefined,
      caption_entities: index === 0 ? caption.entities : undefined,
    }));
    const request = attachments.length
      ? await telegramForm({ chat_id: chatId, media: JSON.stringify(items) }, attachments)
      : { chat_id: chatId, media: items };
    const result = await ambiguousExternalMutation("telegram", () =>
      telegramCall<TelegramResponse>(config, token, "sendMediaGroup", request, fetchImpl),
    );
    return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
  }

  const item = media[0];
  if (item) {
    const method = item.type === "VIDEO" ? "sendVideo" : "sendPhoto";
    const mediaKey = item.type === "VIDEO" ? "video" : "photo";
    const attachments: TelegramAttachment[] = [];
    const mediaSource = telegramMediaSource(item.fileId, item.vpsUrl, item.localPath, `file-${mediaKey}`, attachments);
    const request = attachments.length
      ? await telegramForm(
          {
            chat_id: chatId,
            [mediaKey]: mediaSource ?? "",
            caption: caption.text,
            caption_entities: JSON.stringify(caption.entities),
          },
          attachments,
        )
      : { chat_id: chatId, [mediaKey]: mediaSource, caption: caption.text, caption_entities: caption.entities };
    const result = await ambiguousExternalMutation("telegram", () =>
      telegramCall<TelegramResponse>(config, token, method, request, fetchImpl),
    );
    return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
  }

  const linkPreview = telegramLinkPreview(entities);
  const result = await ambiguousExternalMutation("telegram", () =>
    telegramCall<TelegramResponse>(
      config,
      token,
      "sendMessage",
      {
        chat_id: chatId,
        text,
        entities,
        ...(linkPreview ? { link_preview_options: linkPreview } : { disable_web_page_preview: false }),
      },
      fetchImpl,
    ),
  );
  return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
}

/** A thread is one rich message (Bot API 10.1): each part's text as a
 * paragraph followed by its own media, in the order the author wrote them.
 * An ordinary post never comes here and keeps its caption and album. */
async function publishRichThread(
  config: BackendConfig,
  token: string,
  chatId: string,
  posts: Array<{ text: string; entities: Record<string, unknown>[]; media: PublishMediaItem[] }>,
  fetchImpl: typeof fetch,
): Promise<PublishResult> {
  const attachments: TelegramAttachment[] = [];
  const media: Array<{ id: string; media: { type: "photo" | "video"; media: string } }> = [];
  const blocks = posts.flatMap((post) => {
    const body = post.text.trim() ? [`<p>${richHtml(post.text, post.entities)}</p>`] : [];
    const items = post.media.flatMap((item) => {
      const id = `m${media.length + 1}`;
      const source = telegramMediaSource(item.fileId, item.vpsUrl, item.localPath, `rich-${id}`, attachments);
      if (!source) return [];
      const video = item.type === "VIDEO";
      media.push({ id, media: { type: video ? "video" : "photo", media: source } });
      return [video ? `<video src="tg://video?id=${id}"></video>` : `<img src="tg://photo?id=${id}"/>`];
    });
    return [...body, ...items];
  });
  const richMessage = { html: blocks.join(""), ...(media.length ? { media } : {}) };
  const request = attachments.length
    ? await telegramForm({ chat_id: chatId, rich_message: JSON.stringify(richMessage) }, attachments)
    : { chat_id: chatId, rich_message: richMessage };
  const result = await ambiguousExternalMutation("telegram", () =>
    telegramCall<TelegramResponse>(config, token, "sendRichMessage", request, fetchImpl),
  );
  return reactToPublishedMessage(normalizeTelegramResult(result, chatId), config, token, chatId, fetchImpl);
}

/** The site's entity renderer, in the tags rich HTML knows. */
function richHtml(text: string, entities: Record<string, unknown>[]): string {
  return entitiesToHtml(text, entities)
    .replaceAll(' rel="noopener noreferrer"', "")
    .replaceAll('<span class="spoiler">', "<tg-spoiler>")
    .replaceAll("</span>", "</tg-spoiler>");
}

function telegramLinkPreview(entities: unknown[] | undefined): { url: string; prefer_small_media: true; show_above_text: false } | null {
  for (const entity of entities ?? []) {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) continue;
    const value = entity as Record<string, unknown>;
    if (value.type !== "text_link" || typeof value.url !== "string") continue;
    try {
      const url = new URL(value.url);
      if (url.protocol === "http:" || url.protocol === "https:")
        return { url: value.url, prefer_small_media: true, show_above_text: false };
    } catch {
      // Ignore malformed links just as Telegram does for a plain message.
    }
  }
  return null;
}

/** Keeps a malformed queued caption inside Telegram's hard limit. */
function telegramCaption(text: string, entities: unknown[] | undefined): { text: string; entities: Record<string, unknown>[] } {
  const limit = 1024;
  let caption = text.slice(0, limit);
  // Do not split a surrogate pair; Telegram offsets are UTF-16 code units.
  if (caption.length > 0 && /[\uD800-\uDBFF]/.test(caption.at(-1) ?? "")) caption = caption.slice(0, -1);
  const length = caption.length;
  const safeEntities = (entities ?? []).flatMap((entity) => {
    if (!entity || typeof entity !== "object" || Array.isArray(entity)) return [];
    const value = entity as Record<string, unknown>;
    const offset = Number(value.offset);
    const entityLength = Number(value.length);
    if (!Number.isSafeInteger(offset) || !Number.isSafeInteger(entityLength) || offset < 0 || entityLength <= 0 || offset >= length)
      return [];
    return [{ ...value, offset, length: Math.min(entityLength, length - offset) }];
  });
  return { text: caption, entities: safeEntities };
}

async function telegramCall<T>(
  config: BackendConfig,
  token: string,
  method: string,
  payload: Record<string, unknown> | FormData,
  fetchImpl: typeof fetch,
): Promise<T> {
  const form = payload instanceof FormData;
  return requestJson<T>(fetchImpl, `${config.TELEGRAM_API_BASE_URL.replace(/\/$/, "")}/bot${token}/${method}`, {
    method: "POST",
    ...(form ? {} : { headers: { "Content-Type": "application/json" } }),
    body: form ? payload : JSON.stringify(payload),
  });
}

type TelegramAttachment = { name: string; localPath: string };

function telegramMediaSource(
  fileId: string | undefined,
  vpsUrl: string | undefined,
  localPath: string | undefined,
  attachmentName: string,
  attachments: TelegramAttachment[],
): string | undefined {
  if (fileId || vpsUrl) return fileId || vpsUrl;
  if (!localPath) return undefined;
  attachments.push({ name: attachmentName, localPath });
  return `attach://${attachmentName}`;
}

async function telegramForm(fields: Record<string, string>, attachments: TelegramAttachment[]): Promise<FormData> {
  const form = new FormData();
  for (const [key, value] of Object.entries(fields)) form.set(key, value);
  for (const attachment of attachments) form.set(attachment.name, Bun.file(attachment.localPath), path.basename(attachment.localPath));
  return form;
}

function normalizeTelegramResult(result: TelegramResponse, chatId: string): PublishResult {
  if (!result.ok) return { ok: false, error: result.description ?? "telegram_api_failed" };
  const records = Array.isArray(result.result) ? result.result : [result.result];
  const ids = records
    .map((record) => (record && typeof record === "object" ? (record as Record<string, unknown>).message_id : null))
    .filter((id): id is string | number => typeof id === "string" || typeof id === "number");
  const channel = chatId.startsWith("@") ? chatId.slice(1) : null;
  return { ok: true, id: ids[0] ?? null, ids, url: channel && ids[0] ? `https://t.me/${channel}/${ids[0]}` : null, raw: result };
}

async function reactToPublishedMessage(
  result: PublishResult,
  config: BackendConfig,
  token: string,
  chatId: string,
  fetchImpl: typeof fetch,
): Promise<PublishResult> {
  if (!result.ok || result.id == null) return result;
  try {
    await telegramCall<TelegramResponse>(
      config,
      token,
      "setMessageReaction",
      {
        chat_id: chatId,
        message_id: result.id,
        reaction: [{ type: "emoji", emoji: "❤" }],
        is_big: false,
      },
      fetchImpl,
    );
  } catch {
    // Reaction permission is optional and must not retry an already published post.
  }
  return result;
}
