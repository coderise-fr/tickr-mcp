// Usage quality (D21, §7.6) and the usage set a revision carries.
//
// Quality, per target:
//   segment    pending while it is not final (a new turn may still join it). Once final:
//              complete iff every turn and every known subagent attributed to it has ended, no
//              message in its span is still undecided, and a complete read of every transcript
//              of its session was made after the last of those ends; else incomplete. A final
//              segment with no complete usage set (revisions.ts) is incomplete too.
//   delegated  the first entry of a turn: pending until its turn and the subagents launched in it
//              have ended and a complete read covered them, then complete; incomplete once the
//              session ended first (SessionEnd, or no activity for LEDGER_WINDOW_MS: a crashed
//              session that went quiet is not read any more). The other entries of the turn
//              carry the session link only and are complete at once.
// A message whose recipient is still provisional (ledger "pending" / "turn") is unattributed: the
// target it may belong to cannot be complete. Old provisional rows of a session that is no longer
// read keep their target incomplete; they are never dropped silently.
//
// The server accepts pending -> complete | incomplete and incomplete -> complete only, and a
// segment leaves pending only once final (AgentUsageQualityRules): nextQuality mirrors that table,
// so a revision never carries a transition Tickr would refuse.
//
// Usage: the ledger stage (ledger.ts, snapshotSession) snapshots the totals of every target of a session after a pass whose
// reads of that session were all complete (usage_snapshots). A revision carries the latest
// snapshot, so a newer partial read never replaces a complete set; PD-17 bounds it on the way out.
import { buildTurns, type Turn } from "./attribution.js";
import { ACTIVE_SESSION } from "./flusher/segmentation.js";
import type { Provider, UsageQuality, UsageRow } from "./flusher/revisions.js";
import { LEDGER_WINDOW_MS, type SubagentRow, subagentsFor } from "./ledger.js";
import type { SegmentRow, Store, TargetKind } from "./store/db.js";

export type FinalQuality = "complete" | "incomplete";

/** The latest read of one transcript file of the session (transcript_offsets). */
export interface ReadState {
  status: string | null;
  readAt: string | null;
}

/** Most usage rows of one target (backend bound); the smallest are folded beyond it (PD-17). */
export const MAX_USAGE_ROWS = 20;
/** Largest token count Tickr accepts; above it the count is clamped and the target incomplete. */
export const MAX_TOKENS = 1_000_000_000_000;
export const OTHER_PROVIDER: Provider = "other";
export const OTHER_MODELS = "other-models";

const ms = (iso: string) => Date.parse(iso);
const NEVER = Number.POSITIVE_INFINITY;

/** The turn in progress at `t` (startedAt ≤ t < endedAt, or not ended). */
function turnAt(t: number, turns: readonly Turn[]): Turn | null {
  let found: Turn | null = null;
  for (const turn of turns) if (ms(turn.startedAt) <= t && (turn.endedAt === null || t < ms(turn.endedAt))) found = turn;
  return found;
}

/**
 * When a subagent ended, or null while it may still run. SubagentStop says so; a subagent known
 * only from its transcript (no hook event: no SubagentStop will come) ends with its launch turn.
 */
function subagentEnd(sub: SubagentRow, turns: readonly Turn[]): number | null {
  if (sub.stoppedAt !== null) return ms(sub.stoppedAt);
  if (sub.source === "hook" || sub.launchedAt === null) return null;
  const turn = turnAt(ms(sub.launchedAt), turns);
  return turn?.endedAt ? ms(turn.endedAt) : null;
}

/** A complete read of every transcript of the session, made at or after `after`. */
function coveredAfter(reads: readonly ReadState[], after: number): boolean {
  return reads.length > 0 && reads.every((r) => r.status === "complete" && r.readAt !== null && ms(r.readAt) >= after);
}

/** Every ended instant, or null when one has not ended. */
function latest(ends: readonly (number | null)[], floor: number): number | null {
  let max = floor;
  for (const end of ends) {
    if (end === null) return null;
    max = Math.max(max, end);
  }
  return max;
}

/**
 * Quality of a final segment. `turns` and `subagents` are the session's; `provisional` the
 * timestamps of the session's undecided messages; `until` the start of the session's next segment
 * (the end of this segment's span for undecided messages).
 */
