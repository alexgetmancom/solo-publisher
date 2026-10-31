---
name: studio
description: Operate a self-hosted Studio deployment — write, publish, schedule and edit posts and short-form video, and diagnose a post that did not reach a platform. Use whenever the request is about publishing, a channel, a draft, a scheduled post, delivery to Telegram/X/Threads/Instagram/YouTube, or why something did not go out.
---

# Studio

The `studio` MCP server is the whole interface to one deployment. There is no repository, database
or SSH here: if a task cannot be done with a tool, it cannot be done. Never ask for the server, the
container or the token.

Deployments differ — some publish a website and two languages, some are video only. Call
`studio_capabilities` before choosing a command, and read `tools/list` for the actual surface. Those
describe the deployment you are connected to; this file does not.

## Publish or prepare

Take the wording literally, and when it is ambiguous, prepare.

- "Post it", "publish now", "send it" — publish: create, `studio_post_validate`, then
  `studio_post_publish`. Video: `studio_video_preflight`, then `studio_video_publish`.
- "Let's prepare a post", "draft this", "get it ready" — create and stop at the draft. Report
  `studio_post_preview` and wait. The draft is already visible for approval in the deployment's own
  Telegram bot and Command Center. Do not publish it later without being told to.
- A time — "tomorrow at nine" — is `studio_post_schedule` or `studio_video_schedule`, not publish.

Media is attached to a draft, not passed to publish: `studio_post_attach_media` after the file is
uploaded to the deployment. A post with media publishes only once the media is attached.

## Reaching an audience

`studio_post_publish`, `studio_video_publish`, `ops_retry`, `ops_edit`, `ops_delete` and
`ops_use_other_media` change what other people see. Run them only when asked for that specific
thing, once, and report what actually happened rather than what was intended. Publishing twice
because a call looked like it failed is worse than reporting the uncertainty.

## Diagnosing

Start with `ops_status` — the guide is a CLI command, not a tool an agent can call — then:

- `ops_audit` — failed jobs, stuck targets and inconsistencies across the text and video pipelines.
- `ops_recent` — the last posts, their targets, and the targets each one is missing. This is the
  whole diagnosis for "post X did not go to Y".
- `ops_verify` — fetches a published target and reports whether it is really live.
- `ops_find` with a fragment of the text resolves an older post's ref. Refs are `post:N`.

Read the tool output before reasoning about causes, and never retry a target blindly: `ops_recent`
first, then one `ops_retry` for the target actually missing.

## Language

Post text, captions and titles are written in the language of the channel they publish to.
Everything written to the operator — reports, questions, summaries — is in the operator's language.
