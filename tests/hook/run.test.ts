import { appendFileSync, writeFileSync } from "node:fs";
import { uptime as osUptime } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_DIR, writeFallback } from "../../hook-src/fallback.js";
import { createAgentApi, OFFLINE_API } from "../../hook-src/flusher/api.js";
import { claimOwnership, guarded, OWNER_STALE_MS, RELEASED_HEARTBEAT } from "../../hook-src/flusher/owner.js";
import { REQUEST_TIMEOUT_MS } from "../../hook-src/flusher/api.js";
import {
  type FlusherDeps,
  MAX_SUCCESSOR_DELAY_MS,
  POLL_MS,
  runFlusher,
  SEND_RESERVE_MS,
  SUCCESSOR_MIN_INTERVAL_MS,
} from "../../hook-src/flusher/run.js";
import { AGENT_VERSION_GRACE_MS, writeWorkspace } from "../../hook-src/flusher/sender.js";
import { type FlusherBoundary, STAGE_NAMES, type StageName, type StageRun } from "../../hook-src/flusher/stages.js";
import { ulid } from "../../hook-src/ids.js";
import { recordEvent } from "../../hook-src/intake.js";
import { DB_FILE, type JournalEvent, openStore, type Store } from "../../hook-src/store/db.js";
import { SCHEMA_VERSION } from "../../hook-src/store/schema.js";
import { json, type RecordedRequest, startServer } from "../helpers/httpServer.js";
import { buildChild, startChild } from "./helpers/children.js";
import { cleanTempDirs, count, hookInput, instanceFor, listJson, pluginConfig, rawDb, tempDir, WS, writeMapping } from "./helpers/env.js";
import { journalMapping } from "./helpers/stage.js";

afterEach(() => cleanTempDirs());

function flusherStore(path: string): Store {
  return openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
}

/** An event as a hook journals it (agoMs before now), with the mapping of writeMapping()'s default .tickr.json. */
function event(sessionId = "s-1", agoMs = 0): JournalEvent {
  return {
    eventId: ulid(Date.now()),
    sessionId,
    type: "PostToolUse",
    localTime: new Date(Date.now() - agoMs).toISOString(),
    uptimeS: osUptime(),
    mapping: journalMapping(),
  };
}

/** Fake clocks: sleeping advances the monotonic clock (onSleep runs after each sleep). */
function deps(dir: string, extra: Partial<FlusherDeps> = {}, onSleep: (mono: number) => void = () => undefined) {
  let mono = 0;
  const sleeps: number[] = [];
  const handovers: number[] = [];
  const d: FlusherDeps = {
    now: () => new Date(),
    uptime: () => 1000,
    api: OFFLINE_API,
    config: pluginConfig(dir),
    wakeBudgetMs: 60_000,
    clock: () => mono,
    sleep: (ms) => {
      sleeps.push(ms);
      mono += ms;
      onSleep(mono);
      return Promise.resolve();
    },
    handover: (ms) => void handovers.push(ms),
    ...extra,
  };
  return { deps: d, sleeps, handovers, advance: (ms: number) => (mono += ms), mono: () => mono };
}

const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);

/** A user line of a transcript, with the Claude Code version that wrote it. */
function versionLine(sessionId: string, at: Date, version = "2.1.300"): string {
  return `${JSON.stringify({ type: "user", timestamp: at.toISOString(), sessionId, version, message: { role: "user", content: "<redacted>" } })}\n`;
}

