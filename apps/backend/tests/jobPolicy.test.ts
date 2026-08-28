import { describe, expect, it } from "bun:test";
import { failedJobTransition, partialPublicationTransition } from "../src/publishing/job-policy.js";

const policy = { maxAttempts: 4, backoffBaseSeconds: 60, backoffMaxSeconds: 3600 };

describe("publish job policy", () => {
  it("retries transient errors within the configured budget", () => {
    const transition = failedJobTransition(new Error("HTTP 503 service unavailable"), 0, policy);
    expect(transition).toMatchObject({ attempt: 1, errorClass: "transient", status: "queued" });
    expect(transition.nextAttemptAt).toBeString();
  });

  it("gives unknown errors one safe retry and does not retry permanent errors", () => {
    expect(failedJobTransition(new Error("unexpected parser failure"), 0, policy).status).toBe("queued");
    expect(failedJobTransition(new Error("unexpected parser failure"), 1, policy).status).toBe("failed");
    expect(failedJobTransition(new Error("HTTP 403 forbidden"), 0, policy).status).toBe("failed");
  });

  it("uses the same budget for reconciliation", () => {
    expect(partialPublicationTransition(0, policy).status).toBe("queued");
    expect(partialPublicationTransition(3, policy)).toEqual({ attempt: 4, status: "failed", nextAttemptAt: null });
  });
});
