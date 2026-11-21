/// The idempotency fence one publish attempt runs under.
///
/// The provider deduplicates by this string, which is what makes a lost worker
/// safe: the same attempt asked twice returns the post it already made. It must
/// therefore be stable inside an attempt and different between them — a job row
/// is reused across retries, so its id alone would tie a target to its first
/// attempt forever and a retry after a settled failure could never publish
/// anything. `runAt` is rewritten each time the job is requeued, and never while
/// it is in flight, so the pair says exactly "this attempt".
pub fn zernio_publish_fence(job_id: i64, run_at: &str) -> String {
    format!("video-job:{job_id}:{run_at}")
}
