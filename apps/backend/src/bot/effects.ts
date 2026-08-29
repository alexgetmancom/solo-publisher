import type { Menu } from "@grammyjs/menu";
import { type Context, type InlineKeyboard, InputFile } from "grammy";
import type { BackendDb } from "../db/client.js";
import type { StudioLocale } from "../foundation/locale.js";
import { log } from "../foundation/logger.js";
import { setTelegramPostCard, setTelegramPostProgressCard, setTelegramVideoCard } from "../interfaces/telegram/control-cards.js";
import { sendTelegramDeliveryPreviews } from "../interfaces/telegram/delivery-previews.js";
import type { DeliveryProjection } from "../studio/projections.js";
import type { ConversationStateInput } from "./conversation-state.js";
import { clearConversationState, saveConversationState } from "./conversation-state.js";
import { callbackMessageId } from "./telegram-context.js";
import { isUnchangedMessageEdit } from "./telegram-errors.js";

type PublicationCard =
  | { kind: "post"; draftId: number }
  | { kind: "post-progress"; draftId: number; details?: boolean }
  | { kind: "video"; draftId: number };

/** Effects emitted by publication handlers and interpreted by one Telegram executor. */
export type PublicationEffect =
  | { type: "answer-callback"; text?: string; showAlert?: boolean }
  | { type: "toast"; text: string; showAlert?: boolean }
  /** The answer to what the operator just did. Answering a tap, it replaces the
   * message that was tapped; answering a typed message -- or following anything
   * this same update has already sent -- it arrives as a new message. */
  | { type: "screen"; text: string; options?: Record<string, unknown>; card?: PublicationCard }
  /** Always a new message: output that must sit below what came before it, or
   * that arrives long after the tap it belongs to. */
  | { type: "message"; text: string; options?: Record<string, unknown>; card?: PublicationCard }
  | { type: "edit-reply-markup"; keyboard: InlineKeyboard }
  | { type: "photo"; path: string; options?: Record<string, unknown>; card?: PublicationCard }
  | { type: "delivery-previews"; projections: DeliveryProjection[]; locale: StudioLocale }
  | { type: "main-menu"; menu: Menu<Context>; text: string }
  | { type: "session"; operation: "clear"; kind: "post" | "video"; actorId: number }
  | { type: "session"; operation: "save"; actorId: number; state: ConversationStateInput };

export type PublicationMessageResult = {
  handled: boolean;
  effects: readonly PublicationEffect[];
};

/** Executes transport effects in order, keeping callback acknowledgements in one place. */
export async function executePublicationEffects(ctx: Context, backendDb: BackendDb, effects: readonly PublicationEffect[]): Promise<void> {
  // The message the operator tapped, for as long as it is still the last thing
  // in the chat. One update writes over it once; everything after that is sent
  // below, because an edit above a message just sent is a change nobody sees.
  const anchor = new ScreenAnchor(ctx);
  for (const effect of effects) {
    if (effect.type === "answer-callback") {
      await ctx.answerCallbackQuery(
        effect.text || effect.showAlert
          ? { ...(effect.text ? { text: effect.text } : {}), ...(effect.showAlert ? { show_alert: true } : {}) }
          : undefined,
      );
      continue;
    }
    if (effect.type === "toast") {
      await ctx.answerCallbackQuery({ text: effect.text, ...(effect.showAlert ? { show_alert: true } : {}) });
      continue;
    }
    if (effect.type === "screen" || effect.type === "message") {
      const messageId = await anchor.render(effect.type === "screen", effect.text, effect.options);
      if (messageId != null) bindCard(backendDb, ctx, effect.card, messageId);
      continue;
    }
    if (effect.type === "edit-reply-markup") {
      await ctx.editMessageReplyMarkup({ reply_markup: effect.keyboard });
      continue;
    }
    if (effect.type === "photo") {
      anchor.spend();
      const message = await ctx.replyWithPhoto(new InputFile(effect.path), effect.options);
      bindCard(backendDb, ctx, effect.card, message.message_id);
      continue;
    }
    if (effect.type === "delivery-previews") {
      anchor.spend();
      await sendTelegramDeliveryPreviews(ctx, effect.projections, effect.locale);
      continue;
    }
    if (effect.type === "main-menu") {
      await anchor.render(true, effect.text, { reply_markup: effect.menu });
      continue;
    }
    if (effect.operation === "clear") {
      clearConversationState(backendDb, effect.actorId, effect.kind);
    } else {
      saveConversationState(backendDb, effect.actorId, effect.state);
    }
  }
}

/** Where one update writes: over the tapped message while it is still the last
 * thing in the chat, and below it once anything else has been sent.
 *
 * Every screen used to say for itself whether it edited or replied, and the
 * same screen was reached both ways -- so "← Back" in the wizard answered with
 * a new message under the one it came from, and a tap on the edit menu left a
 * dead screen above the question it asked. */
class ScreenAnchor {
  private messageId: number | null;

  constructor(private readonly ctx: Context) {
    this.messageId = callbackMessageId(ctx);
  }

  /** Marks the anchor as no longer the last message in the chat. */
  spend(): void {
    this.messageId = null;
  }

  /** Renders one screen, returning the message it now lives on. */
  async render(overAnchor: boolean, text: string, options?: Record<string, unknown>): Promise<number | null> {
    const anchored = overAnchor ? this.messageId : null;
    if (anchored != null) {
      // Telegram refuses an edit that changes nothing, and refuses one on a
      // message carrying media at all. Neither is worth losing the answer over.
      try {
        await this.ctx.editMessageText(text, options);
        this.spend();
        return anchored;
      } catch (error) {
        if (isUnchangedMessageEdit(error)) {
          this.spend();
          return anchored;
        }
        log("warn", "screen could not be edited in place", { messageId: anchored, error: String(error) });
      }
    }
    this.spend();
    const message = await this.ctx.reply(text, options);
    return typeof message === "boolean" || !message ? null : message.message_id;
  }
}

function bindCard(backendDb: BackendDb, ctx: Context, card: PublicationCard | undefined, messageId: number): void {
  if (!card || ctx.chat?.id == null) return;
  const chatId = Number(ctx.chat.id);
  if (card.kind === "post") setTelegramPostCard(backendDb, card.draftId, chatId, messageId);
  else if (card.kind === "post-progress") setTelegramPostProgressCard(backendDb, card.draftId, chatId, messageId, Boolean(card.details));
  else setTelegramVideoCard(backendDb, card.draftId, chatId, messageId);
}
