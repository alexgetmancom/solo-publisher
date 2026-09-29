import { and, eq } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../../db/client.js";
import { interfaceBindings, type JsonValue } from "../../db/schema.js";

const TELEGRAM = "telegram";

type Binding = { chatId: number; messageId: number };
/** The draft card also carries the screen it is currently showing, so that a
 * repaint -- the English arriving, a publication moving on -- draws the screen
 * the operator is reading rather than putting them back on the overview. */
type DraftCardBinding = Binding & { view: string | null };
type AnalyticsDashboardCard = { chatId: number; messageId: number; section: "overview" | "posts" | "video"; days: 1 | 7 | 30 };

/** Every control card is the same (interfaceId, entityType, entityId) binding, differing
 * only in its entityType and optional presentation state. */
function setBinding(
  backendDb: BackendDb,
  entityType: string,
  entityId: number,
  chatId: number,
  messageId: number,
  state?: Record<string, JsonValue>,
): void {
  const now = new Date().toISOString();
  unsafeDb(backendDb)
    .db.insert(interfaceBindings)
    .values({
      interfaceId: TELEGRAM,
      entityType,
      entityId,
      conversationId: String(chatId),
      messageId: String(messageId),
      ...(state ? { stateJson: state } : {}),
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [interfaceBindings.interfaceId, interfaceBindings.entityType, interfaceBindings.entityId],
      set: { conversationId: String(chatId), messageId: String(messageId), ...(state ? { stateJson: state } : {}), updatedAt: now },
    })
    .run();
}

function getBinding(backendDb: BackendDb, entityType: string, entityId: number) {
  return unsafeDb(backendDb)
    .db.select()
    .from(interfaceBindings)
    .where(
      and(
        eq(interfaceBindings.interfaceId, TELEGRAM),
        eq(interfaceBindings.entityType, entityType),
        eq(interfaceBindings.entityId, entityId),
      ),
    )
    .get();
}

/** Telegram-only message references. Studio aggregates never need chat/message ids. */
export function setTelegramPostCard(backendDb: BackendDb, draftId: number, chatId: number, messageId: number, view?: string): void {
  setBinding(backendDb, "draft", draftId, chatId, messageId, { view: view ?? null });
}

export function telegramPostCard(backendDb: BackendDb, draftId: number): DraftCardBinding | null {
  const binding = getBinding(backendDb, "draft", draftId);
  if (!binding) return null;
  const view = binding.stateJson?.view;
  return {
    chatId: Number(binding.conversationId),
    messageId: Number(binding.messageId),
    view: typeof view === "string" ? view : null,
  };
}

/** Separate binding: a progress card is transient delivery UI, not the draft editor. */
export function setTelegramPostProgressCard(
  backendDb: BackendDb,
  draftId: number,
  chatId: number,
  messageId: number,
  details = false,
): void {
  setBinding(backendDb, "post_progress", draftId, chatId, messageId, { details });
}

export function telegramPostProgressCard(backendDb: BackendDb, draftId: number): (Binding & { details: boolean }) | null {
  const binding = getBinding(backendDb, "post_progress", draftId);
  return binding
    ? { chatId: Number(binding.conversationId), messageId: Number(binding.messageId), details: binding.stateJson?.details === true }
    : null;
}

export function setTelegramVideoCard(backendDb: BackendDb, videoDraftId: number, chatId: number, messageId: number): void {
  setBinding(backendDb, "video_draft", videoDraftId, chatId, messageId);
}

export function telegramVideoCard(backendDb: BackendDb, videoDraftId: number): Binding | null {
  const binding = getBinding(backendDb, "video_draft", videoDraftId);
  return binding ? { chatId: Number(binding.conversationId), messageId: Number(binding.messageId) } : null;
}

/** The last analytics screen is presentation state, so the Telegram adapter
 * can refresh it without sending the owner a new message every hour. */
export function setTelegramAnalyticsDashboard(
  backendDb: BackendDb,
  actorId: number,
  chatId: number,
  messageId: number,
  section: AnalyticsDashboardCard["section"],
  days: AnalyticsDashboardCard["days"],
): void {
  setBinding(backendDb, "analytics_dashboard", actorId, chatId, messageId, { section, days });
}

export function telegramAnalyticsDashboards(backendDb: BackendDb): Array<AnalyticsDashboardCard & { actorId: number }> {
  return unsafeDb(backendDb)
    .db.select()
    .from(interfaceBindings)
    .where(and(eq(interfaceBindings.interfaceId, TELEGRAM), eq(interfaceBindings.entityType, "analytics_dashboard")))
    .all()
    .flatMap((binding) => {
      const section = binding.stateJson?.section;
      const days = binding.stateJson?.days;
      if ((section !== "overview" && section !== "posts" && section !== "video") || (days !== 1 && days !== 7 && days !== 30)) return [];
      return [{ actorId: binding.entityId, chatId: Number(binding.conversationId), messageId: Number(binding.messageId), section, days }];
    });
}

export function clearTelegramAnalyticsDashboard(backendDb: BackendDb, actorId: number): void {
  unsafeDb(backendDb)
    .db.delete(interfaceBindings)
    .where(
      and(
        eq(interfaceBindings.interfaceId, TELEGRAM),
        eq(interfaceBindings.entityType, "analytics_dashboard"),
        eq(interfaceBindings.entityId, actorId),
      ),
    )
    .run();
}
