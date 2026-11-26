# channels — connected accounts, their credentials, and the probes that check them (Rust)

Connected accounts and the process/provider half of the observability probes. Registry reads publishing
needs stay in `domain::channels`; channel administration (register, Zernio route options) in
`domain::studio::services::channels`; the database-only probes in `domain::observability`
(`credentials`, `failures`, `runtime_health`, `dates`, plus `should_ping_token` / `record_token_ping` on the breaker).

| Module | Holds |
|---|---|
| `token_store` | the `platform_tokens` rows (an upsert only sets the columns a writer names) |
| `credentials` | `apply_stored_credentials`, `Setting`, `ConfigPatch` |
| `meta` | Threads and Instagram providers, OAuth and tokens |
| `x`, `youtube`, `api_keys` | X and YouTube OAuth and tokens; API-key services |
| `connect` | `start_connect`, `ConnectLinks` (the real `ChannelConnectLinks`) |
| `registry` | channel identity, destinations and target routing |
| `zernio` | `ZernioAccounts`: the Zernio directory over its account list |
| `oauth_routes` | the browser side of connecting an account, framework-free |
| `observability::{cycle, memory, token_health}` | the observability tick, process memory and the process half of runtime health, token health |
| `loops` | the `platform-tokens`, `credentials`, `x-token`, `observability` loop bodies |

Credentials changed at run time are swapped into the live `SharedConfig`.

## Wiring

```rust
loops.start(PLATFORM_TOKENS.0, PLATFORM_TOKENS.1, move || platform_tokens_tick(&config, &db, &http));
loops.start(CREDENTIALS.0, CREDENTIALS.1, move || credentials_tick(&config, &db));
loops.start(X_TOKEN.0, X_TOKEN.1, move || x_token_tick(&config, &db, &http));
loops.start(OBSERVABILITY, observability_interval(&config), move || observability_tick(&config, &db, &http));
```

Call `observability::memory::process_boot()` once at startup so the boot time is the process's. `app/src/host.rs` uses `ConnectLinks::new(SystemClock, OsEntropy)` and `ZernioAccounts`.

`crates/http` (`oauth.rs`) mounts `oauth_routes::{meta_start, meta_callback, x_start, x_callback, youtube_start,
youtube_callback}` with an `OauthContext` (live config, connection, `HttpClient`, clock, entropy, and the Studio's
`ChannelService` as `ChannelRegistrar`), the query decoded as Hono does (first occurrence, `+` and `%` decoded) and
the `commandAllowed` verdict; it adds `X-Robots-Tag: noindex, nofollow` and `Cache-Control: no-store` to every
`/oauth/*` answer.

## Goldens

`tests/channels_scenarios.rs` runs the steps of `tests/channels_scenarios.json` and compares with
the recorded goldens (`tests/channels_scenarios.golden.json`; nothing re-records them) (fixed clock, scripted `randomBytes`, canned responses incl. 400 `invalid_grant`, 401,
403, 429, 5xx, transport errors): results, requests, live-config credentials, every table, and `platform_tokens`
opened. Signed Meta states and PKCE challenges compare bit for bit; sealed states compare opened.

## Differences

- Memory logging reports `rssMb` only (no JavaScript heap in a Rust process); rss is `VmRSS` from `/proc`.
- `youtube_access_token` refuses a token response without `access_token` (the runtime crate's approved deviation),
  so a YouTube probe answered that way is inconclusive instead of calling with `Bearer undefined`.
- `JSON.parse` failures of an authentic Meta state carry serde's message.
