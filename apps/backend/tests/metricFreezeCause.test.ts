import { describe, expect, it } from "bun:test";
import { describeMetricFreeze, isQuotaExhausted, isTerminalMetricError, terminalIfMissingRemoteObject } from "../src/analytics/collection/collectors/errors.js";

/** What YouTube answers when the project's daily budget is gone. It is a 403,
 * the same status a revoked credential gets, and the difference is only in the
 * body. */
const QUOTA_SPENT =
  'GET https://www.googleapis.com/youtube/v3/videos?part=snippet&id=nDuGSpdc4NM failed: 403 {\n  "error": {\n    "code": 403,\n    "message": "The request cannot be completed because you have exceeded your \\u003ca href=\\"/youtube/v3/getting-started#quota\\"\\u003equota\\u003c/a\\u003e.",\n    "errors": [{ "domain": "youtube.quota", "reason": "quotaExceeded" }]\n  }\n}';

describe("metric failure classification", () => {
  it("waits out a spent daily quota instead of freezing the video", () => {
    // A backfill can spend the day's budget in a morning, and every routine
    // reading after it got this. Frozen, twelve healthy videos stopped
    // collecting for good and the operator was told to reconnect a channel
    // that was never disconnected.
    const classified = terminalIfMissingRemoteObject(new Error(QUOTA_SPENT));
    expect(isQuotaExhausted(classified)).toBe(true);
    expect(isTerminalMetricError(classified)).toBe(false);
    expect(describeMetricFreeze("video:287", "youtube_shorts", QUOTA_SPENT)).toContain("daily quota");
  });

  it("still freezes a credential that was actually refused", () => {
    const refused = terminalIfMissingRemoteObject(new Error("failed: 403 insufficient authentication scopes"));
    expect(isTerminalMetricError(refused)).toBe(true);
    expect(describeMetricFreeze("video:1", "youtube_shorts", "failed: 403 insufficient authentication scopes")).toContain("Reconnect");
  });

  it("still freezes a post the platform no longer has", () => {
    const gone = terminalIfMissingRemoteObject(new Error('failed: 400 {"error_subcode":33,"message":"does not exist"}'));
    expect(isTerminalMetricError(gone)).toBe(true);
    expect(isQuotaExhausted(gone)).toBe(false);
  });
});
