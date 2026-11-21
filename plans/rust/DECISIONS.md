# Rust rewrite — decisions (owner-approved)

- 2026-11-21 Code lives on branch `rust`; `main` (auto-deploys to prod via CI) is untouched until a single cutover.
- 2026-11-21 Parity 1:1, Telegram bot is the top priority: every screen, section, button, text and callback must match `telegram-bot-spec.md`.
- 2026-11-21 Telegram Stories (MTProto, mtcute) stay in TypeScript as a small sidecar; Rust calls it.
- 2026-11-21 Tests: port only the key ones (delivery invariants, callback/parity contracts, public site contract, DB/migration guards), not all 1,146.
- 2026-11-21 All Rust build output / temp files go to `_trash-rust/` (git-excluded, `rm -rf _trash-rust` to clean).
- 2026-11-21 Bot interface is Russian only: no `en` interface locale, no 🌐 Language settings screen (spec §4.10.6), only `ru` catalog strings are ported; menu fingerprint/locale-dependent bits use `ru` constantly. English CONTENT stays: English posts, `en` targets/channels, `schedule_en`, the `en` queue filter are unchanged. Code, comments and logs remain English (repo rule).
- 2026-11-21 Russian-only consequence: `setMyCommands` description uses the `ru` string (today it is EN). `ru.json` is exported with the EN value wherever the `ru` key is missing, because `t()` falls back to `catalog.en` — that keeps today's rendered output.
