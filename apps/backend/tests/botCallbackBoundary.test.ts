import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { runCallbackBoundary } from "../src/bot/callback-boundary.js";
import type { BackendDb } from "../src/db/client.js";
import { StudioError } from "../src/foundation/errors.js";
import { withDb } from "./helpers/db.js";

function callbackContext(id: string, answers: Array<{ text?: string } | undefined>): Context {
  return {
    callbackQuery: { id, data: "preview:7" },
    from: { id: 42 },
    answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
  } as unknown as Context;
}

describe("Telegram callback boundary", () => {
  it("translates handler errors into an actionable toast", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      await runCallbackBoundary(callbackContext("boundary-error", answers), backendDb, async () => {
        throw new StudioError("err.post-not-yours");
      });

      expect(answers).toEqual([{ text: "Draft is not available to this user." }]);
    }));

  it("runs a redelivered callback only once", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      let executions = 0;
      const next = async () => {
        executions += 1;
      };
      await runCallbackBoundary(callbackContext("boundary-duplicate", answers), backendDb, next);
      await runCallbackBoundary(callbackContext("boundary-duplicate", answers), backendDb, next);

      expect(executions).toBe(1);
      expect(answers).toEqual([undefined]);
    }));
});
