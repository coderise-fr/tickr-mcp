import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership, LostOwnership, OWNER_STALE_MS } from "../../hook-src/flusher/owner.js";
import {
  acknowledge,
  canonicalBody,
  commitIfChanged,
  desiredSegmentBody,
  LEASE_REFRESH_MS,
  REVISION_SOURCES,
  revisionsStage,
  SEGMENT_BODY_KEYS,
  segmentRevisions,
  type UsageRow,
} from "../../hook-src/flusher/revisions.js";
import { segmentationStage } from "../../hook-src/flusher/segmentation.js";
import { PIPELINE } from "../../hook-src/flusher/stages.js";
import { DB_FILE, openStore, type SegmentRow, type Store } from "../../hook-src/store/db.js";
import { cleanTempDirs, PROJECT } from "./helpers/env.js";
import { MAPPING, stageHarness } from "./helpers/stage.js";

afterEach(() => cleanTempDirs());

const MIN = 60_000;
const SEGMENT = "0190f0c0-0000-7000-8000-00000000000a";

function segment(extra: Partial<SegmentRow> = {}): SegmentRow {
  return {
    id: SEGMENT,
    sessionId: "s-1",
    mappingVersionId: 1,
    startedAt: "2026-11-05T10:00:00.000Z",
    lastActivityAt: "2026-11-05T10:05:00.000Z",
    stoppedAt: "2026-11-05T10:05:00.000Z",
    working: true,
    observedAt: "2026-11-05T10:05:00.000Z",
    final: false,
    finalReason: null,
    finalDiagnostic: null,
    quality: "pending",
    createdOnServer: false,
    serverState: null,
    lastRevision: 0,
    ...extra,
  };
}

const at = (iso: string, plusMs = 0) => new Date(Date.parse(iso) + plusMs);
const target = { kind: "segment" as const, id: SEGMENT };

describe("desiredSegmentBody", () => {
  it("has exactly the contract keys, the mapping fields of its version and no usage key without usage", () => {
    const mapping = { ...MAPPING, taskId: "task-1", tagIds: ["t-1", "t-2"], description: "Refactoring" };
    const body = desiredSegmentBody(segment(), mapping, at("2026-11-05T10:06:00.000Z"));
    expect(Object.keys(body)).toEqual(SEGMENT_BODY_KEYS.filter((k) => k !== "revision" && k !== "usage"));
    expect(body).toEqual({
      agentSessionId: "s-1",
      startedAt: "2026-11-05T10:00:00.000Z",
      stoppedAt: "2026-11-05T10:05:00.000Z",
      projectId: PROJECT,
      taskId: "task-1",
      tagIds: ["t-1", "t-2"],
      description: "Refactoring",
      working: true,
      observedAt: "2026-11-05T10:05:00.000Z",
      final: false,
      usageQuality: "pending",
    });
    const usage: UsageRow[] = [{ provider: "anthropic", model: "claude-test", inputTokens: 1, outputTokens: 2, cacheCreationInputTokens: 3, cacheReadInputTokens: 4 }];
    expect(Object.keys(desiredSegmentBody(segment(), MAPPING, at("2026-11-05T10:06:00.000Z"), usage))).toEqual(SEGMENT_BODY_KEYS.filter((k) => k !== "revision"));
  });

  it("never carries usage: null", () => {
    const body = desiredSegmentBody(segment(), MAPPING, at("2026-11-05T10:06:00.000Z"), null as unknown as UsageRow[]);
    expect("usage" in body).toBe(false);
    expect(canonicalBody({ ...body, usage: null })).toBe(canonicalBody(body));
  });

  it("working: true only for an event at most 2 min old, never once final", () => {
    const observed = "2026-11-05T10:05:00.000Z";
    expect(desiredSegmentBody(segment(), MAPPING, at(observed, 2 * MIN)).working).toBe(true);
    expect(desiredSegmentBody(segment(), MAPPING, at(observed, 2 * MIN + 1)).working).toBe(false);
    expect(desiredSegmentBody(segment({ working: false }), MAPPING, at(observed)).working).toBe(false);
    expect(desiredSegmentBody(segment({ final: true }), MAPPING, at(observed)).working).toBe(false);
  });

  it("usageQuality is pending until final, then the final quality (incomplete in Part B)", () => {
    expect(desiredSegmentBody(segment(), MAPPING, at("2026-11-05T10:06:00.000Z")).usageQuality).toBe("pending");
    expect(desiredSegmentBody(segment({ final: true, working: false }), MAPPING, at("2026-11-05T10:06:00.000Z")).usageQuality).toBe("incomplete");
  });
});

