// Session context (context.ts): a task of the linked project and a short description, set for one
// session by `set-context` (/tickr:task, /tickr:describe) and applied by the intake as the
// event's mapping version, so that a change splits the segment.
import { existsSync, mkdirSync, readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isLinked, linkKey } from "../../hook-src/consent.js";
import {
  CONTEXT_DIR,
  contextFile,
  effectiveMapping,
  MAX_CONTEXT_BYTES,
  normalizeDescription,
  pruneContexts,
  readContext,
} from "../../hook-src/context.js";
import { createAgentApi } from "../../hook-src/flusher/api.js";
import { RETENTION_KEY, RETENTION_MS } from "../../hook-src/flusher/bounds.js";
import { PIPELINE, STAGE_NAMES } from "../../hook-src/flusher/stages.js";
import { contextNote, NOT_LINKED_MESSAGE, recordEvent } from "../../hook-src/intake.js";
import { main } from "../../hook-src/main.js";
import { DEFAULT_DESCRIPTION, findMapping, type FoundMapping } from "../../hook-src/mapping.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import { json, startServer } from "../helpers/httpServer.js";
import {
  cleanTempDirs,
  hookInput,
  instanceFor,
  linkCheckout,
  OTHER_PROJECT,
  pluginConfig,
  pluginEnv,
  PROJECT,
  tempDir,
  WS,
  writeMapping,
} from "./helpers/env.js";
import { type StageHarness, stageHarness } from "./helpers/stage.js";
import { writeTranscript } from "./helpers/transcript.js";

const TASK = "2a9c6e3f-7d4b-4e0a-9c3d-5f7b9d1e3f04";
const FILE_TASK = "3b0d7f4a-8e5c-4f1b-8d4e-6a8c0e2f4a05";
const DESCRIPTION = "Implementation of the mobile app UI";
const UUID_ANYWHERE = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;
const ch = (code: number) => String.fromCharCode(code);