describe("runFlusher", () => {
  it("creates and migrates the store, imports the fallback files, runs the stages in order and releases the instance", async () => {
    const dir = tempDir();
    const first = event();
    writeFallback(join(dir, FALLBACK_DIR), first);
    const order: string[] = [];
    const seenByStages: number[] = [];
    const stages = Object.fromEntries(
      STAGE_NAMES.map((name) => [
        name,
        ((ctx) => {
          order.push(name);
          seenByStages.push(ctx.store.maxEventSeq());
          return {};
        }) satisfies StageRun,
      ]),
    );
    const boundaries: FlusherBoundary[] = [];
    const { deps: d } = deps(dir, { stages, onBoundary: (b) => boundaries.push(b) });

    expect(await runFlusher(dir, d)).toBe("done");
    expect(order).toEqual(["workspace", "segmentation", "ledger", "revisions", "send", "bounds"]);
    expect(seenByStages.every((seq) => seq > 0)).toBe(true);
    expect(boundaries).toEqual([
      "claimed",
      "fallback_committed",
      "stage:workspace",
      "stage:segmentation",
      "stage:ledger",
      "stage:revisions",
      "stage:send",
      "stage:bounds",
      "released",
    ]);
    const store = flusherStore(join(dir, DB_FILE));
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.eventsAfter(0).map((e) => e.eventId)).toEqual([first.eventId]);
    expect(store.readOwner()).toMatchObject({ generation: 1, heartbeat: RELEASED_HEARTBEAT });
    expect(listJson(join(dir, FALLBACK_DIR))).toEqual([]);
    store.close();
  });

  it("nothing left to do ⇒ released without a successor", async () => {
    const dir = tempDir();
    const { deps: d, handovers } = deps(dir);
    expect(await runFlusher(dir, d)).toBe("done");
    expect(handovers).toEqual([]);
  });

  it("gives every stage a context bound to its generation", async () => {
    const dir = tempDir();
    const { deps: d } = deps(dir, {
      stages: {
        revisions: (ctx) => {
          expect(ctx.generation).toBe(1);
          expect(ctx.instanceDir).toBe(dir);
          expect(ctx.api).toBe(OFFLINE_API);
          expect(ctx.remainingMs()).toBe(60_000);
          ctx.guarded(() => ctx.store.setMeta("by-stage", "1"));
          return {};
        },
      },
    });
    expect(await runFlusher(dir, d)).toBe("done");
    const store = flusherStore(join(dir, DB_FILE));
    expect(store.getMeta("by-stage")).toBe("1");
    store.close();
  });

  it("waits for a stage due within the budget and runs another pass; exits once nothing is due within the budget", async () => {
    const dir = tempDir();
    let passes = 0;
    const { deps: d, sleeps } = deps(dir, {
      wakeBudgetMs: 2500,
      stages: { send: () => (passes++, { dueInMs: 1000 }) },
    });
    expect(await runFlusher(dir, d)).toBe("done");
    expect(passes).toBe(3);
    // Each wait is slept in slices of at most POLL_MS, watching for new work.
    expect(sum(sleeps)).toBe(2000);
    expect(sleeps.every((ms) => ms > 0 && ms <= POLL_MS)).toBe(true);
  });

  it("a sleeping flusher wakes within a poll slice when a hook journals an event", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    const passAt: number[] = [];
    let journalled = false;
    const c = deps(dir, {}, (mono) => {
      if (journalled || mono < 2500) return;
      // Stop arrives 2.5 s into a 58 s wait; its hook saw a fresh heartbeat and started nobody.
      journalled = true;
      const hook = flusherStore(path);
      hook.journal(event());
      hook.close();
    });
    c.deps.stages = { segmentation: () => (passAt.push(c.mono()), passAt.length === 1 ? { dueInMs: 58_000 } : {}) };
    expect(await runFlusher(dir, c.deps)).toBe("done");
    expect(passAt).toHaveLength(2);
    expect(passAt[1]!).toBeGreaterThanOrEqual(2500);
    expect(passAt[1]!).toBeLessThanOrEqual(2500 + POLL_MS);
    expect(c.handovers).toEqual([]);
  });

  it("a sleeping flusher wakes within a poll slice when a fallback file appears", async () => {
    const dir = tempDir();
    const passAt: number[] = [];
    let written = false;
    const c = deps(dir, {}, (mono) => {
      if (written || mono < 1000) return;
      written = true;
      writeFallback(join(dir, FALLBACK_DIR), event());
    });
    c.deps.stages = { segmentation: () => (passAt.push(c.mono()), passAt.length === 1 ? { dueInMs: 58_000 } : {}) };
    expect(await runFlusher(dir, c.deps)).toBe("done");
    expect(passAt).toHaveLength(2);
    expect(passAt[1]!).toBeLessThanOrEqual(1000 + POLL_MS);
    expect(listJson(join(dir, FALLBACK_DIR))).toEqual([]);
  });

  it("a wait with no new work sleeps the whole due time, then runs the pass", async () => {
    const dir = tempDir();
    const passAt: number[] = [];
    const c = deps(dir);
    c.deps.stages = { segmentation: () => (passAt.push(c.mono()), passAt.length === 1 ? { dueInMs: 58_000 } : {}) };
    expect(await runFlusher(dir, c.deps)).toBe("done");
    expect(passAt).toEqual([0, 58_000]);
  });

  it("keeps the instance for one more pass when an event arrived during the pass", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    let passes = 0;
    const { deps: d } = deps(dir, {
      stages: {
        segmentation: () => {
          passes += 1;
          if (passes === 1) {
            // A hook journals an event meanwhile; it saw a fresh heartbeat and started no flusher.
            const hook = flusherStore(path);
            hook.journal(event());
            hook.close();
          }
          return {};
        },
      },
    });
    expect(await runFlusher(dir, d)).toBe("done");
    expect(passes).toBe(2);
  });

  it("releases at the end of the budget even when work keeps arriving, and hands it over to a successor", async () => {
    const dir = tempDir();
    let passes = 0;
    const clock = deps(dir);
    const { deps: d } = clock;
    d.wakeBudgetMs = 1000;
    d.stages = {
      bounds: () => {
        passes += 1;
        writeFallback(join(dir, FALLBACK_DIR), event());
        clock.advance(400);
        return {};
      },
    };
    expect(await runFlusher(dir, d)).toBe("done");
    expect(passes).toBe(3);
    // The successor starts at once, but never sooner than SUCCESSOR_MIN_INTERVAL_MS after this one.
    expect(clock.handovers).toEqual([SUCCESSOR_MIN_INTERVAL_MS - 1200]);
    const store = flusherStore(join(dir, DB_FILE));
    expect(store.readOwner()!.heartbeat).toBe(RELEASED_HEARTBEAT);
    store.close();
  });

  it("a stage cut short by the budget hands the rest over to a successor (no wait for a hook)", async () => {
    const dir = tempDir();
    const clock = deps(dir);
    clock.deps.stages = { segmentation: () => (clock.advance(60_000), { dueInMs: 0 }) };
    expect(await runFlusher(dir, clock.deps)).toBe("done");
    expect(clock.handovers).toEqual([0]);
  });

  it("a send retry due after the budget is handed over to a successor started that much later", async () => {
    const dir = tempDir();
    const { deps: d, handovers, sleeps } = deps(dir, { stages: { send: () => ({ dueInMs: 90_000 }) } });
    expect(await runFlusher(dir, d)).toBe("done");
    expect(sleeps).toEqual([]);
    expect(handovers).toEqual([90_000]);
  });

  it("a send retry further away than MAX_SUCCESSOR_DELAY_MS, or a later non-send due, is left to the next hook", async () => {
    const farDir = tempDir();
    const far = deps(farDir, { stages: { send: () => ({ dueInMs: MAX_SUCCESSOR_DELAY_MS + 1 }) } });
    expect(await runFlusher(farDir, far.deps)).toBe("done");
    expect(far.handovers).toEqual([]);
    const refreshDir = tempDir();
    const refresh = deps(refreshDir, { stages: { revisions: () => ({ dueInMs: 90_000 }) } });
    expect(await runFlusher(refreshDir, refresh.deps)).toBe("done");
    expect(refresh.handovers).toEqual([]);
  });

  it("a successor waits its start delay before it opens the store", async () => {
    const dir = tempDir();
    const order: string[] = [];
    const c = deps(dir, { startDelayMs: 3000, onBoundary: (b) => order.push(`${b}@${c.mono()}`) });
    expect(await runFlusher(dir, c.deps)).toBe("done");
    expect(c.sleeps[0]).toBe(3000);
    expect(order[0]).toBe("claimed@3000");
  });

  it("the send stage of a pass that committed revisions gets at least one request, once per run, and the run ends", async () => {
    const dir = tempDir();
    const c = deps(dir);
    c.deps.wakeBudgetMs = 3000;
    const seen: number[] = [];
    let passes = 0;
    c.deps.stages = {
      revisions: (ctx) => {
        passes += 1;
        c.advance(100);
        ctx.guarded(() => writeWorkspace(ctx.store, { workspaceId: WS, workspaceName: "Acme", checkedAt: new Date().toISOString(), skewMs: 0 }));
        ctx.boundary("revision_committed");
        return {};
      },
      send: (ctx) => {
        seen.push(ctx.remainingMs());
        if (ctx.remainingMs() < REQUEST_TIMEOUT_MS) return { dueInMs: 0, outOfBudget: true };
        c.advance(1000);
        return { dueInMs: 0 };
      },
    };
    expect(await runFlusher(dir, c.deps)).toBe("done");
    // Pass 1: 2.9 s left after the commit, below one request: extended to SEND_RESERVE_MS. Pass 2:
    // no second extension; the starved send ends the run and hands the rest over.
    expect(SEND_RESERVE_MS).toBeGreaterThanOrEqual(REQUEST_TIMEOUT_MS);
    expect(seen).toEqual([SEND_RESERVE_MS, SEND_RESERVE_MS - 1000 - 100]);
    expect(passes).toBe(2);
    expect(c.handovers).toEqual([SUCCESSOR_MIN_INTERVAL_MS - 1200]);
  });

  it("no revision committed in the pass, or an instance that cannot send ⇒ the send stage gets no extension", async () => {
    const dir = tempDir();
    const c = deps(dir);
    c.deps.wakeBudgetMs = 1000;
    const seen: number[] = [];
    c.deps.stages = { send: (ctx) => (seen.push(ctx.remainingMs()), {}) };
    expect(await runFlusher(dir, c.deps)).toBe("done");
    expect(seen).toEqual([1000]);

    const offline = tempDir();
    const o = deps(offline);
    o.deps.wakeBudgetMs = 1000;
    const offlineSeen: number[] = [];
    o.deps.stages = { revisions: (ctx) => (ctx.boundary("revision_committed"), {}), send: (ctx) => (offlineSeen.push(ctx.remainingMs()), {}) };
    expect(await runFlusher(offline, o.deps)).toBe("done"); // no workspace check yet: nothing can be sent
    expect(offlineSeen).toEqual([1000]);
  });

  it("a halting stage skips the later stages of the pass", async () => {
    const dir = tempDir();
    const ran: StageName[] = [];
    const record = (name: StageName, halt = false): StageRun => () => (ran.push(name), { halt });
    const { deps: d } = deps(dir, {
      stages: { workspace: record("workspace", true), segmentation: record("segmentation"), send: record("send") },
    });
    expect(await runFlusher(dir, d)).toBe("done");
    expect(ran).toEqual(["workspace"]);
  });

  it("another live flusher ⇒ not_owner, nothing run", async () => {
    const dir = tempDir();
    const other = flusherStore(join(dir, DB_FILE));
    claimOwnership(other, 1, new Date().toISOString());
    let ran = false;
    const { deps: d } = deps(dir, { stages: { workspace: () => ((ran = true), {}) } });
    expect(await runFlusher(dir, d)).toBe("not_owner");
    expect(ran).toBe(false);
    expect(other.readOwner()!.generation).toBe(1);
    other.close();
  });

  it("a store migrated by newer code ⇒ newer_schema, nothing written", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    flusherStore(path).close();
    const db = rawDb(path);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);
    writeFallback(join(dir, FALLBACK_DIR), event());
    const { deps: d } = deps(dir);
    expect(await runFlusher(dir, d)).toBe("newer_schema");
    expect(count(db, "owner")).toBe(0);
    expect(count(db, "events")).toBe(0);
    expect(listJson(join(dir, FALLBACK_DIR))).toHaveLength(1);
    db.close();
  });

  it("a takeover during a stage ends the run without further writes (lost_ownership)", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    const { deps: d } = deps(dir, {
      stages: {
        segmentation: (ctx) => {
          const thief = flusherStore(path);
          thief.setOwnerHeartbeat(ctx.generation, "2000-01-01T00:00:00.000Z");
          claimOwnership(thief, 2, new Date().toISOString());
          thief.close();
          ctx.guarded(() => ctx.store.setMeta("after-takeover", "1"));
          return {};
        },
      },
    });
    expect(await runFlusher(dir, d)).toBe("lost_ownership");
    const store = flusherStore(path);
    expect(store.getMeta("after-takeover")).toBeNull();
    expect(store.readOwner()!.generation).toBe(2);
    store.close();
  });
});

