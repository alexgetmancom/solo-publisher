import { describe, expect, it } from "bun:test";
import { and, eq } from "drizzle-orm";
import { clearConversationStateIfCurrent, getConversationState, saveConversationState } from "../src/bot/conversation-state.js";
import { type PostWizardStep, postStateStep, postStepData } from "../src/bot/post-flow.js";
import { clearVideoState, getVideoState, saveVideoState } from "../src/bot/video-ui.js";
import type { BackendDb } from "../src/db/client.js";
import { conversationSessions } from "../src/db/schema.js";
import { unsafeDb } from "../src/db/unsafe.js";
import { withDb } from "./helpers/db.js";

function setPostAdminState(
  db: BackendDb,
  actorId: number,
  step: PostWizardStep,
  draftId: number | null,
  controlMessageId: number | null,
): number {
  return saveConversationState(db, actorId, {
    kind: "post",
    draftId,
    step: step.type,
    data: postStepData(step),
    controlMessageId,
  }).revision;
}

function getPostState(db: BackendDb, actorId: number) {
  const state = getConversationState(db, actorId, "post");
  const step = postStateStep(state);
  return state
    ? { wizardStep: step, step, draft_id: state.draftId, control_message_id: state.controlMessageId, revision: state.revision }
    : null;
}

function clearPostAdminStateIfCurrent(
  db: BackendDb,
  actorId: number,
  step: PostWizardStep,
  draftId: number | null,
  expectedRevision: number,
): boolean {
  return clearConversationStateIfCurrent(db, { kind: "post", step: step.type, draftId }, actorId, expectedRevision);
}

