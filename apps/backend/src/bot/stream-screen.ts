import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import { StudioError } from "../foundation/errors.js";
import type { VideoLocale } from "../foundation/external/youtube.js";
import type { MessageKey } from "../foundation/i18n/index.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import {
  LIVE_CHAT_LIMIT,
  LIVE_DESCRIPTION_LIMIT,
  LIVE_TITLE_LIMIT,
  type LiveBroadcast,
  type StudioStream,
} from "../studio/services/streams.js";
import { clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard } from "./dialog-ui.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { screenCallback } from "./screen-callback.js";

/** What the screen can do to a running stream, each one a prompt for a single
 * line of text. Title and description edit the broadcast; chat says something
 * to the people watching it and cannot be taken back. */
type StreamField = "title" | "description" | "chat";

const FIELD_LIMIT: Record<StreamField, number> = {
  title: LIVE_TITLE_LIMIT,
  description: LIVE_DESCRIPTION_LIMIT,
  chat: LIVE_CHAT_LIMIT,
};

const ASK: Record<StreamField, MessageKey> = {
  title: "stream.ask-title",
  description: "stream.ask-description",
  chat: "stream.ask-chat",
};

/** The stream screen: what is on the air right now, and the two things about it
 * that can be changed from here. */
export async function showStreamScreen(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  mode: "reply" | "edit" = "reply",
): Promise<void> {
  const actorId = Number(ctx.from?.id);
  clearConversationState(backendDb, actorId, "stream");
  const locale = settingsService(backendDb).locale(actorId);
  const found = await createStudioServices(backendDb, config).streams.current();
  await executePublicationEffects(ctx, backendDb, [streamScreen(locale, found, mode)]);
}

function streamScreen(locale: StudioLocale, found: StudioStream, mode: "reply" | "edit"): PublicationEffect {
  const keyboard = new InlineKeyboard();
  if (found.chosen)
    keyboard
      .text(t(locale, "stream.edit-title"), screenCallback("stream_field", ["title"]))
      .text(t(locale, "stream.edit-description"), screenCallback("stream_field", ["description"]))
      .row();
  // Chat exists only while the stream is on the air, so the button appears
  // only when there is a chat to say it in.
  if (found.chosen?.broadcast.liveChatId) keyboard.text(t(locale, "stream.say"), screenCallback("stream_field", ["chat"])).row();
  keyboard.text(t(locale, "stream.refresh"), screenCallback("stream_home")).text(t(locale, "common.menu"), screenCallback("menu_home"));
  return { type: "screen", mode, text: streamText(locale, found), options: { reply_markup: keyboard } };
}

function streamText(locale: StudioLocale, found: StudioStream): string {
  const unreachable = found.channels.flatMap((channel) =>
    channel.error ? [t(locale, "stream.channel-error", { channel: channel.locale.toUpperCase(), error: channel.error })] : [],
  );
  if (!found.chosen) return [t(locale, "stream.none"), ...unreachable].join("\n\n");
  const { locale: channel, broadcast } = found.chosen;
  const state = broadcast.lifeCycleStatus === "live" || broadcast.lifeCycleStatus === "testing" ? "stream.on-air" : "stream.starting";
  return [
    t(locale, state, { channel: channel.toUpperCase() }),
    t(locale, "stream.title-line", { title: broadcast.title }),
    t(locale, "stream.description-line", {
      description: broadcast.description.trim() ? broadcast.description : t(locale, "stream.description-empty"),
    }),
    broadcast.url,
    ...unreachable,
  ].join("\n\n");
}

/** Asks for the new value of one field, remembering which channel the answer
 * belongs to so a stream that starts on the other one meanwhile is not the one
 * that gets edited. */
export async function promptStreamField(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  field: StreamField,
): Promise<PublicationEffect[]> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const found = await createStudioServices(backendDb, config).streams.current();
  if (!found.chosen) return [streamScreen(locale, found, "edit")];
  saveConversationState(backendDb, actorId, {
    kind: "stream",
    draftId: null,
    step: field,
    data: { channel: found.chosen.locale, liveChatId: found.chosen.broadcast.liveChatId },
    controlMessageId: null,
  });
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, ASK[field], {
        current: field === "chat" ? "" : found.chosen.broadcast[field] || t(locale, "stream.description-empty"),
        limit: String(FIELD_LIMIT[field]),
      }),
      options: { reply_markup: cancelPromptKeyboard(locale, screenCallback("stream_home")) },
    },
  ];
}

/** Applies a value the operator typed for the field the screen asked about. */
export async function handleStreamMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  const state = getConversationState(backendDb, actorId, "stream");
  if (!state) return { handled: false, effects: [] };
  const field: StreamField = state.step === "description" ? "description" : state.step === "chat" ? "chat" : "title";
  const locale = settingsService(backendDb).locale(actorId);
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text ?? "") : "";
  if (!text.trim()) return { handled: true, effects: [{ type: "screen", mode: "reply", text: t(locale, "stream.need-text") }] };
  clearConversationState(backendDb, actorId, "stream");
  const channel: VideoLocale = state.data.channel === "en" ? "en" : "ru";
  const streams = createStudioServices(backendDb, config).streams;
  const keyboard = new InlineKeyboard()
    .text(t(locale, "stream.back"), screenCallback("stream_home"))
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  if (field === "chat") {
    const liveChatId = typeof state.data.liveChatId === "string" ? state.data.liveChatId : "";
    if (!liveChatId) throw new StudioError("stream.gone");
    await streams.say(channel, liveChatId, text);
    return {
      handled: true,
      effects: [
        { type: "screen", mode: "reply", text: t(locale, "stream.said", { value: text.trim() }), options: { reply_markup: keyboard } },
      ],
    };
  }
  const updated = await streams.edit(channel, field === "title" ? { title: text } : { description: text });
  // The stream ended between the prompt and the answer: there is no broadcast
  // left that this value belongs to, and the next one is not it.
  if (!updated) throw new StudioError("stream.gone");
  return {
    handled: true,
    effects: [{ type: "screen", mode: "reply", text: confirmation(locale, field, updated), options: { reply_markup: keyboard } }],
  };
}

function confirmation(locale: StudioLocale, field: "title" | "description", broadcast: LiveBroadcast): string {
  return t(locale, field === "title" ? "stream.title-changed" : "stream.description-changed", {
    value: field === "title" ? broadcast.title : broadcast.description,
  });
}
