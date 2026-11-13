import { afterEach, describe, expect, it } from "vitest";
import { createAgentApi, ROUTE_NOT_FOUND } from "../../hook-src/flusher/api.js";
import { commitIfChanged, revisionsStage } from "../../hook-src/flusher/revisions.js";
import { segmentationStage } from "../../hook-src/flusher/segmentation.js";
import {
  AGENT_VERSION_GRACE_MS,
  backoffMs,
  INGESTION_WINDOW_MS,
  MAX_BACKOFF_MS,
  PROBE_INTERVAL_MS,
  readPause,
  readWorkspace,
  SEND_BATCH,
  sendDue,
  STOPPED_LOCKED,
  STOPPED_MISMATCH,
  writeWorkspace,
} from "../../hook-src/flusher/sender.js";
import { CLOCK_SKEW_LIMIT_MS, workspaceStage } from "../../hook-src/flusher/workspace.js";
import { LEDGER_WINDOW_MS } from "../../hook-src/ledger.js";
import { canonicalJson } from "../../hook-src/mapping.js";
import type { JournalEvent } from "../../hook-src/store/db.js";
import { json, problem, type RecordedRequest, type Reply, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, WS } from "./helpers/env.js";
import { journalMapping, MAPPING, type StageHarness, stageHarness } from "./helpers/stage.js";

const NOW = "2026-11-05T10:00:00.000Z";
const MIN = 60_000;
const OTHER_WS = "9b9b9b9b-0000-4000-8000-000000000099";
const VERSION = "2.1.300";

