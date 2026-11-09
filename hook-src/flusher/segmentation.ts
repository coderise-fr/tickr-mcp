// The "segmentation" stage: journalled events -> segment rows, through the pure reducer of
// segmenter.ts. Each session is read from its cursor (sessions.last_event_seq) in batches; a batch,
// its segment changes and the moved cursor commit together in one guarded transaction, so a crash
// never applies an event twice. Then every open segment idle for idle_minutes is finalised, and the
// stage is due again at the next idle deadline.
//
// Segment rows: an open segment has final = 0 and stopped_at = last_activity_at; a finalised one
// has final = 1, its final stopped_at (possibly a synthetic midnight / 23 h bound, stored once and
// replayed unchanged), final_reason and, for a clock-jump split, final_diagnostic.
import { uuidv7 } from "../ids.js";
import type { SegmentRow, SessionRow, Store } from "../store/db.js";
import {
  applyEvent,
  idleDueInMs,
  newSessionState,
  onWake,
  type OpenSegment,
  type SegmentChange,
  type SegmenterConfig,
  type SessionState,
} from "./segmenter.js";
import { clearPendingRename, mayRenameInPlace, writePendingRename } from "./rename.js";
import type { StageRun } from "./stages.js";

/** Events read per guarded transaction. */
export const SEGMENTATION_BATCH = 500;
/** Sessions in any other state (stopped_mismatch, unlinked: set by the workspace stage) consume events without segments. */
export const ACTIVE_SESSION = "active";

export type ServerClosedState = "detached" | "finalized";

function newSessionRow(sessionId: string): SessionRow {
  return { sessionId, lastEventSeq: 0, lastEventTime: null, lastUptimeS: null, state: ACTIVE_SESSION, agentVersion: null, provider: null, lateEvents: 0 };
}

function toOpen(seg: SegmentRow): OpenSegment {
  return {
    id: seg.id,
    mappingVersionId: seg.mappingVersionId,
    startedAt: seg.startedAt,
    lastActivityAt: seg.lastActivityAt,
    working: seg.working,
    observedAt: seg.observedAt,
  };
}

/** The reducer state of a session, rebuilt from its row and its open segment row. */
export function loadSessionState(store: Store, sessionId: string): { row: SessionRow; state: SessionState } {
  const row = store.getSession(sessionId) ?? newSessionRow(sessionId);
  const open = store.openSegmentFor(sessionId);
  return {
    row,
    state: {
      ...newSessionState(sessionId),
      open: open ? toOpen(open) : null,
      lastEventTime: row.lastEventTime,
      lastUptimeS: row.lastUptimeS,
      lateEvents: row.lateEvents,
    },
  };
}

/** Writes the reducer's changes to the segments table (inside the caller's transaction). */
export function applyChanges(store: Store, sessionId: string, changes: readonly SegmentChange[]): void {
  for (const c of changes) {
    if (c.kind === "open") {
      store.upsertSegment({
        id: c.seg.id,
        sessionId,
        mappingVersionId: c.seg.mappingVersionId,
        startedAt: c.seg.startedAt,
        lastActivityAt: c.seg.lastActivityAt,
        stoppedAt: c.seg.lastActivityAt,
        working: c.seg.working,
        observedAt: c.seg.observedAt,
        final: false,
        finalReason: null,
        finalDiagnostic: null,
        quality: "pending",
        createdOnServer: false,
        serverState: null,
        lastRevision: 0,
      });
      continue;
    }
    const row = store.getSegment(c.kind === "rename" ? c.seg.id : c.id);
    if (row === null || row.final) continue;
    if (c.kind === "rename") {
      const s = c.seg;
      store.upsertSegment({ ...row, mappingVersionId: s.mappingVersionId, lastActivityAt: s.lastActivityAt, stoppedAt: s.lastActivityAt, working: s.working, observedAt: s.observedAt });
      // Nothing committed yet: the server holds nothing of the segment, nothing to confirm.
      if (row.lastRevision > 0) {
        writePendingRename(store, s.id, {
          fromMappingVersionId: c.previous.mappingVersionId,
          at: c.at,
          lastActivityAt: c.previous.lastActivityAt,
          observedAt: c.previous.observedAt,
          baseRevision: row.lastRevision,
        });
      }
    } else if (c.kind === "extend") {
      store.upsertSegment({ ...row, lastActivityAt: c.lastActivityAt, stoppedAt: c.lastActivityAt, working: c.working, observedAt: c.observedAt });
    } else {
      store.upsertSegment({ ...row, stoppedAt: c.stoppedAt, working: false, final: true, finalReason: c.reason, finalDiagnostic: c.diagnostic ?? null });
    }
  }
}

