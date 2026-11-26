//! SQL equivalence of the Rust repositories with the recorded goldens: every
//! scenario in `scenarios.json` ran through the TypeScript backend's
//! repositories before the cutover (`scenarios.golden.json`) and runs through
//! these, each on its own fresh database migrated by its own side, and every
//! step's result and every table's rows must come out identical.

mod support;

use std::cell::Cell;
use std::path::{Path, PathBuf};

use content::entity_enrichment::{EntityEnrichmentStore as _, LinkRole};
use db::{BackendDb, unsafe_db};
use domain::application::conversation_flow::PublicationKind;
use domain::application::ports::{ApplicationPorts, ConversationSessionKind};
use jiff::Timestamp;
use serde::de::DeserializeOwned;
use serde_json::{Map, Value, json};
use support::{FixedClock, arg, differences, dump, instant, lookup, out, resolve};

fn spec_path() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenarios.json")
}

fn field<T: DeserializeOwned>(args: &[Value], name: &str) -> T {
    serde_json::from_value(args[0][name].clone()).unwrap_or_else(|error| panic!("field {name} of {args:?}: {error}"))
}

fn link_role(value: &str) -> LinkRole {
    match value {
        "focus" => LinkRole::Focus,
        "mention" => LinkRole::Mention,
        other => panic!("link role {other}"),
    }
}

