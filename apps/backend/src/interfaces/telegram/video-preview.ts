import { InlineKeyboard } from "grammy";
import { confirmationKeyboard } from "../../bot/dialog-ui.js";

import { publicationCallback } from "../../bot/publication-callback.js";
import { screenCallback } from "../../bot/screen-callback.js";
import type { BackendConfig } from "../../foundation/config.js";
import { t } from "../../foundation/i18n/index.js";
import type { StudioLocale } from "../../foundation/locale.js";
import { escapeMarkdown } from "../../foundation/markdown.js";
import {
  isAudienceMutationRetryable,
  isVideoTargetEditable,
  isVideoTargetMetadataEditable,
  isVideoTargetSchedulable,
} from "../../publishing/state.js";
import {
  type InstagramMetadata,
  VIDEO_TARGETS,
  type VideoTarget,
  videoTargetLabel,
  type YouTubeMetadata,
} from "../../publishing/video-types.js";
import { formatVideoTime } from "./video-time.js";

type VideoPreviewData = {
  draft: { id: number; label: string; locale: string; status: string };
  targets: Array<{
    id: number;
    target: string;
    status: string;
    metadataJson: unknown;
    scheduledAt: string | null;
    /** Required, not optional: the Story-of-a-lost-worker button exists only for
     * a provider route, and a projection that dropped this would hide it. */
    deliveryProvider: string | null;
  }>;
};

type VideoPreviewView = "overview" | "confirm_now" | "confirm_cancel" | "confirm_remove";

export function isVideoPreviewView(value: string | undefined): value is VideoPreviewView {
  return value === "overview" || value === "confirm_now" || value === "confirm_cancel" || value === "confirm_remove";
}

type VideoPreviewOptions = {
  view?: VideoPreviewView | undefined;
  revision?: number | null | undefined;
  target?: VideoTarget | undefined;
};

/** Telegram-only representation of a video draft. The video domain itself
 * exposes data and operations, never grammY markup or interface language. */
export function videoPreview(
  data: VideoPreviewData,
  config: Pick<BackendConfig, "TIMEZONE" | "TIMEZONE_LABEL">,
  locale: StudioLocale,
  options: VideoPreviewOptions = {},
): { text: string; keyboard: InlineKeyboard } {
  const { draft, targets } = data;
  const title = draft.label || t(locale, "vpreview.title-fallback");
  const lines = [
    `🎬 *${escapeMarkdown(title)}*`,
    `${t(locale, "vpreview.language")}: *${draft.locale.toUpperCase()}*`,
    `${t(locale, "vpreview.status")}: *${videoStatusLabel(draft.status, locale)}*`,
  ];
  const keyboard = new InlineKeyboard();
  const view = options.view ?? "overview";
  // One pass over the platforms this publication has, in catalogue order: the
  // controls are the same question for each of them, and written out per
  // platform they drifted -- YouTube's retry landed under Instagram's row, and
  // a scheduled target emitted its button without closing the row.
  for (const target of VIDEO_TARGETS) {
    const row = targets.find((candidate) => candidate.target === target);
    if (!row) continue;
    const label = videoTargetLabel(target);
    lines.push("", ...targetLines(target, row.metadataJson, locale));
    lines.push(
      `${t(locale, "vpreview.state")}: ${videoStatusLabel(row.status, locale)}${row.scheduledAt ? ` · ${formatVideoTime(row.scheduledAt, locale, config)}` : ""}`,
    );
    let controls = 0;
    const control = (text: string, callback: string) => {
      keyboard.text(text, callback);
      controls += 1;
    };
    if (isVideoTargetSchedulable(row.status))
      control(t(locale, "vpreview.time", { target: label }), publicationCallback("video", "time", [draft.id, target]));
    if (isVideoTargetEditable(row.status))
      control(t(locale, "vpreview.remove", { target: label }), publicationCallback("video", "remove_ask", [draft.id, target]));
    if (isAudienceMutationRetryable(row.status))
      control(t(locale, "vpreview.retry", { target: label }), publicationCallback("video", "retry", [draft.id, target, "card"]));
    // A publication that lost its worker cannot be retried -- nobody knows
    // whether it landed -- but a provider route can be asked, because the same
    // fenced request returns the post it already has instead of a second one.
    if (row.status === "verification_required" && row.deliveryProvider === "zernio")
      control(t(locale, "vpreview.settle", { target: label }), publicationCallback("video", "settle", [draft.id, target]));
    if (controls) keyboard.row();
  }
  if (view !== "overview") return videoConfirmationPreview(draft.id, lines.join("\n"), locale, view, options);
  // Publishing now and scheduling are the same pair of choices a text post
  // offers on its own card, and both use the shared publication actions.
  if (targets.length > 0 && (draft.status === "draft" || draft.status === "editing"))
    keyboard
      .text(t(locale, "post.publish-now-btn"), publicationCallback("video", "publish", [draft.id]))
      .row()
      .text(t(locale, "post.schedule-btn"), publicationCallback("video", "schedule", [draft.id]))
      .row();
  if (["draft", "editing", "scheduled"].includes(draft.status) && targets.some((target) => isVideoTargetMetadataEditable(target.status)))
    keyboard.text(t(locale, "vpreview.edit-details"), publicationCallback("video", "edit_menu", [draft.id])).row();
  // Nothing left to cancel once it is cancelled: the button would confirm a
  // question and change nothing.
  if (draft.status !== "cancelled")
    keyboard.text(t(locale, "vpreview.cancel-pub"), publicationCallback("video", "cancel", [draft.id])).row();
  keyboard.text(t(locale, "queue.back-btn"), screenCallback("queue_home"));
  return { text: lines.join("\n"), keyboard };
}

