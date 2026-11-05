import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentApi } from "../../hook-src/flusher/api.js";
import { type UsageQuality, type UsageRow } from "../../hook-src/flusher/revisions.js";
import { sendDue, writeWorkspace } from "../../hook-src/flusher/sender.js";
import { getLedgerRow, totalsFor } from "../../hook-src/ledger.js";
import { boundUsage, MAX_TOKENS, MAX_USAGE_ROWS, nextQuality, OTHER_MODELS, usageForRevision } from "../../hook-src/quality.js";
import { json, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, WS } from "./helpers/env.js";
import { appendPartial, appendTranscript, line, lastBody, type SessionDriver, sessionDriver, writeTranscript } from "./helpers/transcript.js";

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

const E1 = "0190f0c0-3333-7000-8000-0000000000e1";

function seg(s: SessionDriver, i = 0) {
  return s.h.store.segmentsForSession("s-1")[i]!;
}
function segBody(s: SessionDriver, i = 0) {
  return lastBody(s.h, "segment", seg(s, i).id)!;
}
function revisions(s: SessionDriver, i = 0) {
  return s.h.store.outboxFor("segment", seg(s, i).id).map((r) => JSON.parse(r.bodyJson) as Record<string, unknown>);
}
const row = (model: string, n: number, provider: UsageRow["provider"] = "anthropic"): UsageRow => ({
  provider,
  model,
  inputTokens: n,
  outputTokens: 2 * n,
  cacheCreationInputTokens: 3 * n,
  cacheReadInputTokens: 4 * n,
});

/** One turn 10:00–10:05 with two complete messages. */
async function oneTurn() {
  const s = sessionDriver("2026-11-05T10:00:00.000Z");
  s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
  s.ev("PostToolUse", "2026-11-05T10:02:00.000Z", { promptId: "p-1" });
  writeTranscript(s.transcript, [
    { id: "m1", at: "2026-11-05T10:01:00.000Z", input: 3, output: 30 },
    { id: "m2", at: "2026-11-05T10:04:00.000Z", input: 4, output: 40, cacheRead: 500 },
  ]);
  s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1" });
  await s.pass("2026-11-05T10:06:00.000Z");
  return s;
}

const U1: UsageRow[] = [{ provider: "anthropic", model: "claude-opus-4-7", inputTokens: 7, outputTokens: 70, cacheCreationInputTokens: 0, cacheReadInputTokens: 500 }];

