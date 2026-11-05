// The per-instance SQLite store: ${CLAUDE_PLUGIN_DATA}/<instance>/tickr.db, rollback journal
// (journal_mode=DELETE, no WAL). SQLite's own file locks give mutual exclusion and are released
// by the OS when a process dies. Hooks never create nor migrate the database (PD-9).
import { createHash } from "node:crypto";
import { existsSync, mkdirSync } from "node:fs";
import { dirname } from "node:path";
import type { DatabaseSync, SQLInputValue, StatementSync } from "node:sqlite";
import { loadSqlite } from "../runtime.js";
import { migrate, SCHEMA_VERSION, userVersion } from "./schema.js";

export const DB_FILE = "tickr.db";
/** Longest diagnostic kept with a terminal item. */
export const MAX_DIAGNOSTIC = 200;

export type StoreRole = "hook" | "flusher";
export type TargetKind = "segment" | "delegated";

export interface OpenStoreOptions {
  role: StoreRole;
  /** Longest wait for the database lock, per statement or transaction start / commit. */
  busyTimeoutMs: number;
}

export interface MappingVersionRow {
  id: number;
  hash: string;
  normalizedJson: string;
}

export interface EventRow {
  seq: number;
  eventId: string;
  sessionId: string;
  type: string;
  localTime: string;
  uptimeS: number;
  mappingVersionId: number | null;
  transcriptPath: string | null;
  provider: string | null;
  promptId: string | null;
  toolName: string | null;
  toolUseId: string | null;
  entryId: string | null;
  /** Set when the event comes from a subagent (hook input agent_id). */
  agentId: string | null;
  /** The subagent's own transcript (hook input agent_transcript_path). */
  agentTranscriptPath: string | null;
}

export type NewEventRow = Omit<EventRow, "seq">;

/**
 * One hook event as journalled by a hook or carried by a fallback file: it holds the full
 * normalised mapping of that moment (canonical JSON and its SHA-256), not a version id.
 */
export interface JournalEvent {
  eventId: string;
  sessionId: string;
  type: string;
  localTime: string;
  uptimeS: number;
  mapping: { hash: string; json: string } | null;
  transcriptPath?: string;
  provider?: string;
  promptId?: string;
  toolName?: string;
  toolUseId?: string;
  entryId?: string;
  agentId?: string;
  agentTranscriptPath?: string;
}

export interface SessionRow {
  sessionId: string;
  lastEventSeq: number;
  lastEventTime: string | null;
  lastUptimeS: number | null;
  state: string;
  agentVersion: string | null;
  provider: string | null;
  /** Events older than the session's cursor that fell outside the open segment (PD-11). */
  lateEvents: number;
}

export interface SegmentRow {
  id: string;
  sessionId: string;
  mappingVersionId: number;
  startedAt: string;
  lastActivityAt: string;
  stoppedAt: string;
  working: boolean;
  observedAt: string;
  final: boolean;
  finalReason: string | null;
  /** Why a clock-jump split was made, for diagnostics. */
  finalDiagnostic: string | null;
  quality: string;
  createdOnServer: boolean;
  serverState: string | null;
  lastRevision: number;
}

export interface OutboxRow {
  targetKind: TargetKind;
  targetId: string;
  revision: number;
  bodyJson: string;
  attempts: number;
  nextAttemptAt: string;
}

/**
 * The last revision committed for a target. Outbox rows are deleted once acknowledged; this row
 * stays, so that the next desired body is compared with what was last committed.
 */
export interface CommittedRow {
  targetKind: TargetKind;
  targetId: string;
  revision: number;
  /** Canonical JSON (sorted keys) of the body without its revision: the comparison key. */
  canonicalJson: string;
  /** The exact body committed to the outbox, revision included. */
  bodyJson: string;
  committedAt: string;
}

export interface TerminalRow {
  id: number;
  targetKind: string;
  targetId: string;
  revision: number | null;
  code: string;
  at: string;
  diagnostic: string;
}

export interface NoticeRow {
  id: number;
  kind: string;
  createdAt: string;
  shownAt: string | null;
}

/** How far one transcript file was read (transcript/reader.ts). */
export interface TranscriptOffsetRow {
  path: string;
  /** Byte offset past the last complete line read. */
  offset: number;
  /** File size at that read. */
  size: number;
  /** SHA-256 hex of the first min(HEAD_BYTES, offset) bytes. */
  headHash: string;
  sessionId: string | null;
  status: string | null;
  readAt: string | null;
}

/** A delegated entry (delegated.ts): an entry the agent created through the plugin's MCP server. */
export interface DelegatedRow {
  entryId: string;
  sessionId: string;
  promptId: string | null;
  /** Local time of the PostToolUse event that named it. */
  createdAt: string;
  /** seq of that event (creation order within a turn). */
  eventSeq: number | null;
}

export interface OwnerRow {
  generation: number;
  pid: number;
  heartbeat: string;
}

type Row = Record<string, SQLInputValue>;

