import { afterEach } from "bun:test";
import type { UnsafeBackendDb } from "../../src/db/client.js";
import { registerTestChannels, type TestChannelId } from "./channels.js";
import { openBackendDb } from "./open-db.js";

/** Open an in-memory backend DB for one test and always close it, even on
 * throw. Use for a single self-contained test body:
 *
 *   it("...", () => withDb((backendDb) => { ... }));
 *   it("...", async () => withDb(async (backendDb) => { ... }));
 */
export function withDb<T>(fn: (backendDb: UnsafeBackendDb) => T | Promise<T>, channels: readonly TestChannelId[] = []): Promise<T> {
  return withOpenDb(() => {
    const backendDb = openBackendDb(":memory:");
    registerTestChannels(backendDb, channels);
    return backendDb;
  }, fn);
}

/** withDb for a suite that opens its database its own way — a file on disk, a
 * fixed set of channels. The close is the part worth sharing; the open is not. */
export function withOpenDb<T>(open: () => UnsafeBackendDb, fn: (backendDb: UnsafeBackendDb) => T | Promise<T>): Promise<T> {
  const backendDb = open();
  return (async () => fn(backendDb))().finally(() => backendDb.close());
}

/** Call once per describe block to get a fresh in-memory DB per test, closed
 * automatically after each one via afterEach. Use when a test needs to open
 * the DB itself (e.g. before other setup) rather than inside a callback:
 *
 *   const testDb = useBackendDb();
 *   it("...", () => {
 *     const backendDb = testDb.open();
 *     ...
 *   });
 */
export function useBackendDb(channels: readonly TestChannelId[] = []): { open: () => UnsafeBackendDb } {
  let backendDb: UnsafeBackendDb | null = null;
  afterEach(() => {
    backendDb?.close();
    backendDb = null;
  });
  return {
    open: () => {
      backendDb = openBackendDb(":memory:");
      registerTestChannels(backendDb, channels);
      return backendDb;
    },
  };
}