describe("segment quality", () => {
  it("segment stays pending until finalised, then complete", async () => {
    const s = await oneTurn();
    expect(segBody(s)).toMatchObject({ final: false, usageQuality: "pending", usage: U1 });

    s.ev("SessionEnd", "2026-11-05T10:10:00.000Z");
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(segBody(s)).toMatchObject({ final: true, usageQuality: "complete", usage: U1 });
    s.h.close();
  });

  it("SessionEnd with a partial transcript ⇒ incomplete", async () => {
    const s = await oneTurn();
    appendPartial(s.transcript, { id: "m3", at: "2026-11-05T10:04:30.000Z" });
    s.ev("SessionEnd", "2026-11-05T10:10:00.000Z");
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(segBody(s)).toMatchObject({ final: true, usageQuality: "incomplete", usage: U1 });
    s.h.close();
  });

  it("SessionEnd with a running subagent ⇒ incomplete; its SubagentStop later makes it complete", async () => {
    const s = sessionDriver("2026-11-05T10:00:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    s.ev("SubagentStart", "2026-11-05T10:01:00.000Z", { promptId: "p-1", agentId: "a-1" });
    writeTranscript(s.transcript, [{ id: "m1", at: "2026-11-05T10:00:30.000Z", agentCall: "toolu_a1" }]);
    writeTranscript(join(s.h.dir, "transcripts", "s-1", "subagents", "agent-a-1.jsonl"), [
      { id: "sub1", at: "2026-11-05T10:01:30.000Z", agentId: "a-1", output: 100 },
    ]);
    s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1" });
    s.ev("SessionEnd", "2026-11-05T10:10:00.000Z");
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(segBody(s)).toMatchObject({ final: true, usageQuality: "incomplete" });

    s.ev("SubagentStop", "2026-11-05T10:12:00.000Z", { agentId: "a-1" });
    await s.pass("2026-11-05T10:13:00.000Z");
    expect(revisions(s).map((b) => [b.revision, b.final, b.usageQuality])).toEqual([
      [1, true, "incomplete"],
      [2, true, "complete"],
    ]);
    expect((segBody(s).usage as UsageRow[])[0]!.outputTokens).toBe(110);
    s.h.close();
  });

  it("incomplete later becomes complete while unlocked", async () => {
    const s = await oneTurn();
    const cut = line({ id: "m3", at: "2026-11-05T10:04:30.000Z", output: 5 });
    appendFileSync(s.transcript, cut.slice(0, 50));
    s.ev("SessionEnd", "2026-11-05T10:10:00.000Z");
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(segBody(s)).toMatchObject({ revision: 2, final: true, usageQuality: "incomplete", usage: U1 });

    appendFileSync(s.transcript, cut.slice(50)); // the line is now whole
    await s.pass("2026-11-05T10:12:00.000Z");
    expect(segBody(s)).toMatchObject({ revision: 3, final: true, usageQuality: "complete", usage: [{ ...U1[0]!, inputTokens: 8, outputTokens: 75 }] });
    s.h.close();
  });

  it("complete usage not acknowledged, then a partial read ⇒ the sent revision still carries the complete set", async () => {
    const s = await oneTurn();
    expect(revisions(s)).toEqual([expect.objectContaining({ revision: 1, usage: U1 })]);

    // A new complete line, then a line cut mid-write: the ledger has it, the snapshot does not move.
    appendTranscript(s.transcript, [{ id: "m3", at: "2026-11-05T10:04:40.000Z", output: 9 }]);
    appendPartial(s.transcript, { id: "m4", at: "2026-11-05T10:04:50.000Z" });
    await s.pass("2026-11-05T10:07:00.000Z");
    expect(getLedgerRow(s.h.store, "m3")).not.toBeNull();
    expect(totalsFor(s.h.store, { kind: "segment", id: seg(s).id })[0]!.outputTokens).toBe(79);
    expect(usageForRevision(s.h.store, { kind: "segment", id: seg(s).id })!.usage).toEqual(U1);
    expect(revisions(s).map((b) => b.revision)).toEqual([1]);

    const server = await startServer(() => json(201, { id: seg(s).id, origin: "agent_session", agentFinalized: false, agentDetached: false }));
    servers.push(server);
    s.h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_quality_key_0001", timeoutMs: 3000 });
    s.h.ctx.guarded(() => writeWorkspace(s.h.store, { workspaceId: WS, workspaceName: "Acme", checkedAt: "2026-11-05T10:00:00.000Z", skewMs: 0 }));
    await sendDue(s.h.store, s.h.ctx.generation, s.h.ctx.api, s.h.ctx.now, 60_000, { random: () => 1 });
    expect(server.requests.map((r) => JSON.parse(r.body).usage)).toEqual([U1]);
    s.h.close();
  });

  it("old undecided messages of a session that went quiet keep its segment incomplete, never dropped", async () => {
    const s = await oneTurn();
    // Written after the Stop: past the open segment's last activity, so not decided yet...
    appendTranscript(s.transcript, [{ id: "m3", at: "2026-11-05T10:05:30.000Z", output: 6 }]);
    await s.pass("2026-11-05T10:06:30.000Z");
    expect(getLedgerRow(s.h.store, "m3")!.recipientKind).toBe("pending");
    // ...and the flusher does not run again before the next day: the idle finalisation comes
    // when the session is no longer read.
    await s.pass("2026-11-06T11:00:00.000Z");
    expect(seg(s).final).toBe(true);
    expect(getLedgerRow(s.h.store, "m3")!.recipientKind).toBe("pending");
    expect(segBody(s)).toMatchObject({ final: true, usageQuality: "incomplete", usage: U1 });
    s.h.close();
  });

  it("a counter above 10^12 is clamped and the segment incomplete, never refused", async () => {
    const s = sessionDriver("2026-11-05T10:00:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    writeTranscript(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", cacheRead: 3 * MAX_TOKENS }]);
    s.ev("Stop", "2026-11-05T10:05:00.000Z", { promptId: "p-1" });
    s.ev("SessionEnd", "2026-11-05T10:06:00.000Z");
    await s.pass("2026-11-05T10:07:00.000Z");
    expect(segBody(s)).toMatchObject({ final: true, usageQuality: "incomplete" });
    expect((segBody(s).usage as UsageRow[])[0]!.cacheReadInputTokens).toBe(MAX_TOKENS);
    s.h.close();
  });
});

