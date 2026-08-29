import { escapeHtml } from "../../foundation/html.js";
import { html } from "../../foundation/http-response.js";
import type { RouteModule } from "./context.js";

/** A pageview beacon is one JSON object holding one path. */
const PAGEVIEW_MAX_BODY_BYTES = 4096;

/** Reads at most `maxBytes` of the body, or nothing. A declared length is a
 * hint and an absent one means nothing, so the ceiling is enforced against the
 * bytes that actually arrive rather than against what the caller claims. */
async function boundedBody(request: Request, maxBytes: number): Promise<string | null> {
  const declared = Number(request.headers.get("content-length"));
  if (Number.isFinite(declared) && declared > maxBytes) return null;
  const body = request.body;
  if (!body) return null;
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    if (!value) continue;
    size += value.byteLength;
    if (size > maxBytes) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  return new TextDecoder().decode(Buffer.concat(chunks));
}

function parsePath(raw: string): string {
  try {
    const value = JSON.parse(raw) as { path?: unknown };
    return typeof value?.path === "string" ? value.path : "/";
  } catch {
    return "/";
  }
}

export const engagementRoutes: RouteModule = (app, { engagement }) => {
  // The only anonymous route that reads a body. Both guards run before it is
  // read: the reverse proxy allows a gigabyte, this container has 384 MB, and
  // one unauthenticated POST used to be able to spend all of it. A pageview
  // beacon carries one path.
  app.post("/stats/pageview", async (c) => {
    if (!engagement.allowPageview(c.req.raw)) return new Response(null, { status: 429 });
    const raw = await boundedBody(c.req.raw, PAGEVIEW_MAX_BODY_BYTES);
    if (raw == null) return new Response(null, { status: 413 });
    const body = parsePath(raw);
    engagement.recordPageview(body);
    return new Response(null, { status: 204 });
  });

  app.get("/stats", () => {
    const summary = engagement.metrics();
    return html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site metrics</title></head><body><main><h1>Site metrics</h1><p>Total: ${escapeHtml(summary.total)}</p><p>Today: ${escapeHtml(summary.today)}</p><p>Last 7 days: ${escapeHtml(summary.last7)}</p><p>Updated: ${escapeHtml(summary.updated_at ?? "-")}</p></main></body></html>`,
    );
  });
};
