import { mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../../hook-src/main.js";
import { loadSqlite } from "../../hook-src/runtime.js";

type Lookup = (id: string) => unknown;

function stubBuiltins(impl: Lookup | undefined) {
  const target = process as unknown as { getBuiltinModule?: Lookup };
  const original = target.getBuiltinModule;
  if (impl === undefined) delete target.getBuiltinModule;
  else target.getBuiltinModule = impl;
  restore.push(() => {
    target.getBuiltinModule = original;
  });
}

const restore: (() => void)[] = [];
const dirs: string[] = [];

afterEach(() => {
  while (restore.length) restore.pop()!();
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function hookIo(input: string) {
  const out: string[] = [];
  return {
    out,
    io: { stdin: Readable.from([input]), deadlineMs: Date.now() + 1000, write: (text: string) => void out.push(text) },
  };
}

function sessionInput(event: string, cwd: string) {
  return JSON.stringify({ session_id: "s-1", cwd, hook_event_name: event });
}

describe("loadSqlite", () => {
  it("loads node:sqlite on this runtime without a flag", () => {
    const sqlite = loadSqlite();
    expect(sqlite).not.toBeNull();
    expect(typeof sqlite!.DatabaseSync).toBe("function");
  });

  it("returns null when the runtime has no getBuiltinModule (Node 20 before 20.16)", () => {
    stubBuiltins(undefined);
    expect(loadSqlite()).toBeNull();
  });

  it("returns null when node:sqlite is not available without a flag", () => {
    stubBuiltins(() => undefined);
    expect(loadSqlite()).toBeNull();
  });

  it("returns null when loading node:sqlite throws", () => {
    stubBuiltins(() => {
      throw new Error("No such built-in module: node:sqlite");
    });
    expect(loadSqlite()).toBeNull();
  });
});

describe("unsupported runtime", () => {
  it("unsupported runtime ⇒ exit 0, one systemMessage on SessionStart, nothing on other events, no store directory created", async () => {
    stubBuiltins(() => undefined);
    const data = mkdtempSync(join(tmpdir(), "tickr-data-"));
    dirs.push(data);
    const env = {
      CLAUDE_PLUGIN_DATA: data,
      CLAUDE_PLUGIN_OPTION_API_KEY: "tkr_test_runtime_key",
      CLAUDE_PLUGIN_OPTION_BASE_URL: "https://tickr.example.test",
    };

    const start = hookIo(sessionInput("SessionStart", data));
    expect(await main(["SessionStart"], env, start.io)).toBe(0);
    expect(start.out).toHaveLength(1);
    const message = JSON.parse(start.out[0]!) as Record<string, unknown>;
    expect(Object.keys(message)).toEqual(["systemMessage"]);
    expect(message.systemMessage).toMatch(/node:sqlite/);
    expect(message.systemMessage).toMatch(/22\.13/);

    for (const event of ["UserPromptSubmit", "PostToolUse", "Stop", "SessionEnd"]) {
      const other = hookIo(sessionInput(event, data));
      expect(await main([event], env, other.io)).toBe(0);
      expect(other.out).toEqual([]);
    }
    expect(readdirSync(data)).toEqual([]);
  });
});
