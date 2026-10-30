import { json } from "../../foundation/http-response.js";
import type { RouteModule } from "./context.js";

const CACHE = { "cache-control": "public, max-age=3600" };

/** The documents an MCP client probes before connecting to `/api/mcp`. They
 * describe this Studio, so they are served by it, on every install, whether or
 * not it has a public site. */
export const discoveryRoutes: RouteModule = (app, { config }) => {
  const origin = config.PUBLIC_BASE_URL.replace(/\/$/, "");

  // RFC 8414. This Studio issues no tokens — the Studio bearer token is minted
  // by its operator — so the grant and response lists are deliberately empty.
  // The document exists because MCP clients probe for it before falling back.
  app.get("/.well-known/oauth-authorization-server", () =>
    json({ issuer: origin, scopes_supported: ["read:feed"], response_types_supported: [], grant_types_supported: [] }, 200, CACHE),
  );

  // RFC 9728. The MCP endpoint is the protected resource; the read-only feed
  // scope is the only one it grants.
  app.get("/.well-known/oauth-protected-resource", () =>
    json(
      { resource: origin, authorization_servers: [origin], scopes_supported: ["read:feed"], bearer_methods_supported: ["header"] },
      200,
      CACHE,
    ),
  );

  // The endpoint is the MCP transport itself: this card used to point at
  // `/feed.json`, which speaks JSON Feed and not MCP, so every client that
  // believed the card failed to connect.
  app.get("/.well-known/mcp/server-card.json", () =>
    json(
      {
        $schema: "https://modelcontextprotocol.io/schemas/server-card/v1.0",
        version: "1.0",
        protocolVersion: "2025-06-18",
        serverInfo: { name: "solo-publisher-studio-mcp", version: "1.0.0" },
        description: `MCP server for operating the ${new URL(origin).host} Studio: drafts, delivery and analytics.`,
        transport: { type: "streamable-http", endpoint: "/api/mcp" },
        capabilities: { tools: { listChanged: true }, resources: { subscribe: true, listChanged: true } },
        authentication: { required: true, schemes: ["bearer"] },
      },
      200,
      CACHE,
    ),
  );
};
