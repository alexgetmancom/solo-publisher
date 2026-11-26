# Bot goldens — coverage

Recorded from the real TypeScript bot against a fake Telegram before the cutover; nothing re-records
them. The recorder's seeds are `seeds/`, its fixtures `fixtures/`; how the Rust replay reads them is in
`crates/bot/tests/support/mod.rs`. Every golden is
`{ id, specRef, seed, steps: [{ update | trigger, calls: [{ method, payload, transport? }] }] }`; `seed` says in words
what state was put in place outside the bot. All screens use the actor locale `ru`. Paths below are relative to
`parity/bot-goldens/`.

## Screen and state checklist

| # | Screen / state | Case file(s) | Status |
|---|---|---|---|
| 1 | /start hint + persistent reply keyboard | entry/start | recorded |
| 2 | Main menu (empty, headline, count) | entry/start, entry/menu-button, queue/queue-pages, queue/menu-headline-tomorrow | recorded |
| 3 | Intake prompt (text / video) | intake/intake-menu-buttons, video/video-intake-destination | recorded |
| 4 | Intake unsupported / rejected | intake/intake-unsupported, video/video-intake-rejects-text, intake/intake-text-entry-video | recorded |
| 5 | Intake kind choice | intake/intake-kind-choice, intake/intake-kind-post | recorded |
| 6 | Article review (asked / decided) | intake/intake-kind-choice, intake/intake-markdown-article, intake/intake-markdown-rather-post | recorded |
| 7 | Article queued (result) | intake/intake-markdown-article | recorded |
| 8 | Video destination (toggles / one platform) | video/video-intake-destination, video/video-intake-single-platform | recorded |
| 9 | Video downloading / download failed | video/video-intake-destination, video/video-download-failed, video/video-download-cancel | recorded |
| 10 | Video downloaded notice | video/video-music-aspect-warnings | recorded |
| 11 | Work queue (empty, pages, overdue, attention row) | queue/queue-empty, queue/queue-pages, queue/queue-attention-pages | recorded |
| 12 | Needs attention (pages) | queue/queue-attention-pages, post/post-settled-overview | recorded |
| 13 | Post card overview (draft) | post/post-card-overview, post/post-card-overview-ru-only, post/post-cycle-mode | recorded |
| 14 | Post card overview (scheduled) | post/post-schedule-both-slots | recorded |
| 15 | Post card overview (settled, unlanded rows) | post/post-settled-overview, post/post-settled-retry-all, post/post-settled-skip-all | recorded |
| 16 | Post platforms | post/post-platforms | recorded |
| 17 | Post schedule chooser (EN served / RU only) | post/post-schedule-chooser, post/post-schedule-chooser-ru-only | recorded |
| 18 | Post change-time chooser | post/post-schedule-both-slots | recorded |
| 19 | Slot grid schedule_ru | post/post-slot-grids | recorded |
| 20 | Slot grid schedule_ru_day | post/post-slot-grids | recorded |
| 21 | Slot grid schedule_ru_evening | post/post-slot-grids | recorded |
| 22 | Slot grid schedule_en | post/post-slot-grids | recorded |
| 23 | Slot grid schedule_en_us | post/post-slot-grids | recorded |
| 24 | confirm_publish | post/post-confirm-publish | recorded |
| 25 | confirm_delete | post/post-delete | recorded |
| 26 | confirm_cancel | post/post-cancel-scheduled | recorded |
| 27 | resend | post/post-resend | recorded |
| 28 | thread view | post/post-thread | recorded |
| 29 | Post text-edit prompt | post/post-edit-ru, post/post-edit-cancel | recorded |
| 30 | Thread part / replacement prompt | post/post-thread | recorded |
| 31 | Thread part added question | post/post-thread, intake/post-album-thread-part | recorded |
| 32 | Manual time prompt (post) | post/post-schedule-manual | recorded |
| 33 | Post schedule confirmation | post/post-schedule-manual | recorded |
| 34 | Post value error / parse error | post/post-schedule-manual, post/post-schedule-manual-errors | recorded |
| 35 | Album received | intake/post-album, intake/post-album-edit, intake/post-album-thread-part | recorded |
| 36 | need-new-post (+ reply kb) | intake/post-need-new-post | recorded |
| 37 | Media-large advice | intake/intake-photo-large | recorded |
| 38 | Preflight thread offer | post/post-preflight-thread-offer | recorded |
| 39 | Story-card choice (publish / schedule) + photos | post/story-choice-publish, post/story-choice-schedule, post/story-cards-wait | recorded |
| 40 | Story-card timeout | post/story-cards-timeout | recorded |
| 41 | Post queued notice | post/post-confirm-publish | recorded |
| 42 | Progress card (summary / details, issues) | post/post-confirm-publish, post/post-progress-cancel, post/post-settled-overview | recorded |
| 43 | Progress cancel confirmation | post/post-progress-cancel | recorded |
| 44 | Post/draft cancelled result | post/post-delete, post/post-cancel-scheduled | recorded |
| 45 | Card-stale message | callbacks/callback-stale-card, callbacks/callback-publication-stale, notices/notice-video-unresolved | recorded |
| 46 | Video card overview | video/video-card-actions, video/video-card-draft-actions | recorded |
| 47 | Video confirm_now | video/video-publish-now | recorded |
| 48 | Video confirm_cancel | video/video-card-actions | recorded |
| 49 | Video confirm_remove | video/video-card-draft-actions | recorded |
| 50 | Video edit menu (draft / scheduled) | video/video-card-draft-actions, video/video-card-actions | recorded |
| 51 | Video field / media prompt | video/video-card-draft-actions, video/video-card-actions | recorded |
| 52 | Background-music warning | video/video-music-aspect-warnings | recorded |
| 53 | Length warning | video/video-length-ok, video/video-wizard-cancel-before-draft, video/video-length-replace | recorded |
| 54 | Script prompt | video/video-wizard-common | recorded |
| 55 | Metadata prompts (title/desc/game/tags/caption) | video/video-wizard-common, video/video-wizard-skip-back | recorded |
| 56 | Game / script skipped notice | video/video-wizard-skip-back | recorded |
| 57 | Schedule choice (wizard / from card) | video/video-wizard-common, video/video-wizard-individual | recorded |
| 58 | Video time picker (common / per target) | video/video-wizard-common, video/video-wizard-individual, video/video-card-actions | recorded |
| 59 | Video manual-time prompt | video/video-wizard-individual | recorded |
| 60 | Video schedule confirmation | video/video-wizard-common, video/video-wizard-individual | recorded |
| 61 | Video confirmed notice + final card (incl. not 9:16, no audio) | video/video-wizard-common, video/video-publish-now, video/video-music-aspect-warnings | recorded |
| 62 | Video awaiting-button / await-text / value-error | video/video-wizard-skip-back, video/video-length-replace | recorded |
| 63 | Video cancelled result | video/video-card-actions | recorded |
| 64 | All platforms removed | video/video-remove-all | recorded |
| 65 | Video source preview (video message) | video/video-wizard-common | recorded |
| 66 | Delivery previews (header, content, media, threads, notes) | post/post-confirm-publish, post/post-previews-with-media, video/video-wizard-common | recorded |
| 67 | Settings root | settings/settings-root | recorded |
| 68 | Settings · Publishing (with / without YouTube signature row) | settings/settings-publishing-channels, settings/settings-connect-zernio | recorded |
| 69 | Channels list | settings/settings-publishing-channels | recorded |
| 70 | Channel card | settings/settings-publishing-channels | recorded |
| 71 | Channel disable confirm | settings/settings-publishing-channels | recorded |
| 72 | Connect a channel (native URLs, YouTube start, direct, Zernio found / failed) | settings/settings-connect, settings/settings-connect-zernio, settings/settings-connect-zernio-accounts | recorded |
| 73 | Default platforms | settings/settings-default-targets | recorded |
| 74 | YouTube signature (+ edit prompt) | settings/settings-youtube-signature | recorded |
| 75 | Notifications category | settings/settings-notifications | recorded |
| 76 | Publication notifications | settings/settings-notifications | recorded |
| 77 | System | settings/settings-system-timezone, settings/settings-system-backup | recorded |
| 78 | Time zone (+ custom prompt, zone outside the list) | settings/settings-system-timezone | recorded |
| 79 | Language | — | not recorded: excluded by docs/decisions.md (no 🌐 Language screen in the Rust bot) |
| 80 | Keyboard-updated message (+ reply kb) | — | not recorded: only reachable from the Language switch, which is excluded |
| 81 | Backup | settings/settings-system-backup | recorded |
| 82 | Settings typed-input replies (tz set / invalid, YT saved) | settings/settings-system-timezone, settings/settings-youtube-signature | recorded |
| 83 | Deploy confirmation | deploy/deploy-promote, deploy/deploy-rollback-failed | recorded |
| 84 | Deploy menu / result (done / failed) | deploy/deploy-promote, deploy/deploy-rollback-failed | recorded |
| 85 | Deploy progress | deploy/deploy-promote, deploy/deploy-rollback-failed | recorded |
| 86 | Reminder notice (post / video) | notices/notice-post-reminder, notices/notice-video-reminder | recorded |
| 87 | Completion notice (post, failed post, locale part, video) | notices/notice-post-completed, notices/notice-post-failed, notices/notice-post-locale-partial, notices/notice-video-completed | recorded |
| 88 | Video failure notice | notices/notice-video-failed | recorded |
| 89 | Video unresolved notice | notices/notice-video-unresolved | recorded |
| 90 | Alert | notices/notice-post-failed | recorded |
| 91 | Daily backup document / failure notice | notices/notice-daily-backup, loops/loop-daily-backup | recorded (backup bytes opaque: integrity and tables instead, see harness header) |
| 92 | Album give-up | intake/post-album-give-up | recorded |
| 93 | Unknown action / Already running… / error message | callbacks/callback-unknown, callbacks/callback-action-lock, callbacks/callback-publication-stale, post/post-preflight-toast | recorded |

