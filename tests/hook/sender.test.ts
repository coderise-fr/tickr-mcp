import { afterEach, describe, expect, it } from "vitest";
import { createAgentApi, ROUTE_NOT_FOUND } from "../../hook-src/flusher/api.js";
import { commitIfChanged, revisionsStage } from "../../hook-src/flusher/revisions.js";
import { segmentationStage } from "../../hook-src/flusher/segmentation.js";
import {
  backoffMs,
  INGESTION_WINDOW_MS,
  MAX_BACKOFF_MS,
  PROBE_INTERVAL_MS,
  readPause,
  readWorkspace,
  sendDue,
  STOPPED_MISMATCH,
  writeWorkspace,
} from "../../hook-src/flusher/sender.js";
import { CLOCK_SKEW_LIMIT_MS, workspaceStage } from "../../hook-src/flusher/workspace.js";
import { canonicalJson } from "../../hook-src/mapping.js";
import { json, problem, type RecordedRequest, type Reply, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, WS } from "./helpers/env.js";
import { journalMapping, MAPPING, type StageHarness, stageHarness } from "./helpers/stage.js";

const NOW = "2026-11-05T10:00:00.000Z";
const MIN = 60_000;
const OTHER_WS = "9b9b9b9b-0000-4000-8000-000000000099";

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
    /** One user prompt at `at`, segmented and committed as a revision. */
    activity: (at: string = h.ctx.now().toISOString(), extra = {}) => {
      h.journal("UserPromptSubmit", at, 1000, extra);
      segmentationStage(h.ctx);
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
    expect(req!.headers["tickr-agent"]).toBe("claude-code/unknown");
    const seg = t.h.store.segmentsForSession("s-1")[0]!;
    expect(seg.createdOnServer).toBe(true);
    expect(t.h.store.pendingOutboxCount()).toBe(0);
    expect(req!.body).toBe(t.h.store.getLastCommitted("segment", seg.id)!.bodyJson);
    expect(t.h.boundaries).toEqual(expect.arrayContaining(["sent", "acknowledged"]));

    t.h.store.upsertSession({ ...t.h.store.getSession("s-1")!, agentVersion: "2.1.300" });
    t.h.setNow(plus(NOW, 2 * MIN));
    t.activity();
    await t.send();
    expect(t.puts()[1]!.headers["tickr-agent"]).toBe("claude-code/2.1.300");
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

  it.each(["segment_id_unavailable", "agent_session_mismatch", "agent_revision_conflict", "entry_locked"])("409 %s ⇒ terminal", async (code) => {
    const t = await setup(() => problem(409, "conflict", code));
    await t.check();
    t.activity();
    await t.send();
    expect(t.h.store.listTerminal().map((r) => r.code)).toEqual([code]);
    expect(t.h.store.segmentsForSession("s-1")[0]!.final).toBe(false);
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
    expect(t.h.store.pendingOutboxCount()).toBe(2);
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
