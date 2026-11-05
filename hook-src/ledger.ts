// The per-message ledger (§7.6) and the "ledger" flusher stage.
//
// ledger: message.id -> { recipient, usage }. The recipient is fixed by the first insert that
// decides it; later lines of the same message only raise its counters (PD-16). Two provisional
// kinds exist until the recipient can be decided:
//   pending  the message is later than its session's last journalled activity (attribution.settled)
//            or its subagent's launch recipient is not known yet;
//   turn     no segment, and its turn has neither a delegated entry nor ended yet.
// A recipient refused by Tickr (terminal) keeps its rows: its tokens are never re-attributed.
//
// Once a recipient is settled (its last committed revision is final for a segment, carries
// usageQuality "complete" and was acknowledged), its rows are folded: their counters move to
// ledger_totals and the rows stay as the id -> recipient map, so a rescan never counts a message
// twice nor moves it. Rows live as long as their session (bounds.ts retention) and are never
// deleted while their recipient has a pending revision.
//
// The stage runs between segmentation and revisions. For each active session with recent
// activity (an event in the last 24 h, or an open segment) it reads the main transcript (the
// events' transcript_path) and the subagent transcripts (<session>/subagents/agent-*.jsonl and the
// hook's agent_transcript_path) outside any transaction, then records the messages, the read
// offsets, the subagents and the session's agent version in one guarded transaction.
import {
  type AttributionContext,
  buildTurns,
  delegatedByTurn,
  type Recipient,
  recipientAt,
  recipientFor,
  resolveRecipient,
  settled,
} from "./attribution.js";
import type { Provider, UsageRow } from "./flusher/revisions.js";
import { ACTIVE_SESSION } from "./flusher/segmentation.js";
import type { StageRun } from "./flusher/stages.js";
import { guarded } from "./flusher/owner.js";
import type { EventRow, Store } from "./store/db.js";
import type { AgentLaunch, AssistantUsage } from "./transcript/parser.js";
import { agentIdOfPath, commitRead, readSubagentMeta, readTranscript, subagentTranscripts, type TranscriptRead } from "./transcript/reader.js";

/** A recipient as stored: decided (a Recipient or null for nobody) or not decided yet. */
export type LedgerRecipient = Recipient | null | "pending";
export type RecipientKind = "segment" | "turn" | "delegated" | "none" | "pending";

/** Sessions whose last event is older than this, and that have no open segment, are not read. */
export const LEDGER_WINDOW_MS = 24 * 3_600_000;

export interface LedgerRow {
  messageId: string;
  sessionId: string;
  agentId: string | null;
  recipientKind: RecipientKind;
  recipientId: string | null;
  provider: string;
  model: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  at: string;
  folded: boolean;
}

export interface SubagentRow {
  agentId: string;
  sessionId: string;
  launchedAt: string | null;
  /** hook (SubagentStart), tool_call (Agent tool call via .meta.json) or timestamp (first message). */
  source: string | null;
  toolUseId: string | null;
  transcriptPath: string | null;
  stoppedAt: string | null;
  /** null: not decided yet. */
  recipientKind: Exclude<RecipientKind, "pending"> | null;
  recipientId: string | null;
}

type Row = Record<string, unknown>;
const str = (v: unknown) => String(v);
const optStr = (v: unknown) => (v === null || v === undefined ? null : String(v));

function encode(r: LedgerRecipient): { kind: RecipientKind; id: string | null } {
  if (r === "pending") return { kind: "pending", id: null };
  if (r === null) return { kind: "none", id: null };
  if (r.kind === "segment") return { kind: "segment", id: r.id };
  if (r.kind === "delegated") return { kind: "delegated", id: r.entryId };
  return { kind: "turn", id: r.promptId };
}

/** The stored recipient of a row (null for nobody, "pending" when not decided). */
export function decode(kind: string, id: string | null, sessionId: string): LedgerRecipient {
  if (kind === "segment" && id !== null) return { kind: "segment", id };
  if (kind === "delegated" && id !== null) return { kind: "delegated", entryId: id };
  if (kind === "turn" && id !== null) return { kind: "turn", sessionId, promptId: id };
  if (kind === "pending") return "pending";
  return null;
}

function toLedger(r: Row): LedgerRow {
  return {
    messageId: str(r.message_id),
    sessionId: str(r.session_id),
    agentId: optStr(r.agent_id),
    recipientKind: str(r.recipient_kind) as RecipientKind,
    recipientId: optStr(r.recipient_id),
    provider: str(r.provider),
    model: str(r.model),
    input: Number(r.input),
    output: Number(r.output),
    cacheCreation: Number(r.cache_creation),
    cacheRead: Number(r.cache_read),
    at: str(r.at),
    folded: Number(r.folded) !== 0,
  };
}

