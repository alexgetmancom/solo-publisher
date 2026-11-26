//! The media a published post
//! carries in one locale swapped for a file on this host. The file becomes a
//! Content asset, the target is taken down and queued again, and the site
//! re-renders from the new asset. A target is required: a locale-wide swap
//! would also take down the Telegram channel post.

use std::borrow::Cow;
use std::path::Path;

use db::rusqlite::OptionalExtension;
use domain::studio::services::media::{ImportedMediaFile, MediaSource};
use serde_json::{Value, json};

use super::{Command, object, resolve, run_operation_command};
use crate::context::{OpError, OpResult, OperationContext};

pub(crate) struct MediaReplacement<'i> {
    pub reference: &'i str,
    pub locale: &'i str,
    pub file: &'i Path,
    pub target: &'i str,
    pub apply: bool,
}

/// `replacePublishedMedia`.
pub(crate) async fn replace_published_media(context: &OperationContext<'_>, input: &MediaReplacement<'_>) -> OpResult {
    let publication = resolve(context, input.reference)?;
    let actor_id: Option<i64> = context
        .sqlite()?
        .query_row(
            r#"select "actor_id" from "drafts" where "drafts"."post_id" = ?"#,
            [publication.post_id],
            |row| row.get(0),
        )
        .optional()?;
    let Some(actor_id) = actor_id else {
        return Err(OpError::failed(format!(
            "draft not found for publication: {}",
            publication.publication_key
        )));
    };
    let command = Command {
        action: "replace_media",
        reference: input.reference,
        target: Some(input.target),
        locale: Some(input.locale),
        ..Command::default()
    };
    // The scope report comes before the file is imported: a plan should not
    // leave an asset behind for a replacement never asked for.
    if !input.apply {
        return run_operation_command(context, &command).await;
    }
    let filename = input
        .file
        .file_name()
        .map(|name| name.to_string_lossy().into_owned())
        .unwrap_or_default();
    let config = context.config()?;
    let asset = context.services(&config)?.media.import_file(
        actor_id,
        &ImportedMediaFile {
            filename: &filename,
            content_type: foundation::media_types::media_content_type(&filename).unwrap_or(""),
            local_path: input.file,
            byte_size: None,
            source: MediaSource::OpsUpload,
        },
    )?;
    // `mediaItemsFromAssets([asset])`.
    let media = json!([{
        "type": asset.asset.kind,
        "assetId": asset.id,
        "localPath": asset.asset.local_path,
        "filename": asset.asset.filename,
        "mimeType": asset.asset.mime_type,
    }]);
    let result = run_operation_command(
        context,
        &Command {
            apply: true,
            media_json: Some(Cow::Owned(domain::json::stringify(&media))),
            actor_type: context.actor_type,
            ..command
        },
    )
    .await?;
    let mut result = object(result);
    result.insert("asset_id".into(), json!(asset.id));
    result.insert("filename".into(), json!(asset.asset.filename));
    result.insert("byte_size".into(), json!(asset.asset.byte_size));
    Ok(Value::Object(result))
}
