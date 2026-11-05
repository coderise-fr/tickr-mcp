// The "send" stage: the latest due revision of each target -> Tickr, classified by PD-12.
//
//   applied   the revision (and every older one) is acknowledged; a segment the server reports
//             detached or finalised is closed locally (markClosedByServer)
//   retry     same revision, same bytes, later: Retry-After when given (capped at 1 h), else
//             min(2^attempts s, 5 min) with jitter; the pass stops sending (the server or the
//             network is struggling, other targets wait for the next pass)
//   pause     the whole instance stops sending (meta send_pause) and one notice is queued; the
//             workspace stage re-probes it at most once an hour
//   terminal  the target is recorded in `terminal`, its outbox rows are dropped, never re-queued
//
// Nothing is sent before the workspace check (GET /me) succeeded, nor while the instance is
// paused. An unsent creation older than the 30-day ingestion window goes terminal before any send.
//
// Tickr keeps the Tickr-Agent version of a segment's creation request for its entry, and the
// version is only read from the session's transcript (ledger stage). The creation of a segment
// (never acknowledged, not final) therefore waits while its session's version is unknown, at most
// AGENT_VERSION_GRACE_MS after the segment's start; then it goes with claude-code/unknown. The
// held revision is committed and replayed as any other (immutable body), and the stage reports the
// time left as its due. Updates of created segments, final segments and delegated entries never wait.
import { agentHeaderValue } from "../../src/api/agent.js";
import { parseStoredMapping } from "../mapping.js";
import { addNotice } from "../notices.js";
import type { OutboxRow, Store, TargetKind } from "../store/db.js";
import { type AgentApi, type PauseReason, REQUEST_TIMEOUT_MS, type SendOutcome, type UsageBody } from "./api.js";
import { guarded } from "./owner.js";
import type { SegmentBody } from "./revisions.js";
import { markClosedByServer } from "./segmentation.js";
import type { FlusherBoundary, StageRun } from "./stages.js";

export const MAX_BACKOFF_MS = 5 * 60_000;
/** A Retry-After longer than this is not trusted further. */
export const MAX_RETRY_AFTER_MS = 60 * 60_000;
/** A paused instance asks Tickr again at most this often. */
export const PROBE_INTERVAL_MS = 60 * 60_000;
/** Tickr refuses to create a segment that started longer ago than this (§4.3 step 7). */
export const INGESTION_WINDOW_MS = 30 * 24 * 60 * 60_000;
/** The creation of a segment waits for its session's agent version this long after its start, at most. */
export const AGENT_VERSION_GRACE_MS = 2 * 60_000;
/** Due rows read per query. */
export const SEND_BATCH = 50;
/** Session state of a session whose .tickr.json names another workspace than the key's. */
export const STOPPED_MISMATCH = "stopped_mismatch";

export const PAUSE_KEY = "send_pause";
export const WORKSPACE_KEY = "workspace";

export interface SendPause {
  reason: PauseReason;
  since: string;
  /** Not before this time is Tickr asked again. */
  probeAt: string;
  /** The probe succeeded: the next send is allowed, and decides whether the pause is over. */
  probing?: boolean;
}

/** The answer of GET /me, cached once per instance. */
export interface CachedWorkspace {
  workspaceId: string;
  workspaceName: string;
  checkedAt: string;
  skewMs: number;
}

function readJson<T>(store: Store, key: string): T | null {
  const raw = store.getMeta(key);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}

export function readPause(store: Store): SendPause | null {
  return readJson<SendPause>(store, PAUSE_KEY);
}

export function readWorkspace(store: Store): CachedWorkspace | null {
  return readJson<CachedWorkspace>(store, WORKSPACE_KEY);
}

export function writeWorkspace(store: Store, ws: CachedWorkspace): void {
  store.setMeta(WORKSPACE_KEY, JSON.stringify(ws));
}

/**
 * Pauses sending (inside a guarded transaction) until the next probe, an hour later. The notice
 * is queued only when the instance was not already paused for this reason: a re-probe that
 * fails again stays silent.
 */