function toSubagent(r: Row): SubagentRow {
  return {
    agentId: str(r.agent_id),
    sessionId: str(r.session_id),
    launchedAt: optStr(r.launched_at),
    source: optStr(r.source),
    toolUseId: optStr(r.tool_use_id),
    transcriptPath: optStr(r.transcript_path),
    stoppedAt: optStr(r.stopped_at),
    recipientKind: optStr(r.recipient_kind) as SubagentRow["recipientKind"],
    recipientId: optStr(r.recipient_id),
  };
}

export interface RecordOptions {
  provider?: Provider;
  now?: Date;
}

const UPSERT = `INSERT INTO ledger (message_id, session_id, agent_id, recipient_kind, recipient_id, provider, model, input, output,
    cache_creation, cache_read, at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  ON CONFLICT (message_id) DO UPDATE SET
    input = CASE WHEN ledger.folded = 1 THEN ledger.input ELSE MAX(ledger.input, excluded.input) END,
    output = CASE WHEN ledger.folded = 1 THEN ledger.output ELSE MAX(ledger.output, excluded.output) END,
    cache_creation = CASE WHEN ledger.folded = 1 THEN ledger.cache_creation ELSE MAX(ledger.cache_creation, excluded.cache_creation) END,
    cache_read = CASE WHEN ledger.folded = 1 THEN ledger.cache_read ELSE MAX(ledger.cache_read, excluded.cache_read) END,
    at = MIN(ledger.at, excluded.at),
    recipient_id = CASE WHEN ledger.recipient_kind IN ('pending', 'turn') AND excluded.recipient_kind <> 'pending'
      THEN excluded.recipient_id ELSE ledger.recipient_id END,
    recipient_kind = CASE WHEN ledger.recipient_kind IN ('pending', 'turn') AND excluded.recipient_kind <> 'pending'
      THEN excluded.recipient_kind ELSE ledger.recipient_kind END`;

/** recordMessage without the guard (inside the caller's guarded transaction). */
function upsertMessage(store: Store, sessionId: string, msg: AssistantUsage, recipient: LedgerRecipient, provider: Provider): void {
  const { kind, id } = encode(recipient);
  store.db
    .prepare(UPSERT)
    .run(msg.messageId, sessionId, msg.agentId ?? null, kind, id, provider, msg.model, msg.input, msg.output, msg.cacheCreation, msg.cacheRead, msg.timestamp);
}

/**
 * Records one message (guarded by the flusher's generation). A new message gets `recipient`; a
 * known one keeps its recipient unless it was provisional (pending / turn) and `recipient` is
 * not pending, and its counters only rise (unless folded).
 */
export function recordMessage(
  store: Store,
  gen: number,
  sessionId: string,
  msg: AssistantUsage,
  recipient: LedgerRecipient,
  opts: RecordOptions = {},
): void {
  guarded(store, gen, (opts.now ?? new Date()).toISOString(), () => upsertMessage(store, sessionId, msg, recipient, opts.provider ?? "anthropic"));
}

/** Decides a provisional row (inside the caller's transaction); false when it stays as it is. */
function setRecipient(store: Store, messageId: string, recipient: LedgerRecipient): boolean {
  if (recipient === "pending") return false;
  const { kind, id } = encode(recipient);
  const changes = store.db
    .prepare(
      `UPDATE ledger SET recipient_kind = ?, recipient_id = ? WHERE message_id = ? AND recipient_kind IN ('pending', 'turn')
         AND (recipient_kind <> ? OR recipient_id IS NOT ?)`,
    )
    .run(kind, id, messageId, kind, id).changes;
  return Number(changes) > 0;
}

export function getLedgerRow(store: Store, messageId: string): LedgerRow | null {
  const r = store.db.prepare("SELECT * FROM ledger WHERE message_id = ?").get(messageId) as Row | undefined;
  return r ? toLedger(r) : null;
}

export function ledgerRowsFor(store: Store, sessionId: string): LedgerRow[] {
  return (store.db.prepare("SELECT * FROM ledger WHERE session_id = ? ORDER BY at, message_id").all(sessionId) as Row[]).map(toLedger);
}

function provisionalRows(store: Store, sessionId: string): LedgerRow[] {
  return (
    store.db.prepare("SELECT * FROM ledger WHERE session_id = ? AND recipient_kind IN ('pending', 'turn') ORDER BY at, message_id").all(sessionId) as Row[]
  ).map(toLedger);
}

