import type { Context } from "grammy";
import { InlineKeyboard } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { BackendConfig } from "../foundation/config.js";
import type { MessageKey } from "../foundation/i18n/index.js";
import { t } from "../foundation/i18n/index.js";
import type { StudioLocale } from "../foundation/locale.js";
import { createStudioServices } from "../studio/services/index.js";
import { settingsService } from "../studio/services/settings.js";
import { FIELD_LIMIT, type StreamField, type StreamOutcome, type StreamPlace, type StudioStream } from "../studio/services/streams.js";
import { clearConversationState, getConversationState, saveConversationState } from "./conversation-state.js";
import { cancelPromptKeyboard } from "./dialog-ui.js";
import { executePublicationEffects, type PublicationEffect, type PublicationMessageResult } from "./effects.js";
import { screenCallback } from "./screen-callback.js";

const ASK: Record<StreamField, MessageKey> = {
  title: "stream.ask-title",
  description: "stream.ask-description",
  chat: "stream.ask-chat",
};

/** The stream screen: what every connected surface is showing right now, and
 * the things about it that can be changed from here. */
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
  // A button appears when at least one surface could act on it. Twitch takes a
  // title with nothing on the air; YouTube takes a description; only a live
  // stream has a chat.
  const editable = found.places.some((place) => place.editable);
  if (editable) keyboard.text(t(locale, "stream.edit-title"), screenCallback("stream_field", ["title"]));
  if (found.places.some((place) => place.editable && place.description !== null))
    keyboard.text(t(locale, "stream.edit-description"), screenCallback("stream_field", ["description"]));
  if (editable) keyboard.row();
  if (found.places.some((place) => place.live)) keyboard.text(t(locale, "stream.say"), screenCallback("stream_field", ["chat"])).row();
  keyboard.text(t(locale, "stream.refresh"), screenCallback("stream_home")).text(t(locale, "common.menu"), screenCallback("menu_home"));
  return { type: "screen", mode, text: streamText(locale, found), options: { reply_markup: keyboard } };
}

function streamText(locale: StudioLocale, found: StudioStream): string {
  if (!found.places.length) return t(locale, "stream.none");
  return found.places.map((place) => placeText(locale, place)).join("\n\n");
}

function placeText(locale: StudioLocale, place: StreamPlace): string {
  if (place.error) return t(locale, "stream.channel-error", { channel: place.label, error: place.error });
  if (!place.editable) return t(locale, "stream.place-idle", { channel: place.label });
  const lines = [
    t(locale, place.live ? "stream.on-air" : "stream.starting", { channel: place.label }),
    t(locale, "stream.title-line", { title: place.title || t(locale, "stream.description-empty") }),
  ];
  if (place.description !== null)
    lines.push(t(locale, "stream.description-line", { description: place.description.trim() || t(locale, "stream.description-empty") }));
  if (place.url) lines.push(place.url);
  return lines.join("\n");
}

/** Asks for the new value of one field, stating the strictest limit the
 * connected surfaces share and offering what the last stream used. */
export async function promptStreamField(
  ctx: Context,
  backendDb: BackendDb,
  config: BackendConfig,
  field: StreamField,
): Promise<PublicationEffect[]> {
  const actorId = Number(ctx.from?.id);
  const locale = settingsService(backendDb).locale(actorId);
  const found = await createStudioServices(backendDb, config).streams.current();
  // The screen was drawn while a stream was running and tapped after it ended.
  // Redrawing it alone would answer a tap on "Title" with a card that quietly
  // says something else, so the tap is answered in words as well.
  if (!found.places.some((place) => place.editable))
    return [{ type: "toast", text: t(locale, "stream.gone") }, streamScreen(locale, found, "edit")];
  saveConversationState(backendDb, actorId, { kind: "stream", draftId: null, step: field, data: {}, controlMessageId: null });
  return [
    {
      type: "screen",
      mode: "edit",
      text: t(locale, ASK[field], { current: currentValue(locale, found, field), limit: String(FIELD_LIMIT[field]) }),
      options: { reply_markup: cancelPromptKeyboard(locale, screenCallback("stream_home")) },
    },
  ];
}

/** What the prompt shows under "now": the value the surfaces agree on, or each
 * of them when they differ, since one typed line replaces all of them. */
function currentValue(locale: StudioLocale, found: StudioStream, field: StreamField): string {
  if (field === "chat") return "";
  const places = found.places.filter((place) => place.editable && (field === "title" || place.description !== null));
  const values = places.map((place) => {
    const value = (field === "title" ? place.title : (place.description ?? "")).trim();
    if (value) return `${place.label}: ${value}`;
    const previous = place.previous[field];
    return previous
      ? t(locale, "stream.previous", { channel: place.label, value: previous })
      : `${place.label}: ${t(locale, "stream.description-empty")}`;
  });
  return values.join("\n");
}

/**
 * Applies a value the operator typed to every surface that takes it.
 *
 * Nothing here throws. A tapped button ends in `runCallbackAction`, where a
 * failure becomes a toast; a typed message has no such boundary, so an error
 * raised here reached `bot.catch`, which logs -- and the operator, who had just
 * typed a new title, saw the bot say nothing at all.
 */
export async function handleStreamMessage(ctx: Context, backendDb: BackendDb, config: BackendConfig): Promise<PublicationMessageResult> {
  const actorId = Number(ctx.from?.id);
  const state = getConversationState(backendDb, actorId, "stream");
  if (!state) return { handled: false, effects: [] };
  const field: StreamField = state.step === "description" ? "description" : state.step === "chat" ? "chat" : "title";
  const locale = settingsService(backendDb).locale(actorId);
  const text = ctx.message && "text" in ctx.message ? (ctx.message.text ?? "") : "";
  if (!text.trim()) return { handled: true, effects: [{ type: "screen", mode: "reply", text: t(locale, "stream.need-text") }] };
  if (text.trim().length > FIELD_LIMIT[field])
    return {
      handled: true,
      effects: [
        {
          type: "screen",
          mode: "reply",
          text: t(locale, "stream.too-long", { limit: String(FIELD_LIMIT[field]), length: String(text.trim().length) }),
        },
      ],
    };
  clearConversationState(backendDb, actorId, "stream");
  const keyboard = new InlineKeyboard()
    .text(t(locale, "stream.back"), screenCallback("stream_home"))
    .text(t(locale, "common.menu"), screenCallback("menu_home"));
  const outcomes = await createStudioServices(backendDb, config).streams.apply(field, text.trim());
  return {
    handled: true,
    effects: [{ type: "screen", mode: "reply", text: report(locale, field, text.trim(), outcomes), options: { reply_markup: keyboard } }],
  };
}

/** One line per surface. Two surfaces answer the same edit differently --
 * Twitch renames a channel that is not streaming, YouTube has nothing to
 * rename -- and an operator who is told only "done" cannot tell which. */
function report(locale: StudioLocale, field: StreamField, value: string, outcomes: readonly StreamOutcome[]): string {
  const heading = t(locale, HEADING[field], { value });
  const lines = outcomes.map((outcome) =>
    t(
      locale,
      outcome.status === "done" ? "stream.result-done" : outcome.status === "skipped" ? "stream.result-skipped" : "stream.result-failed",
      {
        channel: outcome.label,
        detail: outcome.detail,
      },
    ),
  );
  return [heading, ...lines].join("\n");
}

const HEADING: Record<StreamField, MessageKey> = {
  title: "stream.title-changed",
  description: "stream.description-changed",
  chat: "stream.said",
};
