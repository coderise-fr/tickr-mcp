import { uptime as osUptime } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_DIR, writeFallback } from "../../hook-src/fallback.js";
import { createAgentApi, OFFLINE_API } from "../../hook-src/flusher/api.js";
import { claimOwnership, guarded, OWNER_STALE_MS, RELEASED_HEARTBEAT } from "../../hook-src/flusher/owner.js";
import { type FlusherDeps, runFlusher } from "../../hook-src/flusher/run.js";
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

/** Fake clocks: sleeping advances the monotonic clock. */
function deps(dir: string, extra: Partial<FlusherDeps> = {}) {
  let mono = 0;
  const sleeps: number[] = [];
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
      return Promise.resolve();
    },
    ...extra,
  };
  return { deps: d, sleeps, advance: (ms: number) => (mono += ms) };
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
    expect(sleeps).toEqual([1000, 1000]);
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

  it("releases at the end of the budget even when work keeps arriving", async () => {
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
