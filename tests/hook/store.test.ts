import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { HOOK_BUSY_TIMEOUT_MS, recordEvent } from "../../hook-src/intake.js";
import { DB_FILE, type JournalEvent, MAX_DIAGNOSTIC, openStore, type SegmentRow, type Store } from "../../hook-src/store/db.js";
import { migrate, MIGRATIONS, SCHEMA_VERSION, userVersion } from "../../hook-src/store/schema.js";
import { buildChild, startChild } from "./helpers/children.js";
import {
  cleanTempDirs,
  count,
  hookInput,
  instanceFor,
  listJson,
  pluginConfig,
  rawDb,
  tempDir,
  writeMapping,
} from "./helpers/env.js";

afterEach(() => cleanTempDirs());

function flusherStore(path: string): Store {
  const store = openStore(path, { role: "flusher", busyTimeoutMs: 5000 });
  if (typeof store === "string") throw new Error(store);
  return store;
}

/** A linked checkout, its data dir and its migrated instance store (closed). */
function linked() {
  const root = tempDir();
  const cwd = writeMapping(join(root, "repo"));
  const data = join(root, "data");
  const dir = instanceFor(data);
  const dbPath = join(dir, DB_FILE);
  flusherStore(dbPath).close();
  return { cwd, data, dir, dbPath, cfg: pluginConfig(data) };
}

function journalEvent(id: string, extra: Partial<JournalEvent> = {}): JournalEvent {
  return {
    eventId: id,
    sessionId: "s-1",
    type: "UserPromptSubmit",
    localTime: "2026-11-05T10:00:00.000Z",
    uptimeS: 100,
    mapping: { hash: "h", json: '{"projectId":"p"}' },
    ...extra,
  };
}

