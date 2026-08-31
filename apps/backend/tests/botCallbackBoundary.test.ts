import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { acknowledgeCallback, callbackRoute, runCallbackBoundary } from "../src/bot/callback-boundary.js";
import type { BackendDb } from "../src/db/client.js";
import { StudioError } from "../src/foundation/errors.js";
import { withDb } from "./helpers/db.js";

function callbackContext(id: string, answers: Array<{ text?: string } | undefined>, replies: string[] = []): Context {
  return {
    callbackQuery: { id, data: "preview:7" },
    from: { id: 42 },
    answerCallbackQuery: async (options?: { text?: string }) => void answers.push(options),
    reply: async (text: string) => void replies.push(text),
  } as unknown as Context;
}

/** The two middlewares in the order the bot installs them: answer on arrival,
 * then run the boundary once this tap's turn comes. */
async function handleCallback(ctx: Context, backendDb: BackendDb, next: () => Promise<void>): Promise<void> {
  acknowledgeCallback(ctx);
  await runCallbackBoundary(ctx, backendDb, next);
}

describe("Telegram callback boundary", () => {
  it("translates handler errors into an actionable toast", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      const replies: string[] = [];
      await handleCallback(callbackContext("boundary-error", answers, replies), backendDb, async () => {
        throw new StudioError("err.post-not-yours");
      });

      expect(answers).toEqual([undefined]);
      expect(replies).toEqual(["Draft is not available to this user."]);
    }));

  it("runs a redelivered callback only once", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      let executions = 0;
      const next = async () => {
        executions += 1;
      };
      await handleCallback(callbackContext("boundary-duplicate", answers), backendDb, next);
      await handleCallback(callbackContext("boundary-duplicate", answers), backendDb, next);

      expect(executions).toBe(1);
      expect(answers).toEqual([undefined, undefined]);
    }));

  it("acknowledges before work and redirects later callback text into the chat", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      const replies: string[] = [];
      const context = callbackContext("boundary-early-answer", answers, replies);
      await handleCallback(context, backendDb, async () => {
        expect(answers).toEqual([undefined]);
        await context.answerCallbackQuery({ text: "Finished" });
      });

      expect(answers).toEqual([undefined]);
      expect(replies).toEqual(["Finished"]);
    }));
});

describe("callback route grouping", () => {
  it("groups a menu button by its position, not by its payload hash", () => {
    // What production logged: the menu hash is raw bytes, so every tap on the
    // same button arrived as its own unique, unreadable route.
    expect(callbackRoute("main-menu/1/1//h\u00EFm\u00BF")).toBe("main-menu/1/1");
    expect(callbackRoute("main-menu/1/1//h\u0005\u2020q")).toBe("main-menu/1/1");
    expect(callbackRoute("settings-menu/2/0//h\u039D\u0398")).toBe("settings-menu/2/0");
  });

  it("keeps namespaced callbacks and collapses their identifiers", () => {
    expect(callbackRoute("p:post")).toBe("p:post");
    expect(callbackRoute("analytics_section:overview")).toBe("analytics_section:overview");
    expect(callbackRoute("preview:7")).toBe("preview:#");
    expect(callbackRoute(undefined)).toBe("unknown");
  });
});

describe("acknowledgement running alongside the handler", () => {
  // The acknowledgement is no longer awaited before the handler starts, so a
  // handler that answers for itself can now reach ctx.answerCallbackQuery while
  // the real answer is still in flight. Telegram accepts one answer per
  // callback: the second must arrive as a chat message, not as a lost toast or
  // a duplicate answer.
  it("turns a handler's own answer into a message even while the acknowledgement is in flight", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      const replies: string[] = [];
      let releaseAcknowledgement = (): void => {};
      const held = new Promise<void>((resolve) => {
        releaseAcknowledgement = resolve;
      });
      const ctx = {
        callbackQuery: { id: "concurrent-answer", data: "preview:7" },
        from: { id: 42 },
        answerCallbackQuery: async (options?: { text?: string }) => {
          answers.push(options);
          if (answers.length === 1) await held;
        },
        reply: async (text: string) => void replies.push(text),
      } as unknown as Context;

      acknowledgeCallback(ctx);
      const boundary = runCallbackBoundary(ctx, backendDb, async () => {
        await ctx.answerCallbackQuery({ text: "done" });
        releaseAcknowledgement();
      });
      await boundary;

      // One real answer -- the acknowledgement -- and the handler's toast as a message.
      expect(answers).toEqual([undefined]);
      expect(replies).toEqual(["done"]);
    }));

  it("still waits for the acknowledgement before the tap is finished", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      let acknowledged = false;
      const ctx = {
        callbackQuery: { id: "awaited-ack", data: "preview:7" },
        from: { id: 42 },
        answerCallbackQuery: async (options?: { text?: string }) => {
          answers.push(options);
          await new Promise((resolve) => setTimeout(resolve, 20));
          acknowledged = true;
        },
        reply: async () => {},
      } as unknown as Context;

      await handleCallback(ctx, backendDb, async () => {});
      expect(acknowledged).toBe(true);
    }));
});

describe("acknowledging ahead of the queue", () => {
  // The acknowledgement is what stops the spinner, and it is now sent when the
  // update arrives rather than when the handler gets its turn. A tap that waited
  // behind two others must still report the wait, or the number that matters
  // would look fine while the button visibly hung.
  it("answers before the handler runs and reports what the tap waited", () =>
    withDb(async (backendDb: BackendDb) => {
      const answers: Array<{ text?: string } | undefined> = [];
      const order: string[] = [];
      const ctx = {
        callbackQuery: { id: "ahead-of-queue", data: "preview:7" },
        from: { id: 42 },
        answerCallbackQuery: async (options?: { text?: string }) => {
          answers.push(options);
          order.push("acknowledged");
        },
        reply: async () => {},
      } as unknown as Context;

      acknowledgeCallback(ctx);
      // Standing in for the wait behind other taps.
      await new Promise((resolve) => setTimeout(resolve, 15));
      await runCallbackBoundary(ctx, backendDb, async () => {
        order.push("handled");
      });

      expect(order).toEqual(["acknowledged", "handled"]);
      expect(answers).toEqual([undefined]);
    }));

  it("drops a redelivery instead of handling it twice", () =>
    withDb(async (backendDb: BackendDb) => {
      let handled = 0;
      const context = (id: string) =>
        ({
          callbackQuery: { id, data: "preview:7" },
          from: { id: 42 },
          answerCallbackQuery: async () => {},
          reply: async () => {},
        }) as unknown as Context;

      const first = context("redelivered-once");
      acknowledgeCallback(first);
      await runCallbackBoundary(first, backendDb, async () => {
        handled += 1;
      });

      const again = context("redelivered-once");
      acknowledgeCallback(again);
      await runCallbackBoundary(again, backendDb, async () => {
        handled += 1;
      });

      expect(handled).toBe(1);
    }));
});
