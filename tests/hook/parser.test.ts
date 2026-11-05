import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { MODEL_GRAMMAR, parseLines, sanitizeModel, UNKNOWN_MODEL } from "../../hook-src/transcript/parser.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "transcripts");
const fixture = (name: string) => readFileSync(join(FIXTURES, name), "utf8");
const AGENT = "a0000000000000001";

describe("parseLines", () => {
  it("one message spread over duplicate lines ⇒ one row, its earliest timestamp, several models, no synthetic line", () => {
    const parsed = parseLines(fixture("session-main.jsonl"));
    expect(parsed.malformed).toBe(0);
    expect(parsed.unknownShape).toBe(false);
    expect(parsed.messages).toEqual([
      {
        messageId: "msg_0001",
        model: "claude-opus-4-7",
        timestamp: "2026-11-05T09:00:04.000Z",
        input: 3,
        output: 410,
        cacheCreation: 2100,
        cacheRead: 18000,
        sidechain: false,
        version: "2.1.300",
      },
      {
        messageId: "msg_0002",
        model: "claude-sonnet-4-5",
        timestamp: "2026-11-05T09:00:10.000Z",
        input: 5,
        output: 220,
        cacheCreation: 300,
        cacheRead: 20100,
        sidechain: false,
        version: "2.1.300",
      },
      {
        messageId: "msg_0003",
        model: "claude-haiku-4-5-1m",
        timestamp: "2026-11-05T09:01:00.000Z",
        input: 2,
        output: 90,
        cacheCreation: 0,
        cacheRead: 20400,
        sidechain: false,
        version: "2.1.300",
      },
    ]);
    expect(parsed.messages.some((m) => m.model.includes("synthetic"))).toBe(false);
  });

  it("extracts the Claude Code version and the Agent tool calls", () => {
    const parsed = parseLines(fixture("session-main.jsonl"));
    expect(parsed.version).toBe("2.1.300");
    expect(parsed.launches).toEqual([{ toolUseId: "toolu_agent_0001", timestamp: "2026-11-05T09:00:10.000Z" }]);
  });

  it("keeps no text, path or tool input of the transcript", () => {
    const parsed = JSON.stringify(parseLines(fixture("session-main.jsonl")));
    expect(parsed).not.toContain("redacted");
    expect(parsed).not.toContain("/workspace");
    expect(parsed).not.toContain("branch");
  });

  it("subagent lines are sidechain messages with their agent id", () => {
    const parsed = parseLines(fixture(`session-main/subagents/agent-${AGENT}.jsonl`));
    expect(parsed.messages.map((m) => [m.messageId, m.sidechain, m.agentId, m.output])).toEqual([
      ["msg_0101", true, AGENT, 150],
      ["msg_0102", true, AGENT, 700],
    ]);
  });

  it("lines that accumulate usage ⇒ per-field maximum (PD-16)", () => {
    const [msg, ...rest] = parseLines(fixture("accumulating.jsonl")).messages;
    expect(rest).toEqual([]);
    expect(msg).toMatchObject({ messageId: "msg_0201", input: 7, output: 333, cacheCreation: 900, cacheRead: 100, timestamp: "2026-11-05T10:00:01.000Z" });
  });

  it("malformed lines are counted and skipped", () => {
    const parsed = parseLines(fixture("malformed.jsonl"));
    expect(parsed.malformed).toBe(2);
    expect(parsed.unknownShape).toBe(false);
    expect(parsed.messages.map((m) => m.messageId)).toEqual(["msg_0301", "msg_0303"]);
  });

  it("stops before a trailing partial line", () => {
    const text = fixture("accumulating.jsonl");
    const lines = text.split("\n");
    const cut = `${lines[0]}\n${lines[1]}\n${lines[2]!.slice(0, 40)}`;
    const parsed = parseLines(cut);
    expect(parsed.consumedBytes).toBe(Buffer.byteLength(`${lines[0]}\n${lines[1]}\n`));
    expect(parsed.messages).toHaveLength(1);
    expect(parsed.messages[0]!.output).toBe(64);
    expect(parsed.malformed).toBe(0);
  });

  it("counts consumed bytes in UTF-8", () => {
    const line = `${JSON.stringify({ type: "user", message: { content: "é€😀" } })}\n`;
    expect(parseLines(line + "{\"partial").consumedBytes).toBe(Buffer.byteLength(line, "utf8"));
  });

  it("unknown shape ⇒ unknownShape", () => {
    expect(parseLines(fixture("unknown-shape.jsonl")).unknownShape).toBe(true);
    expect(parseLines(fixture("unknown-usage.jsonl")).unknownShape).toBe(true);
    expect(parseLines("").unknownShape).toBe(false);
    expect(parseLines("garbage\n").unknownShape).toBe(false);
  });

  it("skips negative or non-numeric counts and invalid timestamps", () => {
    const line = (usage: unknown, timestamp: unknown = "2026-11-05T10:00:00Z") =>
      JSON.stringify({ type: "assistant", timestamp, message: { id: "m", model: "claude-x", usage } });
    expect(parseLines(`${line({ input_tokens: -1, output_tokens: 1 })}\n`).messages).toEqual([]);
    expect(parseLines(`${line({ input_tokens: "1", output_tokens: 1 })}\n`).messages).toEqual([]);
    expect(parseLines(`${line({ input_tokens: 1, output_tokens: 1 }, "yesterday")}\n`).messages).toEqual([]);
    expect(parseLines(`${line({ input_tokens: 1, output_tokens: 2 })}\n`).messages[0]).toMatchObject({
      input: 1,
      output: 2,
      cacheCreation: 0,
      cacheRead: 0,
      timestamp: "2026-11-05T10:00:00.000Z",
    });
  });
});

describe("sanitizeModel", () => {
  it("keeps a model of the backend grammar unchanged", () => {
    for (const model of ["claude-opus-4-7", "us.anthropic.claude-sonnet-4-5-v1:0", "claude-sonnet-4-5@20250929", "models/claude-x"]) {
      expect(sanitizeModel(model)).toBe(model);
    }
  });

  it("rewrites anything else into the grammar", () => {
    expect(sanitizeModel("claude-haiku-4-5[1m]")).toBe("claude-haiku-4-5-1m");
    expect(sanitizeModel("  -claude opus\r\n")).toBe("claude-opus");
    expect(sanitizeModel("x".repeat(300))).toBe("x".repeat(128));
    expect(sanitizeModel("модель")).toBe(UNKNOWN_MODEL);
    expect(sanitizeModel("")).toBe(UNKNOWN_MODEL);
    expect(sanitizeModel(42)).toBe(UNKNOWN_MODEL);
    for (const raw of ["a[b]", "-x-", "é", "a".repeat(129), "1/2:3@4", "\u0000"]) expect(sanitizeModel(raw)).toMatch(MODEL_GRAMMAR);
  });
});
