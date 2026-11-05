import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { FALLBACK_DIR } from "../../hook-src/fallback.js";
import { boundsStage, instanceBytes, MAX_INSTANCE_BYTES, MAX_PENDING_ROWS, RETENTION_KEY, RETENTION_MS } from "../../hook-src/flusher/bounds.js";
import { acknowledge, commitIfChanged, revisionsStage } from "../../hook-src/flusher/revisions.js";
import { segmentationStage } from "../../hook-src/flusher/segmentation.js";
import { PIPELINE } from "../../hook-src/flusher/stages.js";
import { INTAKE_PAUSED_KEY, recordEvent } from "../../hook-src/intake.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import { cleanTempDirs, hookInput, instanceFor, pluginConfig, tempDir, writeMapping } from "./helpers/env.js";
import { type StageHarness, stageHarness } from "./helpers/stage.js";

const NOW = "2026-11-05T10:00:00.000Z";
const DAY = 24 * 60 * 60_000;

const harnesses: StageHarness[] = [];
afterEach(() => {
  for (const h of harnesses.splice(0)) h.close();
  cleanTempDirs();
});

function harness(now = NOW): StageHarness {
  const h = stageHarness({ now });
  harnesses.push(h);
  return h;
}

const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

function commit(h: StageHarness, id: string, n: number) {
  return commitIfChanged(h.store, h.ctx.generation, { kind: "delegated", id }, { agentSessionId: "s-1", usageQuality: "pending", usage: [], n }, h.ctx.now());
}

describe("instanceBytes", () => {
  it("counts the database, its rollback journal and the fallback files", () => {
    const dir = tempDir();
    writeFileSync(join(dir, DB_FILE), Buffer.alloc(1000));
    writeFileSync(join(dir, `${DB_FILE}-journal`), Buffer.alloc(200));
    mkdirSync(join(dir, FALLBACK_DIR));
    writeFileSync(join(dir, FALLBACK_DIR, "a.json"), Buffer.alloc(30));
    writeFileSync(join(dir, FALLBACK_DIR, ".b.tmp"), Buffer.alloc(4));
    writeFileSync(join(dir, "instance.json"), Buffer.alloc(5000));
    expect(instanceBytes(dir)).toBe(1234);
    expect(instanceBytes(join(dir, "missing"))).toBe(0);
  });

  it("the limits are 500 pending rows and 50 MB", () => {
    expect(MAX_PENDING_ROWS).toBe(500);
    expect(MAX_INSTANCE_BYTES).toBe(50 * 1024 * 1024);
    expect(PIPELINE.bounds).toBeTypeOf("function");
  });
});

