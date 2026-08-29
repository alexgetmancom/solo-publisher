import { escapeHtml } from "../../foundation/html.js";
import { html } from "../../foundation/http-response.js";
import type { RouteModule } from "./context.js";

export const engagementRoutes: RouteModule = (app, { engagement }) => {
  app.post("/stats/pageview", async (c) => {
    const body = await c.req.raw.json().catch(() => ({}) as { path?: string });
    engagement.recordPageview(c.req.raw, typeof body?.path === "string" ? body.path : "/");
    return new Response(null, { status: 204 });
  });

  app.get("/stats", () => {
    const summary = engagement.metrics();
    return html(
      `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Site metrics</title></head><body><main><h1>Site metrics</h1><p>Total: ${escapeHtml(summary.total)}</p><p>Today: ${escapeHtml(summary.today)}</p><p>Last 7 days: ${escapeHtml(summary.last7)}</p><p>Updated: ${escapeHtml(summary.updated_at ?? "-")}</p></main></body></html>`,
    );
  });
};
