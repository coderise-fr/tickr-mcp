import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it } from "vitest";
import { createServer } from "../src/server.js";
import { KeyGate } from "../src/tools/gate.js";
import { MAX_INPUT_ELEMENTS } from "../src/tools/tool.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { NOW } from "./helpers/fixtures.js";

async function connect(api = fakeApi()) {
  const server = createServer({ api, gate: new KeyGate(api), now: () => NOW, baseUrl: "https://t.example.com", apiKey: "tkr_test" });
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

  describe("input-validation errors", () => {
    const callText = async (name: string, args: Record<string, unknown>) => {
      const { client, api } = await connect();
      const res = await client.callTool({ name, arguments: args });
      expect(res.isError).toBe(true);
      expect(Object.values(api).some((fn) => fn.mock.calls.length > 0)).toBe(false);
      return (res.content as { text: string }[])[0]!.text;
    };

    it("do not echo an unknown parameter: they count them and list the allowed names", async () => {
      const longKey = "X".repeat(10_000) + "‮";
      const text = await callText("start_timer", { [longKey]: true, other: 1 });
      expect(text.length).toBeLessThan(500);
      expect(text).not.toContain("‮");
      expect(text).not.toContain("XXXX");
      expect(text).not.toContain("other");
      expect(text).toMatch(/2 unknown parameters/);
      expect(text).toMatch(/project_id, task_id, description, tag_ids, billable, started_at/);
    });

    it("say that a tool without parameters takes none", async () => {
      const text = await callText("get_context", { ["Y".repeat(10_000)]: 1 });
      expect(text.length).toBeLessThan(500);
      expect(text).not.toContain("YYYY");
      expect(text).toMatch(/1 unknown parameter\b.*takes no parameters/);
    });

    it.each(["start_timer", "stop_timer", "list_entries", "create_entry", "update_entry", "list_projects", "list_tasks", "list_tags", "list_active_timers"])(
      "%s never echoes an unknown parameter name",
      async (name) => {
        const text = await callText(name, { ["Z".repeat(5000) + "‮"]: 1 });
        expect(text.length).toBeLessThan(500);
        expect(text).not.toContain("ZZZZ");
        expect(text).not.toContain("‮");
      },
    );

    it("stay bounded for a huge array of invalid ids", async () => {
      const text = await callText("start_timer", { tag_ids: Array.from({ length: 10_000 }, () => "‮" + "t".repeat(100)) });
      expect(text.length).toBeLessThan(500);
      expect(text).not.toContain("‮");
      expect(text).not.toContain("tttt");
    });

    it("stay bounded, with our own text only, for the largest accepted array of invalid ids", async () => {
      const text = await callText("update_entry", {
        entry_id: "0199a000-0000-7000-8000-000000000001",
        tag_ids: Array.from({ length: MAX_INPUT_ELEMENTS - 2 }, () => "‮" + "t".repeat(100)),
      });
      expect(text).toMatch(/Expected a Tickr id/);
      expect(text.length).toBeLessThan(MAX_INPUT_ELEMENTS * 100);
      expect(text).not.toMatch(/‮|tttt/);
    });

    it("do not echo the value of a wrongly typed parameter", async () => {
      const text = await callText("update_entry", { entry_id: "W".repeat(10_000) + "‮", description: { ["V".repeat(5000)]: 1 } });
      expect(text.length).toBeLessThan(500);
      expect(text).not.toMatch(/WWWW|VVVV|‮/);
    });
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
