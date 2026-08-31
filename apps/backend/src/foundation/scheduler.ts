import { log } from "./logger.js";

export type ScheduledLoop = {
  name: string;
  /** Runs the task now instead of at the next tick. A wake arriving mid-cycle
   * is not dropped: the cycle that is running may already have read the table,
   * so another one follows it. */
  wake: () => void;
  stop: () => Promise<void>;
};

type LoopHooks = {
  onStart?: () => void;
  onHeartbeat?: () => void;
  heartbeatIntervalMs?: number;
  onFinish?: (error: unknown | null) => void;
};

export function startLoop(name: string, intervalMs: number, task: () => void | Promise<void>, hooks: LoopHooks = {}): ScheduledLoop {
  let running = false;
  let stopped = false;
  let completion = Promise.resolve();
  const notify = (hook: (() => void) | undefined) => {
    if (!hook) return;
    try {
      hook();
    } catch (error) {
      log("warn", `${name} lifecycle hook failed`, { error: String(error) });
    }
  };
  let again = false;
  const run = () => {
    if (stopped) return;
    if (running) {
      again = true;
      return;
    }
    running = true;
    notify(hooks.onStart);
    completion = (async () => {
      let failure: unknown | null = null;
      try {
        await task();
      } catch (error) {
        failure = error;
        log("error", `${name} loop failed`, { error: String(error) });
      } finally {
        notify(() => hooks.onFinish?.(failure));
        running = false;
      }
      if (again) {
        again = false;
        run();
      }
    })();
  };
  const timer = setInterval(run, intervalMs);
  const heartbeatTimer =
    hooks.onHeartbeat && hooks.heartbeatIntervalMs ? setInterval(() => notify(hooks.onHeartbeat), hooks.heartbeatIntervalMs) : undefined;
  run();
  return {
    name,
    wake: run,
    stop: async () => {
      stopped = true;
      clearInterval(timer);
      if (heartbeatTimer) clearInterval(heartbeatTimer);
      await completion;
    },
  };
}
