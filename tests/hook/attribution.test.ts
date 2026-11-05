import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  type AttributionContext,
  buildTurns,
  delegatedByTurn,
  recipientFor,
  settled,
} from "../../hook-src/attribution.js";
import { markClosedByServer, segmentationStage } from "../../hook-src/flusher/segmentation.js";
import { PIPELINE, STAGE_NAMES } from "../../hook-src/flusher/stages.js";
import { getLedgerRow, ledgerRowsFor, ledgerStage, recordMessage, subagentsFor, totalsFor } from "../../hook-src/ledger.js";
import type { EventRow, SegmentRow } from "../../hook-src/store/db.js";
import type { AssistantUsage } from "../../hook-src/transcript/parser.js";
import { cleanTempDirs, OTHER_PROJECT } from "./helpers/env.js";
import { journalMapping, MAPPING, stageHarness, type StageHarness } from "./helpers/stage.js";

afterEach(() => cleanTempDirs());


interface Msg {
  id: string;
  at: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  agentId?: string;
  agentCall?: string;
}

/** One synthetic transcript line of an assistant message (placeholders only). */
function line(m: Msg): string {
  const content: unknown[] = [{ type: "text", text: "<redacted>" }];
  if (m.agentCall) content.push({ type: "tool_use", id: m.agentCall, name: "Agent", input: { prompt: "<redacted>" } });
  return `${JSON.stringify({
    type: "assistant",
    timestamp: m.at,
    sessionId: "s-1",
    version: "2.1.300",
    isSidechain: m.agentId !== undefined,
    ...(m.agentId ? { agentId: m.agentId } : {}),
    message: {
      id: m.id,
      model: m.model ?? "claude-opus-4-7",
      role: "assistant",
      content,
      usage: {
        input_tokens: m.input ?? 1,
        output_tokens: m.output ?? 10,
        cache_creation_input_tokens: m.cacheCreation ?? 0,
        cache_read_input_tokens: m.cacheRead ?? 0,
      },
    },
  })}\n`;
}

function write(path: string, msgs: Msg[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, msgs.map(line).join(""));
}

function append(path: string, msgs: Msg[]): void {
  appendFileSync(path, msgs.map(line).join(""));
}

/** A harness whose events carry the transcript path and an uptime that follows the wall clock. */
function session(now: string) {
  const h = stageHarness({ now });
  const transcript = join(h.dir, "transcripts", "s-1.jsonl");
  const t0 = Date.parse("2026-11-01T00:00:00.000Z");
  const ev = (type: string, at: string, extra: Parameters<StageHarness["journal"]>[3] = {}) =>
    h.journal(type, at, 1000 + (Date.parse(at) - t0) / 1000, { transcriptPath: transcript, ...extra });
  const pass = async (at: string) => {
    h.setNow(at);
    await segmentationStage(h.ctx);
    return ledgerStage(h.ctx);
  };
  const recipients = () => Object.fromEntries(ledgerRowsFor(h.store, "s-1").map((r) => [r.messageId, r.recipientKind === "segment" ? segName(r.recipientId!) : r.recipientId === null ? r.recipientKind : `${r.recipientKind}:${r.recipientId}`]));
  const segs = () => h.store.segmentsForSession("s-1");
  const segName = (id: string) => `seg${segs().findIndex((s) => s.id === id) + 1}`;
  return { h, transcript, ev, pass, recipients, segs };
}