describe("usage of a live segment", () => {
  it("grows with the turn and is re-sent at the pace of the moving end (at most once a minute)", async () => {
    const s = sessionDriver("2026-11-05T10:00:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1" });
    writeTranscript(s.transcript, [{ id: "m1", at: "2026-11-05T10:00:00.500Z", output: 1 }]);
    await s.pass("2026-11-05T10:00:01.000Z");
    appendTranscript(s.transcript, [{ id: "m2", at: "2026-11-05T10:00:10.000Z", output: 2 }]);
    s.ev("PostToolUse", "2026-11-05T10:00:20.000Z", { promptId: "p-1" });
    await s.pass("2026-11-05T10:00:21.000Z");
    const out = (b: Record<string, unknown>) => (b.usage as UsageRow[]).reduce((n, r) => n + r.outputTokens, 0);
    // m1 lies past the last activity at the first pass: not decided yet, no tokens.
    expect(revisions(s).map((b) => [b.revision, out(b)])).toEqual([[1, 0]]);
    s.ev("PostToolUse", "2026-11-05T10:01:00.000Z", { promptId: "p-1" });
    await s.pass("2026-11-05T10:01:02.000Z");
    expect(revisions(s).map((b) => [b.revision, out(b), b.working])).toEqual([
      [1, 0, true],
      [2, 3, true],
    ]);
    s.h.close();
  });

  it("snapshots go with their target at retention", async () => {
    const s = await oneTurn();
    const id = seg(s).id;
    expect(usageForRevision(s.h.store, { kind: "segment", id })).toBeDefined();
    s.h.ctx.guarded(() => s.h.store.db.prepare("DELETE FROM segments WHERE id = ?").run(id));
    s.h.ctx.guarded(() => s.h.store.deleteRetired("2026-01-01T00:00:00.000Z"));
    expect(usageForRevision(s.h.store, { kind: "segment", id })).toBeUndefined();
    s.h.close();
  });
});

describe("delegated quality", () => {
  function delegatedTurn() {
    const s = sessionDriver("2026-11-05T10:00:00.000Z");
    s.ev("UserPromptSubmit", "2026-11-05T10:00:00.000Z", { promptId: "p-1", mapping: null });
    s.ev("PostToolUse", "2026-11-05T10:02:00.000Z", { promptId: "p-1", mapping: null, entryId: E1 });
    writeTranscript(s.transcript, [{ id: "m1", at: "2026-11-05T10:01:00.000Z", output: 5 }]);
    return s;
  }

  it("pending while its turn runs, complete once the turn ended and a complete read covered it", async () => {
    const s = delegatedTurn();
    await s.pass("2026-11-05T10:03:00.000Z");
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ usageQuality: "pending" });
    appendTranscript(s.transcript, [{ id: "m2", at: "2026-11-05T10:03:30.000Z", output: 7 }]);
    s.ev("Stop", "2026-11-05T10:04:00.000Z", { promptId: "p-1", mapping: null });
    await s.pass("2026-11-05T10:05:00.000Z");
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ revision: 2, usageQuality: "complete" });
    expect((lastBody(s.h, "delegated", E1)!.usage as UsageRow[])[0]!.outputTokens).toBe(12);
    s.h.close();
  });

  it("the session ends first (partial transcript) ⇒ incomplete; the missing line later makes it complete", async () => {
    const s = delegatedTurn();
    const cut = line({ id: "m2", at: "2026-11-05T10:03:30.000Z", output: 7 });
    appendFileSync(s.transcript, cut.slice(0, 30));
    s.ev("SessionEnd", "2026-11-05T10:04:00.000Z", { mapping: null });
    await s.pass("2026-11-05T10:05:00.000Z");
    // No complete set yet: the usage route still gets usage, empty.
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ usageQuality: "incomplete", usage: [] });
    appendFileSync(s.transcript, cut.slice(30));
    await s.pass("2026-11-05T10:06:00.000Z");
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ usageQuality: "complete", usage: [expect.objectContaining({ outputTokens: 12 })] });
    s.h.close();
  });

  it("a crashed session that went quiet > 24 h ⇒ incomplete, not pending forever", async () => {
    const s = delegatedTurn();
    await s.pass("2026-11-05T10:03:00.000Z");
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ usageQuality: "pending" });
    await s.pass("2026-11-06T10:03:01.000Z");
    expect(lastBody(s.h, "delegated", E1)).toMatchObject({ usageQuality: "incomplete" });
    s.h.close();
  });
});

