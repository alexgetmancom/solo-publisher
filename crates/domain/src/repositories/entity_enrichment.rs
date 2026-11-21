use content::entity_enrichment::{CatalogEntity, EntityAlias, LinkRole, LocaleText};
use db::rusqlite::{Connection, params};

use crate::{Error, Result};

/// The reviewed catalogue deterministic enrichment matches drafts against:
/// content's enrichment port over SQLite. Over a transaction's connection, the
/// links land with the publication.
pub struct EntityEnrichmentStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> EntityEnrichmentStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }
}

impl content::entity_enrichment::EntityEnrichmentStore for EntityEnrichmentStore<'_> {
    type Error = Error;

    /// Each locale's text, the author's approved text over the source.
    fn locales(&mut self, draft_id: i64) -> Result<Vec<LocaleText>> {
        Ok(self
            .sqlite
            .prepare(
                r#"select "locale", coalesce("approved_text", "source_text", '') from "post_locales" where ("post_locales"."draft_id" = ? and "post_locales"."locale" in (?, ?))"#,
            )?
            .query_map(params![draft_id, "ru", "en"], |row| {
                Ok(LocaleText {
                    locale: row.get(0)?,
                    text: row.get(1)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    fn entities(&mut self) -> Result<Vec<CatalogEntity>> {
        Ok(self
            .sqlite
            .prepare(
                r#"select "id", "kind", "parent_entity_id", "slug", "title_ru", "title_en" from "knowledge_entities" where "knowledge_entities"."kind" in (?, ?, ?)"#,
            )?
            .query_map(params!["company", "model", "topic"], |row| {
                Ok(CatalogEntity {
                    id: row.get(0)?,
                    kind: row.get(1)?,
                    parent_entity_id: row.get(2)?,
                    slug: row.get(3)?,
                    title_ru: row.get(4)?,
                    title_en: row.get(5)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    fn aliases(&mut self) -> Result<Vec<EntityAlias>> {
        Ok(self
            .sqlite
            .prepare(r#"select "entity_id", "alias" from "knowledge_entity_aliases""#)?
            .query_map([], |row| {
                Ok(EntityAlias {
                    entity_id: row.get(0)?,
                    alias: row.get(1)?,
                })
            })?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    /// Links the draft to the entity, or changes the role of the link it has.
    fn link(&mut self, draft_id: i64, entity_id: i64, link_role: LinkRole, created_at: &str) -> Result<()> {
        self.sqlite.execute(
            r#"insert into "draft_entity_links" ("draft_id", "entity_id", "link_role", "created_at") values (?, ?, ?, ?) on conflict ("draft_entity_links"."draft_id", "draft_entity_links"."entity_id") do update set "link_role" = ?"#,
            params![draft_id, entity_id, link_role.as_str(), created_at, link_role.as_str()],
        )?;
        Ok(())
    }
}
