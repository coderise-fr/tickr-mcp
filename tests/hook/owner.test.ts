import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_DIR, writeFallback } from "../../hook-src/fallback.js";
import {
  claimOwnership,
  guarded,
  isOwnerFresh,
  LostOwnership,
  OWNER_STALE_MS,
  RELEASED_HEARTBEAT,
  releaseOwnership,
} from "../../hook-src/flusher/owner.js";
import { ulid } from "../../hook-src/ids.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import { migrate, MIGRATIONS, SCHEMA_VERSION, userVersion } from "../../hook-src/store/schema.js";
import { buildChild, startChild } from "./helpers/children.js";
import { cleanTempDirs, count, listJson, rawDb, tempDir } from "./helpers/env.js";

afterEach(() => cleanTempDirs());

const T0 = new Date("2026-11-05T10:00:00.000Z");
const at = (ms: number) => new Date(T0.getTime() + ms).toISOString();

function stores(n: number): { path: string; list: Store[] } {
  const path = join(tempDir(), DB_FILE);
  const list = Array.from({ length: n }, () => openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store);
  return { path, list };
}

describe("claimOwnership", () => {
  it("the first claim gets generation 1; a second one while the heartbeat is fresh gets null", () => {
    const { list: [a, b] } = stores(2);
    expect(claimOwnership(a!, 101, at(0))).toBe(1);
    expect(claimOwnership(b!, 102, at(1000))).toBeNull();
    expect(a!.readOwner()).toEqual({ generation: 1, pid: 101, heartbeat: at(0) });
    a!.close();
    b!.close();
  });

  it("stale heartbeat (> 2 min) is taken over", () => {
    const { list: [a, b] } = stores(2);
    claimOwnership(a!, 101, at(0));
    expect(claimOwnership(b!, 102, at(OWNER_STALE_MS - 1000))).toBeNull();
    expect(claimOwnership(b!, 102, at(OWNER_STALE_MS + 1000))).toBe(2);
    expect(b!.readOwner()).toEqual({ generation: 2, pid: 102, heartbeat: at(OWNER_STALE_MS + 1000) });
    a!.close();
    b!.close();
  });

  it("a heartbeat far in the future (the clock moved back) is taken over too", () => {
    const { list: [a, b] } = stores(2);
    claimOwnership(a!, 101, at(3_600_000));
    expect(claimOwnership(b!, 102, at(0))).toBe(2);
    a!.close();
    b!.close();
  });

  it("a released instance is claimed at once", () => {
    const { list: [a, b] } = stores(2);
    const gen = claimOwnership(a!, 101, at(0))!;
    expect(releaseOwnership(a!, gen, at(1000), () => true)).toBe(true);
    expect(a!.readOwner()!.heartbeat).toBe(RELEASED_HEARTBEAT);
    expect(isOwnerFresh(a!.readOwner(), new Date(at(2000)))).toBe(false);
    expect(claimOwnership(b!, 102, at(2000))).toBe(2);
    a!.close();
    b!.close();
  });

  it("release keeps ownership when work arrived during the pass", () => {
    const { list: [a] } = stores(1);
    const gen = claimOwnership(a!, 101, at(0))!;
    expect(releaseOwnership(a!, gen, at(1000), () => false)).toBe(false);
    expect(a!.readOwner()).toEqual({ generation: 1, pid: 101, heartbeat: at(1000) });
    a!.close();
  });
});