export function pauseSending(store: Store, reason: PauseReason, now: Date): void {
  const current = readPause(store);
  const probeAt = new Date(now.getTime() + PROBE_INTERVAL_MS).toISOString();
  const pause: SendPause = { reason, since: current?.reason === reason ? current.since : now.toISOString(), probeAt };
  store.setMeta(PAUSE_KEY, JSON.stringify(pause));
  if (current?.reason !== reason) addNotice(store, reason, now);
}

/** The probe of a paused instance succeeded: let the next send decide (inside a guarded transaction). */
export function allowProbeSend(store: Store): void {
  const current = readPause(store);
  if (current !== null) store.setMeta(PAUSE_KEY, JSON.stringify({ ...current, probing: true }));
}

/** Sending is allowed: the workspace is known and the instance is not paused (or is probing). */
export function canSend(store: Store): boolean {
  const pause = readPause(store);
  return readWorkspace(store) !== null && (pause === null || pause.probing === true);
}

export function resumeSending(store: Store): void {
  store.deleteMeta(PAUSE_KEY);
}

/** Capped exponential backoff with equal jitter: after the n-th failure, in [b/2, b], b = min(2^n s, 5 min). */
export function backoffMs(attempts: number, random: () => number = Math.random): number {
  const base = Math.min(2 ** Math.max(1, attempts) * 1000, MAX_BACKOFF_MS);
  const r = Math.min(1, Math.max(0, random()));
  return Math.round(base / 2 + (r * base) / 2);
}

/** The wait before retrying: the server's Retry-After (capped) when given, else the backoff. */
export function retryDelayMs(afterMs: number | null, attempts: number, random?: () => number): number {
  return afterMs === null ? backoffMs(attempts, random) : Math.min(Math.max(0, afterMs), MAX_RETRY_AFTER_MS);
}

/**
 * Stops tracking one session whose mapping names another workspace (inside a guarded
 * transaction): state stopped_mismatch (segmentation then consumes its events without segments),
 * every segment terminal with its outbox rows dropped, one notice.
 */
export function stopMismatchedSession(store: Store, sessionId: string, now: Date): void {
  const row = store.getSession(sessionId);
  if (row?.state === STOPPED_MISMATCH) return;
  store.upsertSession({
    ...(row ?? { sessionId, lastEventSeq: 0, lastEventTime: null, lastUptimeS: null, agentVersion: null, provider: null, lateEvents: 0 }),
    state: STOPPED_MISMATCH,
  });
  for (const seg of store.segmentsForSession(sessionId)) {
    store.deleteOutboxFor("segment", seg.id);
    if (store.isTerminal("segment", seg.id)) continue;
    store.addTerminal({
      targetKind: "segment",
      targetId: seg.id,
      revision: seg.lastRevision > 0 ? seg.lastRevision : null,
      code: "workspace_mismatch",
      at: now.toISOString(),
      diagnostic: "The mapping names another workspace than the API key's.",
    });
  }
  addNotice(store, "workspace_mismatch", now);
}

function recordTerminal(store: Store, row: OutboxRow, code: string, diagnostic: string, now: Date): void {
  store.deleteOutboxFor(row.targetKind, row.targetId);
  if (store.isTerminal(row.targetKind, row.targetId)) return;
  store.addTerminal({ targetKind: row.targetKind, targetId: row.targetId, revision: row.revision, code, at: now.toISOString(), diagnostic });
}

/** The segment's mapping names a workspace other than `workspaceId`. */
function segmentMismatch(store: Store, segmentId: string, workspaceId: string): string | null {
  const seg = store.getSegment(segmentId);
  if (seg === null) return null;
  const version = store.getMapping(seg.mappingVersionId);
  const mapping = version ? parseStoredMapping(version.normalizedJson) : null;
  return mapping !== null && mapping.workspaceId !== workspaceId ? seg.sessionId : null;
}

/**
 * Before any send: unsent creations whose start is older than the ingestion window, and
 * segments whose mapping names another workspace, go terminal (inside a guarded transaction).
 */