/** SQLITE_BUSY or SQLITE_LOCKED, including their extended codes. */
export function isBusy(error: unknown): boolean {
  const code = (error as { errcode?: unknown } | null)?.errcode;
  return typeof code === "number" && ((code & 0xff) === 5 || (code & 0xff) === 6);
}

const pause = new Int32Array(new SharedArrayBuffer(4));
function sleepSync(ms: number): void {
  if (ms > 0) Atomics.wait(pause, 0, 0, ms);
}

const str = (value: SQLInputValue | undefined): string => String(value);
const optStr = (value: SQLInputValue | undefined): string | null => (value === null || value === undefined ? null : String(value));
const num = (value: SQLInputValue | undefined): number => Number(value);
const optNum = (value: SQLInputValue | undefined): number | null => (value === null || value === undefined ? null : Number(value));
const bool = (value: SQLInputValue | undefined): boolean => Number(value) !== 0;

function toEvent(r: Row): EventRow {
  return {
    seq: num(r.seq),
    eventId: str(r.event_id),
    sessionId: str(r.session_id),
    type: str(r.type),
    localTime: str(r.local_time),
    uptimeS: num(r.uptime_s),
    mappingVersionId: optNum(r.mapping_version_id),
    transcriptPath: optStr(r.transcript_path),
    provider: optStr(r.provider),
    promptId: optStr(r.prompt_id),
    toolName: optStr(r.tool_name),
    toolUseId: optStr(r.tool_use_id),
    entryId: optStr(r.entry_id),
    agentId: optStr(r.agent_id),
    agentTranscriptPath: optStr(r.agent_transcript_path),
  };
}

function toSession(r: Row): SessionRow {
  return {
    sessionId: str(r.session_id),
    lastEventSeq: num(r.last_event_seq),
    lastEventTime: optStr(r.last_event_time),
    lastUptimeS: optNum(r.last_uptime_s),
    state: str(r.state),
    agentVersion: optStr(r.agent_version),
    provider: optStr(r.provider),
    lateEvents: num(r.late_events),
  };
}

function toSegment(r: Row): SegmentRow {
  return {
    id: str(r.id),
    sessionId: str(r.session_id),
    mappingVersionId: num(r.mapping_version_id),
    startedAt: str(r.started_at),
    lastActivityAt: str(r.last_activity_at),
    stoppedAt: str(r.stopped_at),
    working: bool(r.working),
    observedAt: str(r.observed_at),
    final: bool(r.final),
    finalReason: optStr(r.final_reason),
    finalDiagnostic: optStr(r.final_diagnostic),
    quality: str(r.quality),
    createdOnServer: bool(r.created_on_server),
    serverState: optStr(r.server_state),
    lastRevision: num(r.last_revision),
  };
}

function toOutbox(r: Row): OutboxRow {
  return {
    targetKind: str(r.target_kind) as TargetKind,
    targetId: str(r.target_id),
    revision: num(r.revision),
    bodyJson: str(r.body_json),
    attempts: num(r.attempts),
    nextAttemptAt: str(r.next_attempt_at),
  };
}

function toCommitted(r: Row): CommittedRow {
  return {
    targetKind: str(r.target_kind) as TargetKind,
    targetId: str(r.target_id),
    revision: num(r.revision),
    canonicalJson: str(r.canonical_json),
    bodyJson: str(r.body_json),
    committedAt: str(r.committed_at),
  };
}

function toTerminal(r: Row): TerminalRow {
  return {
    id: num(r.id),
    targetKind: str(r.target_kind),
    targetId: str(r.target_id),
    revision: optNum(r.revision),
    code: str(r.code),
    at: str(r.at),
    diagnostic: str(r.diagnostic),
  };
}

function toDelegated(r: Row): DelegatedRow {
  return {
    entryId: str(r.entry_id),
    sessionId: str(r.session_id),
    promptId: optStr(r.prompt_id),
    createdAt: str(r.created_at),
    eventSeq: optNum(r.event_seq),
  };
}

function toNotice(r: Row): NoticeRow {
  return { id: num(r.id), kind: str(r.kind), createdAt: str(r.created_at), shownAt: optStr(r.shown_at) };
}

export class Store {
  private readonly statements = new Map<string, StatementSync>();
  private depth = 0;

  constructor(
    readonly db: DatabaseSync,
    readonly path: string,
    readonly role: StoreRole,
    readonly busyTimeoutMs: number,
  ) {}

  close(): void {
    try {
      if (this.depth > 0) this.db.exec("ROLLBACK");
    } catch {
      // Nothing to roll back.
    }
    this.statements.clear();
    this.db.close();
  }

  private stmt(sql: string): StatementSync {
    let statement = this.statements.get(sql);
    if (!statement) {
      statement = this.db.prepare(sql);
      this.statements.set(sql, statement);
    }
    return statement;
  }

  private get(sql: string, ...params: SQLInputValue[]): Row | undefined {
    return this.stmt(sql).get(...params) as Row | undefined;
  }

