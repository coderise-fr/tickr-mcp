import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DELEGATED_TOOL, delegatedEntryId, entryIdForEvent } from "../../hook-src/delegated.js";
import { createAgentApi, USAGE_BODY_KEYS } from "../../hook-src/flusher/api.js";
import { delegatedRevisions, REVISION_SOURCES, segmentRevisions } from "../../hook-src/flusher/revisions.js";
import { sendDue, writeWorkspace } from "../../hook-src/flusher/sender.js";
import { importFallback } from "../../hook-src/fallback.js";
import type { HookInput } from "../../hook-src/io.js";
import { recordEvent } from "../../hook-src/intake.js";
import { ledgerRowsFor, totalsFor } from "../../hook-src/ledger.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import { json, problem, type RecordedRequest, type Reply, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, instanceFor, pluginConfig, tempDir, WS, writeMapping } from "./helpers/env.js";
import type { StageHarness } from "./helpers/stage.js";
import { appendTranscript, lastBody, sessionDriver, writeTranscript } from "./helpers/transcript.js";

const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/post-tool-use-start-timer.json", import.meta.url), "utf8")) as HookInput & {
  tool_response: { content: { type: string; text: string }[]; structuredContent: { entry: { id: string } } };
};
const FIXTURE_ENTRY = "0190f0c0-1111-7000-8000-0000000000e1";
const E1 = "0190f0c0-2222-7000-8000-0000000000e1";
const E2 = "0190f0c0-2222-7000-8000-0000000000e2";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

describe("delegatedEntryId", () => {
  it("matcher matches the captured tool_response fixture and extracts the entry id", () => {
    expect(DELEGATED_TOOL.test(FIXTURE.tool_name!)).toBe(true);
    expect(delegatedEntryId(FIXTURE.tool_response)).toBe(FIXTURE_ENTRY);
    expect(entryIdForEvent("PostToolUse", FIXTURE.tool_name, FIXTURE.tool_response)).toBe(FIXTURE_ENTRY);
  });

  it("reads the first text content when there is no structuredContent, a bare content array, or a serialised result", () => {
    const { content } = FIXTURE.tool_response;
    expect(delegatedEntryId({ content })).toBe(FIXTURE_ENTRY);
    expect(delegatedEntryId(content)).toBe(FIXTURE_ENTRY);
    expect(delegatedEntryId(JSON.stringify(FIXTURE.tool_response))).toBe(FIXTURE_ENTRY);
    expect(delegatedEntryId({ content: [{ type: "image", data: "x" }, ...content] })).toBe(FIXTURE_ENTRY);
  });

  it("reads the shape Claude Code 2.1 really sends: the tool's JSON text itself, as a string or an object", () => {
    const text = JSON.stringify({ entry: { id: FIXTURE_ENTRY, description: "", project_id: null, running: true } });
    expect(delegatedEntryId(text)).toBe(FIXTURE_ENTRY);
    expect(delegatedEntryId(JSON.parse(text))).toBe(FIXTURE_ENTRY);
    expect(entryIdForEvent("PostToolUse", FIXTURE.tool_name, text)).toBe(FIXTURE_ENTRY);
    expect(delegatedEntryId("Tickr rejected the input: project_id: required (required).")).toBeNull();
  });

  it.each([
    ["isError", { ...FIXTURE.tool_response, isError: true }],
    ["text that is not JSON", { content: [{ type: "text", text: "Tickr refused the request." }] }],
    ["an id that is not a UUID", { structuredContent: { entry: { id: "42" } } }],
    ["no entry", { structuredContent: { items: [] }, content: [{ type: "text", text: "{\"items\":[]}" }] }],
    ["nothing readable", null],
    ["a number", 7],
  ])("%s ⇒ no candidate", (_name, response) => {
    expect(delegatedEntryId(response)).toBeNull();
  });

  it("only PostToolUse of the plugin's start_timer and create_entry are delegated", () => {
    const r = FIXTURE.tool_response;
    expect(DELEGATED_TOOL.test("mcp__plugin_tickr_tickr__create_entry")).toBe(true);
    for (const tool of ["mcp__plugin_tickr_tickr__stop_timer", "mcp__tickr__start_timer", "mcp__plugin_tickr_tickr__start_timer_x", "Bash"]) {
      expect(entryIdForEvent("PostToolUse", tool, r)).toBeNull();
    }
    expect(entryIdForEvent("Stop", FIXTURE.tool_name, r)).toBeNull();
    expect(entryIdForEvent("PostToolUse", undefined, r)).toBeNull();
  });
});