describe("schema and journal mode", () => {
  it("a flusher creates and migrates the database to SCHEMA_VERSION, idempotently", () => {
    const path = join(tempDir(), "i", DB_FILE);
    const store = flusherStore(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    const tables = (store.db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name").all() as { name: string }[])
      .map((t) => t.name)
      .filter((n) => !n.startsWith("sqlite_"));
    expect(tables).toEqual([
      "agent_launches",
      "delegated",
      "events",
      "last_committed",
      "ledger",
      "ledger_totals",
      "mapping_versions",
      "meta",
      "notices",
      "outbox",
      "owner",
      "segments",
      "sessions",
      "subagents",
      "terminal",
      "transcript_offsets",
      "usage_snapshots",
    ]);
    store.close();
    const again = flusherStore(path);
    expect(again.schemaVersion()).toBe(SCHEMA_VERSION);
    again.close();
  });

  it("journal_mode is delete and stays so after reopen", () => {
    const path = join(tempDir(), DB_FILE);
    const store = flusherStore(path);
    expect(store.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    store.journal(journalEvent("E1"));
    store.close();

    const hook = openStore(path, { role: "hook", busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS }) as Store;
    expect(hook.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    hook.close();
    const reopened = flusherStore(path);
    expect(reopened.db.prepare("PRAGMA journal_mode").get()).toEqual({ journal_mode: "delete" });
    reopened.close();
    expect(existsSync(`${path}-wal`)).toBe(false);
  });

  it("migrations run one transaction per step and each step once, even from two connections", () => {
    const path = join(tempDir(), DB_FILE);
    flusherStore(path).close();
    const a = rawDb(path);
    const b = rawDb(path);
    let applied = 0;
    const steps = [
      ...MIGRATIONS,
      (db: typeof a) => {
        db.exec("CREATE TABLE extra (x)");
        applied += 1;
      },
    ];
    migrate(a, steps);
    migrate(b, steps);
    expect(applied).toBe(1);
    expect(userVersion(a)).toBe(MIGRATIONS.length + 1);
    a.close();
    b.close();
  });
});

describe("schema v2", () => {
  it("migrates a v1 store in place: events keep their rows and gain agent_id, agent_transcript_path", () => {
    const path = join(tempDir(), DB_FILE);
    const v1 = rawDb(path);
    migrate(v1, MIGRATIONS.slice(0, 1));
    v1.exec(
      "INSERT INTO events (event_id, session_id, type, local_time, uptime_s) VALUES ('E1', 's-1', 'UserPromptSubmit', '2026-11-05T10:00:00.000Z', 1)",
    );
    v1.close();
    const store = flusherStore(path);
    expect(store.schemaVersion()).toBe(SCHEMA_VERSION);
    expect(store.eventsAfter(0)).toEqual([expect.objectContaining({ eventId: "E1", agentId: null, agentTranscriptPath: null })]);
    store.close();
  });
});

describe("schema v3", () => {
  it("migrates a v2 store in place: every row is kept, events gain link_key (null: never judged)", () => {
    const path = join(tempDir(), DB_FILE);
    const v2 = rawDb(path);
    migrate(v2, MIGRATIONS.slice(0, 2));
    expect(userVersion(v2)).toBe(2);
    v2.exec(`
      INSERT INTO mapping_versions (id, hash, normalized_json) VALUES (1, 'h', '{"projectId":"p"}');
      INSERT INTO events (event_id, session_id, type, local_time, uptime_s, mapping_version_id, agent_id)
        VALUES ('E1', 's-1', 'UserPromptSubmit', '2026-11-05T10:00:00.000Z', 1, 1, 'a-1');
      INSERT INTO sessions (session_id, last_event_seq, state) VALUES ('s-1', 1, 'active');
      INSERT INTO segments (id, session_id, mapping_version_id, started_at, last_activity_at, stopped_at, working, observed_at)
        VALUES ('g-1', 's-1', 1, '2026-11-05T10:00:00.000Z', '2026-11-05T10:00:00.000Z', '2026-11-05T10:00:00.000Z', 1, '2026-11-05T10:00:00.000Z');
      INSERT INTO outbox (target_kind, target_id, revision, body_json, next_attempt_at) VALUES ('segment', 'g-1', 1, '{}', '2026-11-05T10:00:00.000Z');
      INSERT INTO ledger (message_id, session_id, recipient_kind, provider, model, at) VALUES ('m-1', 's-1', 'segment', 'anthropic', 'x', '2026-11-05T10:00:00.000Z');
    `);
    v2.close();
    const store = flusherStore(path);
    expect(store.schemaVersion()).toBe(3);
    expect(SCHEMA_VERSION).toBe(3);
    expect(store.eventsAfter(0)).toEqual([expect.objectContaining({ eventId: "E1", agentId: "a-1", mappingVersionId: 1, linkKey: null })]);
    expect(store.lastLinkKey("s-1")).toBeNull();
    expect(store.getSession("s-1")).toMatchObject({ state: "active", lastEventSeq: 1 });
    expect(store.getSegment("g-1")).toMatchObject({ sessionId: "s-1", working: true });
    expect(store.pendingOutboxCount()).toBe(1);
    expect(count(store.db, "ledger")).toBe(1);
    store.journal(journalEvent("E2", { linkKey: "k" }));
    expect(store.lastLinkKey("s-1")).toBe("k");
    store.close();
  });

  it("a hook facing a v2 store (not migrated yet by the flusher) writes a fallback file", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const db = rawDb(dbPath);
    db.exec("PRAGMA user_version = 2");
    db.close();
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 1000);
    expect(listJson(join(dir, "fallback"))).toHaveLength(1);
  });

  it("a hook facing a v1 store (not migrated yet by the flusher) writes a fallback file", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const db = rawDb(dbPath);
    db.exec("PRAGMA user_version = 1");
    db.close();
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 1000);
    expect(listJson(join(dir, "fallback"))).toHaveLength(1);
  });
});

describe("openStore for hooks", () => {
  it("never creates nor migrates a database", () => {
    const dir = tempDir();
    const missing = join(dir, DB_FILE);
    expect(openStore(missing, { role: "hook", busyTimeoutMs: 250 })).toBe("not_migrated");
    expect(existsSync(missing)).toBe(false);

    const empty = join(dir, "empty.db");
    rawDb(empty).close();
    expect(openStore(empty, { role: "hook", busyTimeoutMs: 250 })).toBe("not_migrated");
    const db = rawDb(empty);
    expect(userVersion(db)).toBe(0);
    db.close();
  });

  it("a hook facing a newer user_version writes a fallback file and no row", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const db = rawDb(dbPath);
    db.exec(`PRAGMA user_version = ${SCHEMA_VERSION + 1}`);

    expect(openStore(dbPath, { role: "hook", busyTimeoutMs: 250 })).toBe("newer_schema");
    expect(openStore(dbPath, { role: "flusher", busyTimeoutMs: 250 })).toBe("newer_schema");
    expect(recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 1000)).toEqual({});
    expect(listJson(join(dir, "fallback"))).toHaveLength(1);
    expect(count(db, "events")).toBe(0);
    expect(count(db, "mapping_versions")).toBe(0);
    db.close();
  });

  it("hook blocked by a writer holding the lock ⇒ fallback within the 1 s budget (real second connection holding BEGIN EXCLUSIVE)", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const writer = rawDb(dbPath);
    writer.exec("BEGIN EXCLUSIVE");
    const started = performance.now();
    const deadline = Date.now() + 1000;
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, deadline);
    const elapsed = performance.now() - started;
    expect(elapsed).toBeLessThan(1000);
    expect(elapsed).toBeGreaterThanOrEqual(HOOK_BUSY_TIMEOUT_MS - 20);
    expect(listJson(join(dir, "fallback"))).toHaveLength(1);
    writer.exec("ROLLBACK");
    expect(count(writer, "events")).toBe(0);
    writer.close();
  });

  it("a hook with less budget left than two lock waits goes straight to the fallback file", () => {
    const { cwd, dir, dbPath, cfg } = linked();
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 2 * HOOK_BUSY_TIMEOUT_MS);
    expect(listJson(join(dir, "fallback"))).toHaveLength(1);
    const db = rawDb(dbPath);
    expect(count(db, "events")).toBe(0);
    db.close();
  });
});

