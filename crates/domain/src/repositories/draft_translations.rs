use db::rusqlite::{Connection, OptionalExtension, params};

use super::{random_uuid, stamp, stamp_offset};
use crate::Result;
use crate::application::ports::{Clock, TranslationClaim};

/// A claimable row: queued and due, or claimed by a worker whose lease ran out.
/// A row left "translating" with no timestamp is already unowned, so it is
/// recovered on sight rather than left claimed forever.
const DUE: &str = r#"(("draft_translations"."status" = ? and ("draft_translations"."next_attempt_at" is null or "draft_translations"."next_attempt_at" <= ?)) or ("draft_translations"."status" = ? and ("draft_translations"."locked_at" is null or "draft_translations"."locked_at" < ?)))"#;

/// The machine-translation queue. One row per draft, claimed under a lease so
/// a worker killed mid-translation does not lose the draft's English: the next
/// cycle takes the row back and asks the model again. The row's absence is
/// what "this draft has its English" means.
pub struct DraftTranslationStore<'a> {
    sqlite: &'a Connection,
    clock: &'a dyn Clock,
}

impl<'a> DraftTranslationStore<'a> {
    pub fn new(sqlite: &'a Connection, clock: &'a dyn Clock) -> Self {
        Self { sqlite, clock }
    }

    /// An edited draft is translated again, and the row it left behind is the
    /// same work item: re-queueing resets the attempts rather than stacking a
    /// second one the primary key would refuse anyway.
    pub fn queue(&self, draft_id: i64) -> Result<()> {
        let now = stamp(self.clock);
        self.sqlite.execute(
            r#"insert into "draft_translations" ("draft_id", "status", "attempt_count", "next_attempt_at", "locked_by", "locked_at", "last_error", "created_at", "updated_at") values (?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict ("draft_translations"."draft_id") do update set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = ?, "locked_at" = ?, "last_error" = ?, "updated_at" = ?"#,
            params![
                draft_id, "queued", 0, now, None::<String>, None::<String>, None::<String>, now, now,
                "queued", 0, now, None::<String>, None::<String>, None::<String>, now
            ],
        )?;
        Ok(())
    }

    /// Whether the draft is still waiting for its English; a failed row is not.
    pub fn pending(&self, draft_id: i64) -> Result<bool> {
        let status: Option<String> = self
            .sqlite
            .query_row(
                r#"select "status" from "draft_translations" where "draft_translations"."draft_id" = ?"#,
                [draft_id],
                |row| row.get(0),
            )
            .optional()?;
        Ok(status.is_some_and(|status| status != "failed"))
    }

    pub fn claim_due(&self, lease_ms: i64) -> Result<Option<TranslationClaim>> {
        let now = stamp(self.clock);
        let cutoff = stamp_offset(self.clock, -lease_ms);
        let candidate: Option<i64> = self
            .sqlite
            .query_row(
                &format!(
                    r#"select "draft_id" from "draft_translations" where {DUE} order by "draft_translations"."created_at" asc, "draft_translations"."draft_id" asc"#
                ),
                params!["queued", now, "translating", cutoff],
                |row| row.get(0),
            )
            .optional()?;
        let Some(candidate) = candidate else { return Ok(None) };
        let locked_by = format!("translation:{}:{}", std::process::id(), random_uuid());
        // The claim carries the condition it was chosen under: another worker
        // that took this row between the select and here leaves it no longer
        // due, and this update then changes nothing instead of stealing a live
        // claim.
        let claimed = self
            .sqlite
            .query_row(
                &format!(
                    r#"update "draft_translations" set "status" = ?, "locked_by" = ?, "locked_at" = ?, "updated_at" = ? where ("draft_translations"."draft_id" = ? and {DUE}) returning "draft_id", "attempt_count""#
                ),
                params!["translating", locked_by, now, now, candidate, "queued", now, "translating", cutoff],
                |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
            )
            .optional()?;
        Ok(claimed.map(|(draft_id, attempt_count)| TranslationClaim {
            draft_id,
            attempt_count,
            locked_by,
        }))
    }

    /// The English is on the draft: the work item is done, if this worker
    /// still holds it.
    pub fn settle(&self, draft_id: i64, locked_by: &str) -> Result<()> {
        self.sqlite.execute(
            r#"delete from "draft_translations" where ("draft_translations"."draft_id" = ? and "draft_translations"."locked_by" = ?)"#,
            params![draft_id, locked_by],
        )?;
        Ok(())
    }

    /// Requeues with a growing delay, or gives up after `max_attempts`; only
    /// while this worker still holds the claim.
    pub fn fail(&self, draft_id: i64, locked_by: &str, error: &str, max_attempts: i64) -> Result<()> {
        let now = stamp(self.clock);
        let attempts: Option<i64> = self
            .sqlite
            .query_row(
                r#"select "attempt_count" from "draft_translations" where "draft_translations"."draft_id" = ?"#,
                [draft_id],
                |row| row.get(0),
            )
            .optional()?;
        let attempt = attempts.unwrap_or(0) + 1;
        let retry = attempt < max_attempts;
        self.sqlite.execute(
            r#"update "draft_translations" set "status" = ?, "attempt_count" = ?, "next_attempt_at" = ?, "locked_by" = ?, "locked_at" = ?, "last_error" = ?, "updated_at" = ? where ("draft_translations"."draft_id" = ? and "draft_translations"."locked_by" = ?)"#,
            params![
                if retry { "queued" } else { "failed" },
                attempt,
                retry.then(|| stamp_offset(self.clock, attempt * 5_000)),
                None::<String>,
                None::<String>,
                foundation::js::utf16_prefix_lossy(error, 500),
                now,
                draft_id,
                locked_by
            ],
        )?;
        Ok(())
    }
}