export function segmentQuality(
  seg: SegmentRow,
  turns: readonly Turn[],
  subagents: readonly SubagentRow[],
  reads: readonly ReadState[],
  provisional: readonly string[] = [],
  until: string | null = null,
): FinalQuality {
  const start = ms(seg.startedAt);
  const stop = ms(seg.stoppedAt);
  const spanEnd = until === null ? NEVER : ms(until);
  const inSpan = (iso: string) => ms(iso) >= start && ms(iso) < spanEnd;
  if (provisional.some(inSpan)) return "incomplete";

  const mine = turns.filter((t) => ms(t.startedAt) < Math.max(stop, start + 1) && (t.endedAt === null || ms(t.endedAt) > start));
  const subs = subagents.filter(
    (s) => (s.recipientKind === "segment" && s.recipientId === seg.id) || (s.recipientKind === null && s.launchedAt !== null && inSpan(s.launchedAt)),
  );
  if (subs.some((s) => s.recipientKind === null)) return "incomplete";
  const end = latest([...mine.map((t) => (t.endedAt === null ? null : ms(t.endedAt))), ...subs.map((s) => subagentEnd(s, turns))], stop);
  return end !== null && coveredAfter(reads, end) ? "complete" : "incomplete";
}

/** Where a delegated entry stands: the turn it was created in, and whether it is its first entry. */
export interface DelegatedPlaceLike {
  turn: Turn | null;
  first: boolean;
}

/** Quality of a delegated entry (see the header). `sessionEnded`: SessionEnd seen or the session went quiet. */
export function delegatedQuality(
  place: DelegatedPlaceLike | undefined,
  subagents: readonly SubagentRow[],
  reads: readonly ReadState[],
  sessionEnded: boolean,
  provisional: readonly string[] = [],
): UsageQuality {
  if (place === undefined || place.turn === null || !place.first) return "complete";
  const turn = place.turn;
  const start = ms(turn.startedAt);
  const turnEnd = turn.endedAt === null ? null : ms(turn.endedAt);
  const inTurn = (iso: string) => ms(iso) >= start && (turnEnd === null || ms(iso) < turnEnd);
  const launched = subagents.filter((s) => s.launchedAt !== null && inTurn(s.launchedAt));
  const end = turnEnd === null ? null : latest(launched.map((s) => subagentEnd(s, [turn])), turnEnd);
  const complete = end !== null && !provisional.some(inTurn) && launched.every((s) => s.recipientKind !== null) && coveredAfter(reads, end);
  if (complete) return "complete";
  return sessionEnded ? "incomplete" : "pending";
}

const RANK: Record<UsageQuality, number> = { pending: 0, incomplete: 1, complete: 2 };

/**
 * The quality a new revision may carry after `previous` (the last committed one), mirroring the
 * server's transitions: a segment stays pending until final; then quality never moves back
 * (pending -> incomplete | complete, incomplete -> complete).
 */
export function nextQuality(previous: UsageQuality | null, computed: UsageQuality, target: { segment: boolean; final: boolean }): UsageQuality {
  if (target.segment && !target.final) return "pending";
  if (previous === null) return computed;
  return RANK[computed] >= RANK[previous] ? computed : previous;
}

const tokensOf = (r: UsageRow) => r.inputTokens + r.outputTokens + r.cacheCreationInputTokens + r.cacheReadInputTokens;
const byKey = (a: UsageRow, b: UsageRow) => (a.provider < b.provider ? -1 : a.provider > b.provider ? 1 : a.model < b.model ? -1 : a.model > b.model ? 1 : 0);

/**
 * PD-17: at most MAX_USAGE_ROWS rows, unique (provider, model): beyond it the smallest are folded
 * into (other, other-models), sums preserved; a count above MAX_TOKENS is clamped (clamped: true,
 * the target's quality becomes incomplete). Rows sorted by provider, then model.
 */
