//! Folds an article's target jobs into its one status. An article is queued
//! for the targets it is queued for; nothing else can leave it unfinished, so
//! the shared `publication_status` fold is the whole rule.

use db::rusqlite::params;

use super::Publishing;
use super::state::publication_status;
use crate::Result;
use crate::application::publication_ref::{PublicationRefKind, publication_ref};

impl Publishing<'_> {
    pub fn refresh_article_status(&self, article_id: i64) -> Result<()> {
        let key = publication_ref(PublicationRefKind::Article, article_id);
        let statuses: Vec<String> = self
            .sqlite
            .prepare(r#"select "status" from "publish_jobs" where "publish_jobs"."publication_key" = ?"#)?
            .query_map([key], |row| row.get(0))?
            .collect::<db::rusqlite::Result<_>>()?;
        let Some(status) = publication_status(&statuses) else {
            return Ok(());
        };
        self.sqlite.execute(
            r#"update "articles" set "status" = ?, "updated_at" = ? where "articles"."id" = ?"#,
            params![status, self.now(), article_id],
        )?;
        Ok(())
    }
}