describe("a hook killed mid-insert", () => {
  let harness: ReturnType<typeof buildChild>;
  let bundle: string;
  beforeAll(() => {
    harness = buildChild();
    bundle = harness.path;
  });
  afterAll(() => harness.remove());

  it("hook killed mid-insert (child process) ⇒ next hook not blocked beyond busy_timeout", async () => {
    const { cwd, dir, dbPath, cfg } = linked();
    const child = startChild(bundle, ["hold-insert", dbPath]);
    await child.waitFor(/^holding$/);
    expect(existsSync(`${dbPath}-journal`)).toBe(true);
    await child.kill();

    const started = performance.now();
    recordEvent(hookInput("UserPromptSubmit", cwd), cfg, Date.now() + 1000);
    expect(performance.now() - started).toBeLessThan(HOOK_BUSY_TIMEOUT_MS + 500);

    expect(listJson(join(dir, "fallback"))).toEqual([]);
    const db = rawDb(dbPath);
    const sessions = db.prepare("SELECT session_id FROM events").all() as { session_id: string }[];
    expect(sessions.map((s) => s.session_id)).toEqual(["s-1"]);
    db.close();
  });
});

describe("Store", () => {
  function store(): Store {
    return flusherStore(join(tempDir(), DB_FILE));
  }

  it("journals an event once per event_id with its mapping version", () => {
    const s = store();
    expect(s.journal(journalEvent("E1", { promptId: "p-1", toolName: "Bash" }))).toBe(true);
    expect(s.journal(journalEvent("E1"))).toBe(false);
    expect(s.journal(journalEvent("E2", { mapping: null }))).toBe(true);
    const [first, second] = s.eventsAfter(0);
    expect(first).toMatchObject({ eventId: "E1", promptId: "p-1", toolName: "Bash", transcriptPath: null, entryId: null });
    expect(first!.mappingVersionId).toBe(s.listMappings()[0]!.id);
    expect(second!.mappingVersionId).toBeNull();
    // seq only grows (it is a cursor, not a count).
    expect(second!.seq).toBeGreaterThan(first!.seq);
    expect(s.maxEventSeq()).toBe(second!.seq);
    expect(s.eventsAfter(first!.seq).map((e) => e.eventId)).toEqual(["E2"]);
    expect(s.sessionEventsAfter("other", 0)).toEqual([]);
    s.close();
  });

  it("journals the subagent fields of an event", () => {
    const s = store();
    s.journal(journalEvent("E1", { type: "SubagentStop", agentId: "a-1", agentTranscriptPath: "/t/s-1/subagents/agent-a-1.jsonl" }));
    expect(s.eventsAfter(0)[0]).toMatchObject({ type: "SubagentStop", agentId: "a-1", agentTranscriptPath: "/t/s-1/subagents/agent-a-1.jsonl" });
    s.close();
  });

  it("keeps transcript offsets and the session's agent version", () => {
    const s = store();
    expect(s.getTranscriptOffset("/t/a.jsonl")).toBeNull();
    const row = { path: "/t/a.jsonl", offset: 10, size: 12, headHash: "h", sessionId: "s-1", status: "partial", readAt: "2026-11-05T10:00:00.000Z" };
    s.putTranscriptOffset(row);
    s.putTranscriptOffset({ ...row, offset: 12, sessionId: null, status: "complete" });
    expect(s.getTranscriptOffset("/t/a.jsonl")).toEqual({ ...row, offset: 12, status: "complete" });

    s.upsertSession({ sessionId: "s-1", lastEventSeq: 0, lastEventTime: null, lastUptimeS: null, state: "active", agentVersion: null, provider: null, lateEvents: 0 });
    s.setSessionAgentVersion("s-1", "2.1.300");
    expect(s.getSession("s-1")!.agentVersion).toBe("2.1.300");
    s.close();
  });

  it("keeps sessions, segments, meta and the owner row", () => {
    const s = store();
    s.upsertSession({ sessionId: "s-1", lastEventSeq: 3, lastEventTime: null, lastUptimeS: null, state: "active", agentVersion: null, provider: "anthropic", lateEvents: 0 });
    s.upsertSession({ sessionId: "s-1", lastEventSeq: 4, lastEventTime: "t", lastUptimeS: 5.5, state: "active", agentVersion: "2.1.0", provider: "anthropic", lateEvents: 2 });
    expect(s.getSession("s-1")).toEqual({ sessionId: "s-1", lastEventSeq: 4, lastEventTime: "t", lastUptimeS: 5.5, state: "active", agentVersion: "2.1.0", provider: "anthropic", lateEvents: 2 });
    expect(s.listSessions()).toHaveLength(1);

    const seg: SegmentRow = {
      id: "0190f0c0-0000-7000-8000-000000000001",
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
    };
    s.upsertSegment(seg);
    expect(s.getSegment(seg.id)).toEqual(seg);
    expect(s.openSegments()).toEqual([seg]);
    s.upsertSegment({ ...seg, final: true, finalReason: "idle", working: false, lastRevision: 2 });
    expect(s.openSegments()).toEqual([]);
    expect(s.segmentsForSession("s-1")[0]).toMatchObject({ final: true, finalReason: "idle", working: false, lastRevision: 2 });

    expect(s.getMeta("k")).toBeNull();
    s.setMeta("k", "1");
    s.setMeta("k", "2");
    expect(s.getMeta("k")).toBe("2");
    s.deleteMeta("k");
    expect(s.getMeta("k")).toBeNull();
    expect(s.readOwner()).toBeNull();
    s.close();
  });

  it("selects only the latest due revision of each target and deletes acknowledged ones", () => {
    const s = store();
    const row = (id: string, revision: number, next = "2026-11-05T10:00:00.000Z") => ({
      targetKind: "segment" as const,
      targetId: id,
      revision,
      bodyJson: `{"revision":${revision}}`,
      attempts: 0,
      nextAttemptAt: next,
    });
    s.insertOutbox(row("a", 1));
    s.insertOutbox(row("a", 2));
    s.insertOutbox(row("b", 1, "2026-11-05T11:00:00.000Z"));
    expect(s.dueOutbox("2026-11-05T10:30:00.000Z").map((r) => [r.targetId, r.revision])).toEqual([["a", 2]]);
    expect(s.pendingOutboxCount()).toBe(3);
    s.setOutboxAttempt("segment", "a", 2, 1, "2026-11-05T12:00:00.000Z");
    expect(s.dueOutbox("2026-11-05T11:30:00.000Z").map((r) => [r.targetId, r.revision])).toEqual([["b", 1]]);
    expect(s.deleteOutboxThrough("segment", "a", 2)).toBe(2);
    expect(s.outboxFor("segment", "a")).toEqual([]);
    s.close();
  });

  it("bounds terminal diagnostics and shows each notice kind once", () => {
    const s = store();
    s.addTerminal({ targetKind: "segment", targetId: "a", revision: 1, code: "invalid", at: "t", diagnostic: "x".repeat(1000) });
    expect(s.listTerminal()[0]!.diagnostic).toHaveLength(MAX_DIAGNOSTIC);
    expect(s.addNotice("unauthorized", "t1")).toBe(true);
    expect(s.addNotice("unauthorized", "t2")).toBe(false);
    expect(s.takeUnshownNotices("t3").map((n) => n.kind)).toEqual(["unauthorized"]);
    expect(s.takeUnshownNotices("t4")).toEqual([]);
    expect(s.addNotice("unauthorized", "t5")).toBe(true);
    s.close();
  });

  it("rolls a failed transaction back", () => {
    const s = store();
    expect(() =>
      s.transaction(() => {
        s.journal(journalEvent("E1"));
        throw new Error("boom");
      }),
    ).toThrow("boom");
    expect(s.maxEventSeq()).toBe(0);
    expect(s.inTransaction).toBe(false);
    s.close();
  });
});
