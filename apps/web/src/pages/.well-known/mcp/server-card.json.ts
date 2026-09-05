import type { APIRoute } from "astro";
import { siteUrlFromContext } from "../../../utils/site";

/** Server card for MCP clients that discover a server before connecting.
 * The endpoint is the MCP transport itself: this card used to point at
 * `/feed.json`, which speaks JSON Feed and not MCP, so every client that
 * believed the card failed to connect. */
export const prerender = false;

export const GET: APIRoute = (context) => {
  const site = siteUrlFromContext(context);
  const body = {
    $schema: "https://modelcontextprotocol.io/schemas/server-card/v1.0",
    version: "1.0",
    protocolVersion: "2025-06-18",
    serverInfo: { name: "solo-publisher-studio-mcp", version: "1.0.0" },
    description: `MCP server for operating the ${new URL(site).host} Studio: drafts, delivery and analytics.`,
    transport: { type: "streamable-http", endpoint: "/api/mcp" },
    capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
    authentication: { required: true, schemes: ["bearer"] },
  };
  return new Response(JSON.stringify(body, null, 2), {
    headers: { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "public, max-age=3600" },
  });
};
