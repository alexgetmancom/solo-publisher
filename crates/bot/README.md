# bot — the Studio Telegram bot (Rust)

Port of the TypeScript `bot.ts` + `bot/**`; the contract is the recorded goldens (`parity/bot-goldens/`). Russian only
(`docs/decisions.md`). Everything runs on one thread inside a tokio `LocalSet`.

## Core (shared; edit only with a reason)

| Module | TypeScript |
|---|---|
| `api/` (client, guard, retry, timing, payload, types, transport) | grammY `Api`, `unchanged-edits.ts`, auto-retry, `api-timing.ts`, `telegram-errors.ts` |
| `bot.rs` (middleware chain, routers), `runner.rs` | `bot.ts`, `bot/runner.ts` |
| `boundary.rs`, `sequentialize.rs`, `action_lock.rs`, `tap.rs` | `callback-boundary.ts`, `sequentialize`, `action-lock.ts`, `tap-measurement.ts` |
| `callback.rs` (screen ids + arity, `p:` namespace, `sv<n>\|`) | `screen-callback.ts`, `publication-callback.ts` |
| `menu.rs` | `@grammyjs/menu` wire format (hash, outdated, nav injection) |
| `effects.rs`, `publication.rs`, `session.rs`, `cards.rs`, `dialog_ui.rs`, `error_text.rs`, `queue_time.rs` | `effects.ts`, `callback-router.ts` + `publication-actions.ts` + `callback-effects.ts`, `conversation-state.ts`, `control-cards.ts` + `card-freshness.ts`, … |
| `screens/entry.rs` | `/start`, `☰ Меню`, main menu, `menu_home`, `noop` |

## Adding an area

1. Create `src/screens/<area>.rs` with `pub fn register(registry: &mut Registry)`.
2. Add one line `<area>,` to `areas! { … }` in `src/screens/mod.rs`.
3. Delete the area's line from `PENDING_AREAS` in `tests/support/pending.rs` once its cases pass.

Everything is registered in `register`, never by editing shared files:

- screen button → `registry.screen(ScreenId::QueueHome, route)`; ids, arity and owning area are declared once in
  `callback.rs` (`screens!`). A route returns `Ok(false)` for well-formed but meaningless data ("Unknown action").
- publication control → `registry.action(kind, "name", ActionDef { handler, entity, args, fresh_card, session_revision })`;
  card → `registry.renderer(kind, fn)`; conversation messages → `registry.publication_messages(kind, fn)`.
  `view`/`retry` are shared and already registered.
- text trigger → `registry.hears(&["📝 Text", "📝 Текст"], handler)` (EN variants stay: old keyboards send them);
  message stage → `registry.message_stage(MessageStage::Settings | Intake, fn)`; menu → `registry.menu(MenuDef { … })`.
- intake routes: wrap in `publication::run_callback_action(ctx, "<actor>:intake", …)` as TS does. The video area
  registers `registry.video_intake(VideoIntake { store, attach })`: storing the intake's captured video and opening
  the video conversation on it.

Handlers are plain `fn`s returning `Fut<'_, …>` (`Box::pin(async move { … })`); build screens as `Vec<Effect>` and let
`effects::execute` decide edit-in-place vs new message. Background work goes through `ctx.bot.spawn` (the replay waits
for it).

Byte-exact rules: build `Payload` options in the TypeScript call-site order (the unchanged-edit guard compares
serialised payloads); menus return their rows exactly as the plugin renders them (keep an empty row TS produces).
Studio services come from `ctx.services()`; boundaries Studio needs but the bot does not own come from the `Host`.

## Worker loops

`workers.rs` is `interfaces/telegram/worker.ts`: one task per loop (`telegram_events`, `telegram_translations`,
`telegram_albums`, `telegram_alerts`, `telegram_daily_backup`) and `start_telegram_workers(bot, http, loops)`, which
starts them through `runtime`'s `HeartbeatLoops` with the TypeScript intervals (1 s, 1 s, idle poll, idle poll, 60 s)
and wires the event loop's wake: `domain::repositories::set_event_bell` rings it whenever an event is journalled.
`http` is the client DeepSeek is reached through (`workers/translations.rs`, `runTranslationCycle`). The
`notifications` loop is a core worker: its task is `domain::notifications::run_notification_cycle`.

## Goldens

```
cargo test -p bot --test goldens <area> -- --nocapture   # PASS / NOT PORTED / FAIL per case, first diff shown
cargo test -p bot --test boundary                       # core boundary rules
```

Each case replays on the database the TS recorder seeded right before its first step, committed as SQL in
`parity/bot-goldens/seeds/` (recorded from the TypeScript backend before the cutover; nothing re-records them) and built by the test into
`_trash-rust/tmp/bot-goldens-seeds/` when the committed seeds change; shared, read-only. Whatever a case or boundary test writes (its database copy, `DATA_DIR`) lives in
its own `Scratch` dir, `_trash-rust/tmp/bot-tests/<pid>-<n>-<label>/`, removed afterwards, so concurrent `cargo test`
runs are safe. Cross-area needs per case: `CASE_NEEDS` in `tests/support/pending.rs`. Recorder triggers (worker
ticks) replay from `tests/support/triggers.rs`, one row per trigger name. Boundaries the replay reaches
are implemented in `tests/support/host.rs` (unimplemented ones panic with their name). Plain HTTP the TS bot made
(`method: "http"` in goldens) is recorded by the fakes beneath it: Telegram file downloads go through
`Transport::download` (the fake serves the local file, as the recorder's `fileDownload` did), the deploy agent through
its own boundary. Steps feeding several updates at once compare per chat.
Loop cases (`loops/`) replay each loop's task and also compare the database effects the
recorder watched (`db` in a step: the same SQL run on the Rust database, rows with sorted keys); the translator is the
golden DeepSeek behind the workers' `HttpClient` (`tests/support/deepseek.rs`), scripted by the case's seed notes.
`entry/bootstrap` differs on purpose (`setMyCommands` description in Russian) and is asserted as such.