const harnesses: StageHarness[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

/** Runs one bundle mode through main(); returns its exit code and output. */
async function run(argv: string[], env: NodeJS.ProcessEnv = {}, stdin = ""): Promise<{ code: number; out: string }> {
  let out = "";
  const code = await main(argv, env, { stdin: Readable.from(stdin ? [stdin] : []), deadlineMs: Date.now() + 2000, write: (t) => void (out += t) });
  return { code, out };
}

const setContext = (data: string, session: string, project: string, ...options: string[]) => run(["set-context", data, session, project, ...options]);

function linked(mapping?: Record<string, unknown>) {
  const root = tempDir();
  const cwd = writeMapping(join(root, "repo"), mapping);
  const data = join(root, "data");
  linkCheckout(data, cwd);
  const dir = instanceFor(data);
  mkdirSync(dir, { recursive: true });
  flusherStore(dir).close();
  return { root, cwd, data, dir, cfg: pluginConfig(data) };
}

function flusherStore(dir: string): Store {
  return openStore(join(dir, DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
}

/** The normalised mapping each journalled event carries, in journal order. */
function journalledMappings(dir: string, sessionId?: string): Record<string, unknown>[] {
  const store = flusherStore(dir);
  try {
    return store
      .eventsAfter(0)
      .filter((e) => sessionId === undefined || e.sessionId === sessionId)
      .map((e) => JSON.parse(store.getMapping(e.mappingVersionId!)!.normalizedJson) as Record<string, unknown>);
  } finally {
    store.close();
  }
}

describe("description rules", () => {
  it("collapses whitespace and trims", () => {
    expect(normalizeDescription("  Fix   tickets 1 2 3 4 5 6 7 110 210 ")).toBe("Fix tickets 1 2 3 4 5 6 7 110 210");
    expect(normalizeDescription(`Mobile${ch(0xa0)}app  UI`)).toBe("Mobile app UI");
  });

  it("at most 10 words and 100 characters", () => {
    expect(normalizeDescription("one two three four five six seven eight nine ten")).toBe("one two three four five six seven eight nine ten");
    expect(normalizeDescription("one two three four five six seven eight nine ten eleven")).toEqual({ invalid: expect.stringContaining("10 words") });
    expect(normalizeDescription("x".repeat(100))).toBe("x".repeat(100));
    expect(normalizeDescription("x".repeat(101))).toEqual({ invalid: expect.stringContaining("100 characters") });
  });

  it("numbers are not words (a word holds a letter); the character limit still bounds them", () => {
    expect(normalizeDescription("Fix tickets 1 2 3 4 5 6 7 110 210")).toBe("Fix tickets 1 2 3 4 5 6 7 110 210");
    expect(normalizeDescription("one two three four five six seven eight nine ten 11")).toBe("one two three four five six seven eight nine ten 11");
    expect(normalizeDescription("one two three four five six seven eight nine ten v2")).toEqual({ invalid: expect.stringContaining("10 words") });
    expect(normalizeDescription(`Fix ${"1 ".repeat(49)}`)).toEqual({ invalid: expect.stringContaining("100 characters") });
  });

  it("refuses control and format characters, shell specials and an empty text", () => {
    for (const bad of [ch(9), ch(10), ch(13), ch(0), ch(0x1b), ch(0x7f), ch(0x202e), ch(0x200b), ch(0x2028)]) {
      expect(normalizeDescription(`Fix${bad}tickets`), JSON.stringify(bad)).toEqual({ invalid: expect.stringContaining("control characters") });
    }
    for (const bad of ['"', "`", "$", ch(92)]) expect(normalizeDescription(`Fix ${bad} it`), bad).toEqual({ invalid: expect.any(String) });
    expect(normalizeDescription("   ")).toEqual({ invalid: expect.stringContaining("empty") });
  });
});

describe("set-context and clear-context", () => {
  it("writes the context file of the session: ids, description and time only, no path; prints one line without ids", async () => {
    const data = tempDir();
    const { code, out } = await setContext(data, "s-1", PROJECT, "--task", TASK, "--description", "  Fix tickets  1 2 3 ");
    expect(code).toBe(0);
    expect(out).toBe('Tickr: from now on this session is recorded with the chosen task and the description "Fix tickets 1 2 3".\n');
    expect(out).not.toMatch(UUID_ANYWHERE);
    const file = contextFile(data, "s-1");
    expect(file).toMatch(/[0-9a-f]{32}\.json$/);
    const raw = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
    expect(Object.keys(raw)).toEqual(["project_id", "task_id", "description", "set_at"]);
    expect(raw).toMatchObject({ project_id: PROJECT, task_id: TASK, description: "Fix tickets 1 2 3" });
    expect(Number.isFinite(Date.parse(raw.set_at as string))).toBe(true);
    expect(readFileSync(file, "utf8")).not.toContain(data.replace(/\\/g, "\\\\"));
    expect(readFileSync(file, "utf8")).not.toContain("s-1");
  });

  it.each([
    ["11 words", ["--description", "one two three four five six seven eight nine ten eleven"], /more than 10 words/],
    ["101 characters", ["--description", "x".repeat(101)], /longer than 100 characters/],
    ["a control character", ["--description", `Fix${ch(10)}tickets`], /control characters/],
    ["a task that is not a UUID", ["--task", "task-1"], /--task must be a task id or none/],
    ["no option", [], /give --task and\/or --description/],
    ["an unknown option", ["--tag", TASK], /usage: set-context/],
    ["an option twice", ["--task", TASK, "--task", "none"], /usage: set-context/],
    ["an option without value", ["--description"], /usage: set-context/],
  ])("refuses %s: nothing is written, exit 0", async (_what, options, message) => {
    const data = tempDir();
    const { code, out } = await setContext(data, "s-1", PROJECT, ...options);
    expect(code).toBe(0);
    expect(out).toMatch(message);
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(existsSync(join(data, CONTEXT_DIR))).toBe(false);
  });

  it("refuses an invalid session id or project id", async () => {
    const data = tempDir();
    expect((await setContext(data, "../s 1", PROJECT, "--task", "none")).out).toMatch(/session id is not valid/);
    expect((await setContext(data, "s-1", "project-1", "--task", "none")).out).toMatch(/project id is not valid/);
    expect((await run(["set-context", data])).out).toMatch(/usage: set-context/);
    expect(existsSync(join(data, CONTEXT_DIR))).toBe(false);
  });

  it("`--task none` sets no task; a later call keeps what it does not give, for the same project only", async () => {
    const data = tempDir();
    expect((await setContext(data, "s-1", PROJECT, "--task", "none")).out).toMatch(/with no task and the description of \.tickr\.json/);
    expect(readContext(data, "s-1")).toMatchObject({ projectId: PROJECT, taskId: null });
    await setContext(data, "s-1", PROJECT, "--description", DESCRIPTION);
    expect(readContext(data, "s-1")).toMatchObject({ projectId: PROJECT, taskId: null, description: DESCRIPTION });
    await setContext(data, "s-1", PROJECT, "--task", TASK.toUpperCase());
    expect(readContext(data, "s-1")).toMatchObject({ taskId: TASK, description: DESCRIPTION });
    // Another project: the earlier context is not carried over.
    await setContext(data, "s-1", OTHER_PROJECT, "--description", "Other work");
    expect(readContext(data, "s-1")).toEqual({ projectId: OTHER_PROJECT, description: "Other work", setAt: expect.any(String) });
  });

  it("writes atomically: the new content replaces the old one and no temporary file is left behind", async () => {
    const data = tempDir();
    for (let i = 1; i <= 5; i++) await setContext(data, "s-1", PROJECT, "--description", `Step ${i}`);
    expect(readdirSync(join(data, CONTEXT_DIR))).toEqual([contextFile(data, "s-1").split(/[\\/]/).pop()]);
    expect(readContext(data, "s-1")?.description).toBe("Step 5");
  });

  it("a context that cannot be written: one message, no temporary file left behind", async () => {
    const data = tempDir();
    mkdirSync(contextFile(data, "s-1"), { recursive: true }); // a directory where the file goes
    const { code, out } = await setContext(data, "s-1", PROJECT, "--description", DESCRIPTION);
    expect(code).toBe(0);
    expect(out).toMatch(/could not be saved/);
    expect(readdirSync(join(data, CONTEXT_DIR))).toHaveLength(1);
  });

  it("clear-context removes the context of the session only", async () => {
    const data = tempDir();
    await setContext(data, "s-1", PROJECT, "--description", DESCRIPTION);
    await setContext(data, "s-2", PROJECT, "--description", "Other work");
    expect((await run(["clear-context", data, "s-1"])).out).toMatch(/session context is removed/);
    expect(readContext(data, "s-1")).toBeNull();
    expect(readContext(data, "s-2")?.description).toBe("Other work");
    expect((await run(["clear-context", data, "s-1"])).out).toMatch(/no session context\. Nothing was changed/);
    expect((await run(["clear-context", data])).out).toMatch(/usage: clear-context/);
  });
});

describe("effective mapping of the hook events", () => {
  it("the context of the same project overrides task and description; the link stays the one of .tickr.json", async () => {
    const { cwd, data, dir, cfg } = linked({ workspace_id: WS, project_id: PROJECT, task_id: FILE_TASK, description: "From the file" });
    const linkedCheck = { linked: (d: string, h: string) => isLinked(data, d, h) };
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 1000, linkedCheck);
    await setContext(data, "s-1", PROJECT, "--task", TASK, "--description", DESCRIPTION);
    recordEvent(hookInput("PostToolUse", cwd), cfg, Date.now() + 1000, linkedCheck);
    await setContext(data, "s-1", PROJECT, "--task", "none");
    recordEvent(hookInput("PostToolUse", cwd), cfg, Date.now() + 1000, linkedCheck);

    expect(journalledMappings(dir).map((m) => [m.taskId, m.description])).toEqual([
      [FILE_TASK, "From the file"],
      [TASK, DESCRIPTION],
      [null, DESCRIPTION],
    ]);
    const found = findMapping(cwd) as FoundMapping;
    const store = flusherStore(dir);
    expect(store.eventsAfter(0).map((e) => e.linkKey)).toEqual(Array(3).fill(linkKey(found.dir, found.hash)));
    expect(store.listMappings()).toHaveLength(3);
    store.close();
    expect(isLinked(data, found.dir, found.hash)).toBe(true);
  });

  it("a context of another project is ignored", async () => {
    const { cwd, data, dir, cfg } = linked();
    await setContext(data, "s-1", OTHER_PROJECT, "--task", TASK, "--description", DESCRIPTION);
    recordEvent(hookInput("PostToolUse", cwd), cfg, Date.now() + 1000);
    expect(journalledMappings(dir)).toEqual([{ workspaceId: WS, projectId: PROJECT, taskId: null, tagIds: [], description: DEFAULT_DESCRIPTION }]);
  });

  it("two sessions of one checkout have independent contexts", async () => {
    const { cwd, data, dir, cfg } = linked();
    await setContext(data, "s-1", PROJECT, "--description", DESCRIPTION);
    await setContext(data, "s-2", PROJECT, "--task", TASK);
    for (const session_id of ["s-1", "s-2", "s-3"]) recordEvent(hookInput("PostToolUse", cwd, { session_id }), cfg, Date.now() + 1000);
    expect(journalledMappings(dir, "s-1").map((m) => [m.taskId, m.description])).toEqual([[null, DESCRIPTION]]);
    expect(journalledMappings(dir, "s-2").map((m) => [m.taskId, m.description])).toEqual([[TASK, DEFAULT_DESCRIPTION]]);
    expect(journalledMappings(dir, "s-3").map((m) => [m.taskId, m.description])).toEqual([[null, DEFAULT_DESCRIPTION]]);
  });

  const valid = { project_id: PROJECT, task_id: TASK, description: DESCRIPTION, set_at: "2026-11-05T10:00:00.000Z" };
  it.each([
    ["not JSON", "{ not json"],
    ["a JSON array", "[]"],
    ["a task that is not a UUID", JSON.stringify({ ...valid, task_id: "task-1" })],
    ["a project that is not a UUID", JSON.stringify({ ...valid, project_id: "p" })],
    ["a description of 11 words", JSON.stringify({ ...valid, description: "a b c d e f g h i j k" })],
    ["a description not normalised", JSON.stringify({ ...valid, description: "Fix  tickets" })],
    ["a description with a control character", JSON.stringify({ ...valid, description: `Fix${ch(27)}tickets` })],
    ["a description that is not text", JSON.stringify({ ...valid, description: 3 })],
    ["no set_at", JSON.stringify({ project_id: PROJECT, task_id: TASK })],
    ["a file over 4 KB", JSON.stringify({ ...valid, padding: "x".repeat(MAX_CONTEXT_BYTES) })],
  ])("a context file with %s is ignored", (_what, content) => {
    const { cwd, data, dir, cfg } = linked();
    mkdirSync(join(data, CONTEXT_DIR), { recursive: true });
    writeFileSync(contextFile(data, "s-1"), content);
    expect(readContext(data, "s-1")).toBeNull();
    recordEvent(hookInput("PostToolUse", cwd), cfg, Date.now() + 1000);
    expect(journalledMappings(dir).map((m) => [m.taskId, m.description])).toEqual([[null, DEFAULT_DESCRIPTION]]);
  });

  it("a context path that is not a regular file is ignored", () => {
    const { cwd, data, dir, cfg } = linked();
    mkdirSync(contextFile(data, "s-1"), { recursive: true });
    expect(readContext(data, "s-1")).toBeNull();
    recordEvent(hookInput("PostToolUse", cwd), cfg, Date.now() + 1000);
    expect(journalledMappings(dir).map((m) => m.description)).toEqual([DEFAULT_DESCRIPTION]);
  });

  it("effectiveMapping keeps what the context does not set", () => {
    const file = { workspaceId: WS, projectId: PROJECT, taskId: FILE_TASK, tagIds: ["t"], description: "From the file" };
    expect(effectiveMapping(file, null)).toBe(file);
    expect(effectiveMapping(file, { projectId: PROJECT, setAt: "x" })).toEqual(file);
    expect(effectiveMapping(file, { projectId: PROJECT, description: DESCRIPTION, setAt: "x" })).toEqual({ ...file, description: DESCRIPTION });
    expect(effectiveMapping(file, { projectId: PROJECT, taskId: null, setAt: "x" })).toEqual({ ...file, taskId: null });
    expect(effectiveMapping(file, { projectId: OTHER_PROJECT, taskId: TASK, description: DESCRIPTION, setAt: "x" })).toBe(file);
  });
});

describe("SessionStart note for the model (additionalContext)", () => {
  async function sessionStart(cwd: string, data: string, extra: Record<string, string> = {}, source = "startup") {
    const { code, out } = await run(["SessionStart"], pluginEnv(data, extra), JSON.stringify(hookInput("SessionStart", cwd, { source })));
    expect(code).toBe(0);
    return out === "" ? null : (JSON.parse(out) as { systemMessage?: string; hookSpecificOutput?: { hookEventName: string; additionalContext: string } });
  }

  it("manual mode by default, no context: one JSON object with the note", async () => {
    const { cwd, data } = linked();
    const out = await sessionStart(cwd, data);
    expect(out?.hookSpecificOutput?.hookEventName).toBe("SessionStart");
    const note = out!.hookSpecificOutput!.additionalContext;
    expect(note).toBe(contextNote(false, null));
    expect(note).toMatch(/Mode: manual\./);
    expect(note).toMatch(/propose \/tickr:task/);
    expect(note).toMatch(/Current session context: none/);
    expect(note).not.toMatch(UUID_ANYWHERE);
  });

  it("automatic mode with auto_context, at every SessionStart (resume included), with the current context", async () => {
    const { cwd, data } = linked();
    await setContext(data, "s-1", PROJECT, "--task", TASK, "--description", DESCRIPTION);
    for (const raw of ["true", "1"]) {
      for (const source of ["startup", "resume", "compact"]) {
        const note = (await sessionStart(cwd, data, { CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT: raw }, source))!.hookSpecificOutput!.additionalContext;
        expect(note).toMatch(/Mode: automatic\./);
        expect(note).toMatch(/without asking in chat, after reading list_tasks/);
        expect(note).toContain(`task ${TASK}, description "${DESCRIPTION}"`);
      }
    }
    await setContext(data, "s-1", PROJECT, "--task", "none");
    expect((await sessionStart(cwd, data, { CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT: "false" }))!.hookSpecificOutput!.additionalContext).toMatch(
      /Mode: manual\..*Current session context: no task, description "Implementation of the mobile app UI"/,
    );
  });

  it("a context of another project is not shown", async () => {
    const { cwd, data } = linked();
    await setContext(data, "s-1", OTHER_PROJECT, "--description", DESCRIPTION);
    expect((await sessionStart(cwd, data))!.hookSpecificOutput!.additionalContext).toMatch(/Current session context: none/);
  });

  it("only at SessionStart", async () => {
    const { cwd, data } = linked();
    const { out } = await run(["UserPromptSubmit"], pluginEnv(data), JSON.stringify(hookInput("UserPromptSubmit", cwd)));
    expect(out).not.toContain("hookSpecificOutput");
  });

  it("nothing in a checkout that is not linked, nor in one without .tickr.json", async () => {
    const root = tempDir();
    const data = join(root, "data");
    const unlinked = writeMapping(join(root, "unlinked"));
    expect(await sessionStart(unlinked, data)).toEqual({ systemMessage: NOT_LINKED_MESSAGE });
    const untracked = join(root, "untracked");
    mkdirSync(untracked);
    const out = await sessionStart(untracked, data);
    expect(out?.hookSpecificOutput).toBeUndefined();
    expect(out?.systemMessage).toMatch(/not tracked/);
  });
});

describe("retention of context files", () => {
  const old = (path: string, days: number) => {
    const t = new Date(Date.now() - days * 24 * 3_600_000);
    utimesSync(path, t, t);
  };

  it("pruneContexts removes the context and temporary files not written for 90 days, nothing else", async () => {
    const data = tempDir();
    await setContext(data, "s-old", PROJECT, "--description", "Old work");
    await setContext(data, "s-new", PROJECT, "--description", "New work");
    const dir = join(data, CONTEXT_DIR);
    const temp = `${contextFile(data, "s-x")}.abcdef.tmp`;
    const foreign = join(dir, "notes.txt");
    writeFileSync(temp, "{");
    writeFileSync(foreign, "");
    for (const path of [contextFile(data, "s-old"), temp, foreign]) old(path, 91);
    old(contextFile(data, "s-new"), 89);
    expect(pruneContexts(data, new Date(), RETENTION_MS)).toBe(2);
    expect(readContext(data, "s-old")).toBeNull();
    expect(readContext(data, "s-new")?.description).toBe("New work");
    expect(existsSync(temp)).toBe(false);
    expect(existsSync(foreign)).toBe(true);
    expect(pruneContexts(join(data, "missing"), new Date(), RETENTION_MS)).toBe(0);
  });

  it("the flusher's retention pass removes them", async () => {
    const root = tempDir();
    const data = join(root, "data");
    const dir = join(data, "instance");
    mkdirSync(dir, { recursive: true });
    await setContext(data, "s-old", PROJECT, "--description", "Old work");
    old(contextFile(data, "s-old"), 91);
    const h = stageHarness({ now: new Date().toISOString(), dir, dataDir: data });
    harnesses.push(h);
    await PIPELINE.bounds(h.ctx);
    expect(h.store.getMeta(RETENTION_KEY)).not.toBeNull();
    expect(readContext(data, "s-old")).toBeNull();
  });
});

describe("a context change in a running session (intake, segmentation, revisions and sender together)", () => {
  it("splits the segment at the change; the next segment carries the new task and description", async () => {
    const t0 = "2026-11-05T10:00:00.000Z";
    const at = (s: number) => new Date(Date.parse(t0) + s * 1000);
    const { cwd, data, dir, cfg } = linked({ workspace_id: WS, project_id: PROJECT, task_id: FILE_TASK });
    const h = stageHarness({ now: t0, dir, dataDir: data });
    harnesses.push(h);
    const server = await startServer((req) => {
      if (req.url === "/api/v1/me") {
        return json(200, { user: { id: "u-1" }, workspace: { id: WS, name: "Acme" }, role: "workspace_user", serverTime: h.ctx.now().toISOString() });
      }
      return json(201, { id: "e", origin: "agent_session", agentFinalized: false, agentDetached: false });
    });
    servers.push(server);
    h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_context_key_0001", timeoutMs: 3000, now: () => h.ctx.now().getTime() });
    const transcript = join(dir, "transcripts", "s-1.jsonl");
    writeTranscript(transcript, [{ id: "msg_1", at: t0 }]);
    const hook = (type: string, s: number) =>
      recordEvent(hookInput(type, cwd, { transcript_path: transcript, prompt_id: "p-1" }), cfg, Date.now() + 1000, {
        now: () => at(s),
        uptime: () => 1000 + s,
        linked: (d, hh) => isLinked(data, d, hh),
      });
    const pass = async (s: number) => {
      h.setNow(at(s).toISOString());
      for (const name of STAGE_NAMES) await PIPELINE[name](h.ctx);
    };

    hook("UserPromptSubmit", 0);
    hook("PostToolUse", 30);
    await pass(31);
    await setContext(data, "s-1", PROJECT, "--task", TASK, "--description", DESCRIPTION);
    hook("PostToolUse", 60);
    hook("Stop", 90);
    await pass(91);

    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ final: true, startedAt: at(0).toISOString(), stoppedAt: at(60).toISOString() });
    expect(segments[1]).toMatchObject({ final: false, startedAt: at(60).toISOString() });

    const bodies = server.requests
      .filter((r) => r.method === "PUT" && r.url.startsWith("/api/v1/agent-segments/"))
      .map((r) => ({ id: r.url.split("/").pop()!, body: JSON.parse(r.body) as { revision: number; taskId: string | null; description: string; final: boolean } }));
    const of = (id: string) => bodies.filter((b) => b.id === id).map((b) => b.body);
    const first = of(segments[0]!.id);
    const second = of(segments[1]!.id);
    expect(first.length).toBeGreaterThan(0);
    expect(first.every((b) => b.taskId === FILE_TASK && b.description === DEFAULT_DESCRIPTION)).toBe(true);
    expect(first.at(-1)!.final).toBe(true);
    expect(second.length).toBeGreaterThan(0);
    expect(second.every((b) => b.taskId === TASK && b.description === DESCRIPTION)).toBe(true);
  });
});
