//! Best-effort edits of content that has
//! already left this system, through each target's edit port.

use std::rc::Rc;

use adapters::{EditRequest, TargetRouting, Unprepared, create_platform_adapters};
use content::Locale;
use domain::application::publication_ref::{PublicationRefKind, parse_publication_ref};
use domain::targets::target_locale;
use futures_util::future::join_all;
use serde::Deserialize;
use serde_json::{Map, Value};

use crate::external_removals::NoStories;
use crate::{Delivery, Result};

/// What an operator asked to edit (`PublishedTargetEdit`).
#[derive(Clone, Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PublishedTargetEdit {
    pub publication_key: String,
    pub text_ru: Option<String>,
    pub text_en: Option<String>,
    pub target: Option<String>,
    /// `ru` or `en`.
    pub locale: Option<String>,
}

struct EditableRow {
    target: String,
    external_id: String,
    external_id_count: usize,
}

/// `editPublishedTargets`: one record per published target the edit
/// reached — its port's answer, a skip, or the error it failed with.
pub async fn edit_published_targets(
    delivery: &Delivery<'_>,
    edit: &PublishedTargetEdit,
) -> Result<Vec<Map<String, Value>>> {
    let sqlite = delivery.sqlite();
    let source = match parse_publication_ref(Some(&edit.publication_key)) {
        Some(reference) if reference.kind == PublicationRefKind::Post => {
            Some(delivery.publishing().publication_source_from_db(reference.id)?)
        }
        _ => None,
    };
    let rows: Vec<(String, String, Option<String>, Option<String>)> = sqlite
        .prepare(
            r#"select "target", "status", "external_id", "external_ids_json" from "publication_targets" where "publication_targets"."publication_key" = ?"#,
        )?
        .query_map([&edit.publication_key], |row| {
            Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?))
        })?
        .collect::<db::rusqlite::Result<_>>()?;
    let editable: Vec<EditableRow> = rows
        .into_iter()
        .filter_map(|(target, status, external_id, ids)| {
            let external_id = external_id.filter(|_| status == "published")?;
            Some(EditableRow {
                external_id_count: match ids.as_deref().map(serde_json::from_str::<Value>) {
                    Some(Ok(Value::Array(ids))) => ids.len(),
                    _ => 1,
                },
                target,
                external_id,
            })
        })
        .filter(|row| edit.target.as_ref().is_none_or(|target| *target == row.target))
        .filter(|row| {
            edit.locale
                .as_deref()
                .is_none_or(|locale| target_locale(&row.target).map(Locale::as_str) == Some(locale))
        })
        .collect();
    let adapters = create_platform_adapters(
        delivery.adapters.clone(),
        Rc::new(Unprepared),
        Rc::new(NoStories),
        &TargetRouting::default(),
    );
    let results = join_all(editable.iter().map(|row| {
        let adapters = &adapters;
        let source = source.as_ref();
        async move {
            let mut record = Map::new();
            record.insert("target".into(), row.target.clone().into());
            let locale = target_locale(&row.target);
            let text = match locale {
                Some(Locale::Ru) => edit.text_ru.as_deref(),
                Some(Locale::En) => edit.text_en.as_deref(),
                None => None,
            }
            .filter(|text| !text.is_empty());
            let request = EditRequest {
                external_id: row.external_id.clone(),
                text: text.unwrap_or_default().to_owned(),
                chat_id: None,
                media_count: match (source, locale) {
                    (Some(source), Some(locale)) => source.locale(locale).media.len(),
                    _ => 0,
                },
                external_id_count: row.external_id_count,
            };
            let port = adapters.get(&row.target).and_then(|adapter| adapter.edit(&request));
            let (Some(port), Some(_), Some(_)) = (port, text, locale) else {
                record.insert("ok".into(), false.into());
                record.insert("skipped".into(), true.into());
                record.insert("error".into(), "no_edit_port_for_target".into());
                return record;
            };
            match port.await {
                Ok(outcome) => record.extend(outcome.to_json()),
                Err(error) => {
                    record.insert("ok".into(), false.into());
                    record.insert("error".into(), error.message().into());
                }
            }
            record
        }
    }))
    .await;
    Ok(results)
}