/// One repository call by the name the spec records, arguments positional.
fn call(ports: &ApplicationPorts<'_>, name: &str, args: &[Value]) -> domain::Result<Value> {
    let int = |index| arg::<i64>(args, index);
    let ints = |index| arg::<Vec<i64>>(args, index);
    let text = |index| arg::<String>(args, index);
    let kind = |index| arg::<ConversationSessionKind>(args, index);
    Ok(match name {
        "drafts.create" => out(ports.drafts().create(&arg(args, 0))?),
        "drafts.get" => out(ports.drafts().get(int(0))?),
        "drafts.list" => out(ports.drafts().list(&ints(0), int(1))?),
        "drafts.update" => out(ports.drafts().update(int(0), &arg(args, 1))?),
        "drafts.updateIfCurrent" => out(ports
            .drafts()
            .update_if_current(int(0), &text(1), &text(2), &arg(args, 3))?),
        "threadParts.list" => {
            let parts = ports.thread_parts().list(int(0))?;
            out(parts
                .iter()
                .map(|part| {
                    json!({
                        "position": part.position, "textRu": part.text_ru, "entitiesRu": part.entities_ru,
                        "textEn": part.text_en, "textEnApproved": part.text_en_approved, "media": part.media,
                    })
                })
                .collect::<Vec<_>>())
        }
        "threadParts.append" => out(ports.thread_parts().append(int(0), &arg(args, 1))?),
        "threadParts.replace" => out(ports.thread_parts().replace(int(0), &arg::<Vec<_>>(args, 1))?),
        "threadParts.update" => out(ports.thread_parts().update(int(0), int(1), &arg(args, 2))?),
        "threadParts.remove" => out(ports.thread_parts().remove(int(0), int(1))?),
        "threadParts.setEnglish" => out(ports.thread_parts().set_english(int(0), &arg::<Vec<_>>(args, 1))?),
        "threadParts.approveEnglish" => out(ports.thread_parts().approve_english(int(0), int(1), &text(2))?),
        "draftTranslations.queue" => out(ports.draft_translations().queue(int(0))?),
        "draftTranslations.pending" => out(ports.draft_translations().pending(int(0))?),
        "draftTranslations.claimDue" => out(ports.draft_translations().claim_due(int(0))?),
        "draftTranslations.settle" => out(ports.draft_translations().settle(int(0), &text(1))?),
        "draftTranslations.fail" => out(ports.draft_translations().fail(int(0), &text(1), &text(2), int(3))?),
        "events.record" => out(ports.events().record(&arg(args, 0))?),
        "studioPosts.replaceEntityCandidates" => {
            out(ports
                .studio_posts()
                .replace_entity_candidates(int(0), &arg::<Vec<_>>(args, 1), &text(2))?)
        }
        "studioPosts.acceptEntityCandidates" => out(ports.studio_posts().accept_entity_candidates(int(0), &text(1))?),
        "studioPosts.history" => out(ports.studio_posts().history(int(0), arg(args, 1), int(2))?),
        "studioPosts.progress" => out(ports.studio_posts().progress(int(0))?),
        "studioPosts.failedPublicationTargets" => out(ports.studio_posts().failed_publication_targets(int(0))?),
        "conversationSessions.get" => out(ports.conversation_sessions().get(int(0), kind(1))?),
        "conversationSessions.save" => out(ports.conversation_sessions().save(&arg(args, 0))?),
        "conversationSessions.clearIfCurrent" => out(ports.conversation_sessions().clear_if_current(&arg(args, 0))?),
        "conversationSessions.retire" => out(ports.conversation_sessions().retire(int(0), kind(1), &text(2))?),
        "studioQueue.posts" => out(ports.studio_queue().posts(&ints(0), int(1))?),
        "studioQueue.videos" => out(ports.studio_queue().videos(&ints(0), int(1))?),
        "studioQueue.latestPublished" => out(ports.studio_queue().latest_published(&ints(0))?),
        "studioQueue.videoTargets" => out(ports.studio_queue().video_targets(&ints(0))?),
        "actionableIssues.list" => {
            let actors: Option<Vec<i64>> = arg(args, 0);
            out(ports.actionable_issues().list(actors.as_deref())?)
        }
        "studioSettings.profile" => out(ports.studio_settings().profile()?),
        "studioSettings.saveProfile" => out(ports.studio_settings().save_profile(&arg(args, 0))?),
        "studioSettings.notifications" => out(ports.studio_settings().notifications(int(0))?),
        "studioSettings.locale" => out(ports.studio_settings().locale(int(0))?),
        "studioSettings.timezone" => out(ports.studio_settings().timezone(int(0))?),
        "studioSettings.backup" => out(ports.studio_settings().backup()?),
        "studioSettings.saveBackup" => out(ports
            .studio_settings()
            .save_backup(field(args, "enabled"), &field::<String>(args, "updatedAt"))?),
        "studioSettings.saveNotifications" => out(ports.studio_settings().save_notifications(&arg(args, 0))?),
        "studioSettings.cancelQueuedReminders" => {
            out(ports
                .studio_settings()
                .cancel_queued_reminders(int(0), arg::<PublicationKind>(args, 1), &text(2))?)
        }
        "studioSettings.youtubeSettings" => out(ports.studio_settings().youtube_settings()?),
        "studioSettings.saveYoutubeSettings" => out(ports
            .studio_settings()
            .save_youtube_settings(&field::<String>(args, "signature"), &field::<String>(args, "updatedAt"))?),
        "studioSettings.saveLocale" => out(ports.studio_settings().save_locale(
            field(args, "actorId"),
            &field::<String>(args, "locale"),
            &field::<String>(args, "updatedAt"),
        )?),
        "studioSettings.saveTimezone" => out(ports.studio_settings().save_timezone(
            field(args, "actorId"),
            &field::<String>(args, "timezone"),
            &field::<String>(args, "updatedAt"),
        )?),
        "studioMediaAssets.findByOwnerHash" => out(ports.studio_media_assets().find_by_owner_hash(int(0), &text(1))?),
        "studioMediaAssets.insertIfAbsent" => out(ports.studio_media_assets().insert_if_absent(&arg(args, 0))?),
        "studioMediaAssets.get" => out(ports.studio_media_assets().get(int(0))?),
        "studioMediaAssets.list" => out(ports.studio_media_assets().list(&ints(0), int(1))?),
        "studioMediaAssets.require" => out(ports.studio_media_assets().require(&ints(0), &ints(1))?),
        "studioVideos.get" => out(ports.studio_videos().get(int(0))?),
        "studioVideos.list" => out(ports.studio_videos().list(&ints(0), int(1))?),
        "studioVideos.targets" => out(ports.studio_videos().targets(int(0))?),
        "studioVideos.jobs" => out(ports.studio_videos().jobs(int(0))?),
        "studioVideos.history" => out(ports.studio_videos().history(&text(0), int(1))?),
        "entityEnrichment.locales" => out(ports
            .entity_enrichment()
            .locales(int(0))?
            .into_iter()
            .map(|locale| json!({ "locale": locale.locale, "text": locale.text }))
            .collect::<Vec<_>>()),
        "entityEnrichment.entities" => out(ports
            .entity_enrichment()
            .entities()?
            .into_iter()
            .map(|entity| {
                json!({
                    "id": entity.id, "kind": entity.kind, "parentEntityId": entity.parent_entity_id,
                    "slug": entity.slug, "titleRu": entity.title_ru, "titleEn": entity.title_en,
                })
            })
            .collect::<Vec<_>>()),
        "entityEnrichment.aliases" => out(ports
            .entity_enrichment()
            .aliases()?
            .into_iter()
            .map(|alias| json!({ "entityId": alias.entity_id, "alias": alias.alias }))
            .collect::<Vec<_>>()),
        "entityEnrichment.link" => {
            out(ports
                .entity_enrichment()
                .link(int(0), int(1), link_role(&text(2)), &text(3))?)
        }
        "channels.list" => out(ports.channels().list(arg(args, 0))?),
        "channels.get" => out(ports.channels().get(&text(0))?),
        "channels.upsert" => out(ports.channels().upsert(&arg(args, 0), &text(1))?),
        "channels.disable" => out(ports.channels().disable(&text(0), &text(1))?),
        "channels.find" => out(ports.channels().find(&text(0), &text(1))?),
        other => panic!("unknown call {other}"),
    })
}

