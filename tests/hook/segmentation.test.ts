import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_DIR, writeFallback } from "../../hook-src/fallback.js";
import { OFFLINE_API } from "../../hook-src/flusher/api.js";
import { runFlusher } from "../../hook-src/flusher/run.js";
import { markClosedByServer, segmentationStage, segmentSession } from "../../hook-src/flusher/segmentation.js";
import { PIPELINE } from "../../hook-src/flusher/stages.js";
import { ulid } from "../../hook-src/ids.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import { cleanTempDirs, OTHER_PROJECT, pluginConfig } from "./helpers/env.js";
import { journalMapping, MAPPING, stageHarness } from "./helpers/stage.js";

afterEach(() => cleanTempDirs());

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MIN = 60_000;

describe("segmentation stage", () => {
  it("is the pipeline's segmentation stage", () => {
    expect(PIPELINE.segmentation).toBe(segmentationStage);
  });

  it("turns journalled events into segments with uuidv7 ids and moves each session's cursor", async () => {
    const h = stageHarness({ now: "2026-11-05T10:06:00.000Z" });
    h.journal("SessionStart", "2026-11-05T10:00:00.000Z", 100);
    h.journal("UserPromptSubmit", "2026-11-05T10:00:05.000Z", 105);
    h.journal("UserPromptSubmit", "2026-11-05T10:01:00.000Z", 160, { sessionId: "s-2", provider: "bedrock" });
    h.journal("PostToolUse", "2026-11-05T10:02:00.000Z", 220);
    h.journal("Stop", "2026-11-05T10:05:00.000Z", 400);

    const result = await segmentationStage(h.ctx);
    const [one] = h.store.segmentsForSession("s-1");
    const [two] = h.store.segmentsForSession("s-2");
    expect(one).toMatchObject({
      startedAt: "2026-11-05T10:00:05.000Z",
      lastActivityAt: "2026-11-05T10:05:00.000Z",
      stoppedAt: "2026-11-05T10:05:00.000Z",
      working: false,
      observedAt: "2026-11-05T10:05:00.000Z",
      final: false,
      quality: "pending",
      lastRevision: 0,
      mappingVersionId: h.store.listMappings()[0]!.id,
    });
    expect(two).toMatchObject({ startedAt: "2026-11-05T10:01:00.000Z", working: true, final: false });
    expect(one!.id).toMatch(UUID_V7);
    expect(two!.id).toMatch(UUID_V7);
    expect(one!.id).not.toBe(two!.id);

    expect(h.store.getSession("s-1")).toMatchObject({ lastEventSeq: 5, lastEventTime: "2026-11-05T10:05:00.000Z", lastUptimeS: 400, provider: "anthropic", lateEvents: 0 });
    expect(h.store.getSession("s-2")).toMatchObject({ lastEventSeq: 3, provider: "bedrock" });
    expect(h.store.pendingEventSessions()).toEqual([]);
    // Next idle deadline: s-2 at 10:16:00 (s-1 at 10:20:00), from now 10:06:00.
    expect(result).toEqual({ dueInMs: 10 * MIN });

    // A second pass with no new event changes nothing.
    await segmentationStage(h.ctx);
    expect(h.store.segmentsForSession("s-1")).toEqual([one]);
    h.close();
  });

  it("finalises an idle segment on a later wake, honouring idle_minutes", async () => {
    const h = stageHarness({ now: "2026-11-05T10:20:00.000Z", idleMinutes: 30 });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    h.journal("PostToolUse", "2026-11-05T10:01:00.000Z", 160);
    expect(await segmentationStage(h.ctx)).toEqual({ dueInMs: 11 * MIN });
    expect(h.store.openSegments()).toHaveLength(1);

    h.setNow("2026-11-05T10:31:00.000Z");
    expect(await segmentationStage(h.ctx)).toEqual({});
    expect(h.store.segmentsForSession("s-1")).toMatchObject([
      { final: true, finalReason: "idle", stoppedAt: "2026-11-05T10:01:00.000Z", working: false },
    ]);
    h.close();
  });

  it("synthetic bounds stored and replayed unchanged on a rebuild", async () => {
    const h = stageHarness({ now: "2026-11-06T00:05:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T23:55:00.000Z", 100);
    h.journal("PostToolUse", "2026-11-06T00:03:00.000Z", 580);
    await segmentationStage(h.ctx);
    const [before, after] = h.store.segmentsForSession("s-1");
    expect(before).toMatchObject({ final: true, finalReason: "midnight", stoppedAt: "2026-11-06T00:00:00.000Z", lastActivityAt: "2026-11-05T23:55:00.000Z" });
    expect(after).toMatchObject({ final: false, startedAt: "2026-11-06T00:00:00.000Z", lastActivityAt: "2026-11-06T00:03:00.000Z" });
    const path = join(h.dir, DB_FILE);
    h.close();

    // A new flusher on the same store, later events, a wake-up past idle: the stored bounds stay.
    const store = openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
    store.journal({ eventId: ulid(Date.now()), sessionId: "s-1", type: "Stop", localTime: "2026-11-06T00:04:00.000Z", uptimeS: 640, mapping: journalMapping() });
    store.close();
    const later = new Date("2026-11-06T01:00:00.000Z");
    const outcome = await runFlusher(h.dir, {
      now: () => later,
      uptime: () => 1000,
      api: OFFLINE_API,
      config: pluginConfig(h.dir),
      wakeBudgetMs: 60_000,
      stages: { revisions: () => ({}) },
    });
    expect(outcome).toBe("done");
    const reopened = openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
    const [b, a] = reopened.segmentsForSession("s-1");
    expect(b).toEqual(before);
    expect(a).toMatchObject({ id: after!.id, startedAt: "2026-11-06T00:00:00.000Z", stoppedAt: "2026-11-06T00:04:00.000Z", final: true, finalReason: "idle" });
    reopened.close();
  });

  it("a mapping change in .tickr.json splits at the event", async () => {
    const h = stageHarness({ now: "2026-11-05T10:06:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    h.journal("PostToolUse", "2026-11-05T10:05:00.000Z", 400, { mapping: journalMapping({ ...MAPPING, projectId: OTHER_PROJECT }) });
    await segmentationStage(h.ctx);
    const [first, second] = h.store.segmentsForSession("s-1");
    expect(first).toMatchObject({ final: true, finalReason: "mapping", stoppedAt: "2026-11-05T10:05:00.000Z" });
    expect(second).toMatchObject({ final: false, startedAt: "2026-11-05T10:05:00.000Z" });
    expect(second!.mappingVersionId).not.toBe(first!.mappingVersionId);
    h.close();
  });

  it("a clock-jump split keeps its diagnostic", async () => {
    const h = stageHarness({ now: "2026-11-05T10:14:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    h.journal("PostToolUse", "2026-11-05T10:13:00.000Z", 280);
    await segmentationStage(h.ctx);
    expect(h.store.segmentsForSession("s-1")[0]).toMatchObject({ finalReason: "clock_jump", finalDiagnostic: "clock drift or possible reboot" });
    h.close();
  });

  it("a fallback event imported after newer events is counted as late, nothing reopened", async () => {
    const h = stageHarness({ now: "2026-11-05T11:05:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    h.journal("UserPromptSubmit", "2026-11-05T11:00:00.000Z", 3700);
    await segmentationStage(h.ctx);
    const segments = h.store.segmentsForSession("s-1");
    h.journal("PostToolUse", "2026-11-05T10:30:00.000Z", 1900);
    await segmentationStage(h.ctx);
    expect(h.store.segmentsForSession("s-1")).toEqual(segments);
    expect(h.store.getSession("s-1")).toMatchObject({ lateEvents: 1, lastEventTime: "2026-11-05T11:00:00.000Z" });
    h.close();
  });

  it("reads a long backlog in batches, each with its cursor", () => {
    const h = stageHarness({ now: "2026-11-05T10:10:00.000Z" });
    for (let i = 0; i < 5; i++) h.journal("PostToolUse", new Date(Date.parse("2026-11-05T10:00:00.000Z") + i * MIN).toISOString(), 100 + i * 60);
    const cfg = { idleMs: 15 * MIN, newId: () => "0190f0c0-0000-7000-8000-000000000001" };
    expect(h.ctx.guarded(() => segmentSession(h.store, "s-1", cfg, 2))).toBe(2);
    expect(h.store.getSession("s-1")!.lastEventSeq).toBe(2);
    expect(h.ctx.guarded(() => segmentSession(h.store, "s-1", cfg, 2))).toBe(2);
    expect(h.ctx.guarded(() => segmentSession(h.store, "s-1", cfg, 2))).toBe(1);
    expect(h.ctx.guarded(() => segmentSession(h.store, "s-1", cfg, 2))).toBe(0);
    expect(h.store.segmentsForSession("s-1")).toMatchObject([{ startedAt: "2026-11-05T10:00:00.000Z", lastActivityAt: "2026-11-05T10:04:00.000Z" }]);
    h.close();
  });

  it("a session no longer active consumes its events without segments", async () => {
    const h = stageHarness({ now: "2026-11-05T10:06:00.000Z" });
    h.store.upsertSession({ sessionId: "s-1", lastEventSeq: 0, lastEventTime: null, lastUptimeS: null, state: "stopped_mismatch", agentVersion: null, provider: null, lateEvents: 0 });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    await segmentationStage(h.ctx);
    expect(h.store.segmentsForSession("s-1")).toEqual([]);
    expect(h.store.getSession("s-1")).toMatchObject({ lastEventSeq: 1, state: "stopped_mismatch" });
    h.close();
  });

  it("a segment closed by the server stays closed and the next activity opens a new one", async () => {
    const h = stageHarness({ now: "2026-11-05T10:06:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    await segmentationStage(h.ctx);
    const [first] = h.store.segmentsForSession("s-1");
    h.ctx.guarded(() => markClosedByServer(h.store, first!.id, "detached"));
    h.journal("PostToolUse", "2026-11-05T10:02:00.000Z", 220);
    await segmentationStage(h.ctx);
    const [closed, next] = h.store.segmentsForSession("s-1");
    expect(closed).toMatchObject({ id: first!.id, final: true, finalReason: "server_closed", serverState: "detached", stoppedAt: "2026-11-05T10:00:00.000Z" });
    expect(next).toMatchObject({ final: false, startedAt: "2026-11-05T10:02:00.000Z" });
    h.close();
  });

  it("two Claude Code sessions in one repository ⇒ independent segments (through the flusher, with fallback files)", async () => {
    const h = stageHarness({ now: "2026-11-05T10:06:00.000Z" });
    h.journal("UserPromptSubmit", "2026-11-05T10:00:00.000Z", 100);
    const fallback = join(h.dir, FALLBACK_DIR);
    writeFallback(fallback, { eventId: ulid(Date.now()), sessionId: "s-2", type: "UserPromptSubmit", localTime: "2026-11-05T10:01:00.000Z", uptimeS: 160, mapping: journalMapping() });
    h.journal("PostToolUse", "2026-11-05T10:03:00.000Z", 280);
    h.ctx.store.setOwnerHeartbeat(h.ctx.generation, "1970-01-01T00:00:00.000Z");
    const path = join(h.dir, DB_FILE);
    h.close();
    const now = new Date("2026-11-05T10:06:00.000Z");
    await runFlusher(h.dir, { now: () => now, uptime: () => 1000, api: OFFLINE_API, config: pluginConfig(h.dir), wakeBudgetMs: 60_000, stages: { revisions: () => ({}) } });
    const store = openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
    expect(store.segmentsForSession("s-1")).toMatchObject([{ startedAt: "2026-11-05T10:00:00.000Z", lastActivityAt: "2026-11-05T10:03:00.000Z" }]);
    expect(store.segmentsForSession("s-2")).toMatchObject([{ startedAt: "2026-11-05T10:01:00.000Z", lastActivityAt: "2026-11-05T10:01:00.000Z" }]);
    store.close();
  });
});