describe("ledger stage", () => {
  it("runs between segmentation and revisions", () => {
    expect(STAGE_NAMES.slice(1, 4)).toEqual(["segmentation", "ledger", "revisions"]);
    expect(PIPELINE.ledger).toBe(ledgerStage);
  });

  it("turn crossing midnight: each message by its timestamp, a message past the last activity waits for the next event", async () => {
    const s = session("2026-11-05T23:59:30.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T23:50:00.000Z", { promptId: "p-1" });
    s.ev("PostToolUse", "2026-11-05T23:58:00.000Z");
    write(s.transcript, [
      { id: "m1", at: "2026-11-05T23:51:00.000Z" },
      { id: "m2", at: "2026-11-05T23:57:00.000Z" },
      { id: "m3", at: "2026-11-06T00:01:00.000Z" },
    ]);
    await s.pass("2026-11-06T00:01:30.000Z");
    // m3 lies after the open segment's last activity: the split at midnight is not known yet.
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "seg1", m3: "pending" });

    s.ev("PostToolUse", "2026-11-06T00:05:00.000Z");
    append(s.transcript, [{ id: "m4", at: "2026-11-06T00:08:00.000Z" }]);
    s.ev("Stop", "2026-11-06T00:10:00.000Z", { promptId: "p-1" });
    await s.pass("2026-11-06T00:11:00.000Z");
    expect(s.segs().map((g) => [g.startedAt, g.stoppedAt, g.final])).toEqual([
      ["2026-11-05T23:50:00.000Z", "2026-11-06T00:00:00.000Z", true],
      ["2026-11-06T00:00:00.000Z", "2026-11-06T00:10:00.000Z", false],
    ]);
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "seg1", m3: "seg2", m4: "seg2" });
    s.h.close();
  });

  it("a split during a turn moves later messages only", async () => {
    const s = session("2026-11-05T10:06:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("PostToolUse", "2026-11-05T10:05:00.000Z");
    write(s.transcript, [
      { id: "m1", at: "2026-11-05T10:01:00.000Z" },
      { id: "m2", at: "2026-11-05T10:04:00.000Z" },
    ]);
    await s.pass("2026-11-05T10:06:00.000Z");
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "seg1" });

    // .tickr.json changed mid-turn: the segment is split at the event.
    s.ev("PostToolUse", "2026-11-05T10:10:00.000Z", { mapping: journalMapping({ ...MAPPING, projectId: OTHER_PROJECT }) });
    append(s.transcript, [
      { id: "m3", at: "2026-11-05T10:11:00.000Z" },
      { id: "m4", at: "2026-11-05T10:15:00.000Z" },
    ]);
    s.ev("Stop", "2026-11-05T10:20:00.000Z", { promptId: "p-1" });
    await s.pass("2026-11-05T10:21:00.000Z");
    expect(s.segs()).toHaveLength(2);
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "seg1", m3: "seg2", m4: "seg2" });
    s.h.close();
  });

  it("message in a gap ⇒ segment open at the latest preceding event", async () => {
    const s = session("2026-11-05T10:31:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1" });
    s.ev("UserPromptSubmit", "2026-11-05T10:30:00.000Z", { promptId: "p-2" });
    write(s.transcript, [
      { id: "m1", at: "2026-11-05T10:02:00.000Z" },
      { id: "m2", at: "2026-11-05T10:10:00.000Z" },
      { id: "m3", at: "2026-11-05T10:30:30.000Z" },
    ]);
    await s.pass("2026-11-05T10:31:00.000Z");
    expect(s.segs().map((g) => [g.stoppedAt, g.finalReason])).toEqual([
      ["2026-11-05T10:05:00.000Z", "idle"],
      ["2026-11-05T10:30:00.000Z", null],
    ]);
    // m3 is after the open segment's last activity (10:30): it waits for the next event.
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "seg1", m3: "pending" });
    s.ev("Stop", "2026-11-05T10:31:00.000Z", { promptId: "p-2" });
    await s.pass("2026-11-05T10:32:00.000Z");
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "seg1", m3: "seg2" });
    s.h.close();
  });

  it("late subagent of a finalised segment ⇒ still that segment (recipient recorded at SubagentStart)", async () => {
    const s = session("2026-11-05T10:03:00.000Z");
    const sub = join(dirname(s.transcript), "s-1", "subagents", "agent-a-1.jsonl");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("PostToolUse", "2026-11-05T10:01:00.000Z");
    s.ev("SubagentStart", "2026-11-05T10:01:00.000Z", { agentId: "a-1" });
    s.ev("Stop", "2026-11-05T10:02:00.000Z", { promptId: "p-1" });
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:00:30.000Z" }]);
    write(sub, [{ id: "s1", at: "2026-11-05T10:01:30.000Z", agentId: "a-1", model: "claude-sonnet-4-5" }]);
    await s.pass("2026-11-05T10:03:00.000Z");
    expect(subagentsFor(s.h.store, "s-1")).toEqual([
      expect.objectContaining({ agentId: "a-1", source: "hook", launchedAt: "2026-11-05T10:01:00.000Z", recipientKind: "segment", recipientId: s.segs()[0]!.id }),
    ]);

    // The segment is finalised by idleness, a new one opens; the subagent keeps working.
    s.ev("UserPromptSubmit", "2026-11-05T10:35:00.000Z", { promptId: "p-2" });
    s.ev("Stop", "2026-11-05T10:36:00.000Z", { promptId: "p-2" });
    append(sub, [
      { id: "s2", at: "2026-11-05T10:20:00.000Z", agentId: "a-1", model: "claude-sonnet-4-5" },
      { id: "s3", at: "2026-11-05T10:35:30.000Z", agentId: "a-1", model: "claude-sonnet-4-5" },
    ]);
    s.ev("SubagentStop", "2026-11-05T10:36:00.000Z", { agentId: "a-1", agentTranscriptPath: sub });
    await s.pass("2026-11-05T10:37:00.000Z");
    expect(s.segs()[0]!.final).toBe(true);
    expect(s.recipients()).toEqual({ m1: "seg1", s1: "seg1", s2: "seg1", s3: "seg1" });
    expect(totalsFor(s.h.store, { kind: "segment", id: s.segs()[0]!.id })).toEqual([
      { provider: "anthropic", model: "claude-opus-4-7", inputTokens: 1, outputTokens: 10, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
      { provider: "anthropic", model: "claude-sonnet-4-5", inputTokens: 3, outputTokens: 30, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ]);
    expect(totalsFor(s.h.store, { kind: "segment", id: s.segs()[1]!.id })).toEqual([]);
    expect(subagentsFor(s.h.store, "s-1")[0]).toMatchObject({ stoppedAt: "2026-11-05T10:36:00.000Z", transcriptPath: sub });
    s.h.close();
  });

  it("subagent without SubagentStart ⇒ the Agent tool call named by .meta.json, else its first message", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    const dir = join(dirname(s.transcript), "s-1", "subagents");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("Stop", "2026-11-05T10:09:00.000Z", { promptId: "p-1" });
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", agentCall: "toolu_agent_1" }]);
    write(join(dir, "agent-a-1.jsonl"), [{ id: "s1", at: "2026-11-05T10:02:00.000Z", agentId: "a-1" }]);
    writeFileSync(join(dir, "agent-a-1.meta.json"), JSON.stringify({ agentType: "general-purpose", description: "<redacted>", toolUseId: "toolu_agent_1" }));
    write(join(dir, "agent-a-2.jsonl"), [{ id: "s2", at: "2026-11-05T10:03:00.000Z", agentId: "a-2" }]);
    await s.pass("2026-11-05T10:10:00.000Z");
    expect(subagentsFor(s.h.store, "s-1").map((r) => [r.agentId, r.source, r.launchedAt, r.toolUseId, r.recipientKind])).toEqual([
      ["a-1", "tool_call", "2026-11-05T10:01:00.000Z", "toolu_agent_1", "segment"],
      ["a-2", "timestamp", "2026-11-05T10:03:00.000Z", null, "segment"],
    ]);
    expect(s.recipients()).toEqual({ m1: "seg1", s1: "seg1", s2: "seg1" });
    s.h.close();
  });

  it("delegated entry before a segment opens: the turn's tokens go to its first delegated entry, the final response included", async () => {
    // No mapping (no segment): rule 3.
    const s = session("2026-11-05T10:01:30.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1", mapping: null });
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", output: 5 }]);
    await s.pass("2026-11-05T10:01:30.000Z");
    expect(s.recipients()).toEqual({ m1: "turn:p-1" });

    s.ev("PostToolUse", "2026-11-05T10:02:00.000Z", { promptId: "p-1", mapping: null, entryId: "E-1" });
    s.ev("PostToolUse", "2026-11-05T10:03:00.000Z", { promptId: "p-1", mapping: null, entryId: "E-2" });
    append(s.transcript, [
      { id: "m2", at: "2026-11-05T10:02:30.000Z", output: 7 },
      { id: "m3", at: "2026-11-05T10:04:00.000Z", output: 9 },
    ]);
    s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1", mapping: null });
    // A second turn without any delegated entry: nobody.
    s.ev("UserPromptSubmit", "2026-11-05T10:10:00.000Z", { promptId: "p-2", mapping: null });
    append(s.transcript, [{ id: "m4", at: "2026-11-05T10:10:30.000Z" }]);
    s.ev("Stop", "2026-11-05T10:11:00.000Z", { promptId: "p-2", mapping: null });
    await s.pass("2026-11-05T10:12:00.000Z");
    expect(s.segs()).toEqual([]);
    expect(s.recipients()).toEqual({ m1: "delegated:E-1", m2: "delegated:E-1", m3: "delegated:E-1", m4: "none" });
    expect(totalsFor(s.h.store, { kind: "delegated", entryId: "E-1" })).toEqual([
      { provider: "anthropic", model: "claude-opus-4-7", inputTokens: 3, outputTokens: 21, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 },
    ]);
    expect(totalsFor(s.h.store, { kind: "delegated", entryId: "E-2" })).toEqual([]);
    s.h.close();
  });

  it("rescan after compaction ⇒ same ledger", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("Stop", "2026-11-05T10:09:00.000Z", { promptId: "p-1" });
    const msgs: Msg[] = [
      { id: "m1", at: "2026-11-05T10:01:00.000Z", input: 3, output: 30, cacheRead: 100 },
      { id: "m1", at: "2026-11-05T10:01:01.000Z", input: 3, output: 30, cacheRead: 100 },
      { id: "m2", at: "2026-11-05T10:02:00.000Z", model: "claude-haiku-4-5", output: 4 },
    ];
    write(s.transcript, msgs);
    await s.pass("2026-11-05T10:10:00.000Z");
    const before = ledgerRowsFor(s.h.store, "s-1");
    const totals = totalsFor(s.h.store, { kind: "segment", id: s.segs()[0]!.id });

    // Rewritten from the start (another head), then shrunk: read again, nothing counted twice.
    writeFileSync(s.transcript, `${JSON.stringify({ type: "system", subtype: "compact_boundary", timestamp: "2026-11-05T10:09:30.000Z" })}\n${msgs.map(line).join("")}`);
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(s.h.store.getTranscriptOffset(s.transcript)!.offset).toBeGreaterThan(0);
    expect(ledgerRowsFor(s.h.store, "s-1")).toEqual(before);
    write(s.transcript, msgs.slice(2));
    await s.pass("2026-11-05T10:12:00.000Z");
    expect(ledgerRowsFor(s.h.store, "s-1")).toEqual(before);
    expect(totalsFor(s.h.store, { kind: "segment", id: s.segs()[0]!.id })).toEqual(totals);
    s.h.close();
  });

  it("refused recipient (terminal) never re-attributed", async () => {
    const s = session("2026-11-05T10:06:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("PostToolUse", "2026-11-05T10:05:00.000Z");
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z" }]);
    await s.pass("2026-11-05T10:06:00.000Z");
    const refused = s.segs()[0]!;
    s.h.ctx.guarded(() => {
      s.h.store.addTerminal({ targetKind: "segment", targetId: refused.id, revision: 1, code: "segment_detached", at: "2026-11-05T10:06:00.000Z", diagnostic: "" });
      markClosedByServer(s.h.store, refused.id, "detached");
    });

    s.ev("UserPromptSubmit", "2026-11-05T10:07:00.000Z", { promptId: "p-2" });
    s.ev("Stop", "2026-11-05T10:09:00.000Z", { promptId: "p-2" });
    // The whole file read again, with a message of the new segment.
    write(s.transcript, [
      { id: "m0", at: "2026-11-05T10:00:30.000Z" },
      { id: "m1", at: "2026-11-05T10:01:00.000Z", output: 99 },
      { id: "m2", at: "2026-11-05T10:08:00.000Z" },
    ]);
    await s.pass("2026-11-05T10:10:00.000Z");
    expect(s.segs()).toHaveLength(2);
    expect(s.recipients()).toEqual({ m0: "seg1", m1: "seg1", m2: "seg2" });
    expect(totalsFor(s.h.store, { kind: "segment", id: s.segs()[1]!.id })).toEqual([expect.objectContaining({ outputTokens: 10 })]);
    s.h.close();
  });

  it("/clear ⇒ new session: each session reads its own transcript", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    const cleared = join(dirname(s.transcript), "s-2.jsonl");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("SessionEnd", "2026-11-05T10:02:00.000Z");
    s.ev("SessionStart", "2026-11-05T10:02:01.000Z", { sessionId: "s-2", transcriptPath: cleared });
    s.ev("UserPromptSubmit", "2026-11-05T10:03:00.000Z", { sessionId: "s-2", promptId: "p-2", transcriptPath: cleared });
    s.ev("Stop", "2026-11-05T10:04:00.000Z", { sessionId: "s-2", promptId: "p-2", transcriptPath: cleared });
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z" }]);
    write(cleared, [{ id: "m2", at: "2026-11-05T10:03:30.000Z" }]);
    await s.pass("2026-11-05T10:10:00.000Z");
    const [one] = s.h.store.segmentsForSession("s-1");
    const [two] = s.h.store.segmentsForSession("s-2");
    expect(ledgerRowsFor(s.h.store, "s-1").map((r) => [r.messageId, r.recipientId])).toEqual([["m1", one!.id]]);
    expect(ledgerRowsFor(s.h.store, "s-2").map((r) => [r.messageId, r.recipientId])).toEqual([["m2", two!.id]]);
    s.h.close();
  });

  it("--resume ⇒ same session id, messages by timestamp, never to a finalised segment of another day", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1" });
    s.ev("SessionEnd", "2026-11-05T10:06:00.000Z");
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z" }]);
    await s.pass("2026-11-05T10:10:00.000Z");

    s.ev("SessionStart", "2026-11-07T09:00:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-07T09:01:00.000Z", { promptId: "p-2" });
    s.ev("Stop", "2026-11-07T09:05:00.000Z", { promptId: "p-2" });
    append(s.transcript, [
      { id: "m2", at: "2026-11-07T09:00:30.000Z" },
      { id: "m3", at: "2026-11-07T09:02:00.000Z" },
    ]);
    await s.pass("2026-11-07T09:06:00.000Z");
    expect(s.segs().map((g) => g.startedAt)).toEqual(["2026-11-05T10:00:00.000Z", "2026-11-07T09:01:00.000Z"]);
    expect(s.recipients()).toEqual({ m1: "seg1", m2: "none", m3: "seg2" });
    s.h.close();
  });

  it("fills the session's agent version from the transcript", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z");
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:00:00.000Z" }]);
    await s.pass("2026-11-05T10:01:00.000Z");
    expect(s.h.store.getSession("s-1")!.agentVersion).toBe("2.1.300");
    s.h.close();
  });

  it("an unreadable transcript records nothing and does not fail the stage", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z");
    expect(await s.pass("2026-11-05T10:01:00.000Z")).toEqual({});
    expect(ledgerRowsFor(s.h.store, "s-1")).toEqual([]);
    expect(s.h.store.getTranscriptOffset(s.transcript)).toMatchObject({ status: "unavailable" });
    s.h.close();
  });

  it("folds a settled recipient into totals; the message stays mapped and is not counted twice", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("SessionEnd", "2026-11-05T10:05:00.000Z");
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", output: 10 }]);
    await s.pass("2026-11-05T10:10:00.000Z");
    const seg = s.segs()[0]!;
    const before = totalsFor(s.h.store, { kind: "segment", id: seg.id });
    s.h.ctx.guarded(() =>
      s.h.store.putLastCommitted({
        targetKind: "segment",
        targetId: seg.id,
        revision: 1,
        canonicalJson: "{}",
        bodyJson: JSON.stringify({ revision: 1, final: true, usageQuality: "complete" }),
        committedAt: "2026-11-05T10:10:00.000Z",
      }),
    );
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(getLedgerRow(s.h.store, "m1")).toMatchObject({ folded: true, recipientKind: "segment", recipientId: seg.id, output: 0 });
    expect(totalsFor(s.h.store, { kind: "segment", id: seg.id })).toEqual(before);
    // A rescan neither re-adds nor moves it.
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", output: 50 }]);
    await s.pass("2026-11-05T10:12:00.000Z");
    expect(totalsFor(s.h.store, { kind: "segment", id: seg.id })).toEqual(before);
    s.h.close();
  });
});

