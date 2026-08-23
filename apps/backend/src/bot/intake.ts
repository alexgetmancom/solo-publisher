import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import { targetsFor } from "../botTargets.js";
import { parseMarkdownArticle } from "../content/markdown.js";
import { type DraftMessage, firstNonEmptyLine } from "../content/message.js";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { storeTelegramVideo } from "../interfaces/telegram/video-ingress.js";
import { publishArticle } from "../publishing/article-publish.js";
import { settingsService } from "../studio/services/settings.js";
import { clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard } from "./dialog-ui.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { extractMessage } from "./message.js";
import { createPostFromMessage } from "./post-screen.js";
import { screenCallback } from "./screen-callback.js";
import { attachVideoAsset } from "./video-conversation.js";
import { saveVideoState } from "./video-ui.js";

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

/** Text this short is a post here. Not a theory about writing -- the operator's
 * own posts run under this, and their articles run well over it. Above it the
 * two are equally likely, so the question is asked instead of guessed.
 *
 * An article is written long or written in a file; nothing else is one. That is
 * the whole rule, which is why the short-text and bare-video readings need no
 * way back: they are not close calls. */
const POST_WITHOUT_ASKING = 900;

/** What captured material can become. A kind is offered only when the material
 * can actually become it -- a message with no video file cannot be a video
 * publication -- and never withheld because it merely looks unlikely. Length is
 * shown, never judged: a short piece can be an article and a long one a post. */
type MaterialKind = "post" | "article" | "video";

type CapturedVideo = { fileId: string; name: string; mime: string };
type Captured = { message: DraftMessage; markdown: string | null; video: CapturedVideo | null };

/** The one entry point for anything new. It captures the material first and
 * asks what it is second, because that is the order the operator has it in. */
export async function openIntake(ctx: Context, backendDb: BackendDb, mode: "reply" | "edit" = "reply"): Promise<void> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  saveConversationState(backendDb, actorId, { kind: "intake", draftId: null, step: "awaiting", data: {}, controlMessageId: null });
  await executePublicationEffects(ctx, backendDb, [
    {
      type: "screen",
      mode,
      text: t(locale, "intake.prompt"),
      options: { reply_markup: cancelPromptKeyboard(locale, screenCallback("intake_cancel")) },
    },
  ]);
}

/** Captures the first message of an intake and offers the kinds it could be. */
export async function handleIntakeMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  if (getConversationState(backendDb, actorId, "intake")?.step !== "awaiting") return { handled: false, effects: [] };
  // An album arrives as several messages and can only be a post, so there is
  // nothing to ask: the intake steps aside and the album collector assembles
  // every part of it into one draft.
  if (ctx.message && "media_group_id" in ctx.message && ctx.message.media_group_id) {
    clearConversationState(backendDb, actorId, "intake");
    return { handled: false, effects: [] };
  }
  const locale = settingsService(backendDb).locale(actorId);
  const message = extractMessage(ctx);
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  const markdown = document && isMarkdown(document) ? await downloadDocument(ctx, config, document) : null;
  const video = capturedVideo(ctx, message);
  // A voice note, a sticker, a PDF: the bot has no publication that carries it,
  // and capturing it anyway created an empty draft with an empty card. The
  // intake stays open, so the next message is still the first one.
  if (markdown === null && !message.text.trim() && message.media.length === 0)
    return { handled: true, effects: [{ type: "screen", mode: "reply", text: t(locale, "intake.unsupported") }] };
  const captured: Captured = { message: markdown === null ? message : { ...message, text: markdown }, markdown, video };
  saveConversationState(backendDb, actorId, {
    kind: "intake",
    draftId: null,
    step: "choose",
    data: captured as unknown as Record<string, unknown>,
    controlMessageId: null,
  });
  const decided = decideKind(captured);
  if (decided) return { handled: true, effects: await applyIntakeKind(ctx, backendDb, config, decided, "reply") };
  return { handled: true, effects: [chooseKindScreen(locale, captured)] };
}

/** The kind the material plainly is, or null when both readings are live.
 * Every rule here reads something the material carries, never how it reads. */
function decideKind(captured: Captured): MaterialKind | null {
  if (captured.markdown !== null) return "article";
  // A video file the operator sent without a caption: the caption is a post's
  // text, and a video publication gets its title and description in the wizard.
  if (captured.video) return captured.message.text.trim() ? null : "video";
  return captured.message.text.length <= POST_WITHOUT_ASKING ? "post" : null;
}

