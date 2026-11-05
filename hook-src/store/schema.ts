// Schema of the per-instance store, versioned with PRAGMA user_version. Migrations run at flusher
// start-up only (hooks never migrate), one transaction per step. A process that finds a newer
// user_version than its own code never writes.
import type { DatabaseSync } from "node:sqlite";

export const SCHEMA_VERSION = 3;

/** Step i brings the schema from version i to version i + 1. */
export type MigrationStep = (db: DatabaseSync) => void;

const V1 = `
CREATE TABLE meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
CREATE TABLE mapping_versions (
  id INTEGER PRIMARY KEY,
  hash TEXT NOT NULL UNIQUE,
  normalized_json TEXT NOT NULL
);
CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  event_id TEXT NOT NULL UNIQUE,
  session_id TEXT NOT NULL,
  type TEXT NOT NULL,
  local_time TEXT NOT NULL,
  uptime_s REAL NOT NULL,
  mapping_version_id INTEGER NULL,
  transcript_path TEXT NULL,
  provider TEXT NULL,
  prompt_id TEXT NULL,
  tool_name TEXT NULL,
  tool_use_id TEXT NULL,
  entry_id TEXT NULL
);
CREATE INDEX events_by_session ON events (session_id, seq);
CREATE TABLE sessions (
  session_id TEXT PRIMARY KEY,
  last_event_seq INTEGER NOT NULL DEFAULT 0,
  last_event_time TEXT NULL,
  last_uptime_s REAL NULL,
  state TEXT NOT NULL DEFAULT 'active',
  agent_version TEXT NULL,
  provider TEXT NULL,
  late_events INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE segments (
  id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  mapping_version_id INTEGER NOT NULL,
  started_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL,
  stopped_at TEXT NOT NULL,
  working INTEGER NOT NULL,
  observed_at TEXT NOT NULL,
  final INTEGER NOT NULL DEFAULT 0,
  final_reason TEXT NULL,
  final_diagnostic TEXT NULL,
  quality TEXT NOT NULL DEFAULT 'pending',
  created_on_server INTEGER NOT NULL DEFAULT 0,
  server_state TEXT NULL,
  last_revision INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX segments_by_session ON segments (session_id, started_at);
CREATE TABLE outbox (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  body_json TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  next_attempt_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id, revision)
);
CREATE TABLE last_committed (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision INTEGER NOT NULL,
  canonical_json TEXT NOT NULL,
  body_json TEXT NOT NULL,
  committed_at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
CREATE TABLE terminal (
  id INTEGER PRIMARY KEY,
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  revision INTEGER NULL,
  code TEXT NOT NULL,
  at TEXT NOT NULL,
  diagnostic TEXT NOT NULL DEFAULT ''
);
CREATE TABLE notices (
  id INTEGER PRIMARY KEY,
  kind TEXT NOT NULL,
  created_at TEXT NOT NULL,
  shown_at TEXT NULL
);
CREATE TABLE owner (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  generation INTEGER NOT NULL,
  pid INTEGER NOT NULL,
  heartbeat TEXT NOT NULL
);
`;

