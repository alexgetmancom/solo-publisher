import { describe, expect, it } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { eq } from "drizzle-orm";
import type { UnsafeBackendDb } from "../src/db/client.js";
import { credentialChecks, type JsonObject } from "../src/db/schema.js";
import {
  isTargetAuthBlocked,
  recordAuthFailure,
  recordAuthSuccess,
  recordTokenPing,
  shouldPingToken,
} from "../src/observability/auth-circuit.js";
import { newDeliveryPayload } from "../src/publishing/delivery-payload.js";
import { HttpPublishError } from "../src/publishing/errors.js";
import { claimDuePublishJobs, enqueuePublishJobTx, failPublishJob } from "../src/publishing/queue.js";
import { withOpenDb } from "./helpers/db.js";
import { openBackendDb } from "./helpers/open-db.js";

function tempDb() {
  const dir = mkdtempSync(join(tmpdir(), "alexgetman-auth-circuit-"));
  return openBackendDb(join(dir, "pipeline.db"), 5000);
}

const withTempDb = <T>(fn: (backendDb: UnsafeBackendDb) => T | Promise<T>): Promise<T> => withOpenDb(tempDb, fn);

describe("auth circuit breaker", () => {
  it("stays closed below the failure threshold", () =>
    withTempDb(async (backendDb) => {
      recordAuthFailure(backendDb, "test_platform");
      recordAuthFailure(backendDb, "test_platform");
      expect(isTargetAuthBlocked(backendDb, "test_platform")).toBe(false);
    }));

  it("trips after consecutive auth failures and clears on success", () =>
    withTempDb(async (backendDb) => {
      recordAuthFailure(backendDb, "test_platform");
      recordAuthFailure(backendDb, "test_platform");
      recordAuthFailure(backendDb, "test_platform");
      expect(isTargetAuthBlocked(backendDb, "test_platform")).toBe(true);

      recordAuthSuccess(backendDb, "test_platform");
      expect(isTargetAuthBlocked(backendDb, "telegram")).toBe(false);

      const row = backendDb.db.select().from(credentialChecks).where(eq(credentialChecks.target, "test_platform")).get();
      expect(JSON.parse(row?.detailsJson ?? "{}")).toEqual({ authFailureStreak: 0, blockedUntil: null });
    }));

  it("does not block a different target", () =>
    withTempDb(async (backendDb) => {
      recordAuthFailure(backendDb, "test_platform");
      recordAuthFailure(backendDb, "test_platform");
      recordAuthFailure(backendDb, "test_platform");
      expect(isTargetAuthBlocked(backendDb, "test_platform")).toBe(true);
      expect(isTargetAuthBlocked(backendDb, "telegram")).toBe(false);
    }));

  it("failPublishJob records an auth failure for a 401/403 HttpPublishError", () =>
    withTempDb(async (backendDb) => {
      const enqueue = (messageId: number) =>
        enqueuePublishJobTx(backendDb.db, {
          publicationKey: `post:${messageId}`,
          target: "test_platform",
          payload: newDeliveryPayload({ text: "hi" }),
        });

      for (let i = 0; i < 3; i++) {
        const id = enqueue(i);
        const [claimed] = claimDuePublishJobs(backendDb, 1);
        if (!claimed) throw new Error("job was not claimed");
        failPublishJob(backendDb, id, new HttpPublishError("unauthorized", 401), claimed.lockId);
      }

      expect(isTargetAuthBlocked(backendDb, "test_platform")).toBe(true);
    }));

  it("keeps the token-ping throttle across auth failures", () =>
    withTempDb(async (backendDb) => {
      recordTokenPing(backendDb, "test_platform");
      expect(shouldPingToken(backendDb, "test_platform", 3600)).toBe(false);
      // An auth failure used to rebuild the details blob from scratch, dropping
      // lastPingAt and un-throttling live probes against the very credential the
      // breaker exists to stop calling.
      recordAuthFailure(backendDb, "test_platform");
      expect(shouldPingToken(backendDb, "test_platform", 3600)).toBe(false);
    }));
});
