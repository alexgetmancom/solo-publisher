//! The golden Content translator (`content/translation-worker.ts`,
//! `runTranslationCycle`): one queued draft translated per pass, by the
//! recorder's `fetch` stub for the DeepSeek API. The case's seed note says
//! what it answers ("the translator answers '<text>'."); each request is
//! recorded among the Telegram calls as `method: "http"`, as the recorder
//! writes it.

use std::sync::LazyLock;

use domain::application::ports::{ApplicationPorts, DraftPatch, ThreadEnglish};
use regex::Regex;
use serde_json::{Value, json};

use super::Harness;

const COMPLETIONS_URL: &str = "https://api.deepseek.com/v1/chat/completions";
const TRANSLATION_LEASE_MS: i64 = 2 * 60_000;
static ANSWER: LazyLock<Regex> = LazyLock::new(|| Regex::new(r"the translator answers '(.*)'\.$").unwrap());

/// What the case's translator answers, from its seed notes.
fn answer(seed: &Value) -> Result<String, String> {
    seed.as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .find_map(|note| ANSWER.captures(note).map(|found| found[1].replace("\\n", "\n")))
        .ok_or_else(|| "the case scripts no translator answer".to_owned())
}

/// One pass; the drafts whose card is now out of date.
pub fn run_translation_cycle(harness: &Harness, seed: &Value) -> Result<Vec<i64>, String> {
    let deps = harness.bot.deps();
    let ports = ApplicationPorts::within(db::unsafe_db(&deps.db), &*deps.clock);
    let failed = |error: domain::Error| error.to_string();
    let Some(claim) = ports
        .draft_translations()
        .claim_due(TRANSLATION_LEASE_MS)
        .map_err(failed)?
    else {
        return Ok(Vec::new());
    };
    let Some(draft) = ports.drafts().get(claim.draft_id).map_err(failed)? else {
        ports
            .draft_translations()
            .settle(claim.draft_id, &claim.locked_by)
            .map_err(failed)?;
        return Ok(Vec::new());
    };
    let answer = answer(seed)?;
    let translate = || {
        harness
            .telegram
            .record_http(json!({"method": "POST", "url": COMPLETIONS_URL}));
        answer.clone()
    };
    let text_en = translate();
    let thread: Vec<ThreadEnglish> = draft
        .thread
        .iter()
        .map(|part| ThreadEnglish {
            position: part.position,
            text_en: translate(),
        })
        .collect();
    ports
        .drafts()
        .update(
            draft.id,
            &DraftPatch {
                text_en_machine: Some(text_en),
                ..DraftPatch::default()
            },
        )
        .map_err(failed)?;
    ports.thread_parts().set_english(draft.id, &thread).map_err(failed)?;
    // The English Story card is drawn from the English text, which did not
    // exist when the draft was created.
    deps.host
        .publishing()
        .story_cards
        .queue(db::unsafe_db(&deps.db), draft.id)
        .map_err(failed)?;
    ports
        .draft_translations()
        .settle(draft.id, &claim.locked_by)
        .map_err(failed)?;
    Ok(vec![draft.id])
}