// v2: token usage (§7.6). Transcript read offsets, the per-message ledger and its folded totals,
// subagents and the Agent tool calls that launch them, delegated entries, usage snapshots.
//
// - transcript_offsets: one row per transcript file read by the flusher. `offset` is the byte
//   offset past the last complete line read; `head_hash` the SHA-256 of the first
//   min(HEAD_BYTES, offset) bytes, so a replaced file is noticed and read again from the start.
// - ledger: one row per message.id (a response spans several transcript lines). Its recipient is
//   fixed once: recipient_kind segment | delegated | none, or, until it can be decided,
//   pending (the message is newer than the session's last activity) or turn (no segment, the
//   turn has no delegated entry yet and has not ended). folded = 1: the counters were moved to
//   ledger_totals once the recipient was settled; the row stays as the id -> recipient map.
// - subagents: recipient_kind NULL until the recipient at launch can be decided.
const V2 = `
ALTER TABLE events ADD COLUMN agent_id TEXT NULL;
ALTER TABLE events ADD COLUMN agent_transcript_path TEXT NULL;
CREATE TABLE transcript_offsets (
  path TEXT PRIMARY KEY,
  offset INTEGER NOT NULL,
  size INTEGER NOT NULL,
  head_hash TEXT NOT NULL,
  session_id TEXT NULL,
  status TEXT NULL,
  read_at TEXT NULL
);
CREATE TABLE ledger (
  message_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  agent_id TEXT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_id TEXT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  at TEXT NOT NULL,
  folded INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX ledger_by_recipient ON ledger (recipient_kind, recipient_id);
CREATE INDEX ledger_by_session ON ledger (session_id, recipient_kind);
CREATE TABLE ledger_totals (
  session_id TEXT NOT NULL,
  recipient_kind TEXT NOT NULL,
  recipient_id TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  input INTEGER NOT NULL DEFAULT 0,
  output INTEGER NOT NULL DEFAULT 0,
  cache_creation INTEGER NOT NULL DEFAULT 0,
  cache_read INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (session_id, recipient_kind, recipient_id, provider, model)
);
CREATE TABLE subagents (
  agent_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  launched_at TEXT NULL,
  source TEXT NULL,
  tool_use_id TEXT NULL,
  transcript_path TEXT NULL,
  stopped_at TEXT NULL,
  recipient_kind TEXT NULL,
  recipient_id TEXT NULL
);
CREATE INDEX subagents_by_session ON subagents (session_id);
CREATE TABLE agent_launches (
  tool_use_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  at TEXT NOT NULL
);
CREATE TABLE delegated (
  entry_id TEXT PRIMARY KEY,
  session_id TEXT NOT NULL,
  prompt_id TEXT NULL,
  created_at TEXT NOT NULL,
  event_seq INTEGER NULL
);
CREATE TABLE usage_snapshots (
  target_kind TEXT NOT NULL,
  target_id TEXT NOT NULL,
  usage_json TEXT NOT NULL,
  quality TEXT NOT NULL,
  at TEXT NOT NULL,
  PRIMARY KEY (target_kind, target_id)
);
`;

// v3: the link of each event (consent.ts linkKey): the key under which this machine linked the
// checkout's .tickr.json when the hook journalled it (a hash: no path). The flusher stops a session
// whose last event's link was revoked since (flusher/workspace.ts checkLinks). NULL for the events
// journalled before v3: they are never judged.
const V3 = `
ALTER TABLE events ADD COLUMN link_key TEXT NULL;
`;

export const MIGRATIONS: readonly MigrationStep[] = [(db) => db.exec(V1), (db) => db.exec(V2), (db) => db.exec(V3)];

export function userVersion(db: DatabaseSync): number {
  const row = db.prepare("PRAGMA user_version").get() as { user_version?: number } | undefined;
  return Number(row?.user_version ?? 0);
}

/**
 * Brings the database to the version of `steps` (default: this code's SCHEMA_VERSION), one
 * transaction per step. The version is re-read inside each transaction, so two processes
 * migrating at once apply every step once. A database newer than `steps` is left untouched.
 */
export function migrate(db: DatabaseSync, steps: readonly MigrationStep[] = MIGRATIONS): void {
  for (;;) {
    db.exec("BEGIN IMMEDIATE");
    try {
      const current = userVersion(db);
      if (current >= steps.length) {
        db.exec("COMMIT");
        return;
      }
      steps[current]!(db);
      db.exec(`PRAGMA user_version = ${current + 1}`);
      db.exec("COMMIT");
    } catch (error) {
      try {
        db.exec("ROLLBACK");
      } catch {
        // The transaction may already be gone.
      }
      throw error;
    }
  }
}
