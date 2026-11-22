# http_edge — the Studio's HTTP surface (Rust)

Port of the TypeScript `api.ts`,
`interfaces/http/{context,discovery,health,media-upload,meta-oauth,public-site,studio,x-oauth,youtube-oauth}.ts`,
`foundation/{http-auth,http-response,ranged-file,client-identity}.ts` and the `Bun.serve` options of
`runtime/server.ts`, on axum 0.8 / hyper 1. The package is `http_edge` (a package named `http` makes every
`cargo -p http` ambiguous with the `http` crate); the directory is `crates/http`.

| Module | TypeScript |
|---|---|
| `lib.rs` (`router`, `HttpState`, `Backend`, `BotBackend`) | `api.ts` `buildApp`, `context.ts` |
| `edge.rs` | Hono's dispatch: `strict: false`, HEAD via GET, `notFound`, the `/oauth/*` + `/stats*` `unindexed` middleware |
| `uri.rs` (`Target`) | `request.url` (WHATWG), Hono's `getPath` / `decodeURI` / `tryDecode` and `c.req.query` |
| `health.rs`, `discovery.rs`, `studio.rs`, `site.rs` | the route files of the same names (`site.rs` = `public-site.ts`) |
| `oauth.rs` | `meta-oauth.ts`, `x-oauth.ts`, `youtube-oauth.ts`: `/oauth/{threads,instagram,x,youtube}[/start]` over `channels::oauth_routes` |
| `media_upload.rs`, `ranged_file.rs`, `auth.rs`, `client_identity.rs`, `response.rs` | the helpers of the same names |
| `mime.rs` | `Bun.file(path).type` (the extensions Bun 1.4 names, recorded) |
| `server.rs` (`serve`) | `Bun.serve`: body cap 1 GB + 1 MB (413), idle 255 s; `server.stop()` |

## Wiring (the integrator's part)

```rust
let state = http_edge::HttpState::new(Rc::new(BotBackend { bot: bot.clone(), http }));
let server = tokio::task::spawn_local(http_edge::serve(listener, state, async { let _ = stop.await; }));
```

`serve` and `router` must run inside the process's `LocalSet`. When `stop` completes, `serve` stops accepting and
returns once every connection is done: requests in flight are answered, idle keep-alive connections close
(`await server.stop()`). `crates/app` does this first on SIGINT/SIGTERM.

`Backend` is what the routes reach: the database, clock, live `SharedConfig`, a Studio handle, the HTTP client and
entropy the OAuth exchanges use, and `ChannelRegistrar` (`studio.channels.connect`). `BotBackend` is the process's:
the bot plus the provider `HttpClient`, with the operating system's randomness.

## Why a local executor

axum requires `Send` handlers and a `Send + Sync` router state; the Studio is single-threaded and its state is `Rc`
(the bot owns `BackendDb`). So axum/hyper keep routing, extraction and the connection loop (`tokio::spawn`, all
`Send`), and each route body runs on the `LocalSet`: `Local::run(|state| async { … })` sends a `Send` closure over a
channel to a dispatcher spawned with `spawn_local`, which runs its future as a local task with `Rc<HttpState>` and
sends the response back. A caller that stops waiting (client gone) drops the local work, which ends a long poll the
way an aborted request did in TypeScript. On the current-thread runtime everything still runs on one thread. The
alternative — a hand-rolled hyper loop serving a `!Send` service — would give up axum's router and its `Send`
checking, for no gain.

## Adding a route group (later slices)

A group is `pub(crate) fn routes() -> Router<Local>` in its module plus one `.merge(module::routes())` line in
`lib.rs` `routes()`. Handlers take `State<Local>` (and `Extension<Target>` for the path/URL as Hono read them) and
call `response::on_local`. `mcp_studio_actor` and `client_ip_hash` are ready for MCP.

Not in this slice: the MCP transport (`GET`/`POST /api/mcp`, ops slice). Until it lands its paths are unknown
routes: `404 "not found\n"`.

## Parity

```
cargo test -p http_edge   # tests/goldens.rs replays parity/http/goldens.json (the Hono app, recorded from the TypeScript backend before the cutover; nothing re-records them) with `oneshot`
```

23 cases / 222 responses (every route; auth ok/missing/wrong; HEAD; ranges incl. suffix, clamped and 416; traversal
403; versioned vs unversioned caching; readiness 200/503/500; upload 403/413/415/429/400/200 with the stored
assets; trailing slashes; wrong methods; unknown routes; OAuth start without/with the command token by header,
query and cookie, callbacks with valid, foreign-platform, malformed and expired states, provider refusals, canned
token exchanges that succeed, fail with 400/401 or a transport error, and unconfigured Studios). A recording
transport answers the canned responses and the requests sent are compared; `randomBytes` is scripted as in the
channels goldens, and a sealed `state=` is compared opened. Each case also compares `channel_connections`,
`platform_tokens` (opened) and the live config's credentials. Plus `commandAllowed` (every token channel),
`mcpStudioActor`, `clientIpHash` and `streamUploadToFile` call by call. `server.rs` tests drive a real hyper
connection over an in-memory stream.

## Deliberate differences

- `content-length`: hyper frames every body; a length the TypeScript route did not set itself is not compared.
- Content types outside `mime.rs`'s table are `application/octet-stream` (Bun names a few hundred more).
- A directory under a video asset's path is "not found" (Bun would try to stream it).
- The 413 for a body over the cap and the idle close come from tower-http / hyper, not Bun's own wording.
