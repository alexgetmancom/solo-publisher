import { describe, expect, it } from "bun:test";
import { ringWorker, setWorkerWake } from "../src/foundation/worker-signal.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("publish queue doorbell", () => {
  it("rings after the transaction that enqueued, not inside it", async () => {
    const rings: string[] = [];
    setWorkerWake("publish", () => rings.push("wake"));
    // Stands in for the publication transaction: bun:sqlite runs it
    // synchronously, so nothing may wake a worker until it has finished.
    const committed: string[] = [];
    ringWorker("publish");
    committed.push("commit");
    expect(rings).toEqual([]);
    await tick();
    expect(rings).toEqual(["wake"]);
    expect(committed).toEqual(["commit"]);
    setWorkerWake("publish", null);
  });

  it("collapses the jobs of one publication into a single wake", async () => {
    let rings = 0;
    setWorkerWake("publish", () => {
      rings += 1;
    });
    for (let target = 0; target < 5; target += 1) ringWorker("publish");
    await tick();
    expect(rings).toBe(1);
    setWorkerWake("publish", null);
  });

  it("is harmless before a queue loop exists", async () => {
    setWorkerWake("publish", null);
    expect(() => ringWorker("publish")).not.toThrow();
    await tick();
  });
});

describe("two queues, one mechanism", () => {
  it("rings each queue independently", async () => {
    const rung: string[] = [];
    setWorkerWake("publish", () => rung.push("publish"));
    setWorkerWake("telegram-events", () => rung.push("telegram-events"));
    ringWorker("telegram-events");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rung).toEqual(["telegram-events"]);
    ringWorker("publish");
    await new Promise((resolve) => setTimeout(resolve, 5));
    expect(rung).toEqual(["telegram-events", "publish"]);
    setWorkerWake("publish", null);
    setWorkerWake("telegram-events", null);
  });
});