/**
 * Applies up to `limit` events of one session after its cursor and moves the cursor past them.
 * Must run inside a guarded transaction. Returns how many events were read.
 */
export function segmentSession(store: Store, sessionId: string, cfg: SegmenterConfig, limit = SEGMENTATION_BATCH): number {
  const { row, state } = loadSessionState(store, sessionId);
  const events = store.sessionEventsAfter(sessionId, row.lastEventSeq, limit);
  if (events.length === 0) return 0;
  let s = state;
  let provider = row.provider;
  for (const ev of events) {
    if (row.state === ACTIVE_SESSION) {
      const out = applyEvent(s, ev, cfg);
      s = out.state;
      applyChanges(store, sessionId, out.changes);
    }
    if (ev.provider !== null) provider = ev.provider;
  }
  store.upsertSession({
    ...row,
    lastEventSeq: events[events.length - 1]!.seq,
    lastEventTime: s.lastEventTime,
    lastUptimeS: s.lastUptimeS,
    lateEvents: s.lateEvents,
    provider,
  });
  return events.length;
}

/**
 * Wake-up: finalises every open segment idle for idleMs (inside a guarded transaction). Returns
 * the milliseconds until the next idle deadline of the segments still open, or null.
 */
export function finalizeIdle(store: Store, now: Date, idleMs: number): number | null {
  let due: number | null = null;
  for (const seg of store.openSegments()) {
    const { state } = loadSessionState(store, seg.sessionId);
    const out = onWake(state, now, { idleMs });
    applyChanges(store, seg.sessionId, out.changes);
    const left = idleDueInMs(out.state, now, { idleMs });
    if (left !== null) due = due === null ? left : Math.min(due, left);
  }
  return due;
}

/**
 * After segment_detached / segment_finalized (B8, inside its guarded transaction): the segment is
 * closed locally (final, reason server_closed unless it was already final) and keeps the server
 * state; the session's next activity opens a new segment (segmenter.closedByServer).
 */
export function markClosedByServer(store: Store, segmentId: string, serverState: ServerClosedState): void {
  const row = store.getSegment(segmentId);
  if (row === null) return;
  store.upsertSegment({ ...row, working: false, final: true, finalReason: row.final ? row.finalReason : "server_closed", serverState });
  // The server closed it: a rename of it waiting for an answer is over.
  clearPendingRename(store, segmentId);
}

export const segmentationStage: StageRun = (ctx) => {
  const idleMs = ctx.config.idleMinutes * 60_000;
  const cfg: SegmenterConfig = {
    idleMs,
    newId: () => uuidv7(ctx.now().getTime()),
    renameInPlace: (open, mappingVersionId) => mayRenameInPlace(ctx.store, open.id, open.mappingVersionId, mappingVersionId, ctx.now()),
  };
  for (const sessionId of ctx.store.pendingEventSessions()) {
    for (;;) {
      if (ctx.remainingMs() <= 0) return { dueInMs: 0 };
      const read = ctx.guarded(() => segmentSession(ctx.store, sessionId, cfg));
      if (read < SEGMENTATION_BATCH) break;
    }
  }
  const due = ctx.guarded(() => finalizeIdle(ctx.store, ctx.now(), idleMs));
  return due === null ? {} : { dueInMs: due };
};
