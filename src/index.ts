#!/usr/bin/env node
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createTickrClient } from "./api/client.js";
import { ConfigError, loadConfig } from "./config.js";
import { createServer } from "./server.js";
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
  const api = createTickrClient({ baseUrl: config.baseUrl, apiKey: config.apiKey });
  const server = createServer({
    api, gate: new KeyGate(api), now: () => new Date(), baseUrl: config.baseUrl, apiKey: config.apiKey,
  });
  await server.connect(new StdioServerTransport());
}

main().catch((e: unknown) => {
  console.error(`tickr-mcp: fatal error: ${e instanceof Error ? e.message : "unknown"}`);
  process.exit(1);
});