/** The fields one platform carries, as its own card section. Only this differs
 * between platforms; every control around it is the same. */
function targetLines(target: VideoTarget, metadataJson: unknown, locale: StudioLocale): string[] {
  if (target === "youtube_shorts") {
    const metadata = (metadataJson ?? {}) as Partial<YouTubeMetadata>;
    const lines = ["▶️ *YouTube Shorts*", `${t(locale, "vpreview.yt-title-label")}: ${escapeMarkdown(metadata.title || "—")}`];
    if (metadata.description) lines.push(`${t(locale, "vpreview.description")}: ${escapeMarkdown(metadata.description)}`);
    if (metadata.gameUrl) lines.push(`${t(locale, "vpreview.game")}: ${escapeMarkdown(metadata.gameUrl)}`);
    if (metadata.tags?.length) lines.push(`${t(locale, "vpreview.tags")}: ${escapeMarkdown(metadata.tags.join(", "))}`);
    return lines;
  }
  const metadata = (metadataJson ?? {}) as Partial<InstagramMetadata>;
  return ["📸 *Instagram Reels*", `${t(locale, "vpreview.description")}: ${escapeMarkdown(metadata.caption || "—")}`];
}

function videoConfirmationPreview(
  draftId: number,
  overviewText: string,
  locale: StudioLocale,
  view: Exclude<VideoPreviewView, "overview">,
  options: VideoPreviewOptions,
): { text: string; keyboard: InlineKeyboard } {
  if (view === "confirm_now") {
    return {
      text: `${overviewText}\n\n${t(locale, "video.publish-now-q")}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "video.publish-now-yes"), callback: publicationCallback("video", "publish_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("video", "view", [draftId, "overview"]) },
        options.revision,
      ),
    };
  }
  if (view === "confirm_cancel") {
    return {
      text: `${overviewText}\n\n⚠️ *${t(locale, "vpreview.cancel-confirm-q")}*\n${t(locale, "vpreview.cancel-confirm-warn")}`,
      keyboard: confirmationKeyboard(
        { label: t(locale, "vpreview.cancel-yes"), callback: publicationCallback("video", "cancel_confirm", [draftId]) },
        { label: t(locale, "common.back"), callback: publicationCallback("video", "view", [draftId, "overview"]) },
        options.revision,
      ),
    };
  }
  const target = options.target;
  if (!target) throw new Error("Video removal confirmation target is missing.");
  const label = videoTargetLabel(target);
  return {
    text: `${overviewText}\n\n⚠️ *${t(locale, "vpreview.remove-confirm-q", { target: label })}*\n${t(locale, "vpreview.remove-confirm-warn", { target: label })}`,
    keyboard: confirmationKeyboard(
      { label: t(locale, "vpreview.remove-yes", { target: label }), callback: publicationCallback("video", "remove", [draftId, target]) },
      { label: t(locale, "common.back"), callback: publicationCallback("video", "view", [draftId, "overview"]) },
      options.revision,
    ),
  };
}

function videoStatusLabel(status: string, locale: StudioLocale): string {
  const labels: Record<string, string> = {
    editing: t(locale, "vstatus.editing"),
    draft: t(locale, "vstatus.draft"),
    scheduled: t(locale, "vstatus.scheduled"),
    preparing: t(locale, "vstatus.preparing"),
    prepared: t(locale, "vstatus.prepared"),
    publishing: t(locale, "vstatus.publishing"),
    published: t(locale, "vstatus.published"),
    failed: t(locale, "vstatus.failed"),
    verification_required: t(locale, "vstatus.verification-required"),
    cancelled: t(locale, "vstatus.cancelled"),
  };
  return labels[status] ?? status;
}
