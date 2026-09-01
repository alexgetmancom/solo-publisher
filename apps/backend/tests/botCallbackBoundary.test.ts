import { describe, expect, it } from "bun:test";
import type { Context } from "grammy";
import { acknowledgeCallback, callbackRoute, runCallbackBoundary } from "../src/bot/callback-boundary.js";
import type { BackendDb } from "../src/db/client.js";
import { StudioError } from "../src/foundation/errors.js";
import { currentTapMeasurement, withTapMeasurement } from "../src/foundation/tap-measurement.js";
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

describe("what a tap is judged by", () => {
  it("stops the clock at the answer, not at the acknowledgement behind it", () =>
    withDb(async (backendDb: BackendDb) => {
      const acknowledgementMs = 150;
      const ctx = {
        callbackQuery: { id: "slow-ack", data: "queue_home", message: { message_id: 3 } },
        chat: { id: 100 },
        from: { id: 42 },
        // The acknowledgement goes out ahead of the queue and settles whenever
        // the event loop returns to it. Production has seen 950 ms of that in a
        // tap whose screen edit took 68 ms.
        answerCallbackQuery: () => Bun.sleep(acknowledgementMs),
        reply: async () => undefined,
      } as unknown as Context;

      const startedAt = performance.now();
      const answeredAt = await withTapMeasurement(async () => {
        acknowledgeCallback(ctx);
        await runCallbackBoundary(ctx, backendDb, async () => undefined);
        return currentTapMeasurement().answeredAt;
      });

      // The boundary still waits for the acknowledgement -- it just no longer
      // bills the operator for it.
      expect(performance.now() - startedAt).toBeGreaterThanOrEqual(acknowledgementMs);
      expect(answeredAt).not.toBeNull();
      expect((answeredAt ?? 0) - startedAt).toBeLessThan(acknowledgementMs / 2);
    }));
});

/** A tap on one button of one message, which is the only relation under which
 * one tap can stand in for another. */
function screenContext(id: string, data: string, messageId: number): Context {
  return {
    callbackQuery: { id, data, message: { message_id: messageId } },
    chat: { id: 100 },
    from: { id: 42 },
    answerCallbackQuery: async () => undefined,
    reply: async () => undefined,
  } as unknown as Context;
}

describe("superseded taps", () => {
  it("drops the page nobody would have seen and draws the one behind it", () =>
    withDb(async (backendDb: BackendDb) => {
      const drawn: string[] = [];
      const first = screenContext("burst-1", "queue_page:1", 9);
      const second = screenContext("burst-2", "queue_page:2", 9);
      // Both arrive before either is handled, which is what a burst is.
      acknowledgeCallback(first);
      acknowledgeCallback(second);

      await runCallbackBoundary(first, backendDb, async () => void drawn.push("page 1"));
      await runCallbackBoundary(second, backendDb, async () => void drawn.push("page 2"));

      expect(drawn).toEqual(["page 2"]);
    }));

  it("draws every tap on a button that is not supersedable", () =>
    withDb(async (backendDb: BackendDb) => {
      const drawn: string[] = [];
      const first = screenContext("toggle-1", "intake_target:youtube", 9);
      const second = screenContext("toggle-2", "intake_target:threads_ru", 9);
      acknowledgeCallback(first);
      acknowledgeCallback(second);

      await runCallbackBoundary(first, backendDb, async () => void drawn.push("youtube"));
      await runCallbackBoundary(second, backendDb, async () => void drawn.push("threads"));

      // Two toggles are two changes; the later one does not include the earlier.
      expect(drawn).toEqual(["youtube", "threads"]);
    }));

  it("keeps the same button on two different cards apart", () =>
    withDb(async (backendDb: BackendDb) => {
      const drawn: string[] = [];
      const first = screenContext("card-1", "progress:4", 11);
      const second = screenContext("card-2", "progress:5", 12);
      acknowledgeCallback(first);
      acknowledgeCallback(second);

      await runCallbackBoundary(first, backendDb, async () => void drawn.push("card 11"));
      await runCallbackBoundary(second, backendDb, async () => void drawn.push("card 12"));

      expect(drawn).toEqual(["card 11", "card 12"]);
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
