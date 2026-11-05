import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { AGENT_NAME, AGENT_VERSION, agentHeaderValue } from "../src/api/agent.js";

describe("agentHeaderValue", () => {
  it("keeps a conforming identity", () => expect(agentHeaderValue({ name: "claude-code", version: "2.1.300" })).toBe("claude-code/2.1.300"));
  it("lower-cases the name and replaces characters outside the grammar", () =>
    expect(agentHeaderValue({ name: "Claude Desktop", version: "1.0 beta" })).toBe("claude-desktop/1.0-beta"));
  it("drops leading characters a spreadsheet reads as a formula", () =>
    expect(agentHeaderValue({ name: "=cmd", version: "+1" })).toBe("cmd/1"));
  it("truncates to 64 and 32 characters", () => {
    const [n, v] = agentHeaderValue({ name: "a".repeat(100), version: "1".repeat(50) }).split("/");
    expect([n!.length, v!.length]).toEqual([64, 32]);
  });
  it.each([
    [undefined, "mcp-client/unknown"], [{ name: "日本", version: "" }, "mcp-client/unknown"],
    [{ name: "cursor" }, "cursor/unknown"], [{ name: 42, version: "1" }, "mcp-client/1"],
  ])("falls back per part (%j)", (info, expected) => expect(agentHeaderValue(info)).toBe(expected));
  it.each(["a\r\nX-Evil: 1", "a/b/c", "İstanbul", "--", "\t1", "x".repeat(5000)])(
    "always produces exactly one valid name/version pair for %j", (raw) => {
      const parts = agentHeaderValue({ name: raw, version: raw }).split("/");
      expect(parts).toHaveLength(2);
      expect(parts[0]).toMatch(AGENT_NAME);
      expect(parts[1]).toMatch(AGENT_VERSION);
    });
  it("maps the captured Claude Code initialize to claude-code/<its version>", () => {
    const { params } = JSON.parse(readFileSync(new URL("./fixtures/mcp/initialize-claude-code.json", import.meta.url), "utf8")) as {
      params: { clientInfo: { name: string; version: string } };
    };
    expect(params.clientInfo.name).toBe("claude-code");
    expect(agentHeaderValue(params.clientInfo)).toBe(`claude-code/${params.clientInfo.version}`);
  });
  it("pins the backend grammars", () => {
    expect(AGENT_NAME.source).toBe("^[a-z0-9][a-z0-9._-]{0,63}$");
    expect(AGENT_VERSION.source).toBe("^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$");
  });
});