91 of 93 rows recorded; the two missing rows are the excluded Language screen and the message only it produces.

## Flows

| Flow | Case file(s) |
|---|---|
| 6.1 intake (open, first message, post, article, video destination, download, cancel, expired) | intake/*, video/video-intake-*, video/video-download-* |
| 6.2 post message input (edit_text, schedule_manual, thread_part, thread_edit, errors, no open step, album) | post/post-edit-ru, post/post-schedule-manual*, post/post-thread, intake/post-need-new-post, intake/post-album* |
| 6.3 publish / schedule intents (preflight, Story choice, queue now, commit one locale) | post/post-preflight-*, post/story-*, post/post-confirm-publish, post/post-schedule-* |
| 6.4 video wizard (attach, prompts, message rules, common / individual, apply date, final, single edits, cancel) | video/* |
| 6.5 album collector (new draft, edit step, thread part, give-up) | intake/post-album, intake/post-album-edit, intake/post-album-thread-part, intake/post-album-give-up |
| 6.6 settings text input (time zone, YouTube signature, navigation message) | settings/settings-system-timezone, settings/settings-youtube-signature |

## Messages the bot sends on its own

| Source | Case file(s) |
|---|---|
| 7.1 event consumer (at-most-once: a second tick sends nothing) | notices/notice-post-completed |
| 7.2 reminder | notices/notice-post-reminder, notices/notice-video-reminder |
| 7.3 card repaints (progress, preview after translation, video card) | notices/notice-post-completed, notices/notice-translation-repaint, notices/notice-video-completed |
| 7.4 completion | notices/notice-post-completed, notices/notice-post-failed, notices/notice-post-locale-partial, notices/notice-video-completed |
| 7.5 video failure / unresolved | notices/notice-video-failed, notices/notice-video-unresolved, notices/video-settle-accepted |
| 7.6 delivery previews | post/post-confirm-publish, post/post-previews-with-media, video/video-wizard-common |
| 7.7 alerts, daily backup, album give-up, Story follow-up, download result, deploy result | notices/notice-post-failed, notices/notice-daily-backup, intake/post-album-give-up, post/story-cards-wait, video/video-intake-destination, deploy/deploy-promote |

## Worker loops (`loops/`)

Each trigger runs one loop's task exactly as the worker starts it; every step after `h.watch(…)` also records what the watched queries return (`db`).

| Loop | Case file(s) |
|---|---|
| telegram-events (every event type, age windows, unknown publications, at-most-once reservation) | loops/loop-events-post, loops/loop-events-video |
| notifications → telegram-events (due / not due / cancelled jobs, reminder text without title or targets) | loops/loop-notification-jobs |
| telegram-translations (thread parts, English Story card, settled row; refusal, HTTP 500, empty answer, exhausted) | loops/loop-translation-settled, loops/loop-translation-exhausted |
| telegram-alerts (severity filter, cooldown suppression and expiry, 4000-unit cut, failed send stays settled) | loops/loop-alerts |
| telegram-albums (before / after the settle window) | loops/loop-albums |
| telegram-daily-backup (before 04:00, switched off, once a day, next day) | loops/loop-daily-backup |

## Callback data (stale and foreign)

| Rule | Case file |
|---|---|
| 5.1 unknown screen id, wrong arity, bad numbers, intake choice with no effect | callbacks/callback-unknown |
| 5.2 steps 1-6: unknown action (post/video), invalid draft id, arity, missing / wrong `sv` revision, unreadable draft | callbacks/callback-publication-stale |
| 5.2 step 7 / 5.5: tap on a superseded card → stale + current card re-sent | callbacks/callback-stale-card, notices/notice-video-unresolved |
| 5.2.3 unversioned confirm_now | video/video-publish-now |
| 5.3 intake_download of a replaced screen (intake expired) | video/video-download-cancel |
| 5.3 deploy validation | deploy/deploy-invalid |
| 5.4 supersession | callbacks/callback-superseded |
| 5.6 duplicate callback id, action lock | callbacks/callback-duplicate, callbacks/callback-action-lock |
| 5.7 menu-plugin format: outdated hash, unknown menu, malformed position | callbacks/callback-menu-legacy |
| 1.3 admin gate | entry/admin-gate |
| 1.1 setMyCommands at construction | entry/bootstrap |
| 1.1 internal error: a tap gets the raw error as a message, a message handler gets no reply | callbacks/callback-internal-error |

## Findings while recording (behaviour of today's bot, recorded as is)

- An actor with no stored locale reads as `en` (the settings read defaults to `en`), not `ru`. The recorder stores `ru` explicitly before every case.
- `setMyCommands` still sends the EN description (`entry/bootstrap`); docs/decisions.md moves it to `ru` in Rust, so that
  golden will differ on purpose.
- Settings menu-plugin hashes contain raw control characters and U+FFFD (the plugin decodes 4 hash bytes as UTF-8);
  they are recorded exactly and the Rust side must reproduce the plugin's `tinyHash` + lossy decode to match.
- After removing Instagram from a draft video the card reports status "scheduled" and no publish row
  (`video/video-card-draft-actions`).
