//! Draft translation, with the model call: the only place a post is
//! translated. An operator's message becomes a draft and a card at once; the
//! English arrives here a moment later.

use content::Locale;
use content::translation::{
    SYSTEM_PROMPT, TEMPERATURE, TIMEOUT, TranslationStep, checked_translation, translation_step,
};
use domain::application::ports::{DraftPatch, DraftRecord, ThreadEnglish};
use foundation::logger::{LogLevel, log};
use providers::external::deepseek::{ChatOptions, DeepSeekMessage, Role, deepseek_chat};
use runtime::http::HttpClient;
use serde_json::json;

use crate::bot::Bot;
use crate::context::Ctx;

/// A translation is one model call; past this the claim is abandoned rather
/// than held by a worker that is no longer running.
const TRANSLATION_LEASE_MS: i64 = 2 * 60_000;

/// A model that answers with something unusable answers the same way twice.
/// Past this the draft keeps its Russian and the card says it has no English,
/// the state preflight already refuses to publish.
const TRANSLATION_MAX_ATTEMPTS: i64 = 3;

const USAGE_FEATURE: &str = "content.draft.translate";

/// One queued draft's English. The ids returned are the drafts whose card is
/// now out of date, which is the interface's business: a draft that ran out
/// of attempts is among them, its card stops saying the English is coming.
pub async fn run_translation_cycle(bot: &Bot, http: &HttpClient) -> crate::Result<Vec<i64>> {
    let ctx = Ctx::worker(bot);
    let ports = ctx.ports();
    let Some(claim) = ports.draft_translations().claim_due(TRANSLATION_LEASE_MS)? else {
        return Ok(Vec::new());
    };
    // The draft is gone, so the work item is too: retrying would only
    // rediscover that on every cycle.
    let Some(draft) = ports.drafts().get(claim.draft_id)? else {
        ports.draft_translations().settle(claim.draft_id, &claim.locked_by)?;
        return Ok(Vec::new());
    };
    if let Err(error) = translate(&ctx, http, &draft, &claim.locked_by).await {
        let message = error.to_string();
        ports
            .draft_translations()
            .fail(draft.id, &claim.locked_by, &message, TRANSLATION_MAX_ATTEMPTS)?;
        log(
            LogLevel::Warn,
            "draft translation attempt failed",
            Some(json!({"draftId": draft.id, "attempt": claim.attempt_count + 1, "error": message})),
        );
    }
    Ok(vec![draft.id])
}

/// The draft and every thread part translated and written, the English Story
/// card queued and the claim settled. A thread is translated whole on every
/// pass: a part translated apart from its neighbours loses the thread's voice.
async fn translate(ctx: &Ctx, http: &HttpClient, draft: &DraftRecord, locked_by: &str) -> crate::Result<()> {
    let text_en = tracked_translation(ctx, http, &draft.text_ru)
        .await?
        .ok_or_else(|| crate::error("translation produced no English text"))?;
    let mut thread = Vec::new();
    for part in &draft.thread {
        let text_en = tracked_translation(ctx, http, &part.text_ru).await?.ok_or_else(|| {
            crate::error(format!(
                "translation produced no English text for thread part {}",
                part.position
            ))
        })?;
        thread.push(ThreadEnglish {
            position: part.position,
            text_en,
        });
    }
    let ports = ctx.ports();
    ports.drafts().update(
        draft.id,
        &DraftPatch {
            text_en_machine: Some(text_en),
            ..DraftPatch::default()
        },
    )?;
    ports.thread_parts().set_english(draft.id, &thread)?;
    // The English Story card is drawn from the English text, which did not
    // exist when the draft was created: queueing again gives it something to draw.
    ctx.bot.deps().host.publishing().story_cards.queue(ctx.db(), draft.id)?;
    ports.draft_translations().settle(draft.id, locked_by)?;
    Ok(())
}

/// `trackUsageAsync(…, "content.draft.translate", () => translateDraftText(…))`.
async fn tracked_translation(ctx: &Ctx, http: &HttpClient, text: &str) -> crate::Result<Option<String>> {
    let started_at = ctx.now();
    let result = translate_draft_text(ctx, http, text).await;
    let elapsed = (ctx.now() - started_at).get_milliseconds().max(0);
    ctx.bot.deps().host.publishing().usage.record(
        ctx.db(),
        USAGE_FEATURE,
        result.is_ok(),
        u64::try_from(elapsed).unwrap_or_default(),
    );
    result
}

/// `translateDraftText`: the English, or nothing when this Studio publishes
/// no English or the translator could not produce it. Both are "no English
/// text" on purpose: the Russian handed back would be indistinguishable from
/// a translation. The connected languages are checked before the model is paid.
async fn translate_draft_text(ctx: &Ctx, http: &HttpClient, text: &str) -> crate::Result<Option<String>> {
    if !domain::channels::post_locales(ctx.db())?.contains(&Locale::En) {
        return Ok(None);
    }
    match translate_to_english(ctx, http, text).await {
        Ok(english) => Ok(Some(english)),
        Err(error) => {
            log(
                LogLevel::Warn,
                "draft translation failed",
                Some(json!({"error": format!("Error: {error}")})),
            );
            Ok(None)
        }
    }
}

/// `translateToEnglish`.
async fn translate_to_english(ctx: &Ctx, http: &HttpClient, text: &str) -> crate::Result<String> {
    let has_translator = ctx
        .config
        .deepseek_api_key
        .as_deref()
        .is_some_and(|key| !key.is_empty());
    let source = match translation_step(text, has_translator) {
        TranslationStep::Unchanged(source) => return Ok(source.to_owned()),
        TranslationStep::Ask(source) => source,
    };
    let messages = [
        DeepSeekMessage {
            role: Role::System,
            content: SYSTEM_PROMPT.to_owned(),
        },
        DeepSeekMessage {
            role: Role::User,
            content: source.to_owned(),
        },
    ];
    let options = ChatOptions {
        temperature: TEMPERATURE,
        timeout: TIMEOUT,
        json: false,
    };
    let answer = deepseek_chat(http, &ctx.config, &messages, options).await?;
    Ok(checked_translation(&answer)?.to_owned())
}