  private all(sql: string, ...params: SQLInputValue[]): Row[] {
    return this.stmt(sql).all(...params) as Row[];
  }

  private run(sql: string, ...params: SQLInputValue[]): number {
    return Number(this.stmt(sql).run(...params).changes);
  }

  /**
   * Runs fn, retrying while the database is locked, for at most busyTimeoutMs measured on the
   * monotonic clock. Hooks set SQLite's own busy_timeout to 0 and wait here instead: SQLite's
   * busy handler sleeps in coarse steps on some platforms and would overrun the hook budget.
   */
  retryBusy<T>(fn: () => T): T {
    const deadline = performance.now() + this.busyTimeoutMs;
    for (;;) {
      try {
        return fn();
      } catch (error) {
        const left = deadline - performance.now();
        if (!isBusy(error) || left <= 0) throw error;
        sleepSync(Math.min(10, left));
      }
    }
  }

  get inTransaction(): boolean {
    return this.depth > 0;
  }

  /** BEGIN IMMEDIATE … COMMIT around fn (rolled back if fn throws). Nested calls join the outer one. */
  transaction<T>(fn: () => T): T {
    if (this.depth > 0) return fn();
    this.retryBusy(() => this.db.exec("BEGIN IMMEDIATE"));
    this.depth = 1;
    try {
      const result = fn();
      this.retryBusy(() => this.db.exec("COMMIT"));
      this.depth = 0;
      return result;
    } catch (error) {
      this.depth = 0;
      try {
        this.db.exec("ROLLBACK");
      } catch {
        // Already rolled back by SQLite.
      }
      throw error;
    }
  }

  schemaVersion(): number {
    return userVersion(this.db);
  }

  // meta

  getMeta(key: string): string | null {
    return optStr(this.get("SELECT value FROM meta WHERE key = ?", key)?.value);
  }

  setMeta(key: string, value: string): void {
    this.run("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value", key, value);
  }

  deleteMeta(key: string): void {
    this.run("DELETE FROM meta WHERE key = ?", key);
  }

  // mapping versions (immutable, one per distinct normalised content)

  /** Returns the id of the version with this hash, creating it when it is new. */
  upsertMapping(hash: string, normalizedJson: string): number {
    this.run("INSERT INTO mapping_versions (hash, normalized_json) VALUES (?, ?) ON CONFLICT (hash) DO NOTHING", hash, normalizedJson);
    return num(this.get("SELECT id FROM mapping_versions WHERE hash = ?", hash)?.id);
  }

  getMapping(id: number): MappingVersionRow | null {
    const r = this.get("SELECT id, hash, normalized_json FROM mapping_versions WHERE id = ?", id);
    return r ? { id: num(r.id), hash: str(r.hash), normalizedJson: str(r.normalized_json) } : null;
  }

  listMappings(): MappingVersionRow[] {
    return this.all("SELECT id, hash, normalized_json FROM mapping_versions ORDER BY id").map((r) => ({
      id: num(r.id),
      hash: str(r.hash),
      normalizedJson: str(r.normalized_json),
    }));
  }

  // events (append-only journal)

  /** Inserts the event unless its event_id is already journalled; true when inserted. */
  insertEvent(ev: NewEventRow): boolean {
    return (
      this.run(
        `INSERT INTO events (event_id, session_id, type, local_time, uptime_s, mapping_version_id, transcript_path, provider,
           prompt_id, tool_name, tool_use_id, entry_id, agent_id, agent_transcript_path)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT (event_id) DO NOTHING`,
        ev.eventId,
        ev.sessionId,
        ev.type,
        ev.localTime,
        ev.uptimeS,
        ev.mappingVersionId,
        ev.transcriptPath,
        ev.provider,
        ev.promptId,
        ev.toolName,
        ev.toolUseId,
        ev.entryId,
        ev.agentId,
        ev.agentTranscriptPath,
      ) === 1
    );
  }

  /**
   * Journals one event with the mapping version of its moment (created when new, by hash).
   * Idempotent by event_id; true when the event was not journalled yet.
   */
  journal(ev: JournalEvent): boolean {
    let mappingVersionId: number | null = null;
    if (ev.mapping !== null) {
      const hash = createHash("sha256").update(ev.mapping.json, "utf8").digest("hex");
      mappingVersionId = this.upsertMapping(hash, ev.mapping.json);
    }
    const inserted = this.insertEvent({
      eventId: ev.eventId,
      sessionId: ev.sessionId,
      type: ev.type,
      localTime: ev.localTime,
      uptimeS: ev.uptimeS,
      mappingVersionId,
      transcriptPath: ev.transcriptPath ?? null,
      provider: ev.provider ?? null,
      promptId: ev.promptId ?? null,
      toolName: ev.toolName ?? null,
      toolUseId: ev.toolUseId ?? null,
      entryId: ev.entryId ?? null,
      agentId: ev.agentId ?? null,
      agentTranscriptPath: ev.agentTranscriptPath ?? null,
    });
    if (inserted && ev.entryId !== undefined) {
      const seq = optNum(this.get("SELECT seq FROM events WHERE event_id = ?", ev.eventId)?.seq);
      this.recordDelegated({ entryId: ev.entryId, sessionId: ev.sessionId, promptId: ev.promptId ?? null, createdAt: ev.localTime, eventSeq: seq });
    }
    return inserted;
  }

