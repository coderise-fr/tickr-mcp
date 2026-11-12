import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isLinked, linkKey } from "../../hook-src/consent.js";
import { isOwnerFresh, OWNER_STALE_MS } from "../../hook-src/flusher/owner.js";
import { findMapping, type FoundMapping } from "../../hook-src/mapping.js";
import { DESCRIBE_NOTE, INTAKE_PAUSED_KEY, providerFrom, recordEvent } from "../../hook-src/intake.js";
import { main } from "../../hook-src/main.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import {
  cleanTempDirs,
  count,
  hookInput,
  instanceFor,
  KEY,
  linkCheckout,
  listJson,
  OTHER_PROJECT,
  pluginConfig,
  pluginEnv,
  PROJECT,
  rawDb,
  tempDir,
  WS,
  writeMapping,
} from "./helpers/env.js";

afterEach(() => cleanTempDirs());

function flusherStore(path: string): Store {
  return openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
}

function linked(migrated = true) {
  const root = tempDir();
  const cwd = writeMapping(join(root, "repo"));
  const data = join(root, "data");
  linkCheckout(data, cwd);
  const dir = instanceFor(data);
  const dbPath = join(dir, DB_FILE);
  if (migrated) flusherStore(dbPath).close();
  return { root, cwd, data, dir, dbPath, cfg: pluginConfig(data) };
}

const soon = () => Date.now() + 1000;

