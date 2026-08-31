import { describe, expect, it } from "bun:test";
import { ringPublishQueue, setPublishQueueWake } from "../src/foundation/publish-queue-signal.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 5));

describe("publish queue doorbell", () => {
  it("rings after the transaction that enqueued, not inside it", async () => {
    const rings: string[] = [];
    setPublishQueueWake(() => rings.push("wake"));
    // Stands in for the publication transaction: bun:sqlite runs it
    // synchronously, so nothing may wake a worker until it has finished.
    const committed: string[] = [];
    ringPublishQueue();
    committed.push("commit");
    expect(rings).toEqual([]);
    await tick();
    expect(rings).toEqual(["wake"]);
    expect(committed).toEqual(["commit"]);
    setPublishQueueWake(null);
  });

  it("collapses the jobs of one publication into a single wake", async () => {
    let rings = 0;
    setPublishQueueWake(() => {
      rings += 1;
    });
    for (let target = 0; target < 5; target += 1) ringPublishQueue();
    await tick();
    expect(rings).toBe(1);
    setPublishQueueWake(null);
  });

  it("is harmless before a queue loop exists", async () => {
    setPublishQueueWake(null);
    expect(() => ringPublishQueue()).not.toThrow();
    await tick();
  });
});