/** Acts on the kind the operator chose for the captured material. */
export async function applyIntakeKind(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  kind: MaterialKind,
  mode: "reply" | "edit" = "edit",
): Promise<PublicationEffect[]> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const captured = capturedFrom(backendDb, actorId);
  const asked = mode === "edit";

  if (kind === "post") {
    clearConversationState(backendDb, actorId, "intake");
    return createPostFromMessage(backendDb, config, actorId, captured.message);
  }

  if (kind === "article") {
    const { title, characters } = articleSummary(captured);
    saveConversationState(backendDb, actorId, {
      kind: "intake",
      draftId: null,
      step: "article_review",
      data: { ...(captured as unknown as Record<string, unknown>) },
      controlMessageId: null,
    });
    const keyboard = new InlineKeyboard()
      .text(t(locale, "intake.article-publish"), screenCallback("intake_kind", ["article_confirm"]))
      .row();
    if (!asked) keyboard.text(t(locale, "intake.rather-post"), screenCallback("intake_kind", ["post"])).row();
    keyboard.text(t(locale, "common.cancel"), screenCallback("intake_cancel"));
    return [
      {
        type: "screen",
        mode,
        text: t(locale, "intake.article-review", { title, characters: String(characters) }),
        options: { reply_markup: keyboard },
      },
    ];
  }

  if (!captured.video) throw new StudioError("intake.expired");
  saveConversationState(backendDb, actorId, {
    kind: "intake",
    draftId: null,
    step: "video_locale",
    data: captured as unknown as Record<string, unknown>,
    controlMessageId: null,
  });
  const keyboard = new InlineKeyboard()
    .text(t(locale, "video.language-ru"), screenCallback("intake_locale", ["ru"]))
    .text(t(locale, "video.language-en"), screenCallback("intake_locale", ["en"]))
    .row()
    .text(t(locale, "common.cancel"), screenCallback("intake_cancel"));
  return [{ type: "screen", mode, text: t(locale, "video.choose-language"), options: { reply_markup: keyboard } }];
}

/** Stores the video and hands it to the wizard in the chosen language. The file
 * is fetched only here: material corrected back to a post before this point
 * costs no download and leaves no asset behind. */
export async function applyIntakeVideoLocale(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  actorId: number,
  videoLocale: "ru" | "en",
): Promise<PublicationEffect[]> {
  const state = getConversationState(backendDb, actorId, "intake");
  if (state?.step !== "video_locale") throw new StudioError("intake.expired");
  const captured = capturedFrom(backendDb, actorId);
  if (!captured.video) throw new StudioError("intake.expired");
  const { assetId } = await storeTelegramVideo(ctx, backendDb, config, actorId, captured.video);
  clearConversationState(backendDb, actorId, "intake");
  const session = saveVideoState(backendDb, actorId, {
    draftId: null,
    step: "asset",
    selected: [],
    data: { videoLocale },
    controlMessageId: null,
  });
  return attachVideoAsset(backendDb, config, actorId, session, assetId);
}

/** Publishes the reviewed article to every connected target that carries one. */
export function publishReviewedArticle(backendDb: BackendDb, config: BackendConfig, actorId: number): { title: string } {
  const state = getConversationState(backendDb, actorId, "intake");
  if (state?.step !== "article_review") throw new StudioError("intake.expired");
  const captured = capturedFrom(backendDb, actorId);
  // Which targets carry an article, and in which language, is the catalogue's
  // answer; naming one here is how the bot and the publisher drift apart.
  const carriers = targetsFor("article");
  const [first] = carriers;
  if (!first) throw new StudioError("intake.no-article-target");
  const result = publishArticle(backendDb, config, {
    locale: first.locale,
    targets: carriers.filter(({ locale }) => locale === first.locale).map(({ id }) => String(id)),
    markdown: articleMarkdown(captured),
  }) as { title: string };
  clearConversationState(backendDb, actorId, "intake");
  return result;
}

export function cancelIntake(backendDb: BackendDb, actorId: number): void {
  clearConversationState(backendDb, actorId, "intake");
}