fn run(scenario: &Value, start: Timestamp, setup: &[Value]) -> Value {
    let backend_db = BackendDb::open(":memory:").unwrap();
    let clock = FixedClock(Cell::new(start));
    let sqlite = unsafe_db(&backend_db);
    let ports = ApplicationPorts::within(sqlite, &clock);
    let mut vars = Map::new();
    let mut results = Vec::new();
    for sql in setup {
        sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
    }
    for step in scenario["steps"].as_array().unwrap() {
        if let Some(at) = step.get("clock") {
            clock.0.set(instant(at));
        } else if let Some(sql) = step.get("sql") {
            sqlite.execute_batch(sql.as_str().unwrap()).unwrap();
        } else {
            let name = step["call"].as_str().expect("step without clock, sql or call");
            let args = resolve(step.get("args").unwrap_or(&json!([])), &vars);
            let result = match call(&ports, name, args.as_array().unwrap()) {
                Ok(value) => {
                    if let Some(bind) = step.get("bind").and_then(Value::as_str) {
                        vars.insert(bind.into(), value.clone());
                    }
                    value
                }
                Err(_) if step.get("error").is_some_and(|mode| mode == "any") => json!({ "error": "<any>" }),
                Err(error) => json!({ "error": error.to_string() }),
            };
            results.push(json!({ "call": name, "result": result }));
        }
    }
    let mut text = serde_json::to_string(&json!({
        "name": scenario["name"],
        "results": results,
        "tables": dump(sqlite, &[]),
    }))
    .unwrap();
    for reference in scenario
        .get("nondeterministic")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
    {
        let reference = reference.as_str().unwrap();
        let value = lookup(&vars, reference)
            .as_str()
            .unwrap_or_else(|| panic!("{reference} is not a bound string"));
        let (prefix, rest) = value.split_once(':').unwrap();
        let (pid, uuid) = rest.split_once(':').unwrap();
        assert!(
            prefix == "translation" && pid == std::process::id().to_string() && uuid.len() == 36,
            "{reference} = {value}"
        );
        text = text.replace(value, &format!("<{reference}>"));
    }
    serde_json::from_str(&text).unwrap()
}

#[test]
fn repositories_match_typescript() {
    let spec: Value = serde_json::from_str(&std::fs::read_to_string(spec_path()).unwrap()).unwrap();
    let typescript = support::golden(&spec_path());
    let start = instant(&spec["clock"]);
    let actual: Vec<Value> = spec["scenarios"]
        .as_array()
        .unwrap()
        .iter()
        .map(|scenario| run(scenario, start, spec["setup"].as_array().unwrap()))
        .collect();
    let failures = differences(typescript["scenarios"].as_array().unwrap(), &actual);
    assert!(
        failures.is_empty(),
        "{} differences:\n{}",
        failures.len(),
        failures.join("\n")
    );
}

/// Every repository function appears in at least one scenario.
#[test]
fn scenarios_cover_every_repository_function() {
    let spec = std::fs::read_to_string(spec_path()).unwrap();
    let source = std::fs::read_to_string(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/scenarios.rs")).unwrap();
    let dispatched: Vec<&str> = source
        .lines()
        .filter_map(|line| line.trim().strip_prefix('"')?.split_once("\" =>").map(|(name, _)| name))
        .filter(|name| name.contains('.'))
        .collect();
    assert!(dispatched.len() > 60, "{dispatched:?}");
    let missing: Vec<&&str> = dispatched
        .iter()
        .filter(|name| !spec.contains(&format!("\"call\": \"{name}\"")))
        .collect();
    assert!(missing.is_empty(), "never called: {missing:?}");
}
