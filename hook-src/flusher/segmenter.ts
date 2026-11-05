// Segmentation reducer: one session's journalled hook events become agent_session segments.
// Pure: no I/O, no clock of its own (wall time and uptime come from the events, `now` from the
// caller), ids from cfg.newId. The segmentation stage (segmentation.ts) persists its output.
//
// Rules (§7.5, PD-10, PD-11):
// - UserPromptSubmit / PostToolUse open a segment when none is open; Stop extends one (working
//   false) but never opens one; SessionEnd finalises the open segment at its last activity, with
//   no extension; every other event only moves the session's clock cursor.
// - Idle: an event (or a wake-up) at least idleMs after the last activity finalises the segment
//   at that last activity.
// - The segment is split, the next one starting exactly at the boundary, at the next UTC
//   midnight of its start (00:00:00Z) or 23 h after its start, whichever comes first, and when
//   an activity event carries another mapping version (split at the event).
// - Clock: each event carries wall time and uptime. Uptime decreased ⇒ reboot, nothing concluded
//   (the idle rule applies). Otherwise |Δwall − Δuptime| > 2 min ⇒ proven jump: the segment is
//   finalised at its last activity and the next one starts at the new event time.
// - Late events (wall time and uptime both before the session's cursor, e.g. a fallback file
//   imported after newer events) extend the open segment only when they fall inside it;
//   otherwise they are counted in lateEvents and never re-segmented.
import type { EventRow } from "../store/db.js";

/** Longest |Δwall − Δuptime| between two events of one boot that is not a clock jump. */
export const CLOCK_TOLERANCE_MS = 2 * 60_000;
/** A segment is split before it reaches this duration. */
export const MAX_SEGMENT_MS = 23 * 3_600_000;

export const DRIFT_DIAGNOSTIC = "clock drift or possible reboot";
export const BACKWARDS_DIAGNOSTIC = "wall clock moved backwards";

export interface OpenSegment {
  id: string;
  mappingVersionId: number;
  startedAt: string;
  lastActivityAt: string;
  working: boolean;
  observedAt: string;
}

export interface SessionState {
  sessionId: string;
  open: OpenSegment | null;
  /** Wall time and uptime of the last event processed in order (the clock cursor). */
  lastEventTime: string | null;
  lastUptimeS: number | null;
  lateEvents: number;
}

export type FinalReason = "idle" | "midnight" | "max_duration" | "mapping" | "clock_jump" | "session_end" | "server_closed";

export type SegmentChange =
  | { kind: "open"; seg: OpenSegment }
  | { kind: "extend"; id: string; lastActivityAt: string; working: boolean; observedAt: string }
  | { kind: "finalize"; id: string; stoppedAt: string; reason: FinalReason; diagnostic?: string };

export interface SegmenterConfig {
  idleMs: number;
  newId: () => string;
}

/** The event fields the reducer reads. */
export type SegmentEvent = Pick<EventRow, "type" | "localTime" | "uptimeS" | "mappingVersionId">;

export interface Reduced {
  state: SessionState;
  changes: SegmentChange[];
}

const OPENING = new Set(["UserPromptSubmit", "PostToolUse"]);

export function newSessionState(sessionId: string): SessionState {
  return { sessionId, open: null, lastEventTime: null, lastUptimeS: null, lateEvents: 0 };
}

const ms = (iso: string): number => Date.parse(iso);
const iso = (t: number): string => new Date(t).toISOString();

/** First instant the open segment may not run past: next UTC midnight of its start, or start + 23 h. */
export function segmentBoundary(seg: Pick<OpenSegment, "startedAt">): { at: number; reason: "midnight" | "max_duration" } {
  const start = new Date(seg.startedAt);
  const midnight = Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate() + 1);
  const max = start.getTime() + MAX_SEGMENT_MS;
  return max < midnight ? { at: max, reason: "max_duration" } : { at: midnight, reason: "midnight" };
}

type ClockVerdict = "normal" | "late" | "reboot" | "forward" | "backward";

function judgeClock(s: SessionState, wall: number, uptimeS: number): ClockVerdict {
  if (s.lastEventTime === null || s.lastUptimeS === null) return "normal";
  const dWall = wall - ms(s.lastEventTime);
  const dUptime = (uptimeS - s.lastUptimeS) * 1000;
  if (dWall < 0 && dUptime <= 0) return "late";
  if (dUptime < 0) return "reboot";
  const drift = dWall - dUptime;
  if (drift > CLOCK_TOLERANCE_MS) return "forward";
  if (drift < -CLOCK_TOLERANCE_MS) return "backward";
  return "normal";
}

function later(a: string, b: string): string {
  return ms(b) > ms(a) ? b : a;
}

