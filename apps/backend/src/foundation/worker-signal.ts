/**
 * The doorbells of the two queues a person waits on.
 *
 * Both workers poll every five seconds. A publication therefore waited for the
 * next tick before it went out, and the card reporting it waited for another one
 * before it changed. The poll stays as the safety net; these are how the common
 * case stops paying for it.
 *
 * Every ring is deferred by one macrotask on purpose. Work is enqueued inside a
 * transaction and bun:sqlite runs those synchronously, so a ring made in place
 * would wake a worker that cannot see the row yet and send it back to sleep for
 * a full interval. By the time a timer callback runs, the transaction has
 * committed. Rings collapse while one is already pending: a publication enqueues
 * one job per target and needs exactly one wake.
 *
 * Two queues, one mechanism. A third would be a third entry here, not a third
 * copy of this file.
 */
export type WorkerQueue = "publish" | "telegram-events";

const wakes = new Map<WorkerQueue, () => void>();
const pending = new Set<WorkerQueue>();

/** Called by the composition root once the loop exists. */
export function setWorkerWake(queue: WorkerQueue, wake: (() => void) | null): void {
  if (wake) wakes.set(queue, wake);
  else wakes.delete(queue);
}

export function ringWorker(queue: WorkerQueue): void {
  if (pending.has(queue)) return;
  pending.add(queue);
  const timer = setTimeout(() => {
    pending.delete(queue);
    wakes.get(queue)?.();
  }, 0);
  timer.unref?.();
}