describe("retention of token data", () => {
  it("lives as long as its session, and never goes while its recipient has a pending revision", async () => {
    const s = session("2026-11-05T10:10:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("SessionEnd", "2026-11-05T10:05:00.000Z");
    write(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z" }]);
    write(join(dirname(s.transcript), "s-1", "subagents", "agent-a-1.jsonl"), [{ id: "s1", at: "2026-11-05T10:02:00.000Z", agentId: "a-1" }]);
    await s.pass("2026-11-05T10:10:00.000Z");
    const seg = s.segs()[0]!;
    const cutoff = "2026-12-01T00:00:00.000Z";
    const rows = () => ["ledger", "transcript_offsets", "subagents"].map((t) => Number((s.h.store.db.prepare(`SELECT COUNT(*) AS c FROM ${t}`).get() as { c: number }).c));
    expect(rows()).toEqual([2, 2, 1]);

    // The session is still journalled: nothing goes.
    s.h.ctx.guarded(() => s.h.store.deleteRetired("2026-11-05T10:00:00.000Z"));
    expect(rows()).toEqual([2, 2, 1]);

    // A pending revision of the segment keeps its ledger rows past the session's retirement.
    s.h.ctx.guarded(() =>
      s.h.store.insertOutbox({ targetKind: "segment", targetId: seg.id, revision: 1, bodyJson: "{}", attempts: 0, nextAttemptAt: cutoff }),
    );
    s.h.ctx.guarded(() => s.h.store.deleteRetired(cutoff));
    expect(s.h.store.getSession("s-1")).not.toBeNull();
    s.h.ctx.guarded(() => s.h.store.deleteOutboxFor("segment", seg.id));
    s.h.ctx.guarded(() => s.h.store.deleteRetired(cutoff));
    expect(s.h.store.getSession("s-1")).toBeNull();
    expect(rows()).toEqual([0, 0, 0]);

    // A delegated entry still to be sent keeps the rows of a session already gone.
    const m = { messageId: "m9", model: "claude-opus-4-7", timestamp: "2026-11-05T10:00:00.000Z", input: 1, output: 1, cacheCreation: 0, cacheRead: 0, sidechain: false };
    recordMessage(s.h.store, s.h.ctx.generation, "s-gone", m, { kind: "delegated", entryId: "E-9" });
    s.h.ctx.guarded(() =>
      s.h.store.insertOutbox({ targetKind: "delegated", targetId: "E-9", revision: 1, bodyJson: "{}", attempts: 0, nextAttemptAt: cutoff }),
    );
    s.h.ctx.guarded(() => s.h.store.deleteRetired(cutoff));
    expect(getLedgerRow(s.h.store, "m9")).not.toBeNull();
    s.h.ctx.guarded(() => s.h.store.deleteOutboxFor("delegated", "E-9"));
    s.h.ctx.guarded(() => s.h.store.deleteRetired(cutoff));
    expect(getLedgerRow(s.h.store, "m9")).toBeNull();
    s.h.close();
  });
});

describe("recordMessage and totalsFor", () => {
  const msg = (id: string, extra: Partial<AssistantUsage> = {}): AssistantUsage => ({
    messageId: id,
    model: "claude-opus-4-7",
    timestamp: "2026-11-05T10:00:00.000Z",
    input: 1,
    output: 10,
    cacheCreation: 100,
    cacheRead: 1000,
    sidechain: false,
    ...extra,
  });

  it("the first insert fixes the recipient; later lines only raise the counters", () => {
    const h = stageHarness({ now: "2026-11-05T10:00:00.000Z" });
    const a = { kind: "segment" as const, id: "seg-a" };
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1"), a);
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1", { output: 5, cacheRead: 2000 }), { kind: "segment", id: "seg-b" });
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1", { output: 20 }), null);
    expect(getLedgerRow(h.store, "m1")).toMatchObject({ recipientKind: "segment", recipientId: "seg-a", input: 1, output: 20, cacheCreation: 100, cacheRead: 2000 });
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m2"), null);
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m2"), a);
    expect(getLedgerRow(h.store, "m2")).toMatchObject({ recipientKind: "none", recipientId: null });
    h.close();
  });

  it("a provisional recipient (pending, turn) is decided by a later insert, never undecided", () => {
    const h = stageHarness({ now: "2026-11-05T10:00:00.000Z" });
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1"), "pending");
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1"), { kind: "turn", sessionId: "s-1", promptId: "p-1" });
    expect(getLedgerRow(h.store, "m1")).toMatchObject({ recipientKind: "turn", recipientId: "p-1" });
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1"), "pending");
    expect(getLedgerRow(h.store, "m1")).toMatchObject({ recipientKind: "turn" });
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1"), { kind: "delegated", entryId: "E-1" });
    recordMessage(h.store, h.ctx.generation, "s-1", msg("m1"), { kind: "delegated", entryId: "E-2" });
    expect(getLedgerRow(h.store, "m1")).toMatchObject({ recipientKind: "delegated", recipientId: "E-1" });
    h.close();
  });

  it("totals are grouped by provider and model and scoped to the recipient", () => {
    const h = stageHarness({ now: "2026-11-05T10:00:00.000Z" });
    const a = { kind: "segment" as const, id: "seg-a" };
    const gen = h.ctx.generation;
    recordMessage(h.store, gen, "s-1", msg("m1"), a);
    recordMessage(h.store, gen, "s-1", msg("m2", { model: "claude-haiku-4-5", input: 2 }), a);
    recordMessage(h.store, gen, "s-1", msg("m3"), a, { provider: "bedrock" });
    recordMessage(h.store, gen, "s-1", msg("m4"), a);
    recordMessage(h.store, gen, "s-1", msg("m5"), { kind: "segment", id: "seg-b" });
    recordMessage(h.store, gen, "s-1", msg("m6"), { kind: "turn", sessionId: "s-1", promptId: "p-1" });
    recordMessage(h.store, gen, "s-2", msg("m7"), { kind: "turn", sessionId: "s-2", promptId: "p-1" });
    expect(totalsFor(h.store, a)).toEqual([
      { provider: "anthropic", model: "claude-haiku-4-5", inputTokens: 2, outputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 1000 },
      { provider: "anthropic", model: "claude-opus-4-7", inputTokens: 2, outputTokens: 20, cacheCreationInputTokens: 200, cacheReadInputTokens: 2000 },
      { provider: "bedrock", model: "claude-opus-4-7", inputTokens: 1, outputTokens: 10, cacheCreationInputTokens: 100, cacheReadInputTokens: 1000 },
    ]);
    expect(totalsFor(h.store, { kind: "turn", sessionId: "s-1", promptId: "p-1" })).toEqual([expect.objectContaining({ inputTokens: 1 })]);
    expect(totalsFor(h.store, { kind: "delegated", entryId: "none" })).toEqual([]);
    h.close();
  });
});

describe("attribution rules (pure)", () => {
  const ev = (seq: number, type: string, at: string, extra: Partial<EventRow> = {}): EventRow => ({
    seq,
    eventId: `E${seq}`,
    sessionId: "s-1",
    type,
    localTime: at,
    uptimeS: seq,
    mappingVersionId: 1,
    transcriptPath: null,
    provider: "anthropic",
    promptId: null,
    toolName: null,
    toolUseId: null,
    entryId: null,
    agentId: null,
    agentTranscriptPath: null,
    linkKey: null,
    ...extra,
  });
  const seg = (id: string, startedAt: string, stoppedAt: string, final: boolean): SegmentRow => ({
    id,
    sessionId: "s-1",
    mappingVersionId: 1,
    startedAt,
    lastActivityAt: stoppedAt,
    stoppedAt,
    working: false,
    observedAt: stoppedAt,
    final,
    finalReason: final ? "idle" : null,
    finalDiagnostic: null,
    quality: "pending",
    createdOnServer: false,
    serverState: null,
    lastRevision: 0,
  });

  it("turns are keyed by prompt_id; a new prompt or SessionEnd ends the previous one, inactivity does not", () => {
    const events = [
      ev(1, "UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" }),
      ev(3, "UserPromptSubmit", "2026-11-05T10:05:00.000Z", { promptId: "p-2" }),
      ev(4, "Stop", "2026-11-05T10:06:00.000Z", { promptId: "p-2" }),
      ev(2, "PostToolUse", "2026-11-05T10:01:00.000Z", { promptId: "p-1", entryId: "E-1" }),
      ev(5, "UserPromptSubmit", "2026-11-05T11:00:00.000Z"),
      ev(6, "SessionEnd", "2026-11-05T12:00:00.000Z"),
    ];
    const turns = buildTurns("s-1", events);
    expect(turns).toEqual([
      { sessionId: "s-1", promptId: "p-1", startedAt: "2026-11-05T10:00:00.000Z", endedAt: "2026-11-05T10:05:00.000Z" },
      { sessionId: "s-1", promptId: "p-2", startedAt: "2026-11-05T10:05:00.000Z", endedAt: "2026-11-05T10:06:00.000Z" },
      { sessionId: "s-1", promptId: "E5", startedAt: "2026-11-05T11:00:00.000Z", endedAt: "2026-11-05T12:00:00.000Z" },
    ]);
    expect(delegatedByTurn(events, turns)).toEqual(new Map([["p-1", ["E-1"]]]));
  });

  it("recipientFor: a subagent's recorded recipient wins over its timestamp; unknown subagents fall back to the timestamp", () => {
    const ctx: AttributionContext = {
      segments: [seg("A", "2026-11-05T10:00:00.000Z", "2026-11-05T10:10:00.000Z", true), seg("B", "2026-11-05T10:30:00.000Z", "2026-11-05T10:40:00.000Z", false)],
      turns: [],
      subagents: new Map([
        ["a-1", { kind: "segment", id: "A" }],
        ["a-2", null],
      ]),
      delegatedByTurn: new Map(),
    };
    const at = "2026-11-05T10:35:00.000Z";
    expect(recipientFor({ timestamp: at, agentId: "a-1" }, ctx)).toEqual({ kind: "segment", id: "A" });
    expect(recipientFor({ timestamp: at, agentId: "a-2" }, ctx)).toBeNull();
    expect(recipientFor({ timestamp: at, agentId: "a-3" }, ctx)).toEqual({ kind: "segment", id: "B" });
    expect(recipientFor({ timestamp: "2026-11-05T09:00:00.000Z" }, ctx)).toBeNull();
  });

  it("settled: only instants up to the open segment's last activity", () => {
    const segments = [seg("A", "2026-11-05T10:00:00.000Z", "2026-11-05T10:10:00.000Z", true), seg("B", "2026-11-05T10:30:00.000Z", "2026-11-05T10:40:00.000Z", false)];
    expect(settled("2026-11-05T10:40:00.000Z", segments)).toBe(true);
    expect(settled("2026-11-05T10:40:00.001Z", segments)).toBe(false);
    expect(settled("2026-11-05T11:40:00.000Z", segments.slice(0, 1))).toBe(true);
  });

  it("delegated entries of a turn without prompt_id are found by time", () => {
    const events = [ev(1, "UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" }), ev(2, "PostToolUse", "2026-11-05T10:01:00.000Z", { entryId: "E-1" })];
    expect(delegatedByTurn(events, buildTurns("s-1", events))).toEqual(new Map([["p-1", ["E-1"]]]));
  });
});