export function subagentsFor(store: Store, sessionId: string): SubagentRow[] {
  return (store.db.prepare("SELECT * FROM subagents WHERE session_id = ? ORDER BY agent_id").all(sessionId) as Row[]).map(toSubagent);
}

function recipientWhere(recipient: Recipient): { sql: string; params: string[] } {
  const { kind, id } = encode(recipient);
  if (recipient.kind === "turn") return { sql: "recipient_kind = ? AND recipient_id = ? AND session_id = ?", params: [kind, id!, recipient.sessionId] };
  return { sql: "recipient_kind = ? AND recipient_id = ?", params: [kind, id!] };
}

/**
 * Token totals of a recipient, one row per (provider, model) sorted by provider then model:
 * its unfolded ledger rows plus its folded totals. Not clamped nor capped (C4 applies PD-17).
 */
export function totalsFor(store: Store, recipient: Recipient): UsageRow[] {
  const { sql, params } = recipientWhere(recipient);
  const rows = store.db
    .prepare(
      `SELECT provider, model, SUM(input) AS input, SUM(output) AS output, SUM(cache_creation) AS cache_creation, SUM(cache_read) AS cache_read
       FROM (SELECT provider, model, input, output, cache_creation, cache_read FROM ledger WHERE folded = 0 AND ${sql}
             UNION ALL
             SELECT provider, model, input, output, cache_creation, cache_read FROM ledger_totals WHERE ${sql})
       GROUP BY provider, model ORDER BY provider, model`,
    )
    .all(...params, ...params) as Row[];
  return rows.map((r) => ({
    provider: str(r.provider) as Provider,
    model: str(r.model),
    inputTokens: Number(r.input),
    outputTokens: Number(r.output),
    cacheCreationInputTokens: Number(r.cache_creation),
    cacheReadInputTokens: Number(r.cache_read),
  }));
}

/**
 * Folds the rows of every settled recipient into ledger_totals (inside the caller's guarded
 * transaction): the last committed revision of its target carries usageQuality "complete" (and
 * final: true for a segment) and has no pending revision. Returns the rows folded.
 */
export function foldSettled(store: Store): number {
  const settledTargets = store.db
    .prepare(
      `SELECT DISTINCT l.session_id, l.recipient_kind, l.recipient_id FROM ledger l
       JOIN last_committed c ON c.target_kind = l.recipient_kind AND c.target_id = l.recipient_id
       WHERE l.folded = 0 AND json_extract(c.body_json, '$.usageQuality') = 'complete'
         AND (l.recipient_kind <> 'segment' OR json_extract(c.body_json, '$.final') = 1)
         AND NOT EXISTS (SELECT 1 FROM outbox o WHERE o.target_kind = l.recipient_kind AND o.target_id = l.recipient_id)`,
    )
    .all() as Row[];
  let folded = 0;
  for (const t of settledTargets) {
    const params = [str(t.session_id), str(t.recipient_kind), str(t.recipient_id)];
    store.db
      .prepare(
        `INSERT INTO ledger_totals (session_id, recipient_kind, recipient_id, provider, model, input, output, cache_creation, cache_read)
         SELECT session_id, recipient_kind, recipient_id, provider, model, SUM(input), SUM(output), SUM(cache_creation), SUM(cache_read)
         FROM ledger WHERE folded = 0 AND session_id = ? AND recipient_kind = ? AND recipient_id = ?
         GROUP BY provider, model
         ON CONFLICT (session_id, recipient_kind, recipient_id, provider, model) DO UPDATE SET
           input = ledger_totals.input + excluded.input, output = ledger_totals.output + excluded.output,
           cache_creation = ledger_totals.cache_creation + excluded.cache_creation, cache_read = ledger_totals.cache_read + excluded.cache_read`,
      )
      .run(...params);
    folded += Number(
      store.db
        .prepare(
          `UPDATE ledger SET folded = 1, input = 0, output = 0, cache_creation = 0, cache_read = 0
           WHERE folded = 0 AND session_id = ? AND recipient_kind = ? AND recipient_id = ?`,
        )
        .run(...params).changes,
    );
  }
  return folded;
}

// The stage

/** Sessions the stage reads: active, with an event since `sinceIso` or an open segment. */
export function sessionsToRead(store: Store, sinceIso: string): string[] {
  return (
    store.db
      .prepare(
        `SELECT s.session_id FROM sessions s WHERE s.state = ? AND (s.last_event_time >= ?
           OR EXISTS (SELECT 1 FROM segments g WHERE g.session_id = s.session_id AND g.final = 0))
         ORDER BY s.session_id`,
      )
      .all(ACTIVE_SESSION, sinceIso) as Row[]
  ).map((r) => str(r.session_id));
}