describe("intake of a delegated entry", () => {
  function linked() {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "data");
    const dir = instanceFor(data);
    const dbPath = join(dir, DB_FILE);
    return { cwd, data, dir, dbPath, cfg: pluginConfig(data) };
  }
  const flusher = (path: string) => openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
  const soon = () => Date.now() + 1000;

  it("fills events.entry_id and records the delegated row; nothing else of the response is kept", () => {
    const l = linked();
    flusher(l.dbPath).close();
    const now = new Date("2026-11-05T10:02:00.500Z");
    recordEvent({ ...FIXTURE, cwd: l.cwd }, l.cfg, soon(), { now: () => now, env: {} });
    recordEvent({ ...FIXTURE, cwd: l.cwd, tool_name: "Bash" }, l.cfg, soon(), { env: {} });
    recordEvent({ ...FIXTURE, cwd: l.cwd, tool_response: { ...FIXTURE.tool_response, isError: true } }, l.cfg, soon(), { env: {} });
    const store = flusher(l.dbPath);
    expect(store.eventsAfter(0).map((e) => e.entryId)).toEqual([FIXTURE_ENTRY, null, null]);
    expect(store.getDelegated(FIXTURE_ENTRY)).toEqual({
      entryId: FIXTURE_ENTRY,
      sessionId: FIXTURE.session_id,
      promptId: FIXTURE.prompt_id,
      createdAt: "2026-11-05T10:02:00.500Z",
      eventSeq: 1,
    });
    const dump = JSON.stringify([store.eventsAfter(0), store.db.prepare("SELECT * FROM delegated").all()]);
    expect(dump).not.toContain("redacted");
    expect(dump).not.toContain("running");
    store.close();
  });

  it("an event journalled through a fallback file records its delegated row at import", () => {
    const l = linked(); // no database yet: the hook writes a fallback file
    recordEvent({ ...FIXTURE, cwd: l.cwd }, l.cfg, soon(), { env: {} });
    const store = flusher(l.dbPath);
    const gen = store.transaction(() => {
      store.insertFirstOwner(1, new Date().toISOString());
      return store.readOwner()!.generation;
    });
    expect(importFallback(store, gen, join(l.dir, "fallback"))).toBe(1);
    expect(store.getDelegated(FIXTURE_ENTRY)?.sessionId).toBe(FIXTURE.session_id);
    store.close();
  });
});

/** One turn without a linked segment (rule 3): two delegated entries, the final response after the last tool. */
async function twoEntriesInOneTurn() {
  const s = sessionDriver("2026-11-05T10:00:00.000Z");
  s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1", mapping: null });
  s.ev("PostToolUse", "2026-11-05T10:02:00.000Z", { promptId: "p-1", mapping: null, toolName: "mcp__plugin_tickr_tickr__start_timer", entryId: E1 });
  s.ev("PostToolUse", "2026-11-05T10:03:00.000Z", { promptId: "p-1", mapping: null, toolName: "mcp__plugin_tickr_tickr__create_entry", entryId: E2 });
  writeTranscript(s.transcript, [
    { id: "m1", at: "2026-11-05T10:01:00.000Z", input: 2, output: 5 },
    { id: "m2", at: "2026-11-05T10:02:30.000Z", input: 3, output: 7, cacheRead: 100 },
    { id: "m3", at: "2026-11-05T10:04:00.000Z", input: 4, output: 9 }, // final response, after the last tool
  ]);
  s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1", mapping: null });
  await s.pass("2026-11-05T10:06:00.000Z");
  return s;
}

async function send(h: StageHarness, responder: (req: RecordedRequest) => Reply) {
  const server = await startServer((req) => responder(req));
  servers.push(server);
  h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_delegated_key_0001", timeoutMs: 3000, now: () => h.ctx.now().getTime() });
  h.ctx.guarded(() => writeWorkspace(h.store, { workspaceId: WS, workspaceName: "Acme", checkedAt: h.ctx.now().toISOString(), skewMs: 0 }));
  await sendDue(h.store, h.ctx.generation, h.ctx.api, h.ctx.now, 60_000, { random: () => 1 });
  return server;
}

const applied = () => json(200, { id: E1, origin: "agent", agentFinalized: false, agentDetached: false });

