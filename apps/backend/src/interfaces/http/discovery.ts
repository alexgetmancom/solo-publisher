import { json } from "../../foundation/http-response.js";
import { MCP_SERVER_METADATA } from "../mcp-protocol.js";
import type { RouteModule } from "./context.js";

const CACHE = { "cache-control": "public, max-age=3600" };

/** The documents an MCP client probes before connecting to `/api/mcp`. They
 * describe this Studio, so they are served by it, on every install, whether or
 * not it has a public site. */
export const discoveryRoutes: RouteModule = (app, { config }) => {
  const origin = config.PUBLIC_BASE_URL.replace(/\/$/, "");

  // An operator provisions the bearer token; this Studio issues no OAuth tokens
  // and must not advertise an authorization server or fictional feed scopes.
  app.get("/.well-known/oauth-protected-resource", () =>
    json({ resource: `${origin}/api/mcp`, bearer_methods_supported: ["header"] }, 200, CACHE),
  );

  // The endpoint is the MCP transport itself: this card used to point at
  // `/feed.json`, which speaks JSON Feed and not MCP, so every client that
  // believed the card failed to connect.
  app.get("/.well-known/mcp/server-card.json", () =>
    json(
      {
        version: "1.0",
        ...MCP_SERVER_METADATA,
        description: `Operator tools for the ${new URL(origin).host} Studio. Studio tools require an operator-provisioned bearer token. Read public site content through /feed-ai.json and /llms.txt.`,
        transport: { type: "streamable-http", endpoint: "/api/mcp" },
        authentication: { required: true, schemes: ["bearer"] },
      },
      200,
      CACHE,
    ),
  );
};
