# public_site — what the public website reads (Rust)

Port of the TypeScript `public/*` and the `/api/public/site` logic of `interfaces/http/public-site.ts`,
framework-free: the HTTP slice mounts it.

| Module | TypeScript |
|---|---|
| `feed.rs` (`FeedReader`, `FeedItem`) | `site-read-model.ts`: query, strict item checks with zod's issues, `site.feed.item_invalid` event, per-connection cache (TEMP attached `public_site_cache` + TEMP triggers + `pragma_data_version`, clock for scheduled locales) |
| `site.rs` (`PublicSite`) | `publicSiteBody`, `withServedMedia`, `servedMedia`, `siteIdentity`, the GET handler's ETag / 304 / `Prefer: wait=N` loop |
| `images.rs`, `image_size.rs` | `site-images.ts`; `image-size` 2.x for JPEG (EXIF orientation), PNG, WebP, GIF, HEIF/AVIF |
| `video_asset.rs` | `video-asset.ts` |
| `paths.rs` | Node `path.join`/`resolve`, WHATWG `URL` search, `versioned()` (also for the `/media/*` cache headers) |

## Mounting

One `PublicSite` per database handle, on the Studio's single-threaded runtime:

```rust
let response = site.respond(&db, &config, &clock, SiteRequest { if_none_match, prefer }).await?;
// response.status (200 | 304 | 404), response.headers, response.body (None for 304)
```

Dropping the future ends a long poll (client disconnect). An `Err` is the TypeScript handler's throw (500).
`public_video_asset(&db, sha256)` serves `/media/video/asset/:id`; `/media/*`, IndexNow and
`/generated/responsive/*` file serving belong to the HTTP slice.

## Parity

- `parity/public-site/goldens.json` (TS route, fixed clock, real ffmpeg images on disk; recorded from the TypeScript backend before the cutover; nothing re-records them):
  `tests/goldens.rs` replays every case byte-for-byte (body, ETag, headers, events).
- `tests/read_model.rs`: cache reuse, transactions, external connections.
- `tests/prod_copy.rs` (`--ignored`): body sha256 / ETag / item count over a database copy.

## Deliberate differences

- Stored instants are read with `parse_iso_instant` (explicit offset required); TypeScript reads an offset-less
  one in the host's zone. Production holds none.
- Image formats outside the five above (BMP, TIFF, SVG, ICO, …) are not sized; their entries keep their stored
  dimensions. `JSON.parse` inputs serde rejects (`1e999`, lone surrogates) fail the answer instead of parsing.
- The event journal is written, but the `telegram-events` worker bell (`ringWorker`) is the runtime slice's.
