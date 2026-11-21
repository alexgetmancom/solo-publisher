# story_render — Story cards drawn and the worker that draws them

Port of `apps/backend/src/story-cards/svg.ts`, `renderer-process.ts` and `worker.ts`. The card copy (headline, emoji,
line breaks, bold lines) is `domain::story_cards::story_card_copy`; the store that queues cards is
`domain::story_cards::StoryCardStore`.

## For the host

- At startup: `recover_story_card_jobs(sqlite, clock)` and, when it returns more than 0, log
  `recovered interrupted Story card locks on worker startup` with `{recovered}` (warn), as `runtime/workers.ts`.
- Loop `STORY_CARD_WORKER` (`"story-cards"`) every `IDLE_POLL_INTERVAL_SECONDS`, inside the timed cycle
  `content.story_card.cycle` counted by `claimed`: `run_story_card_cycle(studio).await` with the host's `Studio`
  (publishing boundaries with the real `StoryCardStore` and usage meter; Studio boundaries for the replan's reminders
  and readiness). Record its `StoryCardCycle { state, error }` with `recordWorkerState("story-cards", state, error)`.
  An `Err` is the database's and fails the tick, as a throw did.
- The `StoryCards` boundary is the store itself: once this loop runs, a queued card is no longer "left for the
  renderer", so the host's `queue` drops its warning and `STORY_CARD_RENDERER` leaves `unported.rs`.
- Configuration: `STORY_CARD_ASSETS_DIR` (background, `Manrope-Variable.ttf`, `NotoColorEmoji.ttf`, `emoji/*.svg`)
  and `$DATA_DIR/story-cards` for the output. `STORY_CARD_RENDERER_ENTRY` is not read: there is no renderer process.

## How it differs from TypeScript

- No child process, no sharp, no fontconfig file: the render runs on tokio's blocking pool (resvg, tiny-skia,
  jpeg-encoder are safe Rust; a panic is an error). A render past 15 s is reported as timed out exactly as before,
  but the thread finishes on its own; its file is written beside its name and renamed into place.
- Renderer errors keep the `story_card_renderer_failed: ` prefix; the words after it are resvg's, not sharp's.
- The background is enlarged as libvips does (bicubic, its sampling offset), so it matches sharp within JPEG noise.
- usvg maps only the hundreds of `font-weight` onto a variable font; the renderer injects a style sheet that puts
  680/440/430 on Manrope's `wght` axis, which is what librsvg does with the same SVG.
- An emoji inside the headline (not the leading one) is drawn in colour from Noto Color Emoji. librsvg drew a
  silhouette in the text colour, traced by cairo from the bitmap and larger; the glyph's advance, and so
  the layout, is the same.

## Parity tests

- `tests/render_parity.rs`: copy, line breaks, overlay SVG, emoji file and box against `tests/fixtures/copy.json`
  exactly; five cards' pixels against the TypeScript renders in `tests/fixtures/*.jpg` (halved, see the test for the
  measured limits). Rust renders land in `_trash-rust/tmp/story-render/`.
- `tests/worker_scenarios.rs`: the worker against the TypeScript worker on two fresh databases
  (`worker_scenarios.json`, run through `scripts/rust/story-worker-scenarios.ts` with the real sharp renderer).
- Regenerate the fixtures with `bun scripts/rust/story-render-fixtures.ts` (needs sharp in `apps/backend`).