describe("Telegram dialog state", () => {
  it("round-trips typed post wizard steps through short names and data", () => {
    const value = new Date("2026-08-04T12:34:56.000Z");
    const steps = [
      { type: "edit_text", locale: "ru" } as const,
      { type: "schedule_manual", locale: "ru" } as const,
      { type: "schedule_confirm", locale: "en", value } as const,
    ];

    for (const step of steps) {
      expect(postStateStep({ step: step.type, data: postStepData(step) })).toEqual(step);
    }
    expect(postStateStep({ step: "schedule_confirm", data: { locale: "ru", value: "not-a-date" } })).toBeNull();
  });

  it("stores the step name beside its structured parameters", () =>
    withDb(async (backendDb: BackendDb) => {
      setPostAdminState(backendDb, 42, { type: "edit_text", locale: "ru" }, 7, 9);
      expect(unsafeDb(backendDb).db.select().from(conversationSessions).where(eq(conversationSessions.actorId, 42)).get()).toMatchObject({
        step: "edit_text",
        dataJson: { locale: "ru" },
      });
      expect(getPostState(backendDb, 42)).toMatchObject({
        wizardStep: { type: "edit_text", locale: "ru" },
        step: { type: "edit_text", locale: "ru" },
      });

      unsafeDb(backendDb)
        .db.update(conversationSessions)
        .set({ step: "edit_text", dataJson: { locale: "en" } })
        .where(eq(conversationSessions.actorId, 42))
        .run();
      expect(getPostState(backendDb, 42)).toMatchObject({
        wizardStep: { type: "edit_text", locale: "en" },
        step: { type: "edit_text", locale: "en" },
      });
    }));

  it("increments post revisions and refuses to clear a newer dialog", () =>
    withDb(async (backendDb: BackendDb) => {
      const first = setPostAdminState(backendDb, 42, { type: "edit_text", locale: "ru" }, 7, 9);
      const second = setPostAdminState(backendDb, 42, { type: "edit_text", locale: "en" }, 7, 10);

      expect(second).toBe(first + 1);
      expect(clearPostAdminStateIfCurrent(backendDb, 42, { type: "edit_text", locale: "en" }, 7, first)).toBe(false);
      expect(clearPostAdminStateIfCurrent(backendDb, 42, { type: "edit_text", locale: "en" }, 7, second)).toBe(true);
      expect(getPostState(backendDb, 42)).toBeNull();
    }));

  it("increments video revisions and rejects writes from an older wizard", () =>
    withDb(async (backendDb: BackendDb) => {
      const first = saveVideoState(backendDb, 42, { draftId: null, step: "asset", selected: [], data: {} });
      const second = saveVideoState(backendDb, 42, { ...first, step: "schedule_choice" });

      expect(second.revision).toBe(first.revision + 1);
      expect(() => saveVideoState(backendDb, 42, first)).toThrow("action.session-stale");
      expect(getVideoState(backendDb, 42)).toMatchObject({ step: "schedule_choice", revision: second.revision });
    }));

  it("keeps the video control message in its column across a session reload", () =>
    withDb(async (backendDb: BackendDb) => {
      saveVideoState(backendDb, 42, {
        draftId: 7,
        step: "schedule_confirm",
        selected: ["youtube_shorts"],
        data: { schedule: { youtube_shorts: "2026-08-04T12:00:00.000Z" } },
        controlMessageId: 27,
      });

      expect(
        unsafeDb(backendDb).sqlite.prepare("SELECT control_message_id, data_json FROM conversation_sessions WHERE actor_id=?").get(42),
      ).toEqual({
        control_message_id: 27,
        data_json: JSON.stringify({ schedule: { youtube_shorts: "2026-08-04T12:00:00.000Z" }, selectedTargets: ["youtube_shorts"] }),
      });
      expect(getVideoState(backendDb, 42)).toMatchObject({ controlMessageId: 27 });
    }));

  it("retires a malformed individual schedule step", () =>
    withDb(async (backendDb: BackendDb) => {
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "video",
          draftId: 7,
          step: "schedule_target:youtube_shorts",
          dataJson: { selectedTargets: ["youtube_shorts"] },
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(getVideoState(backendDb, 42)).toBeNull();
    }));

  it("does not reuse a video revision after a session is cleared", () =>
    withDb(async (backendDb: BackendDb) => {
      const first = saveVideoState(backendDb, 42, { draftId: null, step: "asset", selected: [], data: {} });
      clearVideoState(backendDb, 42);
      const second = saveVideoState(backendDb, 42, { draftId: null, step: "asset", selected: [], data: {} });

      expect(second.revision).toBeGreaterThan(first.revision);
      expect(getVideoState(backendDb, 42)).toMatchObject({ revision: second.revision, step: "asset" });
    }));

  it("keeps one active conversation when settings input replaces a publication flow", () =>
    withDb(async (backendDb: BackendDb) => {
      setPostAdminState(backendDb, 42, { type: "edit_text", locale: "ru" }, 7, 9);
      saveConversationState(backendDb, 42, {
        kind: "settings",
        draftId: null,
        step: "timezone",
        data: {},
        controlMessageId: null,
      });

      expect(getConversationState(backendDb, 42, "post")).toBeNull();
      expect(getConversationState(backendDb, 42, "settings")).toMatchObject({ step: "timezone", revision: 1 });
    }));

  it("expires a stale post state instead of applying an old text reply", () =>
    withDb(async (backendDb: BackendDb) => {
      const expired = new Date(Date.now() - 31 * 60_000).toISOString();
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "post",
          step: "edit_text",
          draftId: 7,
          controlMessageId: 9,
          updatedAt: expired,
          expiresAt: expired,
        })
        .run();

      expect(getPostState(backendDb, 42)).toBeNull();
      expect(unsafeDb(backendDb).db.select().from(conversationSessions).where(eq(conversationSessions.actorId, 42)).get()).toMatchObject({
        revision: 1,
      });
    }));

  it("expires a stale video session instead of reopening its old wizard", () =>
    withDb(async (backendDb: BackendDb) => {
      const expired = new Date(Date.now() - 31 * 60_000).toISOString();
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "video",
          draftId: 7,
          step: "schedule_confirm",
          dataJson: { selectedTargets: ["youtube_shorts"] },
          updatedAt: expired,
          expiresAt: expired,
        })
        .run();

      expect(getVideoState(backendDb, 42)).toBeNull();
      expect(
        unsafeDb(backendDb)
          .db.select()
          .from(conversationSessions)
          .where(and(eq(conversationSessions.actorId, 42), eq(conversationSessions.kind, "video")))
          .get(),
      ).toMatchObject({
        active: 0,
      });
    }));

  it("drops malformed persisted state instead of dispatching an unknown step", () =>
    withDb(async (backendDb: BackendDb) => {
      unsafeDb(backendDb)
        .db.insert(conversationSessions)
        .values({
          actorId: 42,
          kind: "video",
          draftId: 7,
          step: "not-a-real-step",
          dataJson: { selectedTargets: ["youtube_shorts"] },
          updatedAt: new Date().toISOString(),
        })
        .run();

      expect(getVideoState(backendDb, 42)).toBeNull();
      expect(
        unsafeDb(backendDb)
          .db.select()
          .from(conversationSessions)
          .where(and(eq(conversationSessions.actorId, 42), eq(conversationSessions.kind, "video")))
          .get(),
      ).toMatchObject({
        active: 0,
      });
    }));
});
