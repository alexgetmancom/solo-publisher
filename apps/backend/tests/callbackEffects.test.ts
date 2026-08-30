import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { runCallbackAction } from "../src/bot/callback-effects.js";
import { StudioError } from "../src/foundation/errors.js";
import { t } from "../src/foundation/i18n/index.js";
import { withDb } from "./helpers/db.js";

type Answer = { text?: string } | undefined;

function ctxWith(answers: Answer[], replies: string[]) {
  return {
    from: { id: 42 },
    chat: { id: 42 },
    answerCallbackQuery: async (options?: { text?: string }) => {
      answers.push(options);
      return true;
    },
    reply: async (text: string) => {
      replies.push(text);
      return { message_id: 1 };
    },
  } as unknown as Context;
}

describe("tapped controls", () => {
  it("acknowledges a tap that produced only a screen", () =>
    withDb(async (backendDb) => {
      const answers: Answer[] = [];
      const replies: string[] = [];
      await runCallbackAction(ctxWith(answers, replies), backendDb, { locale: "en", lockKey: "42:screen", describe: String }, async () => [
        { type: "screen", mode: "reply", text: "Done" },
      ]);
      expect(answers).toEqual([undefined]);
      expect(replies).toEqual(["Done"]);
    }));

  it("turns a failure into a toast instead of an unanswered tap", () =>
    withDb(async (backendDb) => {
      const answers: Answer[] = [];
      await runCallbackAction(
        ctxWith(answers, []),
        backendDb,
        { locale: "en", lockKey: "42:fails", describe: (error) => (error instanceof StudioError ? t("en", "intake.expired") : "?") },
        async () => {
          throw new StudioError("intake.expired");
        },
      );
      expect(answers).toEqual([{ text: t("en", "intake.expired") }]);
    }));

  it("refuses the second tap while the first is still running", () =>
    withDb(async (backendDb) => {
      const answers: Answer[] = [];
      let runs = 0;
      let release: () => void = () => undefined;
      const held = new Promise<void>((resolve) => {
        release = resolve;
      });
      const action = { locale: "en" as const, lockKey: "42:once", describe: String };
      const first = runCallbackAction(ctxWith(answers, []), backendDb, action, async () => {
        runs += 1;
        await held;
        return [];
      });
      await runCallbackAction(ctxWith(answers, []), backendDb, action, async () => {
        runs += 1;
        return [];
      });
      release();
      await first;

      expect(runs).toBe(1);
      expect(answers).toContainEqual({ text: t("en", "action.in-flight") });
    }));
});