function mainTranscripts(store: Store, sessionId: string): string[] {
  return store.transcriptPaths(sessionId).filter((p) => agentIdOfPath(p) === null);
}

interface SubagentFile {
  agentId: string;
  path: string;
}

function subagentFiles(mains: readonly string[], events: readonly EventRow[]): SubagentFile[] {
  const byAgent = new Map<string, string>();
  for (const main of mains) for (const f of subagentTranscripts(main)) byAgent.set(f.agentId, f.path);
  for (const ev of events) {
    if (ev.agentTranscriptPath === null) continue;
    const agentId = ev.agentId ?? agentIdOfPath(ev.agentTranscriptPath);
    if (agentId !== null && !byAgent.has(agentId)) byAgent.set(agentId, ev.agentTranscriptPath);
  }
  return [...byAgent].map(([agentId, path]) => ({ agentId, path }));
}

function upsertSubagent(store: Store, row: SubagentRow): void {
  store.db
    .prepare(
      `INSERT INTO subagents (agent_id, session_id, launched_at, source, tool_use_id, transcript_path, stopped_at, recipient_kind, recipient_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (agent_id) DO UPDATE SET launched_at = excluded.launched_at, source = excluded.source, tool_use_id = excluded.tool_use_id,
         transcript_path = excluded.transcript_path, stopped_at = excluded.stopped_at, recipient_kind = excluded.recipient_kind,
         recipient_id = excluded.recipient_id`,
    )
    .run(row.agentId, row.sessionId, row.launchedAt, row.source, row.toolUseId, row.transcriptPath, row.stoppedAt, row.recipientKind, row.recipientId);
}

function launchTime(store: Store, toolUseId: string): string | null {
  const r = store.db.prepare("SELECT at FROM agent_launches WHERE tool_use_id = ?").get(toolUseId) as Row | undefined;
  return r ? str(r.at) : null;
}

function recordLaunches(store: Store, sessionId: string, launches: readonly AgentLaunch[]): void {
  const insert = store.db.prepare("INSERT INTO agent_launches (tool_use_id, session_id, at) VALUES (?, ?, ?) ON CONFLICT (tool_use_id) DO NOTHING");
  for (const l of launches) insert.run(l.toolUseId, sessionId, l.timestamp);
}

interface SubagentInput {
  file: SubagentFile;
  read: TranscriptRead;
  /** The launching tool_use id from .meta.json, read outside the transaction. */
  toolUseId: string | null;
}

/**
 * Brings the session's subagent rows up to date (PD-14): launch time from SubagentStart, else
 * from the Agent tool call named by .meta.json, else the first message; the recipient at that
 * instant once it is settled. Returns the rows.
 */
function refreshSubagents(store: Store, sessionId: string, events: readonly EventRow[], subs: readonly SubagentInput[], ctx: AttributionContext): Map<string, SubagentRow> {
  const rows = new Map(subagentsFor(store, sessionId).map((r) => [r.agentId, r]));
  const blank = (agentId: string): SubagentRow => ({
    agentId,
    sessionId,
    launchedAt: null,
    source: null,
    toolUseId: null,
    transcriptPath: null,
    stoppedAt: null,
    recipientKind: null,
    recipientId: null,
  });
  for (const ev of events) {
    if (ev.agentId === null || (ev.type !== "SubagentStart" && ev.type !== "SubagentStop")) continue;
    const row = { ...(rows.get(ev.agentId) ?? blank(ev.agentId)) };
    if (ev.type === "SubagentStart" && row.source !== "hook") {
      row.launchedAt = ev.localTime;
      row.source = "hook";
    }
    if (ev.type === "SubagentStop") row.stoppedAt = ev.localTime;
    if (ev.agentTranscriptPath !== null) row.transcriptPath = ev.agentTranscriptPath;
    rows.set(ev.agentId, row);
  }
  for (const { file, read, toolUseId } of subs) {
    const row = { ...(rows.get(file.agentId) ?? blank(file.agentId)) };
    row.transcriptPath ??= file.path;
    if (row.source !== "hook" && toolUseId !== null) {
      const at = launchTime(store, toolUseId);
      row.toolUseId = toolUseId;
      if (at !== null) {
        row.launchedAt = at;
        row.source = "tool_call";
      }
    }
    if (row.launchedAt === null) {
      const first = read.messages.map((m) => m.timestamp).sort()[0];
      if (first !== undefined) {
        row.launchedAt = first;
        row.source = "timestamp";
      }
    }
    rows.set(file.agentId, row);
  }
  for (const row of rows.values()) {
    if (row.recipientKind === null && row.launchedAt !== null && settled(row.launchedAt, ctx.segments)) {
      const { kind, id } = encode(recipientAt(row.launchedAt, ctx));
      row.recipientKind = kind as SubagentRow["recipientKind"];
      row.recipientId = id;
    } else if (row.recipientKind === "turn") {
      const { kind, id } = encode(resolveRecipient(decode("turn", row.recipientId, sessionId) as Recipient, ctx));
      row.recipientKind = kind as SubagentRow["recipientKind"];
      row.recipientId = id;
    }
    upsertSubagent(store, row);
  }
  return rows;
}