const harnesses: StageHarness[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function meBody(serverTime: string, workspaceId = WS) {
  return {
    user: { id: "u-1", displayName: "Dev", email: "dev@example.test", timezone: "UTC" },
    workspace: { id: workspaceId, name: "Acme", timezone: "UTC" },
    role: "workspace_user",
    serverTime,
  };
}

/**
 * A stage harness talking to a local Tickr. `segment` answers every PUT; /me answers with the
 * harness clock minus `skewMs` (the local clock is that far ahead).
 */
async function setup(segment: (req: RecordedRequest, i: number) => Reply, opts: { skewMs?: number; workspaceId?: string; now?: string } = {}) {
  const h = stageHarness({ now: opts.now ?? NOW });
  harnesses.push(h);
  let skewMs = opts.skewMs ?? 0;
  let segmentCalls = 0;
  const server = await startServer((req) => {
    if (req.url === "/api/v1/me") return json(200, meBody(new Date(h.ctx.now().getTime() - skewMs).toISOString(), opts.workspaceId));
    return segment(req, segmentCalls++);
  });
  servers.push(server);
  h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_sender_key_0001", timeoutMs: 3000, now: () => h.ctx.now().getTime() });
  const puts = () => server.requests.filter((r) => r.method === "PUT");
  return {
    h,
    server,
    puts,
    setSkew: (ms: number) => (skewMs = ms),
    /**
     * One user prompt at `at`, segmented and committed as a revision. Its session's Claude Code
     * version is `version` (as the ledger stage reads it from the transcript), or unknown (null).
     */
    activity: (at: string = h.ctx.now().toISOString(), extra: Partial<JournalEvent> = {}, version: string | null = VERSION) => {
      h.journal("UserPromptSubmit", at, 1000, extra);
      segmentationStage(h.ctx);
      const sessionId = extra.sessionId ?? "s-1";
      if (version !== null && h.store.getSession(sessionId)?.agentVersion === null) h.store.setSessionAgentVersion(sessionId, version);
      void revisionsStage()(h.ctx);
    },
    check: () => workspaceStage({ random: () => 1 })(h.ctx),
    send: () => sendDue(h.store, h.ctx.generation, h.ctx.api, h.ctx.now, 60_000, { random: () => 1, boundary: h.ctx.boundary }),
  };
}

const ok = (status = 200, extra: Record<string, unknown> = {}) => json(status, { id: "e", origin: "agent_session", agentFinalized: false, agentDetached: false, ...extra });

describe("sendDue", () => {
  it("sends nothing before the workspace check succeeded", async () => {
    const t = await setup(() => ok(201));
    t.activity();
    expect(await t.send()).toEqual({ dueInMs: null });
    expect(t.puts()).toHaveLength(0);
    await t.check();
    await t.send();
    expect(t.puts()).toHaveLength(1);
  });

  it("applied ⇒ acknowledged, created on the server, Tickr-Agent from the session's agent version", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    t.activity();
    await t.send();
    const [req] = t.puts();
    expect(req!.headers["tickr-agent"]).toBe("claude-code/2.1.300");
    const seg = t.h.store.segmentsForSession("s-1")[0]!;
    expect(seg.createdOnServer).toBe(true);
    expect(t.h.store.pendingOutboxCount()).toBe(0);
    expect(req!.body).toBe(t.h.store.getLastCommitted("segment", seg.id)!.bodyJson);
    expect(t.h.boundaries).toEqual(expect.arrayContaining(["sent", "acknowledged"]));

    t.h.store.upsertSession({ ...t.h.store.getSession("s-1")!, agentVersion: "2.1.301" });
    t.h.setNow(plus(NOW, 2 * MIN));
    t.activity();
    await t.send();
    expect(t.puts()[1]!.headers["tickr-agent"]).toBe("claude-code/2.1.301");
  });

  it("503 workspace_busy ⇒ same revision and same body after Retry-After, never acknowledged meanwhile", async () => {
    const t = await setup((_req, i) => (i === 0 ? problem(503, "service_unavailable", "workspace_busy", {}, { "retry-after": "1" }) : ok(201)));
    await t.check();
    t.activity();
    expect(await t.send()).toEqual({ dueInMs: 1000 });
    expect(t.h.store.pendingOutboxCount()).toBe(1);
    expect(t.h.boundaries).not.toContain("acknowledged");
    expect(await t.send()).toEqual({ dueInMs: 1000 }); // not due yet: nothing sent
    expect(t.puts()).toHaveLength(1);
    t.h.setNow(plus(NOW, 1000));
    await t.send();
    const [first, second] = t.puts();
    expect(second!.body).toBe(first!.body);
    expect(JSON.parse(second!.body).revision).toBe(1);
    expect(t.h.store.pendingOutboxCount()).toBe(0);
  });

  it("429 Retry-After is honoured", async () => {
    const t = await setup((_req, i) => (i === 0 ? problem(429, "rate_limited", "Too many requests", {}, { "retry-after": "42" }) : ok()));
    await t.check();
    t.activity();
    expect(await t.send()).toEqual({ dueInMs: 42_000 });
    t.h.setNow(plus(NOW, 41_999));
    await t.send();
    expect(t.puts()).toHaveLength(1);
    t.h.setNow(plus(NOW, 42_000));
    await t.send();
    expect(t.puts()).toHaveLength(2);
  });

  it("backoff grows and is capped (2^attempts s, 5 min, jitter in [1/2, 1])", async () => {
    expect([1, 2, 3, 4, 8, 9, 30].map((n) => backoffMs(n, () => 1))).toEqual([2000, 4000, 8000, 16_000, 256_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(backoffMs(3, () => 0)).toBe(4000);
    expect(backoffMs(30, () => 0)).toBe(MAX_BACKOFF_MS / 2);

    const t = await setup(() => problem(500, "internal"));
    await t.check();
    t.activity();
    const delays: number[] = [];
    let now = NOW;
    for (let i = 0; i < 10; i++) {
      const { dueInMs } = await t.send();
      delays.push(dueInMs!);
      now = plus(now, dueInMs!);
      t.h.setNow(now);
    }
    expect(delays).toEqual([2000, 4000, 8000, 16_000, 32_000, 64_000, 128_000, 256_000, MAX_BACKOFF_MS, MAX_BACKOFF_MS]);
    expect(new Set(t.puts().map((r) => r.body)).size).toBe(1);
  });

  it("401 pauses once and surfaces one notice; the re-probe an hour later that fails again stays silent", async () => {
    const t = await setup(() => problem(401, "unauthorized"));
    await t.check();
    t.activity();
    expect(await t.send()).toEqual({ dueInMs: null });
    expect(readPause(t.h.store)).toMatchObject({ reason: "unauthorized", probeAt: plus(NOW, PROBE_INTERVAL_MS) });
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual(["unauthorized"]);
    t.h.store.takeUnshownNotices(NOW);

    // Paused: nothing is sent, /me is not asked again before the hour.
    t.h.setNow(plus(NOW, 30 * MIN));
    await t.check();
    await t.send();
    expect(t.server.requests.filter((r) => r.url === "/api/v1/me")).toHaveLength(1);
    expect(t.puts()).toHaveLength(1);
    expect(t.h.store.isTerminal("segment", t.h.store.segmentsForSession("s-1")[0]!.id)).toBe(false);

    // An hour later /me answers, one send is allowed, the PUT is refused again: paused, no new notice.
    t.h.setNow(plus(NOW, PROBE_INTERVAL_MS));
    await t.check();
    expect(readPause(t.h.store)).toMatchObject({ reason: "unauthorized", probing: true });
    await t.send();
    expect(t.puts()).toHaveLength(2);
    expect(readPause(t.h.store)).toMatchObject({ reason: "unauthorized", since: NOW, probeAt: plus(NOW, 2 * PROBE_INTERVAL_MS) });
    expect(readPause(t.h.store)!.probing).toBeUndefined();
    expect(t.h.store.listNotices()).toHaveLength(1);
  });

  it("a paused instance whose probe and next send succeed resumes", async () => {
    const t = await setup((_req, i) => (i === 0 ? problem(404, "not_found", ROUTE_NOT_FOUND) : ok(201)));
    await t.check();
    t.activity();
    await t.send();
    expect(readPause(t.h.store)?.reason).toBe("segments_disabled");
    t.h.setNow(plus(NOW, PROBE_INTERVAL_MS));
    await t.check();
    await t.send();
    expect(readPause(t.h.store)).toBeNull();
    expect(t.h.store.pendingOutboxCount()).toBe(0);
  });

  it("403 analyst_read_only pauses (forbidden_role)", async () => {
    const t = await setup(() => problem(403, "forbidden", "analyst_read_only"));
    await t.check();
    t.activity();
    await t.send();
    expect(readPause(t.h.store)?.reason).toBe("forbidden_role");
    expect(t.h.store.listTerminal()).toEqual([]);
  });

  it("404 Route not found pauses (segments_disabled), does not terminalise", async () => {
    const t = await setup(() => problem(404, "not_found", ROUTE_NOT_FOUND));
    await t.check();
    t.activity();
    await t.send();
    expect(readPause(t.h.store)?.reason).toBe("segments_disabled");
    expect(t.h.store.listTerminal()).toEqual([]);
    expect(t.h.store.pendingOutboxCount()).toBe(1);
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual(["segments_disabled"]);
  });

  it("403 not_project_member ⇒ that segment terminal, one notice, no retry storm", async () => {
    const t = await setup(() => problem(403, "forbidden", "not_project_member"));
    await t.check();
    t.activity();
    await t.send();
    for (let i = 1; i <= 5; i++) {
      t.h.setNow(plus(NOW, i * MIN));
      t.activity();
      await t.send();
    }
    expect(t.puts()).toHaveLength(1);
    const seg = t.h.store.segmentsForSession("s-1");
    expect(seg).toHaveLength(1);
    expect(t.h.store.listTerminal()).toMatchObject([{ targetKind: "segment", targetId: seg[0]!.id, code: "not_project_member", revision: 1 }]);
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual(["not_project_member"]);
    expect(readPause(t.h.store)).toBeNull();
    expect(t.h.store.pendingOutboxCount()).toBe(0);
  });

  it.each(["segment_id_unavailable", "agent_session_mismatch", "entry_locked"])("409 %s ⇒ terminal", async (code) => {
    const t = await setup(() => problem(409, "conflict", code));
    await t.check();
    t.activity();
    await t.send();
    expect(t.h.store.listTerminal().map((r) => r.code)).toEqual([code]);
    expect(t.h.store.segmentsForSession("s-1")[0]!.final).toBe(false);
  });

  it("409 agent_revision_conflict ⇒ nothing terminal, the desired body goes under the next number, the sent bytes never rewritten", async () => {
    const t = await setup((_req, i) => (i === 0 ? problem(409, "conflict", "agent_revision_conflict") : ok(200)));
    await t.check();
    t.activity();
    const seg = t.h.store.segmentsForSession("s-1")[0]!;
    const first = t.h.store.getLastCommitted("segment", seg.id)!.bodyJson;
    expect(await t.send()).toEqual({ dueInMs: 0 });
    expect(t.h.store.listTerminal()).toEqual([]);
    expect(t.h.store.outboxFor("segment", seg.id)).toEqual([]);
    expect(t.h.boundaries).toContain("revision_conflict");
    void revisionsStage()(t.h.ctx);
    await t.send();
    const [a, b] = t.puts();
    expect(a!.body).toBe(first);
    const second = JSON.parse(b!.body) as Record<string, unknown>;
    expect(second.revision).toBe(2);
    expect({ ...second, revision: 1 }).toEqual(JSON.parse(first));
    expect(t.h.store.pendingOutboxCount()).toBe(0);
    expect(t.h.store.listTerminal()).toEqual([]);
  });

  it("409 agent_revision_conflict on a final, complete revision: the replacement is still selected, outside the ledger window", async () => {
    const t = await setup((_req, i) => (i === 0 ? problem(409, "conflict", "agent_revision_conflict") : ok(200)));
    await t.check();
    t.activity();
    const seg = t.h.store.segmentsForSession("s-1")[0]!;
    t.h.store.upsertSegment({ ...seg, working: false, final: true, finalReason: "idle" });
    const target = { kind: "segment", id: seg.id } as const;
    const last = JSON.parse(t.h.store.getLastCommitted("segment", seg.id)!.bodyJson) as Record<string, unknown>;
    commitIfChanged(t.h.store, t.h.ctx.generation, target, { ...last, working: false, final: true, usageQuality: "complete", usage: [] }, t.h.ctx.now());
    await t.send();
    expect(t.h.store.outboxFor("segment", seg.id)).toEqual([]);

    // Days later no ledger row is left to fold and the session is out of the window.
    const later = plus(NOW, 3 * 24 * 60 * MIN);
    t.h.setNow(later);
    expect(t.h.store.segmentsForRevision(plus(later, -LEDGER_WINDOW_MS)).map((s) => s.id)).toEqual([seg.id]);
    void revisionsStage()(t.h.ctx);
    await t.send();
    expect(t.puts().map((r) => (JSON.parse(r.body) as { revision: number }).revision)).toEqual([2, 3]);
    expect(JSON.parse(t.puts().at(-1)!.body)).toMatchObject({ final: true, usageQuality: "complete" });
    expect(t.h.store.pendingOutboxCount()).toBe(0);
  });

  it("an invalidated commit of a delegated entry is selected again, outside the ledger window; a settled one is not", async () => {
    const t = await setup(() => ok());
    t.activity();
    t.h.store.recordDelegated({ entryId: "e-1", sessionId: "s-1", promptId: null, createdAt: NOW, eventSeq: null });
    const committed = { targetKind: "delegated", targetId: "e-1", revision: 1, canonicalJson: '{"agentSessionId":"s-1"}', bodyJson: JSON.stringify({ revision: 1, agentSessionId: "s-1", usageQuality: "complete", usage: [] }), committedAt: NOW } as const;
    const outside = plus(NOW, 3 * 24 * 60 * MIN);
    t.h.store.putLastCommitted(committed);
    expect(t.h.store.delegatedForRevision(outside)).toEqual([]);
    t.h.store.putLastCommitted({ ...committed, canonicalJson: "" });
    expect(t.h.store.delegatedForRevision(outside).map((d) => d.entryId)).toEqual(["e-1"]);
  });

  it("409 entry_locked ⇒ the session's other unsent segments are cancelled, even those of the batch already read", async () => {
    const t = await setup(() => problem(409, "conflict", "entry_locked"));
    await t.check();
    t.activity();
    t.h.setNow(plus(NOW, 30 * MIN));
    t.activity();
    const [first, second] = t.h.store.segmentsForSession("s-1");
    expect(t.h.store.latestOutbox()).toHaveLength(2);
    await t.send();
    // Only one request: the other segment was cancelled before it was sent.
    expect(t.puts()).toHaveLength(1);
    expect(t.h.store.listTerminal().map((r) => [r.targetId, r.code]).sort()).toEqual([[first!.id, "entry_locked"], [second!.id, "entry_locked"]].sort());
    expect(t.h.store.pendingOutboxCount()).toBe(0);
    expect(t.h.store.getSession("s-1")!.state).toBe(STOPPED_LOCKED);
    t.h.setNow(plus(NOW, 60 * MIN));
    t.activity();
    await t.send();
    expect(t.puts()).toHaveLength(1);
    expect(t.h.store.segmentsForSession("s-1")).toHaveLength(2);
  });

  it("409 entry_locked on one segment: a segment Tickr already holds keeps its updates", async () => {
    let lockedId = "";
    const t = await setup((req) => (lockedId !== "" && req.url.endsWith(lockedId) ? problem(409, "conflict", "entry_locked") : ok(200)));
    await t.check();
    t.activity();
    await t.send(); // created on the server
    const [held] = t.h.store.segmentsForSession("s-1");
    expect(held!.createdOnServer).toBe(true);
    t.h.setNow(plus(NOW, 30 * MIN));
    t.activity(); // the first goes final (idle), a second opens
    const second = t.h.store.segmentsForSession("s-1")[1]!;
    lockedId = second.id;
    await t.send();
    expect(t.h.store.listTerminal().map((r) => r.targetId)).toEqual([second.id]);
    const sentToHeld = t.puts().filter((r) => r.url.endsWith(held!.id));
    expect(JSON.parse(sentToHeld.at(-1)!.body)).toMatchObject({ final: true });
  });

  it("409 entry_locked on one segment: a creation already sent without an answer is not cancelled, Tickr decides it", async () => {
    let uncertainId = "";
    let lockedId = "";
    let uncertainAnswered = false;
    const t = await setup((req) => {
      const id = req.url.split("/").pop();
      if (id === lockedId) return problem(409, "conflict", "entry_locked");
      if (id === uncertainId && !uncertainAnswered) {
        uncertainAnswered = true;
        return problem(503, "service_unavailable", "workspace_busy", {}, { "retry-after": "3600" });
      }
      return ok(200);
    });
    await t.check();
    t.activity();
    t.h.setNow(plus(NOW, 30 * MIN));
    t.activity();
    const [uncertain, locked] = t.h.store.segmentsForSession("s-1");
    uncertainId = uncertain!.id;
    await t.send(); // the first creation goes out, its outcome is unknown (retry later)
    expect(uncertainAnswered).toBe(true);
    expect(uncertain!.createdOnServer).toBe(false);
    lockedId = locked!.id;
    await t.send(); // the second is refused as locked
    // The first may exist on Tickr: it is neither cancelled nor terminal, its send stays queued.
    expect(t.h.store.listTerminal().map((r) => r.targetId)).toEqual([locked!.id]);
    expect(t.h.store.latestOutbox().map((r) => r.targetId)).toEqual([uncertain!.id]);
    expect(t.h.store.getSegment(uncertain!.id)!.final).toBe(true);
    // Once due, Tickr answers for it.
    t.h.setNow(plus(NOW, 30 * MIN + 61 * MIN));
    await t.send();
    expect(t.h.store.getSegment(uncertain!.id)!.createdOnServer).toBe(true);
    expect(t.h.store.pendingOutboxCount()).toBe(0);
    expect(t.h.store.isTerminal("segment", uncertain!.id)).toBe(false);
  });

  it("409 agent_revision_conflict, then 409 entry_locked on another segment: the conflicted segment is held by Tickr, its replacement revision is still sent", async () => {
    let lockedId = "";
    let conflictedId = "";
    let conflicts = 1;
    const t = await setup((req) => {
      const id = req.url.split("/").pop();
      if (id === lockedId) return problem(409, "conflict", "entry_locked");
      if (id === conflictedId && conflicts-- > 0) return problem(409, "conflict", "agent_revision_conflict");
      return ok(200);
    });
    await t.check();
    t.activity();
    t.h.setNow(plus(NOW, 30 * MIN));
    t.activity(); // the first goes final (idle), a second opens
    const [conflicted, locked] = t.h.store.segmentsForSession("s-1");
    // The second is held by Tickr already; the first was never acknowledged here (a lost store).
    t.h.store.markSegmentCreated(locked!.id);
    conflictedId = conflicted!.id;
    lockedId = locked!.id;
    await t.send(); // conflicted first (older id): Tickr holds it, nothing terminal; then the lock
    expect(t.h.store.getSegment(conflicted!.id)!.createdOnServer).toBe(true);
    expect(t.h.store.listTerminal().map((r) => r.targetId)).toEqual([locked!.id]);
    expect(t.h.store.getSession("s-1")!.state).toBe(STOPPED_LOCKED);
    await revisionsStage()(t.h.ctx); // the wanted state goes under the next number
    await t.send();
    expect(t.h.store.isTerminal("segment", conflicted!.id)).toBe(false);
    expect(t.puts().filter((r) => r.url.endsWith(conflicted!.id))).toHaveLength(2);
    expect(t.h.store.pendingOutboxCount()).toBe(0);
  });

  it("409 entry_locked ⇒ one notice, the session is no longer segmented: no new entries", async () => {
    const t = await setup(() => problem(409, "conflict", "entry_locked"));
    await t.check();
    t.activity();
    await t.send();
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual(["entry_locked"]);
    expect(t.h.store.getSession("s-1")!.state).toBe(STOPPED_LOCKED);
    // Long after the segment went idle, more activity: no new segment, nothing more sent.
    for (let i = 1; i <= 3; i++) {
      t.h.setNow(plus(NOW, i * 30 * MIN));
      t.activity();
      await t.send();
    }
    expect(t.h.store.segmentsForSession("s-1")).toHaveLength(1);
    expect(t.puts()).toHaveLength(1);
    expect(t.h.store.listNotices()).toHaveLength(1);
  });

  it("422 and 404 Project not found ⇒ terminal with the field code", async () => {
    const t = await setup((_req, i) =>
      i === 0
        ? problem(422, "validation", "Validation failed", { errors: [{ field: "tagIds", code: "invalid_tag", message: "m" }] })
        : problem(404, "not_found", "Project not found"),
    );
    await t.check();
    t.activity();
    await t.send();
    t.h.journal("UserPromptSubmit", plus(NOW, 20 * MIN), 2200, { sessionId: "s-2" });
    t.h.setNow(plus(NOW, 20 * MIN));
    segmentationStage(t.h.ctx);
    t.h.store.setSessionAgentVersion("s-2", VERSION);
    await revisionsStage()(t.h.ctx);
    await t.send();
    expect(t.h.store.listTerminal().map((r) => r.code)).toEqual(["invalid_tag", "not_found"]);
  });

  it.each([
    ["409 segment_detached", () => problem(409, "conflict", "segment_detached"), "detached"],
    ["409 segment_finalized", () => problem(409, "conflict", "segment_finalized"), "finalized"],
    ["200 reporting a detached entry", () => ok(200, { agentDetached: true }), "detached"],
  ] as const)("%s ⇒ the segment is closed and the next activity opens a new one", async (_name, reply, state) => {
    const t = await setup((_req, i) => (i === 0 ? reply() : ok(201)));
    await t.check();
    t.activity();
    await t.send();
    const [closed] = t.h.store.segmentsForSession("s-1");
    expect(closed).toMatchObject({ final: true, serverState: state, finalReason: "server_closed" });
    t.h.setNow(plus(NOW, MIN));
    t.activity();
    await t.send();
    const segments = t.h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(t.puts().map((r) => r.url)).toEqual([`/api/v1/agent-segments/${closed!.id}`, `/api/v1/agent-segments/${segments[1]!.id}`]);
  });

  it("an unsent creation older than the 30-day window goes terminal before any send; a created one is still sent", async () => {
    const t = await setup(() => ok());
    await t.check();
    const old = plus(NOW, -INGESTION_WINDOW_MS - MIN);
    t.activity(old, { sessionId: "s-old" });
    t.activity(NOW, { sessionId: "s-new" });
    // A segment already created on the server keeps being sent even when it started long ago.
    const created = t.h.store.segmentsForSession("s-new")[0]!;
    t.h.store.upsertSegment({ ...created, startedAt: old, createdOnServer: true });
    commitIfChanged(t.h.store, t.h.ctx.generation, { kind: "segment", id: created.id }, { ...JSON.parse(t.h.store.getLastCommitted("segment", created.id)!.bodyJson), startedAt: old }, t.h.ctx.now());

    await t.send();
    const oldSeg = t.h.store.segmentsForSession("s-old")[0]!;
    expect(t.h.store.listTerminal()).toMatchObject([{ targetId: oldSeg.id, code: "ingestion_window" }]);
    expect(t.puts().map((r) => r.url)).toEqual([`/api/v1/agent-segments/${created.id}`]);
  });

  it("a delegated target goes to the usage route: 404 ⇒ terminal, entry_locked ⇒ terminal", async () => {
    const t = await setup((req) => (req.url.includes("e-404") ? problem(404, "not_found", "Entry not found") : problem(409, "conflict", "entry_locked")));
    await t.check();
    for (const id of ["e-404", "e-locked"]) {
      commitIfChanged(t.h.store, t.h.ctx.generation, { kind: "delegated", id }, { agentSessionId: "s-1", usageQuality: "complete", usage: [] }, t.h.ctx.now());
    }
    await t.send();
    expect(t.puts().map((r) => r.url).sort()).toEqual(["/api/v1/entries/e-404/agent-usage", "/api/v1/entries/e-locked/agent-usage"]);
    expect(t.puts().every((r) => r.headers["tickr-agent"] === undefined)).toBe(true);
    expect(t.h.store.listTerminal().map((r) => [r.targetKind, r.targetId, r.code]).sort()).toEqual([
      ["delegated", "e-404", "not_found"],
      ["delegated", "e-locked", "entry_locked"],
    ]);
    expect(readPause(t.h.store)).toBeNull();
  });

  it("stops at the end of the budget, the rest due at once (out of budget, for a successor)", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    t.activity(NOW, { sessionId: "a" });
    t.activity(NOW, { sessionId: "b" });
    const out = await sendDue(t.h.store, t.h.ctx.generation, t.h.ctx.api, t.h.ctx.now, 60_000, { remainingMs: () => 2999 });
    expect(out).toEqual({ dueInMs: 0, outOfBudget: true });
    expect(t.puts()).toHaveLength(0);
    expect(t.h.store.latestOutbox()).toHaveLength(2);
  });
});

describe("the creation of a segment waits for the agent version", () => {
  const bodyOf = (r: RecordedRequest) => JSON.parse(r.body) as { revision: number; startedAt: string; working: boolean; final: boolean };
  const segmentUrl = (id: string) => `/api/v1/agent-segments/${id}`;

  it("waits while the session's version is unknown, at most the grace after the segment's start, reporting the time left", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    t.activity(NOW, {}, null);
    expect(await t.send()).toEqual({ dueInMs: AGENT_VERSION_GRACE_MS });
    t.h.setNow(plus(NOW, 90_000));
    expect(await t.send()).toEqual({ dueInMs: AGENT_VERSION_GRACE_MS - 90_000 });
    expect(t.puts()).toHaveLength(0);
    expect(t.h.store.pendingOutboxCount()).toBe(1);
    expect(t.h.boundaries).not.toContain("sent");
  });

  it("goes as soon as the version is known: Tickr-Agent carries it, revision 1 byte for byte", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    t.activity(NOW, {}, null);
    await t.send();
    t.h.setNow(plus(NOW, 30_000));
    t.h.store.setSessionAgentVersion("s-1", "2.1.301");
    expect(await t.send()).toEqual({ dueInMs: null });
    const [req] = t.puts();
    const seg = t.h.store.segmentsForSession("s-1")[0]!;
    expect(req!.headers["tickr-agent"]).toBe("claude-code/2.1.301");
    expect(req!.body).toBe(t.h.store.getLastCommitted("segment", seg.id)!.bodyJson);
    expect(bodyOf(req!)).toMatchObject({ revision: 1, startedAt: NOW, working: true, final: false });
    expect(t.h.store.getSegment(seg.id)!.createdOnServer).toBe(true);
  });

  it("goes with claude-code/unknown once the grace is over", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    t.activity(NOW, {}, null);
    t.h.setNow(plus(NOW, AGENT_VERSION_GRACE_MS - 1));
    expect(await t.send()).toEqual({ dueInMs: 1 });
    expect(t.puts()).toHaveLength(0);
    t.h.setNow(plus(NOW, AGENT_VERSION_GRACE_MS));
    expect(await t.send()).toEqual({ dueInMs: null });
    expect(t.puts().map((r) => r.headers["tickr-agent"])).toEqual(["claude-code/unknown"]);
    expect(bodyOf(t.puts()[0]!)).toMatchObject({ revision: 1, startedAt: NOW, working: true });
  });

  it("a creation sent after the wait never claims a stale working: the latest revision goes, from the same start", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    t.activity(NOW, {}, null);
    await t.send();
    // Past the working freshness, the revisions stage (before the send) commits working: false.
    t.h.setNow(plus(NOW, AGENT_VERSION_GRACE_MS + 1));
    await revisionsStage()(t.h.ctx);
    await t.send();
    expect(t.puts()).toHaveLength(1);
    expect(bodyOf(t.puts()[0]!)).toMatchObject({ revision: 2, startedAt: NOW, working: false, final: false });
    expect(t.h.store.pendingOutboxCount()).toBe(0);
  });

  it("never waits for an update of a created segment, a final segment or a delegated entry", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    // s-1: already created (with claude-code/unknown), then updated within the grace of its start.
    t.activity(NOW, {}, null);
    const created = t.h.store.segmentsForSession("s-1")[0]!;
    t.h.store.markSegmentCreated(created.id);
    t.h.store.deleteOutboxFor("segment", created.id);
    // s-2: the session ended, its segment is final. s-3: waits (the control).
    t.activity(NOW, { sessionId: "s-2" }, null);
    t.h.journal("SessionEnd", plus(NOW, 1000), 1001, { sessionId: "s-2" });
    t.activity(NOW, { sessionId: "s-3" }, null);
    t.h.setNow(plus(NOW, 61_000));
    t.activity(plus(NOW, 61_000), {}, null);
    commitIfChanged(t.h.store, t.h.ctx.generation, { kind: "delegated", id: "e-1" }, { agentSessionId: "s-3", usageQuality: "complete", usage: [] }, t.h.ctx.now());

    expect(await t.send()).toEqual({ dueInMs: AGENT_VERSION_GRACE_MS - 61_000 });
    const final = t.h.store.segmentsForSession("s-2")[0]!;
    expect(final.final).toBe(true);
    expect(t.puts().map((r) => r.url).sort()).toEqual([segmentUrl(created.id), segmentUrl(final.id), "/api/v1/entries/e-1/agent-usage"].sort());
    const segmentPuts = t.puts().filter((r) => r.url.startsWith("/api/v1/agent-segments/"));
    expect(segmentPuts.map((r) => r.headers["tickr-agent"])).toEqual(["claude-code/unknown", "claude-code/unknown"]);
    expect(segmentPuts.map((r) => bodyOf(r).final).sort()).toEqual([false, true]);
    expect(t.h.store.latestOutbox().map((r) => r.targetId)).toEqual([t.h.store.segmentsForSession("s-3")[0]!.id]);
  });

  it("waiting creations never hold back the rows due after them, past one batch", async () => {
    const t = await setup(() => ok(201));
    await t.check();
    const waiting = SEND_BATCH + 5;
    for (let i = 0; i < waiting; i++) t.h.journal("UserPromptSubmit", NOW, 1000, { sessionId: `w-${String(i).padStart(3, "0")}` });
    segmentationStage(t.h.ctx);
    await revisionsStage()(t.h.ctx);
    t.h.setNow(plus(NOW, 1000));
    t.activity(plus(NOW, 1000), { sessionId: "z-ready" });
    expect(await t.send()).toEqual({ dueInMs: AGENT_VERSION_GRACE_MS - 1000 });
    expect(t.puts().map((r) => r.url)).toEqual([segmentUrl(t.h.store.segmentsForSession("z-ready")[0]!.id)]);
    expect(t.h.store.pendingOutboxCount()).toBe(waiting);
  });
});

