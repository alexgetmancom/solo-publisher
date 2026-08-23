import { describe, expect, it } from "bun:test";
import { startLoop } from "../src/foundation/scheduler.js";

const tick = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** Waits for a count to be reached rather than for a fixed stretch of wall
 * clock. A loaded machine — the full test suite on one core — delivers 5ms
 * timers late, and a fixed 25ms sleep then counts two heartbeats where it
 * asked for three and fails a push gate that has nothing wrong with it. */
async function until(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition() && Date.now() < deadline) await tick(1);
}

describe("startLoop", () => {
  it("runs the task immediately rather than waiting out the first interval", async () => {
    let runs = 0;
    const loop = startLoop("immediate", 60_000, () => {
      runs += 1;
    });
    try {
      await tick(0);
      expect(runs).toBe(1);
    } finally {
      loop.stop();
    }
  });

  it("keeps running on the interval and stops on stop()", async () => {
    let runs = 0;
    const loop = startLoop("repeat", 5, () => {
      runs += 1;
    });
    await until(() => runs > 2);
    loop.stop();
    const afterStop = runs;
    expect(afterStop).toBeGreaterThan(2);

    await tick(40);
    expect(runs).toBe(afterStop);
  });

  it("waits for the in-flight task when stopped", async () => {
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = startLoop("draining", 60_000, () => gate);
    await tick(0);

    let stopped = false;
    const stopping = loop.stop().then(() => {
      stopped = true;
    });
    await tick(0);
    expect(stopped).toBe(false);

    release();
    await stopping;
    expect(stopped).toBe(true);
  });

  it("does not start a second pass while the previous one is still awaiting", async () => {
    let starts = 0;
    let release: () => void = () => {};
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const loop = startLoop("overlap", 5, async () => {
      starts += 1;
      await gate;
    });
    try {
      // Several intervals elapse while the first pass is parked on the gate.
      await tick(50);
      expect(starts).toBe(1);

      release();
      await tick(30);
      // Once the gate opens the loop resumes on its own schedule.
      expect(starts).toBeGreaterThan(1);
    } finally {
      loop.stop();
      release();
    }
  });

  it("survives a throwing task and runs again on the next interval", async () => {
    let runs = 0;
    const loop = startLoop("throwing", 5, () => {
      runs += 1;
      throw new Error("task blew up");
    });
    try {
      await until(() => runs > 2);
      expect(runs).toBeGreaterThan(2);
    } finally {
      loop.stop();
    }
  });

  it("survives a rejecting async task and clears the running flag", async () => {
    let runs = 0;
    const loop = startLoop("rejecting", 5, async () => {
      runs += 1;
      await Promise.reject(new Error("await blew up"));
    });
    try {
      await until(() => runs > 2);
      expect(runs).toBeGreaterThan(2);
    } finally {
      loop.stop();
    }
  });

  it("keeps heartbeats alive while an infrequent task is idle", async () => {
    let heartbeats = 0;
    const loop = startLoop("idle-heartbeat", 60_000, () => {}, {
      heartbeatIntervalMs: 5,
      onHeartbeat: () => {
        heartbeats += 1;
      },
    });
    try {
      await until(() => heartbeats > 2);
      expect(heartbeats).toBeGreaterThan(2);
    } finally {
      loop.stop();
    }
    const afterStop = heartbeats;
    await tick(20);
    expect(heartbeats).toBe(afterStop);
  });
});