describe("bounds stage", () => {
  it("superseded revisions are pruned: one pending row per target, the latest", async () => {
    const h = harness();
    for (let n = 1; n <= 5; n++) commit(h, "e-1", n);
    commit(h, "e-2", 1);
    expect(h.store.pendingOutboxCount()).toBe(6);
    await boundsStage()(h.ctx);
    expect(h.store.outboxFor("delegated", "e-1").map((r) => r.revision)).toEqual([5]);
    expect(h.store.outboxFor("delegated", "e-2").map((r) => r.revision)).toEqual([1]);
  });

  it("an offline live segment stays at one pending row", async () => {
    const h = harness();
    for (let i = 0; i < 30; i++) {
      const at = plus(NOW, i * 61_000);
      h.setNow(at);
      h.journal("PostToolUse", at, 1000 + i * 61);
      segmentationStage(h.ctx);
      await revisionsStage()(h.ctx);
      await boundsStage()(h.ctx);
    }
    expect(h.store.getLastCommitted("segment", h.store.segmentsForSession("s-1")[0]!.id)!.revision).toBe(30);
    expect(h.store.pendingOutboxCount()).toBe(1);
  });

  it("pending-row bound reached ⇒ intake paused + one notice, nothing deleted; resumes below the bound", async () => {
    const h = harness();
    for (let i = 0; i < 5; i++) commit(h, `e-${i}`, 1);
    await boundsStage({ maxPendingRows: 5 })(h.ctx);
    expect(h.store.getMeta(INTAKE_PAUSED_KEY)).toBe(NOW);
    expect(h.store.pendingOutboxCount()).toBe(5);
    expect(h.store.listNotices().map((n) => n.kind)).toEqual(["intake_paused"]);
    await boundsStage({ maxPendingRows: 5 })(h.ctx);
    expect(h.store.listNotices()).toHaveLength(1);

    acknowledge(h.store, h.ctx.generation, { kind: "delegated", id: "e-0" }, 1, h.ctx.now());
    await boundsStage({ maxPendingRows: 5 })(h.ctx);
    expect(h.store.getMeta(INTAKE_PAUSED_KEY)).toBeNull();
  });

  it("quota counts database + journal + fallback files: a fallback directory over the bound pauses intake", async () => {
    const h = harness();
    const base = instanceBytes(h.dir);
    mkdirSync(join(h.dir, FALLBACK_DIR), { recursive: true });
    writeFileSync(join(h.dir, FALLBACK_DIR, "big.json"), Buffer.alloc(10_000));
    await boundsStage({ maxBytes: base + 5000 })(h.ctx);
    expect(h.store.getMeta(INTAKE_PAUSED_KEY)).not.toBeNull();
    expect(instanceBytes(h.dir)).toBeGreaterThanOrEqual(base + 10_000);
  });

  it("while intake is paused, hooks journal nothing and say so once", async () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "data");
    const cfg = pluginConfig(data);
    recordEvent(hookInput("SessionStart", cwd), cfg, Date.now() + 1000); // creates the instance directory
    const store = openStore(join(instanceFor(data), DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
    store.setMeta(INTAKE_PAUSED_KEY, NOW);
    store.addNotice("intake_paused", NOW);
    const before = store.maxEventSeq();
    store.close();

    const first = recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 1000);
    const second = recordEvent(hookInput("PostToolUse", cwd), cfg, Date.now() + 1000);
    expect(first.systemMessage).toMatch(/paused because the local queue reached its size limit/);
    expect(second.systemMessage).toBeUndefined();
    const after = openStore(join(instanceFor(data), DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
    expect(after.maxEventSeq()).toBe(before);
    after.close();
  });

  it("retention: acknowledged data older than 90 days is deleted (then vacuumed), pending and recent data kept", async () => {
    const old = plus(NOW, -RETENTION_MS - DAY);
    const h = harness(old);
    // An old session, segmented, finalised by idle and acknowledged.
    h.journal("UserPromptSubmit", old, 1000, { sessionId: "s-old" });
    segmentationStage(h.ctx);
    h.setNow(plus(old, 60 * 60_000));
    segmentationStage(h.ctx);
    await revisionsStage()(h.ctx);
    const oldSeg = h.store.segmentsForSession("s-old")[0]!;
    expect(oldSeg.final).toBe(true);
    acknowledge(h.store, h.ctx.generation, { kind: "segment", id: oldSeg.id }, oldSeg.lastRevision, h.ctx.now());
    // An old session whose final revision is still pending.
    h.journal("UserPromptSubmit", old, 1000, { sessionId: "s-pending" });
    segmentationStage(h.ctx);
    h.setNow(plus(old, 2 * 60 * 60_000));
    segmentationStage(h.ctx);
    await revisionsStage()(h.ctx);
    // Old terminal item, recent session.
    h.store.addTerminal({ targetKind: "segment", targetId: "x", revision: 1, code: "not_found", at: old, diagnostic: "" });
    h.setNow(NOW);
    h.journal("UserPromptSubmit", NOW, 9_000_000, { sessionId: "s-new" });
    segmentationStage(h.ctx);
    await revisionsStage()(h.ctx);

    await boundsStage()(h.ctx);
    expect(h.store.getMeta(RETENTION_KEY)).toBe(NOW);
    expect(h.store.getSegment(oldSeg.id)).toBeNull();
    expect(h.store.getLastCommitted("segment", oldSeg.id)).toBeNull();
    expect(h.store.getSession("s-old")).toBeNull();
    expect(h.store.eventsAfter(0).map((e) => e.sessionId).sort()).toEqual(["s-new"]);
    expect(h.store.segmentsForSession("s-pending")).toHaveLength(1);
    expect(h.store.segmentsForSession("s-new")).toHaveLength(1);
    expect(h.store.listTerminal()).toEqual([]);
    expect(h.store.freePages()).toBe(0);

    // At most once a day.
    h.setNow(plus(NOW, 60_000));
    await boundsStage()(h.ctx);
    expect(h.store.getMeta(RETENTION_KEY)).toBe(NOW);
  });
});
