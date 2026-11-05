import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, describe, expect, it } from "vitest";
import { createTickrClient } from "../src/api/client.js";
import { clientAgent, createServer } from "../src/server.js";
import { KeyGate } from "../src/tools/gate.js";
import { entryFixture, IDS, meFixture, NOW } from "./helpers/fixtures.js";
import { json, startServer } from "./helpers/httpServer.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function connect(clientInfo: { name: string; version: string }) {
  const srv = await startServer((r) => (r.url === "/api/v1/me" ? json(200, meFixture()) : json(200, entryFixture())));
  close = srv.close;
  const holder: { server?: ReturnType<typeof createServer> } = {};
  const api = createTickrClient({ baseUrl: srv.baseUrl, apiKey: "tkr_test", agent: () => clientAgent(holder.server!)() });
  const server = createServer({ api, gate: new KeyGate(api), now: () => NOW, baseUrl: srv.baseUrl, apiKey: "tkr_test" });
  holder.server = server;
  const client = new Client(clientInfo);
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return { client, requests: srv.requests, server };
}

describe("agent provenance headers", () => {
  it("badges a write with the identity the MCP client sent at initialize", async () => {
    const { client, requests } = await connect({ name: "Claude Code", version: "2.1.300" });
    await client.callTool({ name: "start_timer", arguments: {} });
    const post = requests.find((r) => r.method === "POST")!;
    expect(post.url).toBe("/api/v1/timers/start");
    expect(post.headers["tickr-origin"]).toBe("agent");
    expect(post.headers["tickr-agent"]).toBe("claude-code/2.1.300");
    const me = requests.find((r) => r.url === "/api/v1/me")!;
    expect(me.headers["tickr-origin"]).toBeUndefined();
    expect(me.headers["tickr-agent"]).toBeUndefined();
  });

  it.each(["start_timer", "create_entry"])("returns the entry id in structuredContent and text of %s", async (name) => {
    const { client } = await connect({ name: "claude-code", version: "1.0.0" });
    const args = name === "create_entry"
      ? { project_id: IDS.projectA, started_at: "2026-10-02T09:00:00+02:00", stopped_at: "2026-10-02T10:00:00+02:00" }
      : {};
    const res = await client.callTool({ name, arguments: args });
    expect(res.isError).toBeFalsy();
    expect((res.structuredContent as { entry: { id: string } }).entry.id).toBe(IDS.entry);
    expect(JSON.parse((res.content as [{ text: string }])[0].text).entry.id).toBe(IDS.entry);
  });

  it("falls back to mcp-client/unknown before initialize", () => {
    const fresh = createServer({ api: {} as never, gate: {} as never, now: () => NOW, baseUrl: "http://x", apiKey: "k" });
    expect(clientAgent(fresh)()).toBe("mcp-client/unknown");
  });
});
