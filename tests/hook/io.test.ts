import { PassThrough, Readable } from "node:stream";
import { describe, expect, it } from "vitest";
import { readHookInput, writeHookOutput } from "../../hook-src/io.js";
import { main } from "../../hook-src/main.js";

const valid = {
  session_id: "0b9f3c55-6f2e-4b8e-9d55-2f1f0f3f7a10",
  transcript_path: "/home/user/.claude/projects/x/0b9f.jsonl",
  cwd: "/home/user/project",
  hook_event_name: "PostToolUse",
  prompt_id: "p-1",
  tool_name: "Bash",
  tool_input: { command: "echo secret" },
  tool_response: { stdout: "ok" },
  tool_use_id: "toolu_01",
  prompt: "never kept",
};

function chunks(...parts: string[]) {
  return Readable.from(parts);
}

describe("readHookInput", () => {
  it("parses the hook input and keeps only the known fields", async () => {
    const input = await readHookInput(chunks(JSON.stringify(valid).slice(0, 20), JSON.stringify(valid).slice(20)), Date.now() + 1000);
    expect(input).toEqual({
      session_id: valid.session_id,
      transcript_path: valid.transcript_path,
      cwd: valid.cwd,
      hook_event_name: "PostToolUse",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_response: { stdout: "ok" },
      tool_use_id: "toolu_01",
    });
  });

  it("drops optional fields of the wrong type", async () => {
    const input = await readHookInput(
      chunks(JSON.stringify({ session_id: "s", cwd: "/", hook_event_name: "Stop", prompt_id: 3, source: ["x"] })),
      Date.now() + 1000,
    );
    expect(input).toEqual({ session_id: "s", cwd: "/", hook_event_name: "Stop" });
  });

  it.each([
    ["not JSON", "{ nope"],
    ["empty", ""],
    ["an array", "[]"],
    ["null", "null"],
    ["no session_id", JSON.stringify({ cwd: "/", hook_event_name: "Stop" })],
    ["an empty session_id", JSON.stringify({ session_id: "", cwd: "/", hook_event_name: "Stop" })],
    ["no cwd", JSON.stringify({ session_id: "s", hook_event_name: "Stop" })],
    ["no hook_event_name", JSON.stringify({ session_id: "s", cwd: "/" })],
  ])("returns null for %s", async (_label, text) => {
    expect(await readHookInput(chunks(text), Date.now() + 1000)).toBeNull();
  });

  it("returns null at the deadline when stdin never ends", async () => {
    const stdin = new PassThrough();
    stdin.write('{"session_id":');
    const started = Date.now();
    expect(await readHookInput(stdin, started + 150)).toBeNull();
    expect(Date.now() - started).toBeLessThan(1000);
    stdin.destroy();
  });

  it("returns null when stdin fails", async () => {
    const stdin = new PassThrough();
    const pending = readHookInput(stdin, Date.now() + 1000);
    stdin.destroy(new Error("broken pipe"));
    expect(await pending).toBeNull();
  });
});

describe("writeHookOutput", () => {
  it("writes one JSON object holding the systemMessage", () => {
    const out: string[] = [];
    writeHookOutput({ systemMessage: "Tickr: hello" }, (text) => void out.push(text));
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!)).toEqual({ systemMessage: "Tickr: hello" });
  });

  it("writes the note for the model as hookSpecificOutput.additionalContext, in the same JSON object", () => {
    const out: string[] = [];
    writeHookOutput({ systemMessage: "Tickr: hello", additionalContext: "Tickr session context: note" }, (text) => void out.push(text), "SessionStart");
    writeHookOutput({ additionalContext: "Tickr session context: note" }, (text) => void out.push(text));
    expect(out.map((o) => JSON.parse(o) as unknown)).toEqual([
      { systemMessage: "Tickr: hello", hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Tickr session context: note" } },
      { hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: "Tickr session context: note" } },
    ]);
  });

  it("writes nothing without a message", () => {
    const out: string[] = [];
    writeHookOutput({}, (text) => void out.push(text));
    writeHookOutput({ systemMessage: "" }, (text) => void out.push(text));
    writeHookOutput({ systemMessage: "", additionalContext: "" }, (text) => void out.push(text));
    expect(out).toEqual([]);
  });
});

describe("main", () => {
  const env = { CLAUDE_PLUGIN_OPTION_API_KEY: "tkr_test_io_key" };

  it("malformed stdin ⇒ exit 0 and no output", async () => {
    for (const event of ["SessionStart", "UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
      const out: string[] = [];
      const code = await main([event], env, {
        stdin: chunks("{ not json"),
        deadlineMs: Date.now() + 1000,
        write: (text) => void out.push(text),
      });
      expect(code).toBe(0);
      expect(out).toEqual([]);
    }
  });

  it("an exception anywhere in the handler ⇒ exit 0", async () => {
    const throwingStdin = {
      on() {
        throw new Error("boom");
      },
    } as unknown as NodeJS.ReadableStream;
    expect(await main(["Stop"], env, { stdin: throwingStdin, deadlineMs: Date.now() + 1000, write: () => undefined })).toBe(0);

    const failingWrite = () => {
      throw new Error("EPIPE");
    };
    const input = JSON.stringify({ session_id: "s", cwd: "/", hook_event_name: "SessionStart" });
    expect(await main(["SessionStart"], env, { stdin: chunks(input), deadlineMs: Date.now() + 1000, write: failingWrite })).toBe(0);
  });

  it("unknown arguments ⇒ exit 0 and no output", async () => {
    const out: string[] = [];
    const io = { stdin: chunks(""), deadlineMs: Date.now() + 1000, write: (text: string) => void out.push(text) };
    expect(await main([], env, io)).toBe(0);
    expect(await main(["NotAnEvent"], env, io)).toBe(0);
    expect(out).toEqual([]);
  });
});