  // delegated entries

  /** Records a delegated entry once: the first event naming it wins. */
  recordDelegated(row: DelegatedRow): void {
    this.run(
      `INSERT INTO delegated (entry_id, session_id, prompt_id, created_at, event_seq) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT (entry_id) DO NOTHING`,
      row.entryId,
      row.sessionId,
      row.promptId,
      row.createdAt,
      row.eventSeq,
    );
  }

  delegatedForSession(sessionId: string): DelegatedRow[] {
    return this.all("SELECT * FROM delegated WHERE session_id = ? ORDER BY created_at, entry_id", sessionId).map(toDelegated);
  }

  getDelegated(entryId: string): DelegatedRow | null {
    const r = this.get("SELECT * FROM delegated WHERE entry_id = ?", entryId);
    return r ? toDelegated(r) : null;
  }

  /**
   * Delegated entries the revisions stage evaluates: of an active session, not terminal, and
   * never committed, or last committed with usageQuality pending, or (their session active since
   * `sinceIso`) not complete yet or with tokens not folded.
   */
  delegatedForRevision(sinceIso: string): DelegatedRow[] {
    return this.all(
      `SELECT d.* FROM delegated d
       JOIN sessions s ON s.session_id = d.session_id
       LEFT JOIN last_committed c ON c.target_kind = 'delegated' AND c.target_id = d.entry_id
       WHERE s.state = 'active'
         AND NOT EXISTS (SELECT 1 FROM terminal t WHERE t.target_kind = 'delegated' AND t.target_id = d.entry_id)
         AND (c.target_id IS NULL
           OR json_extract(c.body_json, '$.usageQuality') IS NOT 'complete' AND json_extract(c.body_json, '$.usageQuality') IS NOT 'incomplete'
           OR (s.last_event_time >= ? AND (json_extract(c.body_json, '$.usageQuality') IS NOT 'complete'
             OR EXISTS (SELECT 1 FROM ledger l WHERE l.recipient_kind = 'delegated' AND l.recipient_id = d.entry_id AND l.folded = 0))))
       ORDER BY d.created_at, d.entry_id`,
      sinceIso,
    ).map(toDelegated);
  }

  /** Events with seq > afterSeq, in journal order. */
  eventsAfter(afterSeq: number, limit = 1000): EventRow[] {
    return this.all("SELECT * FROM events WHERE seq > ? ORDER BY seq LIMIT ?", afterSeq, limit).map(toEvent);
  }

  sessionEventsAfter(sessionId: string, afterSeq: number, limit = 1000): EventRow[] {
    return this.all("SELECT * FROM events WHERE session_id = ? AND seq > ? ORDER BY seq LIMIT ?", sessionId, afterSeq, limit).map(
      toEvent,
    );
  }

  /**
   * The session's events attribution needs (ledger.ts): turn bounds, subagent start / stop,
   * delegated entries and subagent transcripts, in journal order.
   */
  attributionEvents(sessionId: string): EventRow[] {
    return this.all(
      `SELECT * FROM events WHERE session_id = ? AND (type IN ('UserPromptSubmit', 'Stop', 'SessionEnd', 'SubagentStart', 'SubagentStop')
         OR entry_id IS NOT NULL OR agent_transcript_path IS NOT NULL) ORDER BY seq`,
      sessionId,
    ).map(toEvent);
  }

  /** The main transcripts named by the session's events. */
  transcriptPaths(sessionId: string): string[] {
    return this.all(
      "SELECT DISTINCT transcript_path FROM events WHERE session_id = ? AND transcript_path IS NOT NULL ORDER BY transcript_path",
      sessionId,
    ).map((r) => str(r.transcript_path));
  }

  /** Sessions with journalled events after their segmentation cursor (sessions.last_event_seq). */
  pendingEventSessions(): string[] {
    return this.all(
      `SELECT DISTINCT e.session_id FROM events e LEFT JOIN sessions s ON s.session_id = e.session_id
       WHERE e.seq > COALESCE(s.last_event_seq, 0) ORDER BY e.session_id`,
    ).map((r) => str(r.session_id));
  }

  maxEventSeq(): number {
    return num(this.get("SELECT COALESCE(MAX(seq), 0) AS m FROM events")?.m);
  }

  // sessions

  getSession(sessionId: string): SessionRow | null {
    const r = this.get("SELECT * FROM sessions WHERE session_id = ?", sessionId);
    return r ? toSession(r) : null;
  }

