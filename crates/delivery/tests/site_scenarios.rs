//! The site build queue, site media materialization and IndexNow, TypeScript
//! (`scripts/rust/site-scenarios.ts`) against Rust over the same scenarios
//! (`site_scenarios.json`): real ffmpeg on both sides, every file the build
//! leaves under the site directory compared by size, digest and link count.
//!
//! IndexNow sends are fire-and-forget on both sides; the `settleIndexNow` step
//! lets the one in flight finish (and, here, journals its failure) before
//! anything is observed.

mod support;

use std::collections::BTreeSet;
use std::os::unix::fs::MetadataExt as _;
use std::path::Path;

use content::Locale;
use content::message::MediaItem;
use delivery::site_content_index::site_urls_for_index_now;
use delivery::site_index_now::index_now_key;
use delivery::site_jobs::{
    SITE_JOB_LOCK_TIMEOUT_SECONDS, materialize_site_posts, recover_stale_site_jobs, run_site_job_cycle,
    settle_index_now,
};
use delivery::site_media::materialize_site_media;
use futures_util::FutureExt as _;
use futures_util::future::LocalBoxFuture;
use serde_json::{Map, Value, json};
use sha2::{Digest as _, Sha256};
use support::Scenario;

fn locale(value: &Value) -> Locale {
    match value.as_str() {
        Some("en") => Locale::En,
        _ => Locale::Ru,
    }
}

fn media(value: &Value) -> Vec<MediaItem> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|item| item.as_object().unwrap().clone())
        .collect()
}

fn keys(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .unwrap()
        .iter()
        .map(|key| key.as_str().unwrap().to_owned())
        .collect()
}

/// Every file under the directory: its path, size, digest and link count.
fn list_files(root: &Path) -> Value {
    fn walk(root: &Path, directory: &Path, out: &mut Vec<(String, Value)>) {
        for entry in std::fs::read_dir(directory).unwrap() {
            let entry = entry.unwrap();
            let kind = entry.file_type().unwrap();
            if kind.is_dir() {
                walk(root, &entry.path(), out);
            } else if kind.is_file() {
                let path = entry.path();
                let metadata = std::fs::metadata(&path).unwrap();
                let digest: String = Sha256::digest(std::fs::read(&path).unwrap())
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                let relative = path.strip_prefix(root).unwrap().to_string_lossy().into_owned();
                out.push((
                    relative.clone(),
                    json!({"path": relative, "size": metadata.len(), "sha256": digest, "links": metadata.nlink()}),
                ));
            }
        }
    }
    let mut files = Vec::new();
    if root.exists() {
        walk(root, root, &mut files);
    }
    files.sort_by(|left, right| left.0.cmp(&right.0));
    Value::Array(files.into_iter().map(|(_, file)| file).collect())
}

/// The IndexNow state file, with each pending URL's random revision dropped.
fn index_now_state(data: &Path) -> Value {
    let Ok(text) = std::fs::read_to_string(data.join("indexnow.json")) else {
        return Value::Null;
    };
    let state: Map<String, Value> = serde_json::from_str(&text).unwrap();
    let mut out = Map::new();
    out.insert("keys".into(), state.keys().cloned().collect::<Vec<_>>().into());
    for (key, value) in &state {
        let value = match (key.as_str(), value) {
            ("pending_urls", Value::Object(pending)) => pending.keys().cloned().collect::<Vec<_>>().into(),
            _ => value.clone(),
        };
        out.insert(key.clone(), value);
    }
    Value::Object(out)
}

fn call<'a>(scenario: &'a Scenario, name: &'a str, args: Vec<Value>) -> LocalBoxFuture<'a, Result<Value, String>> {
    async move {
        let delivery = scenario.delivery();
        let failed = |error: delivery::Error| error.to_string();
        match name {
            "cycle" => Ok(run_site_job_cycle(&delivery).await.map_err(failed)?.into()),
            "recoverStale" => {
                let age = args
                    .first()
                    .map_or(SITE_JOB_LOCK_TIMEOUT_SECONDS, |age| age.as_u64().unwrap());
                Ok(recover_stale_site_jobs(&delivery, age).map_err(failed)?.into())
            }
            "materialize" => {
                let keys = args.first().map(keys);
                let failures = materialize_site_posts(&delivery, keys.as_ref()).await.map_err(failed)?;
                Ok(failures
                    .entries()
                    .iter()
                    .map(|(key, message)| json!([key, message]))
                    .collect::<Vec<_>>()
                    .into())
            }
            "materializeMedia" => {
                let items = media(&args[2]);
                let post_id = args[0].as_i64().unwrap();
                let rendered = materialize_site_media(&delivery.adapters, post_id, locale(&args[1]), &items).await?;
                Ok(rendered.into_iter().map(Value::Object).collect::<Vec<_>>().into())
            }
            "materializeMediaFailure" => {
                let items = media(&args[2]);
                let post_id = args[0].as_i64().unwrap();
                match materialize_site_media(&delivery.adapters, post_id, locale(&args[1]), &items).await {
                    Ok(_) => Ok(Value::Null),
                    Err(message) => {
                        let shared = regex::Regex::new(r"^[^:]*: ffmpeg exit \d+").unwrap();
                        Ok(shared
                            .find(&message)
                            .map_or(message.clone(), |found| found.as_str().to_owned())
                            .into())
                    }
                }
            }
            "siteUrls" => {
                Ok(
                    site_urls_for_index_now(&scenario.db, delivery.config(), delivery.clock(), &keys(&args[0]))
                        .map_err(failed)?
                        .into(),
                )
            }
            "settleIndexNow" => {
                settle_index_now(&delivery).await.map_err(failed)?;
                Ok(Value::Null)
            }
            "indexNowState" => Ok(index_now_state(&scenario.data)),
            "indexNowKey" => Ok(index_now_key(delivery.config()).into()),
            "files" => Ok(list_files(&scenario.data.join(args[0].as_str().unwrap()))),
            other => Err(format!("unknown call {other}")),
        }
    }
    .boxed_local()
}

#[test]
fn site_scenarios_match_typescript() {
    support::compare("site_scenarios.json", "scripts/rust/site-scenarios.ts", call, "site");
}