function ownedStore(now: Date): { store: Store; gen: number } {
  const h = stageHarness({ now: now.toISOString() });
  return { store: h.store, gen: h.ctx.generation };
}

describe("commitIfChanged / acknowledge", () => {
  it("same desired state ⇒ no new revision", () => {
    const now = at("2026-11-05T10:06:00.000Z");
    const { store, gen } = ownedStore(now);
    const body = desiredSegmentBody(segment(), MAPPING, now);
    expect(commitIfChanged(store, gen, target, body, now)).toBe(1);
    // Same content, other key order: still no change.
    const reordered = Object.fromEntries(Object.entries(body).reverse());
    expect(commitIfChanged(store, gen, target, reordered, at("2026-11-05T10:06:30.000Z"))).toBeNull();
    expect(commitIfChanged(store, gen, target, { ...body, stoppedAt: "2026-11-05T10:05:30.000Z" }, now)).toBe(2);
    expect(store.outboxFor("segment", SEGMENT).map((r) => r.revision)).toEqual([1, 2]);
    expect(store.getSegment(SEGMENT)).toBeNull(); // no segment row: last_revision is only kept when one exists
    store.close();
  });

  it("stores the full body with its revision first, due at once, and records it as the last committed", () => {
    const now = at("2026-11-05T10:06:00.000Z");
    const { store, gen } = ownedStore(now);
    store.upsertSegment(segment());
    const body = desiredSegmentBody(segment(), MAPPING, now);
    commitIfChanged(store, gen, target, body, now);
    const [row] = store.outboxFor("segment", SEGMENT);
    expect(row).toMatchObject({ revision: 1, attempts: 0, nextAttemptAt: now.toISOString() });
    expect(row!.bodyJson).toBe(JSON.stringify({ revision: 1, ...body }));
    expect(Object.keys(JSON.parse(row!.bodyJson))).toEqual(SEGMENT_BODY_KEYS.filter((k) => k !== "usage"));
    expect(store.getLastCommitted("segment", SEGMENT)).toEqual({
      targetKind: "segment",
      targetId: SEGMENT,
      revision: 1,
      canonicalJson: canonicalBody(body),
      bodyJson: row!.bodyJson,
      committedAt: now.toISOString(),
    });
    expect(store.getSegment(SEGMENT)!.lastRevision).toBe(1);
    store.close();
  });

  it("response lost, event becomes stale, retry ⇒ same body resent byte-for-byte, then a NEW revision with working: false", async () => {
    const h = stageHarness({ now: "2026-11-05T10:05:10.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:05:00.000Z", 100);
    await segmentationStage(h.ctx);
    const stage = revisionsStage();
    await stage(h.ctx);
    const [sent] = h.store.dueOutbox("2026-11-05T10:05:10.000Z");
    expect(JSON.parse(sent!.bodyJson)).toMatchObject({ revision: 1, working: true });

    // The response is lost (no acknowledgement); three minutes later the retry replays revision 1.
    h.setNow("2026-11-05T10:08:10.000Z");
    const [retry] = h.store.dueOutbox("2026-11-05T10:08:10.000Z");
    expect(retry!.bodyJson).toBe(sent!.bodyJson);

    // The next pass sees a stale observation: a new revision, working: false.
    await stage(h.ctx);
    const [latest] = h.store.dueOutbox("2026-11-05T10:08:10.000Z");
    expect(latest!.revision).toBe(2);
    expect(JSON.parse(latest!.bodyJson)).toMatchObject({ revision: 2, working: false, observedAt: "2026-11-05T10:05:00.000Z" });
    expect(h.store.outboxFor("segment", latest!.targetId).find((r) => r.revision === 1)!.bodyJson).toBe(sent!.bodyJson);
    expect(h.boundaries).toEqual(["revision_committed", "revision_committed"]);
    h.close();
  });

  it("working: true never committed for an event older than 2 min", async () => {
    const h = stageHarness({ now: "2026-11-05T10:07:00.001Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:05:00.000Z", 100);
    await segmentationStage(h.ctx);
    await revisionsStage()(h.ctx);
    const rows = h.store.dueOutbox("2026-11-05T10:07:00.001Z");
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0]!.bodyJson).working).toBe(false);
    h.close();
  });

  it("ack of N removes N and every older revision", () => {
    const now = at("2026-11-05T10:06:00.000Z");
    const { store, gen } = ownedStore(now);
    const body = desiredSegmentBody(segment(), MAPPING, now);
    for (let i = 0; i < 4; i++) commitIfChanged(store, gen, target, { ...body, stoppedAt: `2026-11-05T10:05:0${i}.000Z` }, now);
    acknowledge(store, gen, target, 3, now);
    expect(store.outboxFor("segment", SEGMENT).map((r) => r.revision)).toEqual([4]);
    // The last committed body survives the acknowledgement: the next revision is 5, not 1.
    acknowledge(store, gen, target, 4, now);
    expect(store.pendingOutboxCount()).toBe(0);
    expect(commitIfChanged(store, gen, target, { ...body, stoppedAt: "2026-11-05T10:05:03.000Z" }, now)).toBeNull();
    expect(commitIfChanged(store, gen, target, { ...body, stoppedAt: "2026-11-05T10:05:09.000Z" }, now)).toBe(5);
    store.close();
  });

  it("only the latest revision per target is selectable for sending", () => {
    const now = at("2026-11-05T10:06:00.000Z");
    const { store, gen } = ownedStore(now);
    const body = desiredSegmentBody(segment(), MAPPING, now);
    const other = { kind: "segment" as const, id: "0190f0c0-0000-7000-8000-00000000000b" };
    for (let i = 0; i < 3; i++) commitIfChanged(store, gen, target, { ...body, stoppedAt: `2026-11-05T10:05:0${i}.000Z` }, now);
    commitIfChanged(store, gen, other, body, now);
    expect(store.dueOutbox(now.toISOString()).map((r) => [r.targetId, r.revision])).toEqual([
      [SEGMENT, 3],
      [other.id, 1],
    ]);
    store.close();
  });

  it("a flusher that lost ownership commits and acknowledges nothing", () => {
    const now = at("2026-11-05T10:06:00.000Z");
    const h = stageHarness({ now: now.toISOString() });
    const body = desiredSegmentBody(segment(), MAPPING, now);
    commitIfChanged(h.store, h.ctx.generation, target, body, now);
    const thief = openStore(join(h.dir, DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
    expect(claimOwnership(thief, 2, at(now.toISOString(), OWNER_STALE_MS + 1).toISOString())).toBe(2);
    thief.close();
    expect(() => commitIfChanged(h.store, 1, target, { ...body, working: false }, now)).toThrow(LostOwnership);
    expect(() => acknowledge(h.store, 1, target, 1, now)).toThrow(LostOwnership);
    expect(h.store.outboxFor("segment", SEGMENT).map((r) => r.revision)).toEqual([1]);
    h.close();
  });
});

describe("revisions stage", () => {
  it("is the pipeline's revisions stage, asking the segment source first", () => {
    expect(REVISION_SOURCES[0]).toBe(segmentRevisions);
    expect(PIPELINE.revisions).not.toBe(undefined);
  });

  it("commits one revision per changed segment, each from its own mapping version, and is due when working turns stale", async () => {
    const h = stageHarness({ now: "2026-11-05T10:05:30.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    h.journal("Stop", "2026-11-05T10:02:00.000Z", 220);
    h.journal("UserPromptSubmit", "2026-11-05T10:05:00.000Z", 400, { sessionId: "s-2" });
    await segmentationStage(h.ctx);
    const result = await PIPELINE.revisions(h.ctx);
    const rows = h.store
      .dueOutbox("2026-11-05T10:05:30.000Z")
      .map((r) => JSON.parse(r.bodyJson))
      .sort((a, b) => a.agentSessionId.localeCompare(b.agentSessionId));
    expect(rows.map((r) => [r.agentSessionId, r.revision, r.working, r.projectId])).toEqual([
      ["s-1", 1, false, PROJECT],
      ["s-2", 1, true, PROJECT],
    ]);
    // s-2 turns working: false just after 10:07:00.
    expect(result).toEqual({ dueInMs: 90_001 });
    expect(await PIPELINE.revisions(h.ctx)).toEqual({ dueInMs: 90_001 });
    expect(h.boundaries).toEqual(["revision_committed", "revision_committed"]);
    h.close();
  });

  it("re-sends a live segment whose end moved at most once a minute", async () => {
    const h = stageHarness({ now: "2026-11-05T10:00:01.000Z" });
    const stage = revisionsStage();
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    await segmentationStage(h.ctx);
    await stage(h.ctx);
    h.journal("PostToolUse", "2026-11-05T10:00:20.000Z", 120);
    h.setNow("2026-11-05T10:00:21.000Z");
    await segmentationStage(h.ctx);
    expect(await stage(h.ctx)).toEqual({ dueInMs: LEASE_REFRESH_MS - 20_000 });
    expect(h.store.pendingOutboxCount()).toBe(1);

    // A change other than the moving end (here the end of the turn) is committed at once.
    h.journal("Stop", "2026-11-05T10:00:30.000Z", 130);
    h.setNow("2026-11-05T10:00:31.000Z");
    await segmentationStage(h.ctx);
    await stage(h.ctx);
    expect(JSON.parse(h.store.dueOutbox("2026-11-05T10:00:31.000Z")[0]!.bodyJson)).toMatchObject({ revision: 2, working: false, stoppedAt: "2026-11-05T10:00:30.000Z" });

    h.journal("UserPromptSubmit", "2026-11-05T10:00:40.000Z", 140);
    h.journal("PostToolUse", "2026-11-05T10:00:50.000Z", 150);
    h.setNow("2026-11-05T10:00:51.000Z");
    await segmentationStage(h.ctx);
    await stage(h.ctx); // working again: committed at once (revision 3)
    h.journal("PostToolUse", "2026-11-05T10:01:40.000Z", 200);
    h.setNow("2026-11-05T10:01:52.000Z");
    await segmentationStage(h.ctx);
    await stage(h.ctx); // a minute after revision 3: refreshed
    expect(h.store.outboxFor("segment", h.store.segmentsForSession("s-1")[0]!.id).map((r) => [r.revision, JSON.parse(r.bodyJson).stoppedAt])).toEqual([
      [1, "2026-11-05T10:00:00.000Z"],
      [2, "2026-11-05T10:00:30.000Z"],
      [3, "2026-11-05T10:00:50.000Z"],
      [4, "2026-11-05T10:01:40.000Z"],
    ]);
    h.close();
  });

  it("a final segment is committed once as final, then left alone; terminal and server-closed segments are skipped", async () => {
    const h = stageHarness({ now: "2026-11-05T10:30:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    h.journal("SessionEnd", "2026-11-05T10:01:00.000Z", 160);
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100, { sessionId: "s-2" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100, { sessionId: "s-3" });
    await segmentationStage(h.ctx);
    const [two] = h.store.segmentsForSession("s-2");
    const [three] = h.store.segmentsForSession("s-3");
    h.ctx.guarded(() => {
      h.store.addTerminal({ targetKind: "segment", targetId: two!.id, revision: null, code: "invalid_segment_bounds", at: "2026-11-05T10:30:00.000Z", diagnostic: "" });
      h.store.upsertSegment({ ...three!, serverState: "detached" });
    });
    await revisionsStage()(h.ctx);
    const [one] = h.store.segmentsForSession("s-1");
    expect(h.store.dueOutbox("2026-11-05T10:30:00.000Z").map((r) => [r.targetId, JSON.parse(r.bodyJson)])).toEqual([
      [one!.id, expect.objectContaining({ revision: 1, final: true, working: false, usageQuality: "incomplete", stoppedAt: "2026-11-05T10:00:00.000Z" })],
    ]);
    expect(h.store.segmentsForRevision()).toEqual([]);
    h.close();
  });

  it("stops at the end of the wake budget", async () => {
    const h = stageHarness({ now: "2026-11-05T10:00:10.000Z", remainingMs: 0 });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    await segmentationStage({ ...h.ctx, remainingMs: () => 60_000 });
    expect(await revisionsStage()(h.ctx)).toEqual({ dueInMs: 0 });
    expect(h.store.pendingOutboxCount()).toBe(0);
    h.close();
  });

  it("asks every source in order and commits what each desires", async () => {
    const h = stageHarness({ now: "2026-11-05T10:00:10.000Z" });
    const delegated = { kind: "delegated" as const, id: "6f9a2b1c-0000-4000-8000-000000000001" };
    const stage = revisionsStage([
      () => ({ desired: [], dueInMs: 5000 }),
      () => ({ desired: [{ target: delegated, body: { agentSessionId: "s-1", usageQuality: "pending", usage: [] } }], dueInMs: null }),
    ]);
    expect(await stage(h.ctx)).toEqual({ dueInMs: 5000 });
    expect(h.store.outboxFor("delegated", delegated.id).map((r) => r.bodyJson)).toEqual(['{"revision":1,"agentSessionId":"s-1","usageQuality":"pending","usage":[]}']);
    h.close();
  });
});