  listSessions(): SessionRow[] {
    return this.all("SELECT * FROM sessions ORDER BY session_id").map(toSession);
  }

  upsertSession(s: SessionRow): void {
    this.run(
      `INSERT INTO sessions (session_id, last_event_seq, last_event_time, last_uptime_s, state, agent_version, provider, late_events)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (session_id) DO UPDATE SET last_event_seq = excluded.last_event_seq, last_event_time = excluded.last_event_time,
         last_uptime_s = excluded.last_uptime_s, state = excluded.state, agent_version = excluded.agent_version,
         provider = excluded.provider, late_events = excluded.late_events`,
      s.sessionId,
      s.lastEventSeq,
      s.lastEventTime,
      s.lastUptimeS,
      s.state,
      s.agentVersion,
      s.provider,
      s.lateEvents,
    );
  }

  // segments

  getSegment(id: string): SegmentRow | null {
    const r = this.get("SELECT * FROM segments WHERE id = ?", id);
    return r ? toSegment(r) : null;
  }

  segmentsForSession(sessionId: string): SegmentRow[] {
    return this.all("SELECT * FROM segments WHERE session_id = ? ORDER BY started_at, id", sessionId).map(toSegment);
  }

  /** Segments not yet final, every session. */
  openSegments(): SegmentRow[] {
    return this.all("SELECT * FROM segments WHERE final = 0 ORDER BY started_at, id").map(toSegment);
  }

  /** The session's segment that is not final yet (the segmenter keeps at most one). */
  openSegmentFor(sessionId: string): SegmentRow | null {
    const r = this.get("SELECT * FROM segments WHERE session_id = ? AND final = 0 ORDER BY started_at DESC, id DESC LIMIT 1", sessionId);
    return r ? toSegment(r) : null;
  }

  upsertSegment(s: SegmentRow): void {
    this.run(
      `INSERT INTO segments (id, session_id, mapping_version_id, started_at, last_activity_at, stopped_at, working, observed_at,
         final, final_reason, final_diagnostic, quality, created_on_server, server_state, last_revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET session_id = excluded.session_id, mapping_version_id = excluded.mapping_version_id,
         started_at = excluded.started_at, last_activity_at = excluded.last_activity_at, stopped_at = excluded.stopped_at,
         working = excluded.working, observed_at = excluded.observed_at, final = excluded.final,
         final_reason = excluded.final_reason, final_diagnostic = excluded.final_diagnostic, quality = excluded.quality, created_on_server = excluded.created_on_server,
         server_state = excluded.server_state, last_revision = excluded.last_revision`,
      s.id,
      s.sessionId,
      s.mappingVersionId,
      s.startedAt,
      s.lastActivityAt,
      s.stoppedAt,
      s.working ? 1 : 0,
      s.observedAt,
      s.final ? 1 : 0,
      s.finalReason,
      s.finalDiagnostic,
      s.quality,
      s.createdOnServer ? 1 : 0,
      s.serverState,
      s.lastRevision,
    );
  }

  /**
   * Segments the revisions stage evaluates: not closed by the server, not terminal, and either
   * still open, or not yet committed as final, or (their session active since `sinceIso`, when
   * given) final but whose usage may still change: quality not complete yet, or tokens not folded.
   */
  segmentsForRevision(sinceIso?: string): SegmentRow[] {
    const recheck =
      sinceIso === undefined
        ? ""
        : `OR (EXISTS (SELECT 1 FROM sessions x WHERE x.session_id = s.session_id AND x.last_event_time >= ?)
             AND (json_extract(c.body_json, '$.usageQuality') IS NOT 'complete'
               OR EXISTS (SELECT 1 FROM ledger l WHERE l.recipient_kind = 'segment' AND l.recipient_id = s.id AND l.folded = 0)))`;
    return this.db
      .prepare(
        `SELECT s.* FROM segments s
         LEFT JOIN last_committed c ON c.target_kind = 'segment' AND c.target_id = s.id
         WHERE s.server_state IS NULL
           AND NOT EXISTS (SELECT 1 FROM terminal t WHERE t.target_kind = 'segment' AND t.target_id = s.id)
           AND (s.final = 0 OR c.target_id IS NULL OR json_extract(c.body_json, '$.final') IS NOT 1 ${recheck})
         ORDER BY s.started_at, s.id`,
      )
      .all(...(sinceIso === undefined ? [] : [sinceIso]))
      .map((r) => toSegment(r as Row));
  }

  setSegmentRevision(id: string, revision: number): void {
    this.run("UPDATE segments SET last_revision = ? WHERE id = ?", revision, id);
  }

  // last committed revision of each target

  getLastCommitted(kind: TargetKind, id: string): CommittedRow | null {
    const r = this.get("SELECT * FROM last_committed WHERE target_kind = ? AND target_id = ?", kind, id);
    return r ? toCommitted(r) : null;
  }