describe("workspace check", () => {
  it("asks /me once per instance and caches the workspace", async () => {
    const t = await setup(() => ok());
    await t.check();
    await t.check();
    expect(t.server.requests.filter((r) => r.url === "/api/v1/me")).toHaveLength(1);
    expect(readWorkspace(t.h.store)).toMatchObject({ workspaceId: WS, workspaceName: "Acme", skewMs: 0 });
  });

  it("a failed probe is retried with backoff, not at every pass", async () => {
    const h = stageHarness({ now: NOW });
    harnesses.push(h);
    h.ctx.api = createAgentApi({ baseUrl: "http://127.0.0.1:9", apiKey: "tkr_test_sender_key_0001", timeoutMs: 500 });
    let calls = 0;
    const me = h.ctx.api.me;
    h.ctx.api.me = () => (calls++, me());
    await workspaceStage({ random: () => 1 })(h.ctx);
    await workspaceStage({ random: () => 1 })(h.ctx);
    expect(calls).toBe(1);
    h.setNow(plus(NOW, 2000));
    await workspaceStage({ random: () => 1 })(h.ctx);
    expect(calls).toBe(2);
    expect(readWorkspace(h.store)).toBeNull();
  });

  it("clock 6 min ahead pauses (one notice), 3 min ahead sends; the hourly re-probe resumes under 4 min", async () => {
    const t = await setup(() => ok(201), { skewMs: 6 * MIN });
    await t.check();
    expect(readPause(t.h.store)?.reason).toBe("clock_skew");
    t.activity();
    await t.send();
    expect(t.puts()).toHaveLength(0);
    expect(t.h.store.listTerminal()).toEqual([]);
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual(["clock_skew"]);

    t.setSkew(3 * MIN);
    t.h.setNow(plus(NOW, 10 * MIN));
    await t.check(); // not an hour yet
    expect(readPause(t.h.store)?.reason).toBe("clock_skew");
    t.h.setNow(plus(NOW, PROBE_INTERVAL_MS));
    await t.check();
    expect(readPause(t.h.store)).toBeNull();
    expect(readWorkspace(t.h.store)!.skewMs).toBeLessThanOrEqual(CLOCK_SKEW_LIMIT_MS);
    await t.send();
    expect(t.puts()).toHaveLength(1);
    expect(t.h.store.listNotices()).toHaveLength(1);
  });

  it("clock 3 min ahead: no pause at all", async () => {
    const t = await setup(() => ok(201), { skewMs: 3 * MIN });
    await t.check();
    expect(readPause(t.h.store)).toBeNull();
    t.activity();
    await t.send();
    expect(t.puts()).toHaveLength(1);
  });

  it("workspace mismatch ⇒ terminal + one notice, tracking stops for that session only", async () => {
    const t = await setup(() => ok(201));
    const foreign = { hash: "", json: canonicalJson({ ...MAPPING, workspaceId: OTHER_WS }) };
    t.activity(NOW, { sessionId: "s-foreign", mapping: foreign });
    t.activity(NOW, { sessionId: "s-other-foreign", mapping: foreign });
    t.activity(NOW, { sessionId: "s-ok", mapping: journalMapping() });
    await t.check();
    await t.send();

    expect(t.h.store.getSession("s-foreign")!.state).toBe(STOPPED_MISMATCH);
    expect(t.h.store.getSession("s-ok")!.state).toBe("active");
    expect(t.h.store.listTerminal().map((r) => r.code)).toEqual(["workspace_mismatch", "workspace_mismatch"]);
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual(["workspace_mismatch"]);
    expect(t.puts()).toHaveLength(1);
    expect(t.puts()[0]!.url).toBe(`/api/v1/agent-segments/${t.h.store.segmentsForSession("s-ok")[0]!.id}`);

    // Later events of the stopped session make no segment; the other session goes on.
    t.h.setNow(plus(NOW, 20 * MIN));
    t.activity(plus(NOW, 20 * MIN), { sessionId: "s-foreign", mapping: foreign });
    t.activity(plus(NOW, 20 * MIN), { sessionId: "s-ok", mapping: journalMapping() });
    await t.check();
    await t.send();
    expect(t.h.store.segmentsForSession("s-foreign")).toHaveLength(1);
    expect(t.h.store.segmentsForSession("s-ok")).toHaveLength(2);
    expect(t.h.store.listTerminal()).toHaveLength(2);
  });

  it("a mismatching segment committed after the check is stopped by the send guard, never sent", async () => {
    const t = await setup(() => ok(201));
    writeWorkspace(t.h.store, { workspaceId: WS, workspaceName: "Acme", checkedAt: NOW, skewMs: 0 });
    t.activity(NOW, { sessionId: "s-late", mapping: { hash: "", json: canonicalJson({ ...MAPPING, workspaceId: OTHER_WS }) } });
    await t.send();
    expect(t.puts()).toHaveLength(0);
    expect(t.h.store.getSession("s-late")!.state).toBe(STOPPED_MISMATCH);
  });
});
