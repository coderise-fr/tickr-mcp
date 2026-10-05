import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { KeyGate } from "../src/tools/gate.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { NOW } from "./helpers/fixtures.js";

async function connect(api = fakeApi()) {
  const server = createServer({ api, gate: new KeyGate(api), now: () => NOW, baseUrl: "https://t.example.com" });
  const client = new Client({ name: "test", version: "0.0.0" });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(clientTransport), server.connect(serverTransport)]);
  return { client, api };
}

describe("MCP protocol", () => {
  it("exposes exactly the ten V1 tools (scope guard: no delete, no bulk)", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name).sort()).toEqual([
      "create_entry", "get_context", "list_active_timers", "list_entries", "list_projects",
      "list_tags", "list_tasks", "start_timer", "stop_timer", "update_entry",
    ]);
  });

  it("declares input and output schemas and annotations on every tool", async () => {
    const { client } = await connect();
    const { tools } = await client.listTools();
    for (const t of tools) {
      expect(t.inputSchema.type).toBe("object");
      expect(t.outputSchema?.type).toBe("object");
      expect(t.annotations?.openWorldHint).toBe(true);
      expect(typeof t.annotations?.readOnlyHint).toBe("boolean");
    }
  });

  it("runs a full call with structured content", async () => {
    const { client } = await connect();
    const res = await client.callTool({ name: "get_context", arguments: {} });
    expect(res.isError).toBeFalsy();
    expect(res.structuredContent).toMatchObject({ role: "workspace_user", user: { timezone: "Europe/Paris" } });
  });

  it("rejects invalid arguments before any network call", async () => {
    const { client, api } = await connect();
    // Depending on the SDK version, invalid arguments come back as an isError result or as a
    // thrown InvalidParams error. Both are acceptable; what matters is that nothing hit the API.
    const res = await client
      .callTool({ name: "start_timer", arguments: { started_at: "2026-10-02T09:00:00" } })
      .catch((e: unknown) => ({ isError: true, thrown: e }));
    expect(res.isError).toBe(true);
    expect(api.me).not.toHaveBeenCalled();
    expect(api.startTimer).not.toHaveBeenCalled();
  });

  it("turns API failures into isError results", async () => {
    const api = fakeApi();
    api.me.mockResolvedValue({ ...(await api.me()), keyRole: "owner" });
    const { client } = await connect(api);
    const res = await client.callTool({ name: "list_projects", arguments: {} });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/owner role/);
  });
});