describe("recordEvent", () => {
  it("journals the event with the allow-listed fields only", () => {
    const { cwd, dbPath, cfg } = linked();
    const input = hookInput("PostToolUse", cwd, {
      transcript_path: "/t/s-1.jsonl",
      prompt_id: "p-1",
      tool_name: "Bash",
      tool_use_id: "toolu_1",
      tool_response: { stdout: "SENTINEL_OUTPUT" },
    });
    const now = new Date("2026-11-05T10:00:00.000Z");
    expect(recordEvent(input, cfg, soon(), { now: () => now, uptime: () => 1234.5, env: {} })).toEqual({});
    const store = flusherStore(dbPath);
    const [ev] = store.eventsAfter(0);
    expect(ev).toMatchObject({
      sessionId: "s-1",
      type: "PostToolUse",
      localTime: "2026-11-05T10:00:00.000Z",
      uptimeS: 1234.5,
      transcriptPath: "/t/s-1.jsonl",
      provider: "anthropic",
      promptId: "p-1",
      toolName: "Bash",
      toolUseId: "toolu_1",
      entryId: null,
    });
    expect(ev!.eventId).toMatch(/^[0-9A-HJKMNP-TV-Z]{26}$/);
    expect(JSON.stringify(store.eventsAfter(0))).not.toContain("SENTINEL");
    expect(JSON.parse(store.getMapping(ev!.mappingVersionId!)!.normalizedJson)).toEqual({
      description: "Claude Code session",
      projectId: PROJECT,
      tagIds: [],
      taskId: null,
      workspaceId: WS,
    });
    store.close();
  });

  it("journals the link of the checkout's .tickr.json with every event (a key, no path)", () => {
    const { cwd, data, dbPath, cfg } = linked();
    const nested = join(cwd, "src", "deep");
    mkdirSync(nested, { recursive: true });
    recordEvent(hookInput("UserPromptSubmit", nested), cfg, soon(), { linked: (dir, hash) => isLinked(data, dir, hash) });
    const store = flusherStore(dbPath);
    const found = findMapping(cwd) as FoundMapping;
    const [ev] = store.eventsAfter(0);
    expect(ev).toMatchObject({ linkKey: linkKey(found.dir, found.hash) });
    expect(store.lastLinkKey("s-1")).toBe(linkKey(found.dir, found.hash));
    expect(store.lastLinkKey("s-unknown")).toBeNull();
    expect(JSON.stringify(store.eventsAfter(0))).not.toContain(JSON.stringify(cwd).slice(1, -1));
    store.close();
  });

  it("records the subagent id and transcript of SubagentStart / SubagentStop and of a subagent's tool calls", () => {
    const { cwd, dbPath, cfg } = linked();
    recordEvent(hookInput("SubagentStart", cwd, { agent_id: "a-1" }), cfg, soon());
    recordEvent(hookInput("PostToolUse", cwd, { agent_id: "a-1", tool_name: "Read" }), cfg, soon());
    recordEvent(hookInput("SubagentStop", cwd, { agent_id: "a-1", agent_transcript_path: "/t/s-1/subagents/agent-a-1.jsonl" }), cfg, soon());
    const store = flusherStore(dbPath);
    expect(store.eventsAfter(0).map((e) => [e.type, e.agentId, e.agentTranscriptPath])).toEqual([
      ["SubagentStart", "a-1", null],
      ["PostToolUse", "a-1", null],
      ["SubagentStop", "a-1", "/t/s-1/subagents/agent-a-1.jsonl"],
    ]);
    store.close();
  });

  it(".tickr.json changed between two events ⇒ two mapping versions, each event keeps its own", () => {
    const { cwd, dbPath, cfg } = linked();
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, soon());
    recordEvent(hookInput("PostToolUse", cwd), cfg, soon());
    writeMapping(cwd, { workspace_id: WS, project_id: OTHER_PROJECT });
    recordEvent(hookInput("PostToolUse", cwd), cfg, soon());

    const store = flusherStore(dbPath);
    const versions = store.listMappings();
    expect(versions).toHaveLength(2);
    const projectOf = (id: number | null) => JSON.parse(store.getMapping(id!)!.normalizedJson).projectId;
    expect(store.eventsAfter(0).map((e) => projectOf(e.mappingVersionId))).toEqual([PROJECT, PROJECT, OTHER_PROJECT]);
    store.close();
  });

  it("derives the provider from Claude Code's switches", () => {
    expect(providerFrom({})).toBe("anthropic");
    expect(providerFrom({ CLAUDE_CODE_USE_BEDROCK: "1" })).toBe("bedrock");
    expect(providerFrom({ CLAUDE_CODE_USE_VERTEX: "true" })).toBe("vertex");
    expect(providerFrom({ CLAUDE_CODE_USE_FOUNDRY: "1" })).toBe("foundry");
    expect(providerFrom({ CLAUDE_CODE_USE_BEDROCK: "0", CLAUDE_CODE_USE_VERTEX: "" })).toBe("anthropic");
  });

  it("does nothing for a checkout without .tickr.json", () => {
    const root = tempDir();
    const data = join(root, "data");
    const starts: string[] = [];
    expect(recordEvent(hookInput("UserPromptSubmit", root), pluginConfig(data), soon(), { startFlusher: (d) => starts.push(d) })).toEqual({});
    expect(existsSync(data)).toBe(false);
    expect(starts).toEqual([]);
  });

  it("an invalid .tickr.json ⇒ one message at SessionStart, nothing journalled", () => {
    const root = tempDir();
    writeFileSync(join(root, ".tickr.json"), "{ not json");
    const cfg = pluginConfig(join(root, "data"));
    const start = recordEvent(hookInput("SessionStart", root), cfg, soon());
    expect(start.systemMessage).toMatch(/^Tickr: \.tickr\.json is not valid JSON\. This session is not tracked\.$/);
    expect(recordEvent(hookInput("UserPromptSubmit", root), cfg, soon())).toEqual({});
  });

  it("the first event of a new instance goes to a fallback file and starts a flusher", () => {
    const { cwd, dir, cfg } = linked(false);
    const starts: string[] = [];
    recordEvent(hookInput("SessionStart", cwd), cfg, soon(), { startFlusher: (d) => starts.push(d) });
    expect(listJson(join(dir, "fallback"))).toHaveLength(1);
    expect(starts).toEqual([dir]);
    const info = readFileSync(join(dir, "instance.json"), "utf8");
    expect(info).not.toContain(KEY);
  });

  it("starts a flusher only when no owner heartbeat is fresh", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const now = new Date("2026-11-05T10:00:00.000Z");
    const starts: string[] = [];
    const record = () => recordEvent(hookInput("PostToolUse", cwd), cfg, soon(), { now: () => now, startFlusher: (d) => starts.push(d) });

    record();
    expect(starts).toEqual([dir]);

    const store = flusherStore(dbPath);
    store.insertFirstOwner(1, new Date(now.getTime() - OWNER_STALE_MS + 1000).toISOString());
    record();
    expect(starts).toHaveLength(1);

    store.setOwnerHeartbeat(1, new Date(now.getTime() - OWNER_STALE_MS - 1000).toISOString());
    expect(isOwnerFresh(store.readOwner(), now)).toBe(false);
    record();
    expect(starts).toHaveLength(2);
    store.close();
  });

  it("shows the queued notices once and marks them shown", () => {
    const { cwd, dbPath, cfg } = linked();
    const store = flusherStore(dbPath);
    store.addNotice("unauthorized", "2026-11-05T09:00:00.000Z");
    store.close();
    expect(recordEvent(hookInput("PostToolUse", cwd), cfg, soon()).systemMessage).toMatch(/API key was refused/);
    expect(recordEvent(hookInput("PostToolUse", cwd), cfg, soon())).toEqual({});
  });

  it("journals nothing, not even a fallback file, while intake is paused", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const store = flusherStore(dbPath);
    store.setMeta(INTAKE_PAUSED_KEY, "bytes");
    store.addNotice("intake_paused", "2026-11-05T09:00:00.000Z");
    store.close();
    expect(recordEvent(hookInput("PostToolUse", cwd), cfg, soon()).systemMessage).toMatch(/paused/);
    expect(recordEvent(hookInput("PostToolUse", cwd), cfg, soon())).toEqual({});
    const db = rawDb(dbPath);
    expect(count(db, "events")).toBe(0);
    db.close();
    expect(listJson(join(dir, "fallback"))).toEqual([]);
  });

  it('unwritable data dir ⇒ exit 0, gaps counter attempted, next hook shows "collection interrupted"', async () => {
    const { cwd, data, dir, dbPath } = linked(false);
    // Neither the store nor the fallback directory can be written: tickr.db is a directory and
    // fallback a plain file.
    mkdirSync(dbPath, { recursive: true });
    writeFileSync(join(dir, "fallback"), "");

    const out: string[] = [];
    const run = (event: string) =>
      main([event], pluginEnv(data), {
        stdin: Readable.from([JSON.stringify(hookInput(event, cwd))]),
        deadlineMs: Date.now() + 1000,
        write: (text) => void out.push(text),
      });

    const started = performance.now();
    expect(await run("UserPromptSubmit")).toBe(0);
    expect(await run("PostToolUse")).toBe(0);
    expect(performance.now() - started).toBeLessThan(6000);
    expect(out).toEqual([]);
    expect(readFileSync(join(dir, "gaps"), "utf8")).toBe("2");

    rmSync(dbPath, { recursive: true });
    rmSync(join(dir, "fallback"));
    expect(await run("Stop")).toBe(0);
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).systemMessage).toMatch(/collection interrupted: 2 events could not be recorded/);
    expect(await run("Stop")).toBe(0);
    expect(out).toHaveLength(1);
  });

  it("a data dir that cannot be created at all ⇒ exit 0 within the budget and no output", async () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    writeFileSync(join(root, "blocked"), "");
    const out: string[] = [];
    const started = performance.now();
    const code = await main(["UserPromptSubmit"], pluginEnv(join(root, "blocked", "data")), {
      stdin: Readable.from([JSON.stringify(hookInput("UserPromptSubmit", cwd))]),
      deadlineMs: Date.now() + 1000,
      write: (text) => void out.push(text),
    });
    expect(code).toBe(0);
    expect(performance.now() - started).toBeLessThan(4000);
    expect(out).toEqual([]);
  });
});