  putLastCommitted(row: CommittedRow): void {
    this.run(
      `INSERT INTO last_committed (target_kind, target_id, revision, canonical_json, body_json, committed_at) VALUES (?, ?, ?, ?, ?, ?)
       ON CONFLICT (target_kind, target_id) DO UPDATE SET revision = excluded.revision, canonical_json = excluded.canonical_json,
         body_json = excluded.body_json, committed_at = excluded.committed_at`,
      row.targetKind,
      row.targetId,
      row.revision,
      row.canonicalJson,
      row.bodyJson,
      row.committedAt,
    );
  }

  // outbox (immutable revision bodies waiting for an acknowledgement)

  insertOutbox(row: OutboxRow): void {
    this.run(
      "INSERT INTO outbox (target_kind, target_id, revision, body_json, attempts, next_attempt_at) VALUES (?, ?, ?, ?, ?, ?)",
      row.targetKind,
      row.targetId,
      row.revision,
      row.bodyJson,
      row.attempts,
      row.nextAttemptAt,
    );
  }

  /** Every pending revision of one target, oldest first. */
  outboxFor(kind: TargetKind, id: string): OutboxRow[] {
    return this.all("SELECT * FROM outbox WHERE target_kind = ? AND target_id = ? ORDER BY revision", kind, id).map(toOutbox);
  }

  /** The latest pending revision of each target whose next attempt is due at nowIso. */
  dueOutbox(nowIso: string, limit = 100): OutboxRow[] {
    return this.all(
      `SELECT o.* FROM outbox o
       WHERE o.revision = (SELECT MAX(i.revision) FROM outbox i WHERE i.target_kind = o.target_kind AND i.target_id = o.target_id)
         AND o.next_attempt_at <= ?
       ORDER BY o.next_attempt_at, o.target_kind, o.target_id LIMIT ?`,
      nowIso,
      limit,
    ).map(toOutbox);
  }

  /** Removes the target's revisions up to and including `revision`; returns how many. */
  deleteOutboxThrough(kind: TargetKind, id: string, revision: number): number {
    return this.run("DELETE FROM outbox WHERE target_kind = ? AND target_id = ? AND revision <= ?", kind, id, revision);
  }

  setOutboxAttempt(kind: TargetKind, id: string, revision: number, attempts: number, nextAttemptAt: string): void {
    this.run(
      "UPDATE outbox SET attempts = ?, next_attempt_at = ? WHERE target_kind = ? AND target_id = ? AND revision = ?",
      attempts,
      nextAttemptAt,
      kind,
      id,
      revision,
    );
  }

  pendingOutboxCount(): number {
    return num(this.get("SELECT COUNT(*) AS c FROM outbox")?.c);
  }

  /** The latest pending revision of every target, due or not. */
  latestOutbox(): OutboxRow[] {
    return this.all(
      `SELECT o.* FROM outbox o
       WHERE o.revision = (SELECT MAX(i.revision) FROM outbox i WHERE i.target_kind = o.target_kind AND i.target_id = o.target_id)
       ORDER BY o.target_kind, o.target_id`,
    ).map(toOutbox);
  }

  /** Removes every pending revision of one target; returns how many. */
  deleteOutboxFor(kind: TargetKind, id: string): number {
    return this.run("DELETE FROM outbox WHERE target_kind = ? AND target_id = ?", kind, id);
  }

  /**
   * Removes the pending revisions older than their target's latest one. Only the latest is ever
   * sent and its acknowledgement removes the older ones anyway; returns how many.
   */
  pruneSupersededOutbox(): number {
    return this.run(
      `DELETE FROM outbox WHERE revision < (SELECT MAX(i.revision) FROM outbox i
         WHERE i.target_kind = outbox.target_kind AND i.target_id = outbox.target_id)`,
    );
  }

  /** The server holds the segment (any revision was applied). */
  markSegmentCreated(id: string): void {
    this.run("UPDATE segments SET created_on_server = 1 WHERE id = ? AND created_on_server = 0", id);
  }

  /** Sessions with an event after `afterSeq` journalled with one of these mapping versions. */
  sessionsWithMappingsAfter(afterSeq: number, mappingVersionIds: readonly number[]): string[] {
    if (mappingVersionIds.length === 0) return [];
    const marks = mappingVersionIds.map(() => "?").join(", ");
    return this.db
      .prepare(`SELECT DISTINCT session_id FROM events WHERE seq > ? AND mapping_version_id IN (${marks}) ORDER BY session_id`)
      .all(afterSeq, ...mappingVersionIds)
      .map((r) => str((r as Row).session_id));
  }

