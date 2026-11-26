# mtproto — Telegram channel Stories over MTProto (Rust)

grammers 0.12 (TL layer 233), in the Studio's process. mtcute 0.32 (layer 229) did the same three jobs before it.

| Module | What |
|---|---|
| `session` (`SessionFile`) | the file at `TELEGRAM_CHANNEL_STORIES_SESSION`, in mtcute's SQLite layout: `auth_keys(dc, key)` and `key_value['dc_main']`; written back when the home DC or a permanent key changes |
| `stories` (`post_story`, `send_story_request`, `input_media`) | one Story: connect 30 s, `users.getUsers(self)` 30 s, `contacts.resolveUsername` + upload + `stories.sendStory` 120 s, teardown 5 s; what is not sent vs. ambiguous is in `crates/providers/README.md` |
| `sign_in` (`sign_in`, `SignInPrompts`) | `ops telegram-stories-login`: phone, code (asked again until accepted), 2FA password |
| `MtprotoStories` | `providers::adapters::StoriesClient`, reading the credentials from the live configuration per Story |

The sender pool runs beside the work in the same task (`connection::with_client`), so a dropped Story drops its
connection; nothing is retried except a flood wait of at most 10 s.

```
cargo test -p mtproto   # send_story.rs: the request against mtcute's (send_story.golden.json); session.rs: mtcute's own session file
```

The golden and `tests/fixtures/mtcute.session` (a random key for DC 2) were recorded with mtcute 0.32.1 before that
sidecar was deleted; nothing re-records them. Against Telegram itself this crate is verified only by a real
Story posted from production's session.
