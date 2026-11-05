#!/usr/bin/env node
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTickrClient } from "./api/client.js";
import { ConfigError, loadConfig } from "./config.js";
import { FALLBACK_NAME, FALLBACK_VERSION } from "./api/agent.js";
import { clientAgent, createServer } from "./server.js";
import { KeyGate } from "./tools/gate.js";

async function main(): Promise<void> {
  let config;
  try {
    config = loadConfig(process.env);
  } catch (e) {
    if (e instanceof ConfigError) {
      console.error(`tickr-mcp: ${e.message}`);
      process.exit(1);
    }
    throw e;
  }
  // The client identity is only known after `initialize`, so it is read at each write.
  const connected: { server?: McpServer } = {};
  const api = createTickrClient({
    baseUrl: config.baseUrl,
    apiKey: config.apiKey,
    agent: () => (connected.server ? clientAgent(connected.server)() : `${FALLBACK_NAME}/${FALLBACK_VERSION}`),
  });
  const server = createServer({
    api, gate: new KeyGate(api), now: () => new Date(), baseUrl: config.baseUrl, apiKey: config.apiKey,
  });
  connected.server = server;
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(`tickr-mcp: fatal error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