describe("main dispatch of a hook event", () => {
  it("journals the event named by argv with the options of the environment", async () => {
    const { cwd, data, dbPath } = linked();
    const out: string[] = [];
    const input = { ...hookInput("ignored", cwd), prompt: "never kept" };
    const code = await main(["UserPromptSubmit"], pluginEnv(data, { CLAUDE_CODE_USE_VERTEX: "1" }), {
      stdin: Readable.from([JSON.stringify(input)]),
      deadlineMs: Date.now() + 1000,
      write: (text) => void out.push(text),
    });
    expect(code).toBe(0);
    // Nothing but the note for the model: the checkout's description is still the default.
    expect(JSON.parse(out.join(""))).toEqual({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: DESCRIBE_NOTE } });
    const store = flusherStore(dbPath);
    expect(store.eventsAfter(0).map((e) => [e.type, e.provider])).toEqual([["UserPromptSubmit", "vertex"]]);
    store.close();
  });

  it("reports missing plugin options once, at SessionStart", async () => {
    const { cwd, data } = linked(false);
    const out: string[] = [];
    const run = (event: string) =>
      main([event], { CLAUDE_PLUGIN_DATA: data }, {
        stdin: Readable.from([JSON.stringify(hookInput(event, cwd))]),
        deadlineMs: Date.now() + 1000,
        write: (text) => void out.push(text),
      });
    await run("SessionStart");
    await run("UserPromptSubmit");
    expect(out).toHaveLength(1);
    expect(JSON.parse(out[0]!).systemMessage).toMatch(/^Tickr: .*api_key/);
  });
});
