// Attribution of assistant messages to recipients (§7.6). Pure: the ledger stage (ledger.ts)
// builds the context of one session from the store and persists the outcome.
//
// Each message has exactly one recipient, fixed once:
//   1. A subagent message goes to the recipient recorded when the subagent was launched
//      (PD-14: the SubagentStart hook event, else the launching Agent tool call named by the
//      subagent's .meta.json, else the subagent's first message by timestamp).
//   2. A main-transcript message goes to the session's segment whose half-open interval
//      [startedAt, stoppedAt) contains its timestamp; a message in a gap goes to the segment open
//      at the latest preceding event (the latest segment started before it, the same UTC day).
//   3. Else to the first delegated entry created in its turn (D16), the final response after the
//      last tool included. While the turn has no delegated entry and has not ended, the
//      recipient is the turn itself, resolved when it ends.
//   4. Else nobody: the message is not sent.
//
// A turn (PD-15) is UserPromptSubmit … Stop of one session, keyed by the hook's prompt_id (the
// event id when the input has none). A new prompt or SessionEnd also ends the turn before it
// (Claude Code fires no Stop when a turn is interrupted); inactivity does not.
import type { EventRow, SegmentRow } from "./store/db.js";
import type { AssistantUsage } from "./transcript/parser.js";

export type Recipient = { kind: "segment"; id: string } | { kind: "turn"; sessionId: string; promptId: string } | { kind: "delegated"; entryId: string };

export interface Turn {
  sessionId: string;
  promptId: string;
  startedAt: string;
  endedAt: string | null;
}

/** One session's state, as attribution needs it. */
export interface AttributionContext {
  /** The session's segments. */
  segments: SegmentRow[];
  /** The session's turns, in order. */
  turns: Turn[];
  /** Recipient recorded at each known subagent's launch (null: nobody). */
  subagents: Map<string /* agent_id */, Recipient | null>;
  /** Delegated entries of each turn, in creation order. */
  delegatedByTurn: Map<string /* promptId */, string[] /* entry ids */>;
}

const DAY_MS = 86_400_000;
const ms = (iso: string) => Date.parse(iso);

function nextUtcMidnight(t: number): number {
  return (Math.floor(t / DAY_MS) + 1) * DAY_MS;
}

/** Turns of one session from its journalled events (any order; sorted by local time, then seq). */
export function buildTurns(sessionId: string, events: readonly EventRow[]): Turn[] {
  const sorted = events.filter((e) => e.sessionId === sessionId).sort((a, b) => ms(a.localTime) - ms(b.localTime) || a.seq - b.seq);
  const turns: Turn[] = [];
  let open: Turn | null = null;
  for (const ev of sorted) {
    if (ev.type === "UserPromptSubmit") {
      if (open !== null) open.endedAt = ev.localTime;
      open = { sessionId, promptId: ev.promptId ?? ev.eventId, startedAt: ev.localTime, endedAt: null };
      turns.push(open);
    } else if ((ev.type === "Stop" || ev.type === "SessionEnd") && open !== null) {
      open.endedAt = ev.localTime;
      open = null;
    }
  }
  return turns;
}

/** The turn in progress at `t`: startedAt ≤ t < endedAt (or not ended). */
export function turnAt(t: number, turns: readonly Turn[]): Turn | null {
  let found: Turn | null = null;
  for (const turn of turns) {
    if (ms(turn.startedAt) <= t && (turn.endedAt === null || t < ms(turn.endedAt))) found = turn;
  }
  return found;
}

/** Delegated entries (events carrying an entry id) of each turn, by prompt_id or by time. */
export function delegatedByTurn(events: readonly EventRow[], turns: readonly Turn[]): Map<string, string[]> {
  const out = new Map<string, string[]>();
  const known = new Set(turns.map((t) => t.promptId));
  const withEntry = events.filter((e) => e.entryId !== null).sort((a, b) => a.seq - b.seq);
  for (const ev of withEntry) {
    const promptId = ev.promptId !== null && known.has(ev.promptId) ? ev.promptId : turnAt(ms(ev.localTime), turns)?.promptId;
    if (promptId === undefined) continue;
    const list = out.get(promptId) ?? [];
    if (!list.includes(ev.entryId!)) list.push(ev.entryId!);
    out.set(promptId, list);
  }
  return out;
}

/** Rule 3 for one turn: its first delegated entry, else nobody once it ended, else the turn. */
export function resolveTurn(turn: Turn, ctx: Pick<AttributionContext, "delegatedByTurn">): Recipient | null {
  const first = ctx.delegatedByTurn.get(turn.promptId)?.[0];
  if (first !== undefined) return { kind: "delegated", entryId: first };
  if (turn.endedAt !== null) return null;
  return { kind: "turn", sessionId: turn.sessionId, promptId: turn.promptId };
}

/** A turn recipient re-read against the current context (it may have ended or got an entry). */
export function resolveRecipient(r: Recipient | null, ctx: Pick<AttributionContext, "turns" | "delegatedByTurn">): Recipient | null {
  if (r === null || r.kind !== "turn") return r;
  const turn = ctx.turns.find((t) => t.promptId === r.promptId);
  return turn === undefined ? r : resolveTurn(turn, ctx);
}

/** Rules 2–4 for an instant of the main session. */
export function recipientAt(timestamp: string, ctx: AttributionContext): Recipient | null {
  const t = ms(timestamp);
  let inside: SegmentRow | null = null;
  let before: SegmentRow | null = null;
  for (const seg of ctx.segments) {
    const start = ms(seg.startedAt);
    if (start > t) continue;
    if (t < ms(seg.stoppedAt) && (inside === null || start >= ms(inside.startedAt))) inside = seg;
    if (t < nextUtcMidnight(start) && (before === null || start >= ms(before.startedAt))) before = seg;
  }
  const seg = inside ?? before;
  if (seg !== null) return { kind: "segment", id: seg.id };
  const turn = turnAt(t, ctx.turns);
  return turn === null ? null : resolveTurn(turn, ctx);
}

/** The recipient of one message (§7.6 rules 1–4). */
export function recipientFor(msg: Pick<AssistantUsage, "timestamp" | "agentId">, ctx: AttributionContext): Recipient | null {
  if (msg.agentId !== undefined && ctx.subagents.has(msg.agentId)) return resolveRecipient(ctx.subagents.get(msg.agentId)!, ctx);
  return recipientAt(msg.timestamp, ctx);
}

/**
 * Whether the recipient of an instant of the session can be decided now. Later than the open
 * segment's last activity, a split not journalled yet (midnight, mapping change, clock jump, idle)
 * may still put it in another segment: it waits for the next event or the segment's end.
 */
export function settled(timestamp: string, segments: readonly SegmentRow[]): boolean {
  const t = ms(timestamp);
  return segments.every((seg) => seg.final || t <= ms(seg.lastActivityAt));
}
