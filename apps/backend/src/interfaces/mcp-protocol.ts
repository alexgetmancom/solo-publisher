/** The metadata returned by initialize and advertised by discovery must agree. */
export const MCP_SERVER_METADATA = {
  protocolVersion: "2024-11-05",
  capabilities: { tools: {} },
  serverInfo: { name: "solo-publisher-studio-mcp", version: "2.1.0" },
} as const;