describe("flusher processes", () => {
  let harness: ReturnType<typeof buildChild>;
  let bundle: string;
  beforeAll(() => {
    harness = buildChild();
    bundle = harness.path;
  });
  afterAll(() => harness.remove());

  it("two flushers started together ⇒ one claims, the other exits", async () => {
    const dir = tempDir();
    flusherStore(join(dir, DB_FILE)).close();
    const opts = JSON.stringify({ holdStage: "segmentation", holdMs: 3000 });
    const children = [startChild(bundle, ["flush", dir, opts]), startChild(bundle, ["flush", dir, opts])];
    const outcomes = await Promise.all(children.map((c) => c.waitFor(/^outcome /, 20_000)));
    expect(outcomes.sort()).toEqual(["outcome done", "outcome not_owner"]);
    await Promise.all(children.map((c) => c.exited));
    const db = rawDb(join(dir, DB_FILE));
    expect((db.prepare("SELECT generation FROM owner").get() as { generation: number }).generation).toBe(1);
    db.close();
  });

  async function until<T>(probe: () => T | undefined, timeoutMs = 15_000): Promise<T> {
    const end = Date.now() + timeoutMs;
    for (;;) {
      let value: T | undefined;
      try {
        value = probe();
      } catch {
        value = undefined; // locked by a flusher for a moment
      }
      if (value !== undefined) return value;
      if (Date.now() > end) throw new Error("condition not met in time");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("a flusher process sleeping until a stage is due wakes within about a second when a hook journals an event", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    flusherStore(path).close();
    const child = startChild(bundle, ["flush", dir, JSON.stringify({ firstDueInMs: 25_000 })]);
    try {
      await child.waitFor(/^at stage:bounds$/);
      // A Stop hook journals meanwhile; it sees a fresh heartbeat and starts no flusher.
      const journalled = performance.now();
      const hook = flusherStore(path);
      hook.journal(event("s-stop"));
      hook.close();
      expect(await child.waitFor(/^outcome /, 10_000)).toBe("outcome done");
      expect(performance.now() - journalled).toBeLessThan(3000);
      expect(child.lines.filter((l) => l === "at stage:bounds")).toHaveLength(2);
      const after = flusherStore(path);
      expect(after.pendingEventSessions()).toEqual([]);
      expect(after.segmentsForSession("s-stop")).toHaveLength(1);
      after.close();
    } finally {
      await child.kill();
    }
  });

  it("a flusher process whose budget ran out with work left behind starts a successor that does it", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    flusherStore(path).close();
    const child = startChild(bundle, ["flush", dir, JSON.stringify({ wakeBudgetMs: 1000, holdStage: "bounds", holdMs: 1500, handover: true })]);
    await child.waitFor(/^holding$/);
    // SessionEnd journals while the budget runs out; its hook saw a fresh heartbeat.
    const hook = flusherStore(path);
    hook.journal(event("s-end"));
    hook.close();
    const handover = await child.waitFor(/^handover /);
    expect(Number(handover.split(" ")[1])).toBeLessThanOrEqual(SUCCESSOR_MIN_INTERVAL_MS);
    expect(await child.waitFor(/^outcome /)).toBe("outcome done");
    await child.exited;

    // The successor (detached, the same harness without options) waits its delay, claims the
    // instance (generation 2), segments the event and releases.
    await until(() => {
      const db = rawDb(path);
      try {
        const owner = db.prepare("SELECT generation, heartbeat FROM owner").get() as { generation: number; heartbeat: string };
        return owner.generation === 2 && owner.heartbeat === RELEASED_HEARTBEAT ? true : undefined;
      } finally {
        db.close();
      }
    });
    const after = flusherStore(path);
    expect(after.pendingEventSessions()).toEqual([]);
    expect(after.segmentsForSession("s-end")).toHaveLength(1);
    after.close();
  });

  const BOUNDARIES: FlusherBoundary[] = [
    "claimed",
    "fallback_committed",
    "stage:workspace",
    "stage:segmentation",
    "stage:ledger",
    "revision_committed",
    "stage:revisions",
    "sent",
    "acknowledged",
    "stage:send",
    "stage:bounds",
  ];

  /** A local Tickr: /me names the workspace, every segment PUT is applied (201 the first time). */
  async function tickr() {
    const seen = new Set<string>();
    return startServer((req: RecordedRequest) => {
      if (req.url === "/api/v1/me") {
        return json(200, { user: { id: "u", displayName: "D", email: "d@example.test", timezone: "UTC" }, workspace: { id: WS, name: "Acme", timezone: "UTC" }, role: "workspace_user", serverTime: new Date().toISOString() });
      }
      const created = !seen.has(req.url);
      seen.add(req.url);
      return json(created ? 201 : 200, { id: "e", agentFinalized: false, agentDetached: false });
    });
  }

  it.each(["event insert", ...BOUNDARIES])(
    "crash at each boundary (event insert, revision commit, send, ack) ⇒ one segment, nothing lost: killed at %s",
    async (point) => {
      const server = await tickr();
      try {
        const root = tempDir();
        const cwd = writeMapping(join(root, "repo"));
        const data = join(root, "data");
        const cfg = pluginConfig(data);
        const dir = instanceFor(data);
        const path = join(dir, DB_FILE);
        // Events 10 minutes old: the segments are open and not working, so their desired bodies
        // do not change between the killed flusher and the one that takes over 3 minutes later.
        const store = flusherStore(path);
        store.journal(event("s-1", 10 * 60_000));
        store.journal(event("s-1", 10 * 60_000));
        store.close();
        for (let i = 0; i < 3; i++) writeFallback(join(dir, FALLBACK_DIR), event("s-fallback", 10 * 60_000));

        if (point === "event insert") {
          const hook = startChild(bundle, ["hold-insert", path]);
          await hook.waitFor(/^holding$/);
          await hook.kill();
        } else {
          const flusher = startChild(bundle, ["flush", dir, JSON.stringify({ crashAt: point, baseUrl: server.baseUrl })]);
          expect(await flusher.waitFor(new RegExp(`^at ${point}$`))).toBe(`at ${point}`);
          expect(await flusher.exited).not.toBe(0);
          expect(flusher.lines.some((l) => l.startsWith("outcome"))).toBe(false);
        }
        const sentBeforeTakeover = server.requests.filter((r) => r.method === "PUT").length;

        // The next hook is not blocked and journals in the store.
        const started = performance.now();
        recordEvent(hookInput("PostToolUse", cwd, { session_id: "s-hook" }), cfg, Date.now() + 1000);
        expect(performance.now() - started).toBeLessThan(800);

        // A new flusher takes the dead one's instance over once its heartbeat is stale.
        const api = createAgentApi({ baseUrl: server.baseUrl, apiKey: cfg.apiKey, timeoutMs: 3000 });
        const later = deps(dir, { api, now: () => new Date(Date.now() + OWNER_STALE_MS + 60_000) });
        expect(await runFlusher(dir, later.deps)).toBe("done");

        const after = flusherStore(path);
        try {
          const ids = after.eventsAfter(0).map((e) => e.eventId);
          expect(ids).toHaveLength(2 + 3 + 1);
          expect(new Set(ids).size).toBe(ids.length);
          expect(after.eventsAfter(0).some((e) => e.sessionId === "s-killed")).toBe(false);
          expect(listJson(join(dir, FALLBACK_DIR))).toEqual([]);
          expect(after.readOwner()!.heartbeat).toBe(RELEASED_HEARTBEAT);
          expect(after.pendingEventSessions()).toEqual([]);
          expect(after.pendingOutboxCount()).toBe(0);

          // One segment per session, its last committed revision delivered; a revision sent twice
          // (killed between the answer and its acknowledgement) is the same bytes both times.
          const puts = server.requests.filter((r) => r.method === "PUT");
          const bodies = new Map<string, Set<string>>();
          for (const r of puts) {
            const key = `${r.url}#${String(JSON.parse(r.body).revision)}`;
            bodies.set(key, (bodies.get(key) ?? new Set()).add(r.body));
          }
          for (const variants of bodies.values()) expect(variants.size).toBe(1);
          for (const session of ["s-1", "s-fallback", "s-hook"]) {
            const segments = after.segmentsForSession(session);
            expect(segments).toHaveLength(1);
            const last = after.getLastCommitted("segment", segments[0]!.id)!;
            expect(segments[0]!.lastRevision).toBe(last.revision);
            expect(segments[0]!.createdOnServer).toBe(true);
            expect(puts.some((r) => r.url === `/api/v1/agent-segments/${segments[0]!.id}` && r.body === last.bodyJson)).toBe(true);
          }
          if (point === "sent") {
            expect(sentBeforeTakeover).toBe(1);
            expect(puts.length).toBeGreaterThan(bodies.size); // the unacknowledged revision was replayed
          }
        } finally {
          after.close();
        }
      } finally {
        await server.close();
      }
    },
  );

  it("Stop and SessionEnd of a short session are delivered within a poll slice, final revision included", async () => {
    // The hooks of one short session run one after another: SessionStart and UserPromptSubmit,
    // PostToolUse 2.5 s later, Stop 2.5 s later, SessionEnd 1.5 s later. The flusher started by
    // PostToolUse waits ~57.5 s for the lease refresh; Stop sees its fresh heartbeat and starts
    // nobody. One fake clock drives the wall clock, the uptime and the budget.
    let mono = 0;
    const base = Date.now();
    const now = () => new Date(base + mono);
    const uptime = () => 1000 + mono / 1000;
    const finals: number[] = [];
    const stops: number[] = [];
    const seen = new Set<string>();
    const server = await startServer((req: RecordedRequest) => {
      if (req.url === "/api/v1/me") {
        return json(200, { user: { id: "u", displayName: "D", email: "d@example.test", timezone: "UTC" }, workspace: { id: WS, name: "Acme", timezone: "UTC" }, role: "workspace_user", serverTime: now().toISOString() });
      }
      if (req.method === "PUT") {
        const body = JSON.parse(req.body) as { final?: boolean; working?: boolean };
        if (body.final === true) finals.push(mono);
        else if (body.working === false) stops.push(mono);
      }
      const created = !seen.has(req.url);
      seen.add(req.url);
      return json(created ? 201 : 200, { id: "e", agentFinalized: false, agentDetached: false });
    });
    try {
      const root = tempDir();
      const cwd = writeMapping(join(root, "repo"));
      const data = join(root, "data");
      const cfg = pluginConfig(data);
      const dir = instanceFor(data);
      const api = createAgentApi({ baseUrl: server.baseUrl, apiKey: cfg.apiKey, timeoutMs: 3000 });
      // The transcript names the Claude Code version from the start: no creation waits for it.
      const transcript = join(root, "s-live.jsonl");
      writeFileSync(transcript, versionLine("s-live", now()));
      // A hook that sees no fresh owner starts a flusher: it runs once the current one is done.
      let toStart = 0;
      const at: Record<string, number> = {};
      const fire = (name: string) => {
        at[name] = mono;
        const input = hookInput(name, cwd, { session_id: "s-live", transcript_path: transcript });
        recordEvent(input, cfg, Date.now() + 1000, { now, uptime, startFlusher: () => void (toStart += 1) });
      };
      const later = [
        { after: 2500, name: "PostToolUse" },
        { after: 5000, name: "Stop" },
        { after: 6500, name: "SessionEnd" },
      ];
      // The hooks due by now fire while a flusher sleeps.
      const fireDue = () => {
        while (later.length > 0 && mono >= later[0]!.after) fire(later.shift()!.name);
      };
      const run = () =>
        runFlusher(dir, {
          now,
          uptime,
          api,
          config: cfg,
          wakeBudgetMs: 60_000,
          clock: () => mono,
          sleep: (ms) => {
            mono += ms;
            fireDue();
            return Promise.resolve();
          },
        });

      fire("SessionStart");
      fire("UserPromptSubmit");
      const flushersAt: number[] = [];
      while (toStart > 0 || later.length > 0) {
        if (toStart === 0) {
          mono = Math.max(mono, later[0]!.after); // nobody runs: the clock jumps to the next hook
          fireDue();
          continue;
        }
        toStart -= 1;
        flushersAt.push(mono);
        expect(await run()).toBe("done");
      }

      // Stop was handled by the sleeping owner within a poll slice (no flusher started for it);
      // the SessionEnd that came after its release started one, which delivered the final revision.
      expect(flushersAt).not.toContain(at.Stop);
      expect(stops[0]! - at.Stop!).toBeLessThanOrEqual(POLL_MS);
      expect(finals).toHaveLength(1);
      expect(finals[0]! - at.SessionEnd!).toBeLessThanOrEqual(POLL_MS);
      expect(mono).toBeLessThan(10_000); // not the 57.5 s of the refresh wait
      const store = flusherStore(join(dir, DB_FILE));
      try {
        expect(store.pendingOutboxCount()).toBe(0);
        const segments = store.segmentsForSession("s-live");
        expect(segments).toHaveLength(1);
        expect(segments[0]).toMatchObject({ final: true, createdOnServer: true });
        const last = store.getLastCommitted("segment", segments[0]!.id)!;
        expect(JSON.parse(last.bodyJson)).toMatchObject({ final: true, working: false });
        expect((JSON.parse(last.bodyJson) as { usageQuality: string }).usageQuality).not.toBe("pending");
        expect(server.requests.some((r) => r.method === "PUT" && r.body === last.bodyJson)).toBe(true);
      } finally {
        store.close();
      }
    } finally {
      await server.close();
    }
  });

  it("guarded writes of a killed flusher never reach the store (killed inside a transaction)", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    const store = flusherStore(path);
    const gen = claimOwnership(store, 1, new Date().toISOString())!;
    guarded(store, gen, new Date().toISOString(), () => store.journal(event()));
    store.close();
    const hook = startChild(bundle, ["hold-insert", path]);
    await hook.waitFor(/^holding$/);
    await hook.kill();
    const reopened = flusherStore(path);
    expect(reopened.eventsAfter(0)).toHaveLength(1);
    reopened.close();
  });
});