/** A late event inside the open segment extends its last activity; outside it is only counted. */
function applyLate(s: SessionState, ev: SegmentEvent, wall: number, cfg: SegmenterConfig): Reduced {
  const open = s.open;
  const activity = OPENING.has(ev.type) || ev.type === "Stop";
  const inside =
    open !== null &&
    wall >= ms(open.startedAt) &&
    wall <= segmentBoundary(open).at &&
    wall - ms(open.lastActivityAt) < cfg.idleMs &&
    (!OPENING.has(ev.type) || ev.mappingVersionId === open.mappingVersionId);
  if (!inside) return { state: { ...s, lateEvents: s.lateEvents + 1 }, changes: [] };
  if (!activity || wall <= ms(open.lastActivityAt)) return { state: s, changes: [] };
  const seg = { ...open, lastActivityAt: ev.localTime };
  return {
    state: { ...s, open: seg },
    changes: [{ kind: "extend", id: seg.id, lastActivityAt: seg.lastActivityAt, working: seg.working, observedAt: seg.observedAt }],
  };
}

/** Applies one event of the session, in journal order. */
export function applyEvent(s: SessionState, ev: SegmentEvent, cfg: SegmenterConfig): Reduced {
  const wall = ms(ev.localTime);
  const verdict = judgeClock(s, wall, ev.uptimeS);
  if (verdict === "late") return applyLate(s, ev, wall, cfg);

  const changes: SegmentChange[] = [];
  let open = s.open;
  const finalize = (seg: OpenSegment, stoppedAt: string, reason: FinalReason, diagnostic?: string) => {
    changes.push(diagnostic === undefined ? { kind: "finalize", id: seg.id, stoppedAt, reason } : { kind: "finalize", id: seg.id, stoppedAt, reason, diagnostic });
    open = null;
  };
  const start = (startedAt: string, mappingVersionId: number, working: boolean) => {
    open = { id: cfg.newId(), mappingVersionId, startedAt, lastActivityAt: ev.localTime, working, observedAt: ev.localTime };
    changes.push({ kind: "open", seg: open });
  };

  if (open !== null && (verdict === "forward" || verdict === "backward")) {
    finalize(open, open.lastActivityAt, "clock_jump", verdict === "forward" ? DRIFT_DIAGNOSTIC : BACKWARDS_DIAGNOSTIC);
  }
  if (open !== null && wall - ms(open.lastActivityAt) >= cfg.idleMs) finalize(open, open.lastActivityAt, "idle");

  const current: OpenSegment | null = open;
  if (ev.type === "SessionEnd") {
    if (current !== null) finalize(current, current.lastActivityAt, "session_end");
  } else if (OPENING.has(ev.type) || ev.type === "Stop") {
    const working = ev.type !== "Stop";
    if (current === null) {
      if (working && ev.mappingVersionId !== null) start(ev.localTime, ev.mappingVersionId, true);
    } else {
      const boundary = segmentBoundary(current);
      const otherMapping = working && ev.mappingVersionId !== current.mappingVersionId;
      if (otherMapping || wall > boundary.at) {
        // Split exactly at the boundary: the event's time, or the synthetic midnight / 23 h bound.
        const at = wall > boundary.at ? iso(boundary.at) : ev.localTime;
        finalize(current, at, wall > boundary.at ? boundary.reason : "mapping");
        const mapping = otherMapping ? ev.mappingVersionId : current.mappingVersionId;
        if (mapping !== null) start(at, mapping, working);
      } else {
        const seg: OpenSegment = {
          ...current,
          lastActivityAt: later(current.lastActivityAt, ev.localTime),
          working,
          observedAt: later(current.observedAt, ev.localTime),
        };
        open = seg;
        changes.push({ kind: "extend", id: seg.id, lastActivityAt: seg.lastActivityAt, working: seg.working, observedAt: seg.observedAt });
      }
    }
  }

  return { state: { ...s, open, lastEventTime: ev.localTime, lastUptimeS: ev.uptimeS }, changes };
}

/** On a flusher wake-up: a segment idle for idleMs is finalised at its last activity. */
export function onWake(s: SessionState, now: Date, cfg: Pick<SegmenterConfig, "idleMs">): Reduced {
  const open = s.open;
  if (open === null || now.getTime() - ms(open.lastActivityAt) < cfg.idleMs) return { state: s, changes: [] };
  return { state: { ...s, open: null }, changes: [{ kind: "finalize", id: open.id, stoppedAt: open.lastActivityAt, reason: "idle" }] };
}

/** Milliseconds from `now` until onWake would finalise the open segment (null: none open). */
export function idleDueInMs(s: SessionState, now: Date, cfg: Pick<SegmenterConfig, "idleMs">): number | null {
  if (s.open === null) return null;
  return Math.max(0, ms(s.open.lastActivityAt) + cfg.idleMs - now.getTime());
}

/**
 * After segment_detached / segment_finalized (B8): the server closed that segment, so the next
 * activity event opens a new one.
 */
export function closedByServer(s: SessionState, id: string): SessionState {
  return s.open?.id === id ? { ...s, open: null } : s;
}
