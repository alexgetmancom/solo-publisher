import { and, eq, isNotNull, inArray } from "drizzle-orm";

import { type BackendDb, unsafeDb } from "../db/client.js";
import { videoDrafts, videoMetricSchedule, videoTargets } from "../db/schema/video.js";

/**
 * Puts frozen video metric rows back on the schedule.
 *
 * A row freezes when its platform says something that will not change by
 * itself — the post is gone, the credential is revoked. Anything the platform
 * says wrongly, or that stops being true, leaves a video collecting nothing
 * with no way back, which is what this is: the freeze is a judgement, and a
 * judgement needs an appeal.
 */
export function resumeVideoMetrics(backendDb: BackendDb, input: { apply: boolean; refs: number[] }): Record<string, unknown> {
  const rows = unsafeDb(backendDb)
    .db.select({
      videoTargetId: videoMetricSchedule.videoTargetId,
      videoDraftId: videoTargets.videoDraftId,
      target: videoTargets.target,
      label: videoDrafts.label,
      frozenAt: videoMetricSchedule.frozenAt,
      lastError: videoMetricSchedule.lastError,
    })
    .from(videoMetricSchedule)
    .innerJoin(videoTargets, eq(videoTargets.id, videoMetricSchedule.videoTargetId))
    .innerJoin(videoDrafts, eq(videoDrafts.id, videoTargets.videoDraftId))
    .where(
      and(isNotNull(videoMetricSchedule.frozenAt), ...(input.refs.length ? [inArray(videoTargets.videoDraftId, input.refs)] : [])),
    )
    .all();
  const now = new Date().toISOString();
  if (input.apply && rows.length)
    unsafeDb(backendDb)
      .db.update(videoMetricSchedule)
      .set({ frozenAt: null, nextCheckAt: now, errorCount: 0, lastError: null, lockedBy: null, lockedAt: null, updatedAt: now })
      .where(
        inArray(
          videoMetricSchedule.videoTargetId,
          rows.map((row) => row.videoTargetId),
        ),
      )
      .run();
  return {
    applied: input.apply,
    resumed: rows.length,
    videos: rows.map((row) => ({
      ref: `video:${row.videoDraftId}`,
      target: row.target,
      label: row.label,
      frozenAt: row.frozenAt,
      whyItStopped: row.lastError?.slice(0, 200) ?? null,
    })),
    note: "A resumed video is checked once on the next cycle. If the platform says the same thing again it freezes again, which is the answer to whether the cause is gone.",
  };
}