function expireBeforeSend(store: Store, workspaceId: string, now: Date): void {
  const oldest = now.getTime() - INGESTION_WINDOW_MS;
  for (const row of store.latestOutbox()) {
    if (row.targetKind !== "segment") continue;
    const mismatched = segmentMismatch(store, row.targetId, workspaceId);
    if (mismatched !== null) {
      stopMismatchedSession(store, mismatched, now);
      continue;
    }
    const seg = store.getSegment(row.targetId);
    if (seg?.createdOnServer) continue;
    const startedAt = Date.parse((JSON.parse(row.bodyJson) as Partial<SegmentBody>).startedAt ?? "");
    if (Number.isFinite(startedAt) && startedAt < oldest) {
      recordTerminal(store, row, "ingestion_window", "Started more than 30 days ago: Tickr no longer accepts it.", now);
    }
  }
}

/**
 * Milliseconds the outbox row still waits for its session's agent version, or null to send it now:
 * only the creation of a live segment (never acknowledged, not final) whose session has no
 * version yet and that started less than AGENT_VERSION_GRACE_MS ago (a start in the future, after
 * the clock moved back, does not wait).
 */
export function versionHoldMs(store: Store, row: OutboxRow, now: Date): number | null {
  if (row.targetKind !== "segment") return null;
  const seg = store.getSegment(row.targetId);
  if (seg === null || seg.createdOnServer || seg.final) return null;
  if ((JSON.parse(row.bodyJson) as Partial<SegmentBody>).final === true) return null;
  if ((store.getSession(seg.sessionId)?.agentVersion ?? null) !== null) return null;
  const elapsed = now.getTime() - Date.parse(seg.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0 || elapsed >= AGENT_VERSION_GRACE_MS) return null;
  return AGENT_VERSION_GRACE_MS - elapsed;
}

/** The segments whose creation waits for the agent version now, and the earliest end of a wait. */
function versionHolds(store: Store, now: Date): { held: Set<string>; dueInMs: number | null } {
  const held = new Set<string>();
  let dueInMs: number | null = null;
  for (const row of store.latestOutbox()) {
    const wait = versionHoldMs(store, row, now);
    if (wait === null) continue;
    held.add(row.targetId);
    dueInMs = dueInMs === null ? wait : Math.min(dueInMs, wait);
  }
  return { held, dueInMs };
}

export interface SendOptions {
  /** Jitter source in [0, 1) (tests inject a fixed one). */
  random?: () => number;
  boundary?: (point: FlusherBoundary) => void;
  /** Real time left; the default counts budgetMs down on the monotonic clock. */
  remainingMs?: () => number;
  timeoutMs?: number;
}

export interface SendResult {
  /** Milliseconds until the next row is due, or null when nothing is pending. */
  dueInMs: number | null;
  /** Rows were due but too little time was left for one request: they are due at once. */
  outOfBudget?: true;
}

async function sendRow(store: Store, api: AgentApi, row: OutboxRow): Promise<SendOutcome> {
  const body = JSON.parse(row.bodyJson) as object;
  if (row.targetKind === "segment") {
    const seg = store.getSegment(row.targetId);
    const session = seg ? store.getSession(seg.sessionId) : null;
    const agent = agentHeaderValue({ name: "claude-code", version: session?.agentVersion ?? "unknown" });
    return api.putSegment(row.targetId, body as SegmentBody, agent);
  }
  return api.putUsage(row.targetId, body as UsageBody);
}