describe("PD-17 bounds", () => {
  it("25 pairs ⇒ 20 rows, sums preserved", () => {
    const rows = Array.from({ length: 25 }, (_, i) => row(`model-${String(i).padStart(2, "0")}`, i + 1));
    const { usage, clamped } = boundUsage(rows);
    expect(clamped).toBe(false);
    expect(usage).toHaveLength(MAX_USAGE_ROWS);
    expect(new Set(usage.map((r) => `${r.provider}/${r.model}`)).size).toBe(MAX_USAGE_ROWS);
    const sum = (rs: UsageRow[], k: keyof UsageRow) => rs.reduce((n, r) => n + (r[k] as number), 0);
    for (const k of ["inputTokens", "outputTokens", "cacheCreationInputTokens", "cacheReadInputTokens"] as const) expect(sum(usage, k)).toBe(sum(rows, k));
    // The 6 smallest are folded; the 19 largest kept as they are.
    expect(usage.find((r) => r.model === OTHER_MODELS)).toEqual({ ...row(OTHER_MODELS, 1 + 2 + 3 + 4 + 5 + 6, "other") });
    expect(usage.filter((r) => r.provider === "anthropic").map((r) => r.model)).toEqual(rows.slice(6).map((r) => r.model));
  });

  it("an existing (other, other-models) row is merged, never duplicated; 20 pairs are left as they are", () => {
    const rows = [row(OTHER_MODELS, 1000, "other"), ...Array.from({ length: 20 }, (_, i) => row(`m-${String(i).padStart(2, "0")}`, i + 1))];
    const { usage } = boundUsage(rows);
    expect(usage).toHaveLength(MAX_USAGE_ROWS);
    expect(usage.filter((r) => r.model === OTHER_MODELS)).toHaveLength(1);
    expect(boundUsage(rows.slice(1)).usage).toEqual(rows.slice(1));
  });

  it("a counter above 10^12 is clamped", () => {
    expect(boundUsage([row("m", 1)]).clamped).toBe(false);
    const { usage, clamped } = boundUsage([{ ...row("m", 1), outputTokens: MAX_TOKENS + 1 }]);
    expect(clamped).toBe(true);
    expect(usage[0]!.outputTokens).toBe(MAX_TOKENS);
  });
});

describe("server-side transition table mirrored", () => {
  const ALL: UsageQuality[] = ["pending", "incomplete", "complete"];
  // AgentUsageQualityRules: pending -> complete | incomplete, incomplete -> complete, unchanged.
  const allowed = (from: UsageQuality | null, to: UsageQuality, session: boolean, final: boolean) => {
    if (session && !final && to !== "pending") return false;
    if (from === null || from === to) return true;
    return (from === "pending" && to !== "pending") || (from === "incomplete" && to === "complete");
  };

  it("nextQuality never builds a transition Tickr refuses", () => {
    for (const from of [null, ...ALL]) {
      for (const computed of ALL) {
        for (const [segment, final] of [[true, false], [true, true], [false, false]] as const) {
          const next = nextQuality(from, computed, { segment, final });
          if (!(segment && !final && from !== null && from !== "pending")) expect(allowed(from, next, segment, final)).toBe(true);
        }
      }
    }
    expect(nextQuality("complete", "incomplete", { segment: true, final: true })).toBe("complete");
    expect(nextQuality("incomplete", "complete", { segment: false, final: false })).toBe("complete");
  });

  it("complete on a non-final segment never built, even when every turn ended and the read was complete", async () => {
    const s = await oneTurn();
    await s.pass("2026-11-05T10:08:00.000Z");
    expect(seg(s).final).toBe(false);
    expect(revisions(s).every((b) => b.usageQuality === "pending")).toBe(true);
    s.h.close();
  });

  it("a complete segment never goes back to incomplete when a later read is partial", async () => {
    const s = await oneTurn();
    s.ev("SessionEnd", "2026-11-05T10:10:00.000Z");
    await s.pass("2026-11-05T10:11:00.000Z");
    expect(segBody(s)).toMatchObject({ usageQuality: "complete" });
    const committed = segBody(s).revision;
    appendPartial(s.transcript, { id: "m9", at: "2026-11-05T10:04:59.000Z" });
    await s.pass("2026-11-05T10:12:00.000Z");
    expect(segBody(s)).toMatchObject({ revision: committed, usageQuality: "complete" });
    expect(revisions(s).map((b) => b.usageQuality)).not.toContain("incomplete");
    s.h.close();
  });
});