describe("guarded", () => {
  it("refreshes the heartbeat and commits fn", () => {
    const { list: [a] } = stores(1);
    const gen = claimOwnership(a!, 101, at(0))!;
    expect(guarded(a!, gen, at(5000), () => (a!.setMeta("k", "v"), 42))).toBe(42);
    expect(a!.readOwner()!.heartbeat).toBe(at(5000));
    expect(a!.getMeta("k")).toBe("v");
    a!.close();
  });

  it("rolls back and throws LostOwnership once another generation owns the instance", () => {
    const { list: [a, b] } = stores(2);
    const old = claimOwnership(a!, 101, at(0))!;
    const current = claimOwnership(b!, 102, at(OWNER_STALE_MS + 1))!;
    let ran = false;
    expect(() => guarded(a!, old, at(OWNER_STALE_MS + 2), () => (ran = true))).toThrow(LostOwnership);
    expect(ran).toBe(false);
    expect(b!.readOwner()).toEqual({ generation: current, pid: 102, heartbeat: at(OWNER_STALE_MS + 1) });
    a!.close();
    b!.close();
  });

  it("old flusher suspended after commit and before HTTP, new one takes over, old one wakes ⇒ its send is a replay of a committed revision and its ack fails the generation check", () => {
    const { list: [old, fresh] } = stores(2);
    const body = JSON.stringify({ revision: 1, startedAt: at(0), stoppedAt: at(60_000), working: true });

    // Old flusher: commits revision 1 with its full body, then is suspended before the request.
    const g1 = claimOwnership(old!, 101, at(0))!;
    guarded(old!, g1, at(1000), () =>
      old!.insertOutbox({ targetKind: "segment", targetId: "seg-1", revision: 1, bodyJson: body, attempts: 0, nextAttemptAt: at(1000) }),
    );
    const inFlight = old!.dueOutbox(at(1000))[0]!;

    // New flusher: takes over the stale instance; the committed revision is still pending.
    const g2 = claimOwnership(fresh!, 102, at(OWNER_STALE_MS + 5000))!;
    expect(g2).toBe(g1 + 1);
    expect(fresh!.dueOutbox(at(OWNER_STALE_MS + 5000))[0]!.bodyJson).toBe(body);

    // Old flusher wakes: what it sends is byte-for-byte the committed revision (a harmless replay)…
    expect(inFlight.bodyJson).toBe(body);
    expect(inFlight.revision).toBe(1);
    // …and its acknowledgement fails the generation check and changes nothing.
    expect(() => guarded(old!, g1, at(OWNER_STALE_MS + 6000), () => old!.deleteOutboxThrough("segment", "seg-1", 1))).toThrow(
      LostOwnership,
    );
    expect(fresh!.outboxFor("segment", "seg-1")).toHaveLength(1);

    // The owner's acknowledgement goes through.
    guarded(fresh!, g2, at(OWNER_STALE_MS + 7000), () => fresh!.deleteOutboxThrough("segment", "seg-1", 1));
    expect(fresh!.pendingOutboxCount()).toBe(0);
    old!.close();
    fresh!.close();
  });

  it("schema migration while an old flusher is alive ⇒ the old one exits without writing", () => {
    const { path, list: [old] } = stores(1);
    const gen = claimOwnership(old!, 101, at(0))!;
    const newer = rawDb(path);
    migrate(newer, [...MIGRATIONS, (db) => db.exec("CREATE TABLE added_later (x)")]);
    expect(userVersion(newer)).toBe(SCHEMA_VERSION + 1);

    let error: unknown;
    try {
      guarded(old!, gen, at(1000), () => old!.setMeta("written", "1"));
    } catch (e) {
      error = e;
    }
    expect(error).toBeInstanceOf(LostOwnership);
    expect((error as LostOwnership).reason).toBe("newer_schema");
    expect(count(newer, "meta")).toBe(0);
    expect(old!.readOwner()!.heartbeat).toBe(at(0));
    expect(claimOwnership(old!, 101, at(OWNER_STALE_MS * 2))).toBeNull();
    old!.close();
    newer.close();
  });
});

describe("ownership across processes", () => {
  let harness: ReturnType<typeof buildChild>;
  let bundle: string;
  beforeAll(() => {
    harness = buildChild();
    bundle = harness.path;
  });
  afterAll(() => harness.remove());

  it("schema migration while an old flusher process is alive ⇒ it exits without writing (process level)", async () => {
    const dir = tempDir();
    const path = join(dir, DB_FILE);
    (openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store).close();
    const child = startChild(bundle, ["flush", dir, JSON.stringify({ holdStage: "segmentation", holdMs: 1500 })]);
    await child.waitFor(/^holding$/);

    const newer = rawDb(path);
    migrate(newer, [...MIGRATIONS, (db) => db.exec("CREATE TABLE added_later (x)")]);
    const heartbeat = (newer.prepare("SELECT heartbeat FROM owner").get() as { heartbeat: string }).heartbeat;
    const fallback = join(dir, FALLBACK_DIR);
    writeFallback(fallback, {
      eventId: ulid(Date.now()),
      sessionId: "s-1",
      type: "Stop",
      localTime: new Date().toISOString(),
      uptimeS: 1,
      mapping: null,
    });

    expect(await child.waitFor(/^outcome /)).toBe("outcome newer_schema");
    await child.exited;
    expect(listJson(fallback)).toHaveLength(1);
    expect(count(newer, "events")).toBe(0);
    expect((newer.prepare("SELECT heartbeat FROM owner").get() as { heartbeat: string }).heartbeat).toBe(heartbeat);
    newer.close();
  });
});