function chooseKindScreen(locale: StudioLocale, captured: Captured): PublicationEffect {
  const keyboard = new InlineKeyboard().text(t(locale, "intake.kind-post"), screenCallback("intake_kind", ["post"]));
  // Physics, not judgement: an Article carries no video, and a video
  // publication has nothing to publish without a file.
  if (!captured.video) keyboard.text(t(locale, "intake.kind-article"), screenCallback("intake_kind", ["article"]));
  else keyboard.text(t(locale, "intake.kind-video"), screenCallback("intake_kind", ["video"]));
  keyboard.row().text(t(locale, "common.cancel"), screenCallback("intake_cancel"));
  return {
    type: "screen",
    mode: "reply",
    text: t(locale, "intake.choose-kind", {
      characters: String(captured.message.text.length),
      media: String(captured.message.media.length),
    }),
    options: { reply_markup: keyboard },
  };
}

/** The title an article would carry: its own `# ` heading, or the first line,
 * which the confirmation card then shows so the choice is never silent. */
function articleSummary(captured: Captured): { title: string; characters: number } {
  const parsed = parseMarkdownArticle(articleMarkdown(captured));
  return { title: parsed.title, characters: parsed.body.text.length };
}

function articleMarkdown(captured: Captured): string {
  const source = captured.markdown ?? captured.message.text;
  if (/^#\s+\S/m.test(source)) return source;
  const first = firstNonEmptyLine(source, "Untitled");
  return `# ${first}\n\n${source.slice(source.indexOf(first) + first.length).trimStart()}`;
}

function capturedFrom(backendDb: BackendDb, actorId: number): Captured {
  const data = getConversationState(backendDb, actorId, "intake")?.data;
  const message = data?.message as DraftMessage | undefined;
  if (!message) throw new StudioError("intake.expired");
  return {
    message: { text: message.text ?? "", media: message.media ?? [], entities: message.entities ?? [] },
    markdown: typeof data?.markdown === "string" ? data.markdown : null,
    video: (data?.video as CapturedVideo | null) ?? null,
  };
}

function isMarkdown(document: { file_name?: string; mime_type?: string } | undefined): boolean {
  if (!document) return false;
  const name = (document.file_name ?? "").toLowerCase();
  return (document.mime_type ?? "").startsWith("text/markdown") || MARKDOWN_EXTENSIONS.some((extension) => name.endsWith(extension));
}

function capturedVideo(ctx: Context, message: DraftMessage): CapturedVideo | null {
  if (!message.media.some((item) => item.type === "video")) return null;
  const video = ctx.message && "video" in ctx.message ? ctx.message.video : undefined;
  const document = ctx.message && "document" in ctx.message ? ctx.message.document : undefined;
  const file = video ?? document;
  if (!file) return null;
  return {
    fileId: file.file_id,
    name: "file_name" in file ? (file.file_name ?? "") : "",
    mime: "mime_type" in file ? (file.mime_type ?? "") : "",
  };
}

/** An article a person wrote and a file that would take the process down with
 * it are told apart by size, and a Telegram file server that stops answering is
 * told apart from a slow one by the clock. Neither had a limit. */
const MARKDOWN_DOWNLOAD_LIMIT_BYTES = 1_000_000;
const MARKDOWN_DOWNLOAD_TIMEOUT_MS = 10_000;

async function downloadDocument(ctx: Context, config: BackendConfig, document: { file_id: string; file_size?: number }): Promise<string> {
  if (!config.controllerBotToken) throw new Error("Telegram bot token is not configured.");
  if ((document.file_size ?? 0) > MARKDOWN_DOWNLOAD_LIMIT_BYTES) throw new StudioError("intake.file-too-large");
  const file = await ctx.api.getFile(document.file_id);
  if (!file.file_path) throw new Error("Telegram did not return a file path.");
  const base = config.TELEGRAM_API_BASE_URL.replace(/\/$/, "");
  const response = await fetch(`${base}/file/bot${config.controllerBotToken}/${file.file_path}`, {
    signal: AbortSignal.timeout(MARKDOWN_DOWNLOAD_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`Telegram file download failed: ${response.status}`);
  // Telegram may report no size at all, so the body is measured as well: a
  // gigabyte of "markdown" must not be read into memory to find that out.
  if (Number(response.headers.get("content-length") ?? 0) > MARKDOWN_DOWNLOAD_LIMIT_BYTES) throw new StudioError("intake.file-too-large");
  const text = await response.text();
  if (text.length > MARKDOWN_DOWNLOAD_LIMIT_BYTES) throw new StudioError("intake.file-too-large");
  return text;
}