export function boundUsage(rows: readonly UsageRow[]): { usage: UsageRow[]; clamped: boolean } {
  let kept = rows.map((r) => ({ ...r }));
  if (kept.length > MAX_USAGE_ROWS) {
    const sorted = [...kept].sort((a, b) => tokensOf(b) - tokensOf(a) || byKey(a, b));
    const other = sorted.filter((r) => r.provider === OTHER_PROVIDER && r.model === OTHER_MODELS);
    const rest = sorted.filter((r) => !(r.provider === OTHER_PROVIDER && r.model === OTHER_MODELS));
    const top = rest.slice(0, MAX_USAGE_ROWS - 1);
    const folded: UsageRow = { provider: OTHER_PROVIDER, model: OTHER_MODELS, inputTokens: 0, outputTokens: 0, cacheCreationInputTokens: 0, cacheReadInputTokens: 0 };
    for (const r of [...rest.slice(MAX_USAGE_ROWS - 1), ...other]) {
      folded.inputTokens += r.inputTokens;
      folded.outputTokens += r.outputTokens;
      folded.cacheCreationInputTokens += r.cacheCreationInputTokens;
      folded.cacheReadInputTokens += r.cacheReadInputTokens;
    }
    kept = [...top, folded];
  }
  let clamped = false;
  const clamp = (n: number) => {
    if (n > MAX_TOKENS) {
      clamped = true;
      return MAX_TOKENS;
    }
    return n;
  };
  const usage = kept
    .map((r) => ({
      ...r,
      inputTokens: clamp(r.inputTokens),
      outputTokens: clamp(r.outputTokens),
      cacheCreationInputTokens: clamp(r.cacheCreationInputTokens),
      cacheReadInputTokens: clamp(r.cacheReadInputTokens),
    }))
    .sort(byKey);
  return { usage, clamped };
}

// Snapshots

export interface UsageTarget {
  kind: TargetKind;
  id: string;
}

/** The usage of the latest complete set of a target, bounded (PD-17); undefined when none exists. */
export function usageForRevision(store: Store, target: UsageTarget): { usage: UsageRow[]; clamped: boolean } | undefined {
  const row = store.db.prepare("SELECT usage_json FROM usage_snapshots WHERE target_kind = ? AND target_id = ?").get(target.kind, target.id) as
    | { usage_json: string }
    | undefined;
  if (row === undefined) return undefined;
  return boundUsage(JSON.parse(row.usage_json) as UsageRow[]);
}

// Store context of the quality rules

/** The latest read of each transcript file of the session. */
export function sessionReads(store: Store, sessionId: string): ReadState[] {
  return (store.db.prepare("SELECT status, read_at FROM transcript_offsets WHERE session_id = ? ORDER BY path").all(sessionId) as {
    status: string | null;
    read_at: string | null;
  }[]).map((r) => ({ status: r.status, readAt: r.read_at }));
}

/** Timestamps of the session's messages whose recipient is not decided yet (pending / turn). */
export function provisionalTimes(store: Store, sessionId: string): string[] {
  return (
    store.db.prepare("SELECT at FROM ledger WHERE session_id = ? AND recipient_kind IN ('pending', 'turn') ORDER BY at").all(sessionId) as { at: string }[]
  ).map((r) => r.at);
}


/** What the quality rules need to know about one session. */
export interface SessionContext {
  turns: Turn[];
  subagents: SubagentRow[];
  reads: ReadState[];
  provisional: string[];
  /** The session's segments, by start. */
  segments: SegmentRow[];
  /** SessionEnd seen, the session no longer tracked, or no activity for LEDGER_WINDOW_MS. */
  ended: boolean;
}

export function sessionContext(store: Store, sessionId: string, now: Date): SessionContext {
  const events = store.attributionEvents(sessionId);
  const session = store.getSession(sessionId);
  const quietSince = now.getTime() - LEDGER_WINDOW_MS;
  const ended =
    events.some((e) => e.type === "SessionEnd") ||
    (session !== null && (session.state !== ACTIVE_SESSION || (session.lastEventTime !== null && ms(session.lastEventTime) < quietSince)));
  return {
    turns: buildTurns(sessionId, events),
    subagents: subagentsFor(store, sessionId),
    reads: sessionReads(store, sessionId),
    provisional: provisionalTimes(store, sessionId),
    segments: store.segmentsForSession(sessionId),
    ended,
  };
}

/** segmentQuality of a final segment in its session's context (its span ends where the next segment starts). */
export function finalSegmentQuality(seg: SegmentRow, ctx: SessionContext): FinalQuality {
  const next = ctx.segments.find((s) => s.id !== seg.id && ms(s.startedAt) > ms(seg.startedAt));
  return segmentQuality(seg, ctx.turns, ctx.subagents, ctx.reads, ctx.provisional, next?.startedAt ?? null);
}