  /**
   * Retention: deletes what is settled and older than cutoffIso — final segments without a
   * pending revision (and their last committed body), other targets' last committed bodies once
   * their delegated row is gone, events already segmented, sessions left without events nor
   * segments (then their ledger rows and totals, unless their recipient has a pending revision,
   * their delegated entries without a pending revision, transcript offsets, subagents and Agent
   * launches), usage snapshots of targets gone, unused mapping versions, terminal items and shown
   * notices.
   * Returns the rows deleted.
   */
  deleteRetired(cutoffIso: string): number {
    let n = 0;
    n += this.run(
      `DELETE FROM segments WHERE final = 1 AND stopped_at < ?
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.target_kind = 'segment' AND o.target_id = segments.id)`,
      cutoffIso,
    );
    n += this.run(
      `DELETE FROM last_committed WHERE
         (target_kind = 'segment' AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.id = last_committed.target_id))
         OR (target_kind <> 'segment' AND committed_at < ?
             AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.target_kind = last_committed.target_kind AND o.target_id = last_committed.target_id)
             AND NOT EXISTS (SELECT 1 FROM delegated d WHERE d.entry_id = last_committed.target_id))`,
      cutoffIso,
    );
    n += this.run(
      `DELETE FROM events WHERE local_time < ?
         AND seq <= COALESCE((SELECT s.last_event_seq FROM sessions s WHERE s.session_id = events.session_id), 0)`,
      cutoffIso,
    );
    n += this.run(
      `DELETE FROM sessions WHERE (last_event_time IS NULL OR last_event_time < ?)
         AND NOT EXISTS (SELECT 1 FROM events e WHERE e.session_id = sessions.session_id)
         AND NOT EXISTS (SELECT 1 FROM segments g WHERE g.session_id = sessions.session_id)`,
      cutoffIso,
    );
    // Token data lives as long as its session (rescans need the id -> recipient map), and never
    // goes while its recipient still has a revision to send.
    n += this.run(
      `DELETE FROM ledger WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = ledger.session_id)
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.target_kind = ledger.recipient_kind AND o.target_id = ledger.recipient_id)`,
    );
    n += this.run(
      `DELETE FROM ledger_totals WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = ledger_totals.session_id)
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.target_kind = ledger_totals.recipient_kind AND o.target_id = ledger_totals.recipient_id)`,
    );
    n += this.run(
      `DELETE FROM delegated WHERE NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = delegated.session_id)
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.target_kind = 'delegated' AND o.target_id = delegated.entry_id)`,
    );
    n += this.run(
      `DELETE FROM usage_snapshots WHERE
         (target_kind = 'segment' AND NOT EXISTS (SELECT 1 FROM segments s WHERE s.id = usage_snapshots.target_id))
         OR (target_kind = 'delegated' AND NOT EXISTS (SELECT 1 FROM delegated d WHERE d.entry_id = usage_snapshots.target_id))`,
    );
    for (const table of ["transcript_offsets", "subagents", "agent_launches"]) {
      n += this.run(`DELETE FROM ${table} WHERE session_id IS NULL OR NOT EXISTS (SELECT 1 FROM sessions s WHERE s.session_id = ${table}.session_id)`);
    }
    n += this.run(
      `DELETE FROM mapping_versions WHERE NOT EXISTS (SELECT 1 FROM events e WHERE e.mapping_version_id = mapping_versions.id)
         AND NOT EXISTS (SELECT 1 FROM segments g WHERE g.mapping_version_id = mapping_versions.id)`,
    );
    n += this.run("DELETE FROM terminal WHERE at < ?", cutoffIso);
    n += this.run("DELETE FROM notices WHERE shown_at IS NOT NULL AND created_at < ?", cutoffIso);
    return n;
  }

  /** Free pages of the database file (space a VACUUM would give back). */
  freePages(): number {
    return num((this.db.prepare("PRAGMA freelist_count").get() as Row | undefined)?.freelist_count);
  }

  // terminal items (never re-queued, listed by /tickr:status)

  addTerminal(t: Omit<TerminalRow, "id">): number {
    this.run(
      "INSERT INTO terminal (target_kind, target_id, revision, code, at, diagnostic) VALUES (?, ?, ?, ?, ?, ?)",
      t.targetKind,
      t.targetId,
      t.revision,
      t.code,
      t.at,
      t.diagnostic.slice(0, MAX_DIAGNOSTIC),
    );
    return num(this.get("SELECT last_insert_rowid() AS id")?.id);
  }

  isTerminal(kind: TargetKind, id: string): boolean {
    return this.get("SELECT 1 AS x FROM terminal WHERE target_kind = ? AND target_id = ? LIMIT 1", kind, id) !== undefined;
  }

  listTerminal(): TerminalRow[] {
    return this.all("SELECT * FROM terminal ORDER BY id").map(toTerminal);
  }

  // notices (shown once, by the next hook)

  /** Queues a notice unless one of the same kind is still unshown; true when queued. */
  addNotice(kind: string, nowIso: string): boolean {
    if (this.get("SELECT 1 AS x FROM notices WHERE kind = ? AND shown_at IS NULL", kind)) return false;
    this.run("INSERT INTO notices (kind, created_at) VALUES (?, ?)", kind, nowIso);
    return true;
  }

