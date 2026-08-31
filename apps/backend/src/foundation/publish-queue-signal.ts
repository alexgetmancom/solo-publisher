/**
 * The publish queue's doorbell.
 *
 * The worker polls, so a post published "now" waited for the next tick -- five
 * seconds at worst, two and a half on average, on work a person is sitting and
 * watching. The poll stays as the safety net; this is how the common case stops
 * paying for it.
 *
 * The ring is deferred by one macrotask on purpose. Jobs are enqueued inside the
 * publication transaction, and bun:sqlite transactions are synchronous, so a
 * ring made in place would wake a worker that cannot see the row yet and send it
 * back to sleep for a full interval. By the time a timer callback runs, the
 * transaction has committed. Rings collapse while one is already pending: a
 * publication enqueues one job per target and needs exactly one wake.
 */
let wake: (() => void) | null = null;
let pending = false;

/** Called by the composition root once the queue loop exists. */
export function setPublishQueueWake(next: (() => void) | null): void {
  wake = next;
}

export function ringPublishQueue(): void {
  if (pending) return;
  pending = true;
  const timer = setTimeout(() => {
    pending = false;
    wake?.();
  }, 0);
  timer.unref?.();
}