function applyOutcome(store: Store, row: OutboxRow, outcome: SendOutcome, now: Date, random?: () => number): number | null {
  const kind: TargetKind = row.targetKind;
  // Tickr answered about the target itself: whatever paused the instance is over.
  if ((outcome.kind === "applied" || outcome.kind === "terminal") && readPause(store) !== null) resumeSending(store);
  switch (outcome.kind) {
    case "applied": {
      store.deleteOutboxThrough(kind, row.targetId, row.revision);
      if (kind === "segment") {
        store.markSegmentCreated(row.targetId);
        const sent = JSON.parse(row.bodyJson) as Partial<SegmentBody>;
        if (outcome.detached || (outcome.finalized && sent.final !== true)) {
          markClosedByServer(store, row.targetId, outcome.detached ? "detached" : "finalized");
          store.deleteOutboxFor(kind, row.targetId);
        }
      }
      return null;
    }
    case "retry": {
      const attempts = row.attempts + 1;
      const delay = retryDelayMs(outcome.afterMs, attempts, random);
      store.setOutboxAttempt(kind, row.targetId, row.revision, attempts, new Date(now.getTime() + delay).toISOString());
      return delay;
    }
    case "pause":
      pauseSending(store, outcome.reason, now);
      return null;
    case "terminal": {
      recordTerminal(store, row, outcome.code, `Refused by Tickr (${outcome.code}).`, now);
      if (kind === "segment" && outcome.closesSegment) {
        markClosedByServer(store, row.targetId, outcome.code === "segment_detached" ? "detached" : "finalized");
      }
      if (outcome.code === "not_project_member") addNotice(store, "not_project_member", now);
      return null;
    }
  }
}

/**
 * Sends the latest due revision of each target, within the budget. Every state change is a
 * guarded transaction of generation `gen`; no transaction is open during a request.
 */
export async function sendDue(store: Store, gen: number, api: AgentApi, now: () => Date, budgetMs: number, opts: SendOptions = {}): Promise<SendResult> {
  const endAt = performance.now() + budgetMs;
  const remaining = opts.remainingMs ?? (() => endAt - performance.now());
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const inTx = <T>(fn: () => T): T => guarded(store, gen, now().toISOString(), fn);

  const workspace = readWorkspace(store);
  if (workspace === null || !canSend(store)) return { dueInMs: null };
  inTx(() => expireBeforeSend(store, workspace.workspaceId, now()));

  // Fixed for the pass: a wait that ends meanwhile is sent by the next pass (due at once).
  const { held } = versionHolds(store, now());
  const waiting = (row: OutboxRow) => row.targetKind === "segment" && held.has(row.targetId);
  for (;;) {
    // At most held.size of the rows read wait: an empty remainder means nothing else is due.
    const rows = store.dueOutbox(now().toISOString(), SEND_BATCH + held.size).filter((row) => !waiting(row));
    if (rows.length === 0) break;
    for (const row of rows) {
      // Too little time left for one more request: the rest is due at once, for a successor.
      if (remaining() < timeoutMs) return { dueInMs: 0, outOfBudget: true };
      if (store.isTerminal(row.targetKind, row.targetId)) {
        inTx(() => store.deleteOutboxFor(row.targetKind, row.targetId));
        continue;
      }
      const outcome = await sendRow(store, api, row);
      opts.boundary?.("sent");
      const delay = inTx(() => applyOutcome(store, row, outcome, now(), opts.random));
      if (outcome.kind === "applied") opts.boundary?.("acknowledged");
      if (outcome.kind === "retry") return { dueInMs: delay };
      if (outcome.kind === "pause") return { dueInMs: null };
    }
  }
  return { dueInMs: nextDueMs(store, now()) };
}

/** Milliseconds until the next row is due (a version wait counting as its time left), or null. */
function nextDueMs(store: Store, now: Date): number | null {
  const holds = versionHolds(store, now);
  let due = holds.dueInMs;
  for (const row of store.latestOutbox()) {
    if (row.targetKind === "segment" && holds.held.has(row.targetId)) continue;
    const wait = Math.max(0, Date.parse(row.nextAttemptAt) - now.getTime());
    due = due === null ? wait : Math.min(due, wait);
  }
  return due;
}

export function sendStage(opts: Pick<SendOptions, "random"> = {}): StageRun {
  return async (ctx) => {
    const { dueInMs, outOfBudget } = await sendDue(ctx.store, ctx.generation, ctx.api, ctx.now, ctx.remainingMs(), {
      ...opts,
      boundary: ctx.boundary,
      remainingMs: ctx.remainingMs,
    });
    if (outOfBudget) return { dueInMs: 0, outOfBudget };
    return dueInMs === null ? {} : { dueInMs };
  };
}