  /** Returns the unshown notices, oldest first, and marks them shown. */
  takeUnshownNotices(nowIso: string): NoticeRow[] {
    const rows = this.all("SELECT * FROM notices WHERE shown_at IS NULL ORDER BY id").map(toNotice);
    if (rows.length > 0) this.run("UPDATE notices SET shown_at = ? WHERE shown_at IS NULL", nowIso);
    return rows;
  }

  listNotices(): NoticeRow[] {
    return this.all("SELECT * FROM notices ORDER BY id").map(toNotice);
  }

  // transcript offsets (see transcript/reader.ts)

  getTranscriptOffset(path: string): TranscriptOffsetRow | null {
    const r = this.get("SELECT * FROM transcript_offsets WHERE path = ?", path);
    if (!r) return null;
    return {
      path: str(r.path),
      offset: num(r.offset),
      size: num(r.size),
      headHash: str(r.head_hash),
      sessionId: optStr(r.session_id),
      status: optStr(r.status),
      readAt: optStr(r.read_at),
    };
  }

  putTranscriptOffset(row: TranscriptOffsetRow): void {
    this.run(
      `INSERT INTO transcript_offsets (path, offset, size, head_hash, session_id, status, read_at) VALUES (?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (path) DO UPDATE SET offset = excluded.offset, size = excluded.size, head_hash = excluded.head_hash,
         session_id = COALESCE(excluded.session_id, transcript_offsets.session_id), status = excluded.status, read_at = excluded.read_at`,
      row.path,
      row.offset,
      row.size,
      row.headHash,
      row.sessionId,
      row.status,
      row.readAt,
    );
  }

  /** The agent version read from the session's transcript (sent in Tickr-Agent). */
  setSessionAgentVersion(sessionId: string, version: string): void {
    this.run("UPDATE sessions SET agent_version = ? WHERE session_id = ? AND agent_version IS NOT ?", version, sessionId, version);
  }

  // owner (flusher ownership, see flusher/owner.ts)

  readOwner(): OwnerRow | null {
    const r = this.get("SELECT generation, pid, heartbeat FROM owner WHERE id = 1");
    return r ? { generation: num(r.generation), pid: num(r.pid), heartbeat: str(r.heartbeat) } : null;
  }

  /** First claim ever: generation 1. False when an owner row already exists. */
  insertFirstOwner(pid: number, heartbeat: string): boolean {
    return this.run("INSERT INTO owner (id, generation, pid, heartbeat) VALUES (1, 1, ?, ?) ON CONFLICT (id) DO NOTHING", pid, heartbeat) === 1;
  }

  /** Compare-and-swap takeover of a stale owner (heartbeat outside [staleBefore, futureAfter]). */
  takeOverOwner(pid: number, heartbeat: string, staleBefore: string, futureAfter: string): boolean {
    return (
      this.run(
        "UPDATE owner SET generation = generation + 1, pid = ?, heartbeat = ? WHERE id = 1 AND (heartbeat < ? OR heartbeat > ?)",
        pid,
        heartbeat,
        staleBefore,
        futureAfter,
      ) === 1
    );
  }

  /** Sets the heartbeat if `generation` still owns the instance; returns the rows changed (0 or 1). */
  setOwnerHeartbeat(generation: number, heartbeat: string): number {
    return this.run("UPDATE owner SET heartbeat = ? WHERE id = 1 AND generation = ?", heartbeat, generation);
  }
}

/**
 * Opens the store. A hook gets "not_migrated" for a missing or older database (it never creates
 * nor migrates one, PD-9); a flusher creates and migrates it. Both get "newer_schema" when the
 * database was migrated by newer code. Throws when the file cannot be opened or stays locked.
 */
export function openStore(path: string, opts: OpenStoreOptions): Store | "newer_schema" | "not_migrated" {
  const sqlite = loadSqlite();
  if (sqlite === null) throw new Error("node:sqlite is not available on this runtime.");
  if (opts.role === "hook" && !existsSync(path)) return "not_migrated";
  if (opts.role === "flusher") mkdirSync(dirname(path), { recursive: true });

  const db = new sqlite.DatabaseSync(path);
  const store = new Store(db, path, opts.role, Math.max(0, opts.busyTimeoutMs));
  try {
    db.exec(`PRAGMA busy_timeout = ${opts.role === "hook" ? 0 : Math.floor(store.busyTimeoutMs)}`);
    if (opts.role === "hook") {
      const version = store.retryBusy(() => userVersion(db));
      if (version === SCHEMA_VERSION) return store;
      store.close();
      return version > SCHEMA_VERSION ? "newer_schema" : "not_migrated";
    }

    if (userVersion(db) > SCHEMA_VERSION) {
      store.close();
      return "newer_schema";
    }
    db.exec("PRAGMA journal_mode = DELETE");
    migrate(db);
    if (userVersion(db) > SCHEMA_VERSION) {
      store.close();
      return "newer_schema";
    }
    return store;
  } catch (error) {
    try {
      store.close();
    } catch {
      // Already closed.
    }
    throw error;
  }
}
