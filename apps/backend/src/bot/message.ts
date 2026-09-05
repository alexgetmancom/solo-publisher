import type { Context } from "grammy";
import type { DraftMessage } from "../content/message.js";

export function extractMessage(ctx: Context): DraftMessage {
  const message = ctx.message;
  const text = message && "text" in message ? (message.text ?? "") : message && "caption" in message ? (message.caption ?? "") : "";
  const entities =
    message && "entities" in message
      ? (message.entities ?? [])
      : message && "caption_entities" in message
        ? (message.caption_entities ?? [])
        : [];
  const media: Record<string, unknown>[] = [];
  const photos = message && "photo" in message ? message.photo : undefined;
  const photo = photos?.at(-1);
  if (photo) media.push({ type: "photo", file_id: photo.file_id, width: photo.width, height: photo.height, file_size: photo.file_size });
  if (message && "video" in message && message.video) {
    media.push({
      type: "video",
      file_id: message.video.file_id,
      width: message.video.width,
      height: message.video.height,
      duration: message.video.duration,
      file_size: message.video.file_size,
    });
  }
  // A soundless video arrives as an animation, and the Bot API fills `document`
  // with the same file for backward compatibility. Taking both put one attached
  // file into the draft twice, and the album carrying the twin file id was
  // rejected whole by the Bot API server.
  const animation = message && "animation" in message ? message.animation : undefined;
  if (animation) {
    media.push({
      type: "video",
      file_id: animation.file_id,
      width: animation.width,
      height: animation.height,
      duration: animation.duration,
      file_name: animation.file_name,
      mime_type: animation.mime_type,
      file_size: animation.file_size,
    });
  }
  const document = message && "document" in message && !animation ? message.document : undefined;
  const documentName = document?.file_name ?? "";
  const documentMimeType = document?.mime_type ?? "";
  if (document && (documentMimeType.toLowerCase().startsWith("video/") || /\.(mp4|m4v|mov|webm|mkv|gif)$/i.test(documentName))) {
    media.push({
      type: "video",
      file_id: document.file_id,
      file_name: documentName || undefined,
      mime_type: documentMimeType || undefined,
      file_size: document.file_size,
    });
  }
  return { text, media, entities };
}
