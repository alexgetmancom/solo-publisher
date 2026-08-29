/** Range-aware file serving shared by every route that streams a media file.
 *
 * Video seeking is the reason this exists: a player that gets `Accept-Ranges:
 * bytes` and then a plain 200 for its `Range` request either refetches the whole
 * file on every scrub (Chrome) or refuses to seek at all (Safari/iOS). The header
 * and the 206 must therefore be produced together, in one place — routes used to
 * advertise one and implement the other.
 *
 * Routes that intentionally serve whole files only (see media/video/asset/[id].ts,
 * consumed by Meta's importer) must not use this helper: they omit `Accept-Ranges`
 * on purpose. */

type RangeSpec = { start: number; end: number };

function parseRange(value: string | null, size: number): RangeSpec | null | "invalid" {
  if (!value) return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(value.trim());
  if (!match) return "invalid";
  // `bytes=-500` is a suffix range: the last 500 bytes, not the first 500.
  // Read as a normal range it answered from the head of the file, and a player
  // asking for the trailing moov atom got the opening bytes with a 206 saying
  // they were the closing ones.
  if (!match[1]) {
    const suffixLength = Number(match[2]);
    if (!match[2] || !Number.isInteger(suffixLength) || suffixLength <= 0) return "invalid";
    return { start: Math.max(0, size - suffixLength), end: size - 1 };
  }
  const start = Number(match[1]);
  const end = match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  if (!Number.isInteger(start) || !Number.isInteger(end) || start < 0 || start > end || start >= size) return "invalid";
  return { start, end };
}

/** Answers `request` with `file`, honouring `Range` and setting the length headers.
 * `headers` carries route-specific policy (content type, caching); this function
 * owns only the byte-range contract. */
export function rangedFileResponse(
  file: ReturnType<typeof Bun.file>,
  request: Request,
  init: { headers: HeadersInit; headOnly: boolean },
): Response {
  const size = file.size;
  const headers = new Headers(init.headers);
  headers.set("Accept-Ranges", "bytes");

  const range = parseRange(request.headers.get("range"), size);
  if (range === "invalid") {
    headers.set("Content-Range", `bytes */${size}`);
    return new Response(null, { status: 416, headers });
  }
  if (range) {
    headers.set("Content-Length", String(range.end - range.start + 1));
    headers.set("Content-Range", `bytes ${range.start}-${range.end}/${size}`);
    return new Response(init.headOnly ? null : file.slice(range.start, range.end + 1), { status: 206, headers });
  }

  headers.set("Content-Length", String(size));
  return new Response(init.headOnly ? null : file, { headers });
}
