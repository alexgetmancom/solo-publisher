import { and, inArray, isNull, sql } from "drizzle-orm";
import { type BackendDb, unsafeDb } from "../db/client.js";
import { credentialChecks, publicationEvents, workerState } from "../db/schema.js";
import type { BackendConfig } from "../foundation/config.js";
import { expectedWorkerNames, workerLiveness } from "../foundation/runtime/worker-state.js";
import { capabilityReport } from "./capabilities.js";

/** Transport-neutral health snapshot for operators, APIs and future automation. */
export function healthReport(config: BackendConfig, backendDb: BackendDb) {
  const capabilities = capabilityReport(config, backendDb);
  const activeCapabilityTargets = new Set(capabilities.map((capability) => capability.target));
  const credentials = unsafeDb(backendDb)
    .db.select()
    .from(credentialChecks)
    .all()
    .filter((credential) => activeCapabilityTargets.has(credential.target));
  const expectedWorkers = expectedWorkerNames(Boolean(config.controllerBotToken));
  const expectedWorkerSet = new Set(expectedWorkers);
  const workers = unsafeDb(backendDb)
    .db.select()
    .from(workerState)
    .all()
    .filter((worker) => expectedWorkerSet.has(worker.name));
  const observedWorkers = new Set(workers.map((worker) => worker.name));
  const missingWorkers = expectedWorkers.filter((name) => !observedWorkers.has(name));
  const [pending] = unsafeDb(backendDb)
    .db.select({ count: sql<number>`count(*)` })
    .from(publicationEvents)
    .where(and(inArray(publicationEvents.severity, ["warn", "error"]), isNull(publicationEvents.ackedAt)))
    .all();
  const credentialsOk = credentials.every((check) => check.status === "ready");
  const workersOk =
    missingWorkers.length === 0 &&
    workers.every(
      (worker) =>
        worker.stateJson.ok !== false &&
        worker.stateJson.scheduler_error == null &&
        !workerLiveness(worker.stateJson, worker.updatedAt).stale,
    );
  const capabilitiesOk = capabilities.every((capability) => capability.status === "ready");
  return {
    ok: credentialsOk && workersOk && capabilitiesOk,
    generatedAt: new Date().toISOString(),
    capabilities,
    credentials,
    workers: workers.map((worker) => ({
      name: worker.name,
      state: worker.stateJson,
      updatedAt: worker.updatedAt,
      ...workerLiveness(worker.stateJson, worker.updatedAt),
    })),
    missingWorkers,
    pendingAlerts: Number(pending?.count ?? 0),
  };
}
