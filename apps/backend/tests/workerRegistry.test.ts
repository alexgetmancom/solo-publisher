import { describe, expect, it } from "bun:test";
import { readFileSync } from "node:fs";
import { CORE_WORKER_NAMES, TELEGRAM_WORKER_NAMES } from "../src/foundation/runtime/worker-state.js";

/** Every loop the runtimes start, read out of the source. The names `status`
 * expects were written down a second time and drifted: the whole Telegram side
 * ran unwatched because nobody expected it. */
function loopNames(file: string): string[] {
  const source = readFileSync(new URL(file, import.meta.url), "utf8");
  return [...source.matchAll(/start(?:Worker|Interface)Loop\("([^"]+)"/g)].map((match) => match[1] as string);
}

describe("worker registry", () => {
  it("expects exactly the core loops the runtime starts", () => {
    expect([...loopNames("../src/runtime/workers.ts")].sort()).toEqual([...CORE_WORKER_NAMES].sort());
  });

  it("expects exactly the interface loops the Telegram runtime starts", () => {
    expect([...loopNames("../src/interfaces/telegram/worker.ts")].sort()).toEqual([...TELEGRAM_WORKER_NAMES].sort());
  });
});