describe("delegated revisions", () => {
  it("are the pipeline's second revision source", () => {
    expect(REVISION_SOURCES).toEqual([segmentRevisions, delegatedRevisions]);
  });

  it("two delegated entries in one turn: first gets the tokens including the final response after the last tool, second gets session link only", async () => {
    const s = await twoEntriesInOneTurn();
    expect(s.h.store.segmentsForSession("s-1")).toEqual([]);
    expect(lastBody(s.h, "delegated", E1)).toEqual({
      revision: 1,
      agentSessionId: "s-1",
      usageQuality: "complete",
      usage: [{ provider: "anthropic", model: "claude-opus-4-7", inputTokens: 9, outputTokens: 21, cacheCreationInputTokens: 0, cacheReadInputTokens: 100 }],
    });
    expect(lastBody(s.h, "delegated", E2)).toEqual({ revision: 1, agentSessionId: "s-1", usageQuality: "complete", usage: [] });
    s.h.close();
  });

  it("usage endpoint body has exactly the contract keys, always with agentSessionId and usage, and no Tickr-* header", async () => {
    const s = await twoEntriesInOneTurn();
    const server = await send(s.h, applied);
    const puts = server.requests.filter((r) => r.method === "PUT");
    expect(puts.map((r) => r.url).sort()).toEqual([`/api/v1/entries/${E1}/agent-usage`, `/api/v1/entries/${E2}/agent-usage`]);
    for (const req of puts) {
      expect(Object.keys(JSON.parse(req.body))).toEqual([...USAGE_BODY_KEYS]);
      expect(Object.keys(req.headers).filter((h) => h.startsWith("tickr-"))).toEqual([]);
    }
    expect(s.h.store.outboxFor("delegated", E1)).toEqual([]);
    s.h.close();
  });

  it("404 ⇒ terminal, tokens never re-attributed", async () => {
    const s = await twoEntriesInOneTurn();
    await send(s.h, (req) => (req.url.includes(E1) ? problem(404, "not_found", "Entry not found") : applied()));
    expect(s.h.store.listTerminal().map((t) => [t.targetKind, t.targetId, t.code])).toEqual([["delegated", E1, "not_found"]]);
    const before = totalsFor(s.h.store, { kind: "delegated", entryId: E1 });

    // More activity of the same session: nothing moves to E2 nor to a new recipient, E1 is never re-queued.
    s.ev("UserPromptSubmit", "2026-11-05T10:10:00.000Z", { promptId: "p-2", mapping: null });
    appendTranscript(s.transcript, [{ id: "m4", at: "2026-11-05T10:10:30.000Z" }]);
    s.ev("Stop", "2026-11-05T10:11:00.000Z", { promptId: "p-2", mapping: null });
    await s.pass("2026-11-05T10:12:00.000Z");
    expect(Object.fromEntries(ledgerRowsFor(s.h.store, "s-1").map((r) => [r.messageId, `${r.recipientKind}:${r.recipientId}`]))).toEqual({
      m1: `delegated:${E1}`,
      m2: `delegated:${E1}`,
      m3: `delegated:${E1}`,
      m4: "none:null",
    });
    expect(totalsFor(s.h.store, { kind: "delegated", entryId: E1 })).toEqual(before);
    expect(totalsFor(s.h.store, { kind: "delegated", entryId: E2 })).toEqual([]);
    expect(s.h.store.outboxFor("delegated", E1)).toEqual([]);
    expect(s.h.store.getLastCommitted("delegated", E1)!.revision).toBe(1);
    s.h.close();
  });

  it("entry_locked ⇒ terminal (D20): kept locally, listed, never re-sent", async () => {
    const s = await twoEntriesInOneTurn();
    const first = await send(s.h, (req) => (req.url.includes(E1) ? problem(409, "conflict", "entry_locked") : applied()));
    expect(s.h.store.listTerminal().map((t) => [t.targetKind, t.targetId, t.code])).toEqual([["delegated", E1, "entry_locked"]]);
    expect(totalsFor(s.h.store, { kind: "delegated", entryId: E1 })).not.toEqual([]);
    await s.pass("2026-11-05T10:20:00.000Z");
    const again = await send(s.h, applied);
    expect(first.requests.filter((r) => r.url.includes(E1))).toHaveLength(1);
    expect(again.requests.filter((r) => r.method === "PUT")).toEqual([]);
    s.h.close();
  });

  it("a turn still running keeps the first entry pending; the session's later turns do not change it", async () => {
    const s = sessionDriver("2026-11-05T10:00:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1", mapping: null });
    s.ev("PostToolUse", "2026-11-05T10:02:00.000Z", { promptId: "p-1", mapping: null, entryId: E1 });
    writeTranscript(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", output: 5 }]);
    await s.pass("2026-11-05T10:03:00.000Z");
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ usageQuality: "pending" });
    s.h.close();
  });
});