/** The recipient of a message now, or "pending" while it cannot be decided yet. */
function decide(msg: Pick<AssistantUsage, "timestamp" | "agentId">, ctx: AttributionContext, undecidedAgents: ReadonlySet<string>): LedgerRecipient {
  if (msg.agentId !== undefined) {
    if (undecidedAgents.has(msg.agentId)) return "pending";
    if (ctx.subagents.has(msg.agentId)) return recipientFor(msg, ctx);
  }
  return settled(msg.timestamp, ctx.segments) ? recipientFor(msg, ctx) : "pending";
}

interface SessionReads {
  mains: TranscriptRead[];
  subs: SubagentInput[];
}

/** Reads the session's transcripts (no transaction held). */
export function readSession(store: Store, sessionId: string, now: Date): SessionReads & { events: EventRow[] } {
  const events = store.attributionEvents(sessionId);
  const mainPaths = mainTranscripts(store, sessionId);
  const mains = mainPaths.map((p) => readTranscript(store, p, { sessionId, now }));
  const subs = subagentFiles(mainPaths, events).map((file) => {
    const read = readTranscript(store, file.path, { sessionId, now });
    for (const m of read.messages) if (m.agentId === undefined) m.agentId = file.agentId;
    return { file, read, toolUseId: readSubagentMeta(file.path)?.toolUseId ?? null };
  });
  return { events, mains, subs };
}

/**
 * Records one session's reads (inside the caller's guarded transaction): launches, subagents,
 * messages, read offsets, the agent version; then decides the provisional rows that can be.
 */
export function recordSession(store: Store, sessionId: string, reads: SessionReads & { events: EventRow[] }): void {
  const session = store.getSession(sessionId);
  const provider = (session?.provider ?? "anthropic") as Provider;
  const turns = buildTurns(sessionId, reads.events);
  const ctx: AttributionContext = {
    segments: store.segmentsForSession(sessionId),
    turns,
    subagents: new Map(),
    delegatedByTurn: delegatedByTurn(reads.events, turns),
  };
  for (const read of reads.mains) recordLaunches(store, sessionId, read.launches);

  const undecided = new Set<string>();
  for (const row of refreshSubagents(store, sessionId, reads.events, reads.subs, ctx).values()) {
    if (row.recipientKind === null) undecided.add(row.agentId);
    else ctx.subagents.set(row.agentId, decode(row.recipientKind, row.recipientId, sessionId) as Recipient | null);
  }

  for (const read of [...reads.mains, ...reads.subs.map((s) => s.read)]) {
    for (const msg of read.messages) upsertMessage(store, sessionId, msg, decide(msg, ctx, undecided), provider);
    commitRead(store, read);
  }

  // Provisional rows (new or from earlier passes) decided now when they can be.
  for (const row of provisionalRows(store, sessionId)) {
    if (row.recipientKind === "pending") {
      const msg = row.agentId === null ? { timestamp: row.at } : { timestamp: row.at, agentId: row.agentId };
      setRecipient(store, row.messageId, decide(msg, ctx, undecided));
    } else if (row.recipientKind === "turn") {
      setRecipient(store, row.messageId, resolveRecipient(decode("turn", row.recipientId, sessionId) as Recipient, ctx));
    }
  }

  const version = [...reads.mains].reverse().find((r) => r.version !== undefined)?.version;
  if (version !== undefined && session !== null) store.setSessionAgentVersion(sessionId, version.slice(0, 64));
}

export const ledgerStage: StageRun = (ctx) => {
  const now = ctx.now();
  for (const sessionId of sessionsToRead(ctx.store, new Date(now.getTime() - LEDGER_WINDOW_MS).toISOString())) {
    if (ctx.remainingMs() <= 0) return { dueInMs: 0 };
    const reads = readSession(ctx.store, sessionId, now);
    ctx.guarded(() => recordSession(ctx.store, sessionId, reads));
  }
  ctx.guarded(() => foldSettled(ctx.store));
  return {};
};