describe("a segment's creation waiting for the agent version (hooks, ledger and sender together)", () => {
  /**
   * One session driven by hooks with fake clocks: the transcript is empty until `withVersion()`
   * appends a line with the Claude Code version. Every PUT is recorded with its time.
   */
  async function rig() {
    let mono = 0;
    const base = Date.now();
    const now = () => new Date(base + mono);
    const puts: { at: number; agent: string; revision: number; final: boolean }[] = [];
    const seen = new Set<string>();
    const server = await startServer((req: RecordedRequest) => {
      if (req.url === "/api/v1/me") {
        return json(200, { user: { id: "u", displayName: "D", email: "d@example.test", timezone: "UTC" }, workspace: { id: WS, name: "Acme", timezone: "UTC" }, role: "workspace_user", serverTime: now().toISOString() });
      }
      const body = JSON.parse(req.body) as { revision: number; final: boolean };
      puts.push({ at: mono, agent: String(req.headers["tickr-agent"]), revision: body.revision, final: body.final });
      const created = !seen.has(req.url);
      seen.add(req.url);
      return json(created ? 201 : 200, { id: "e", agentFinalized: false, agentDetached: false });
    });
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const cfg = pluginConfig(join(root, "data"));
    const dir = instanceFor(cfg.dataDir);
    const transcript = join(root, "s-v.jsonl");
    writeFileSync(transcript, "");
    const api = createAgentApi({ baseUrl: server.baseUrl, apiKey: cfg.apiKey, timeoutMs: 3000 });
    const started = { flushers: 0 };
    let onSleep: (mono: number) => void = () => undefined;
    const handovers: number[] = [];
    return {
      puts,
      handovers,
      started,
      close: () => server.close(),
      setMono: (ms: number) => (mono = ms),
      mono: () => mono,
      finals: () => puts.filter((p) => p.final).length,
      onSleep: (fn: (mono: number) => void) => (onSleep = fn),
      withVersion: () => appendFileSync(transcript, versionLine("s-v", now())),
      fire: (name: string) =>
        recordEvent(hookInput(name, cwd, { session_id: "s-v", transcript_path: transcript }), cfg, Date.now() + 1000, {
          now,
          uptime: () => 1000 + mono / 1000,
          startFlusher: () => void (started.flushers += 1),
        }),
      /** Runs one flusher; returns how many passes it ran. */
      run: async () => {
        let passes = 0;
        const outcome = await runFlusher(dir, {
          now,
          uptime: () => 1000 + mono / 1000,
          api,
          config: cfg,
          wakeBudgetMs: 60_000,
          clock: () => mono,
          sleep: (ms) => {
            mono += ms;
            onSleep(mono);
            return Promise.resolve();
          },
          handover: (ms) => void handovers.push(ms),
          debug: (rec) => void (rec.step === "pass" && (passes += 1)),
        });
        expect(outcome).toBe("done");
        return passes;
      },
    };
  }

  it("held while the version is unknown (one pass, a successor at the end of the grace), then sent with the version the next event brings", async () => {
    const r = await rig();
    try {
      r.fire("SessionStart");
      r.fire("UserPromptSubmit");
      expect(await r.run()).toBe(1);
      expect(r.puts).toEqual([]);
      expect(r.handovers).toEqual([AGENT_VERSION_GRACE_MS]);

      // PostToolUse 20 s later: the transcript now names the version; the flusher it starts sends.
      r.setMono(20_000);
      r.withVersion();
      const before = r.started.flushers;
      r.fire("PostToolUse");
      expect(r.started.flushers).toBe(before + 1); // the instance was released: its hook starts one
      expect(await r.run()).toBeLessThanOrEqual(4);
      expect(r.puts[0]).toEqual({ at: 20_000, agent: "claude-code/2.1.300", revision: 1, final: false });

      // Stop and SessionEnd: the final revision goes, every request names the version.
      for (const [name, at] of [["Stop", 90_000], ["SessionEnd", 100_000]] as const) {
        r.setMono(Math.max(at, r.mono()));
        r.fire(name);
        await r.run();
      }
      expect(r.finals()).toBe(1);
      expect(r.puts.length).toBeGreaterThan(1);
      expect(r.puts.every((p) => p.agent === "claude-code/2.1.300")).toBe(true);
    } finally {
      await r.close();
    }
  });

  it("no version ever: the successor at the end of the grace sends the creation with claude-code/unknown", async () => {
    const r = await rig();
    try {
      r.fire("UserPromptSubmit");
      expect(await r.run()).toBe(1);
      r.setMono(r.handovers[0]!);
      expect(await r.run()).toBeLessThanOrEqual(3);
      expect(r.puts[0]).toEqual({ at: AGENT_VERSION_GRACE_MS, agent: "claude-code/unknown", revision: 1, final: false });
    } finally {
      await r.close();
    }
  });

  it("a flusher waiting out the rest of the grace wakes within a poll slice when the event that brings the version arrives", async () => {
    const r = await rig();
    try {
      r.fire("UserPromptSubmit");
      r.setMono(70_000); // its flusher starts late: 50 s of grace left, within the budget
      let fired = false;
      r.onSleep((mono) => {
        if (fired || mono < 80_000) return;
        fired = true;
        r.withVersion();
        r.fire("PostToolUse"); // sees the sleeping owner's fresh heartbeat: starts nobody
      });
      const passes = await r.run();
      expect(passes).toBeLessThanOrEqual(5);
      expect(r.started.flushers).toBe(1);
      expect(r.puts[0]!.agent).toBe("claude-code/2.1.300");
      expect(r.puts[0]!.revision).toBe(1);
      expect(r.puts[0]!.at - 80_000).toBeLessThanOrEqual(POLL_MS);
    } finally {
      await r.close();
    }
  });
});
