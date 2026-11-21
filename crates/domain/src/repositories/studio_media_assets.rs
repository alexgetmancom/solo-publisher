use db::rusqlite::types::Value as SqlValue;
use db::rusqlite::{Connection, OptionalExtension, Row, params, params_from_iter};

use super::{in_list, integers};
use crate::application::ports::{NewStudioMediaAsset, StudioMediaAssetRecord};
use crate::{Error, Result};

const COLUMNS: &str =
    r#""id", "actor_id", "kind", "mime_type", "filename", "local_path", "byte_size", "sha256", "source", "created_at""#;

fn asset(row: &Row<'_>) -> db::rusqlite::Result<StudioMediaAssetRecord> {
    Ok(StudioMediaAssetRecord {
        id: row.get(0)?,
        asset: NewStudioMediaAsset {
            actor_id: row.get(1)?,
            kind: row.get(2)?,
            mime_type: row.get(3)?,
            filename: row.get(4)?,
            local_path: row.get(5)?,
            byte_size: row.get(6)?,
            sha256: row.get(7)?,
            source: row.get(8)?,
            created_at: row.get(9)?,
        },
    })
}

/// Content-addressed Studio media metadata: one row per owner and SHA-256.
pub struct StudioMediaAssetStore<'a> {
    sqlite: &'a Connection,
}

impl<'a> StudioMediaAssetStore<'a> {
    pub fn new(sqlite: &'a Connection) -> Self {
        Self { sqlite }
    }

    pub fn find_by_owner_hash(&self, actor_id: i64, sha256: &str) -> Result<Option<StudioMediaAssetRecord>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(
                    r#"select {COLUMNS} from "studio_media_assets" where ("studio_media_assets"."actor_id" = ? and "studio_media_assets"."sha256" = ?)"#
                ),
                params![actor_id, sha256],
                asset,
            )
            .optional()?)
    }

    /// The new row, or `None` when the owner already has this file: the
    /// uniqueness is what makes "reuse the existing row" safe under
    /// concurrency.
    pub fn insert_if_absent(&self, input: &NewStudioMediaAsset) -> Result<Option<StudioMediaAssetRecord>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(
                    r#"insert into "studio_media_assets" ({COLUMNS}) values (null, ?, ?, ?, ?, ?, ?, ?, ?, ?) on conflict ("studio_media_assets"."actor_id", "studio_media_assets"."sha256") do nothing returning {COLUMNS}"#
                ),
                params![
                    input.actor_id,
                    input.kind,
                    input.mime_type,
                    input.filename,
                    input.local_path,
                    input.byte_size,
                    input.sha256,
                    input.source,
                    input.created_at
                ],
                asset,
            )
            .optional()?)
    }

    pub fn get(&self, id: i64) -> Result<Option<StudioMediaAssetRecord>> {
        Ok(self
            .sqlite
            .query_row(
                &format!(r#"select {COLUMNS} from "studio_media_assets" where "studio_media_assets"."id" = ?"#),
                [id],
                asset,
            )
            .optional()?)
    }

    pub fn list(&self, actor_ids: &[i64], limit: i64) -> Result<Vec<StudioMediaAssetRecord>> {
        let sql = format!(
            r#"select {COLUMNS} from "studio_media_assets" where {} order by "studio_media_assets"."id" limit ?"#,
            in_list(r#""studio_media_assets"."actor_id""#, actor_ids.len())
        );
        Ok(self
            .sqlite
            .prepare(&sql)?
            .query_map(
                params_from_iter(integers(actor_ids).chain([SqlValue::Integer(limit)])),
                asset,
            )?
            .collect::<db::rusqlite::Result<Vec<_>>>()?)
    }

    /// Every asset named, in the order first named, each owned by one of the
    /// actors; an error when any is not.
    pub fn require(&self, actor_ids: &[i64], asset_ids: &[i64]) -> Result<Vec<StudioMediaAssetRecord>> {
        if asset_ids.is_empty() {
            return Ok(Vec::new());
        }
        let mut ids: Vec<i64> = Vec::new();
        for id in asset_ids {
            if !ids.contains(id) {
                ids.push(*id);
            }
        }
        let sql = format!(
            r#"select {COLUMNS} from "studio_media_assets" where ({} and {})"#,
            in_list(r#""studio_media_assets"."actor_id""#, actor_ids.len()),
            in_list(r#""studio_media_assets"."id""#, ids.len())
        );
        let assets = self
            .sqlite
            .prepare(&sql)?
            .query_map(params_from_iter(integers(actor_ids).chain(integers(&ids))), asset)?
            .collect::<db::rusqlite::Result<Vec<_>>>()?;
        if assets.len() != ids.len() {
            return Err(Error::message(
                "One or more media assets are not available to this owner.",
            ));
        }
        Ok(ids
            .iter()
            .filter_map(|id| assets.iter().find(|asset| asset.id == *id).cloned())
            .collect())
    }
}
