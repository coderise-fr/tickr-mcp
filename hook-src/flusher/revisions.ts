// The "revisions" stage: desired state -> immutable outbox revisions (§7.4).
//
// For each target (a segment, a delegated entry) the desired wire body is derived
// from local state. When its canonical JSON, without `revision`, differs from the last committed
// one, revision N + 1 is committed with its full body: the outbox row (sent and replayed byte for
// byte) and the target's last_committed row (kept after the acknowledgement, for the next
// comparison) are written in one guarded transaction, before any send.
import { buildTurns, delegatedByTurn, type Turn } from "../attribution.js";
import { LEDGER_WINDOW_MS } from "../ledger.js";
import { delegatedQuality, finalSegmentQuality, type FinalQuality, nextQuality, type SessionContext, sessionContext, usageForRevision } from "../quality.js";
import type { CommittedRow, DelegatedRow, SegmentRow, Store, TargetKind } from "../store/db.js";
import { canonicalJson, type NormalizedMapping, parseStoredMapping } from "../mapping.js";
import type { UsageBody } from "./api.js";
import { guarded } from "./owner.js";
import { probeView, readPendingRename } from "./rename.js";
import type { StageContext, StageRun } from "./stages.js";

/** `working: true` is only built for an event at most this old (the server re-checks at 5 min). */
export const WORKING_FRESH_MS = 2 * 60_000;
/** A live segment whose only change is its moving end is re-sent at most this often. */
export const LEASE_REFRESH_MS = 60_000;

export type Provider = "anthropic" | "bedrock" | "vertex" | "foundry" | "other";
export type UsageQuality = "pending" | "complete" | "incomplete";

/** One usage row, with the wire names of the backend AgentUsageDto. */
export interface UsageRow {
  provider: Provider;
  model: string;
  inputTokens: number;
  outputTokens: number;
  cacheCreationInputTokens: number;
  cacheReadInputTokens: number;
}

/** Body of PUT /api/v1/agent-segments/{id}. `usage` absent keeps the server's usage; never null. */
export interface SegmentBody {
  revision: number;
  agentSessionId: string;
  startedAt: string;
  stoppedAt: string;
  projectId: string;
  taskId: string | null;
  tagIds: string[];
  description: string;
  working: boolean;
  observedAt: string;
  final: boolean;
  usageQuality: UsageQuality;
  usage?: UsageRow[];
}

/** Every key a segment body may carry, in wire order (the REST contract of the segment route). */
export const SEGMENT_BODY_KEYS = [
  "revision",
  "agentSessionId",
  "startedAt",
  "stoppedAt",
  "projectId",
  "taskId",
  "tagIds",
  "description",
  "working",
  "observedAt",
  "final",
  "usageQuality",
  "usage",
] as const satisfies readonly (keyof SegmentBody)[];

export interface RevisionTarget {
  kind: TargetKind;
  id: string;
}

export { usageForRevision } from "../quality.js";

/**
 * Usage quality of a finalised segment from the local state (quality.ts, D21): complete iff
 * every turn and known subagent attributed to it ended and a complete read covered them.
 */
export function finalQuality(store: Store, seg: SegmentRow, now: Date, ctx: SessionContext = sessionContext(store, seg.sessionId, now)): FinalQuality {
  return finalSegmentQuality(seg, ctx);
}

/**
 * The body the segment should have on the server now (without its revision). `quality` is the
 * usageQuality once final (pending before, whatever is given).
 */
export function desiredSegmentBody(
  seg: SegmentRow,
  mapping: NormalizedMapping,
  now: Date,
  usage?: UsageRow[],
  quality: UsageQuality = "incomplete",
): Omit<SegmentBody, "revision"> {
  const fresh = now.getTime() - Date.parse(seg.observedAt) <= WORKING_FRESH_MS;
  const body: Omit<SegmentBody, "revision"> = {
    agentSessionId: seg.sessionId,
    startedAt: seg.startedAt,
    stoppedAt: seg.stoppedAt,
    projectId: mapping.projectId,
    taskId: mapping.taskId,
    tagIds: [...mapping.tagIds],
    description: mapping.description,
    working: !seg.final && seg.working && fresh,
    observedAt: seg.observedAt,
    final: seg.final,
    usageQuality: seg.final ? quality : "pending",
  };
  if (usage !== undefined && usage !== null) body.usage = usage;
  return body;
}

/** The body without `revision` (and without a null `usage`, which the server reads as absent). */
function withoutRevision(body: object): Record<string, unknown> {
  const rest: Record<string, unknown> = { ...(body as Record<string, unknown>) };
  delete rest.revision;
  if (rest.usage === null) delete rest.usage;
  return rest;
}

/** Canonical JSON of a body without its revision: the comparison key of two revisions. */
export function canonicalBody(body: object): string {
  return canonicalJson(withoutRevision(body));
}

/**
 * Commits revision last + 1 of the target with this body when it differs (canonical JSON without
 * `revision`) from the last committed one. Guarded by the flusher's generation. Returns the new
 * revision, or null when nothing changed.
 */
export function commitIfChanged(store: Store, gen: number, target: RevisionTarget, body: object, now: Date): number | null {
  const nowIso = now.toISOString();
  return guarded(store, gen, nowIso, () => {
    const rest = withoutRevision(body);
    const canonical = canonicalJson(rest);
    const last = store.getLastCommitted(target.kind, target.id);
    if (last !== null && last.canonicalJson === canonical) return null;
    const revision = (last?.revision ?? 0) + 1;
    const bodyJson = JSON.stringify({ revision, ...rest });
    store.insertOutbox({ targetKind: target.kind, targetId: target.id, revision, bodyJson, attempts: 0, nextAttemptAt: nowIso });
    store.putLastCommitted({ targetKind: target.kind, targetId: target.id, revision, canonicalJson: canonical, bodyJson, committedAt: nowIso });
    if (target.kind === "segment") store.setSegmentRevision(target.id, revision);
    return revision;
  });
}

/** The server applied `revision`: removes the target's outbox rows up to it. Guarded. */
export function acknowledge(store: Store, gen: number, target: RevisionTarget, revision: number, now: Date): void {
  guarded(store, gen, now.toISOString(), () => {
    store.deleteOutboxThrough(target.kind, target.id, revision);
  });
}

/** A desired body for one target, and when the source wants to be asked again (ms, or null). */
export interface DesiredRevision {
  target: RevisionTarget;
  body: object;
}

export interface RevisionPlan {
  desired: DesiredRevision[];
  dueInMs: number | null;
}

/** Computes the desired bodies of one kind of target (read-only). */
export type RevisionSource = (ctx: StageContext) => RevisionPlan;

function minDue(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Milliseconds to wait before re-sending a live segment whose only change since the last commit
 * is its moving end (stoppedAt / observedAt), or null to commit now.
 */
function refreshWait(last: CommittedRow | null, desired: Omit<SegmentBody, "revision">, now: Date): number | null {
  if (last === null || desired.final || !desired.working) return null;
  if (canonicalBody(desired) === last.canonicalJson) return null; // unchanged: nothing to refresh
  const previous = JSON.parse(last.bodyJson) as Partial<SegmentBody>;
  if (previous.working !== true || previous.final !== false) return null;
  // The tokens of a live turn grow with its end: refreshed at the same pace.
  const moved: Partial<SegmentBody> = { ...desired, stoppedAt: previous.stoppedAt, observedAt: previous.observedAt };
  if (previous.usage === undefined) delete moved.usage;
  else moved.usage = previous.usage;
  if (canonicalBody(moved) !== last.canonicalJson) return null;
  const wait = Date.parse(last.committedAt) + LEASE_REFRESH_MS - now.getTime();
  return wait > 0 ? wait : null;
}

/** The usageQuality of the last committed revision of a target, or null. */
function committedQuality(last: CommittedRow | null): UsageQuality | null {
  if (last === null) return null;
  const q = (JSON.parse(last.bodyJson) as { usageQuality?: unknown }).usageQuality;
  return q === "pending" || q === "complete" || q === "incomplete" ? q : null;
}

/** The session contexts of one pass, built once per session. */
function contexts(store: Store, now: Date): (sessionId: string) => SessionContext {
  const cache = new Map<string, SessionContext>();
  return (sessionId) => {
    let c = cache.get(sessionId);
    if (c === undefined) {
      c = sessionContext(store, sessionId, now);
      cache.set(sessionId, c);
    }
    return c;
  };
}

/**
 * Segments: one desired body each, from the segment row, its own mapping version, the latest
 * complete usage set and, once final, its quality (never a transition Tickr refuses). A final
 * segment is evaluated again while its session is read (LEDGER_WINDOW_MS) and its quality or
 * tokens may still change.
 */
export const segmentRevisions: RevisionSource = (ctx) => {
  const now = ctx.now();
  const desired: DesiredRevision[] = [];
  let due: number | null = null;
  const mappings = new Map<number, NormalizedMapping | null>();
  const contextOf = contexts(ctx.store, now);
  for (const seg of ctx.store.segmentsForRevision(new Date(now.getTime() - LEDGER_WINDOW_MS).toISOString())) {
    if (!mappings.has(seg.mappingVersionId)) {
      const version = ctx.store.getMapping(seg.mappingVersionId);
      mappings.set(seg.mappingVersionId, version ? parseStoredMapping(version.normalizedJson) : null);
    }
    const mapping = mappings.get(seg.mappingVersionId);
    if (!mapping) continue;
    const target: RevisionTarget = { kind: "segment", id: seg.id };
    const pending = readPendingRename(ctx.store, seg.id);
    if (pending !== null) {
      // A rename in place waits for Tickr's answer to its probe (flusher/rename.ts): the probe is
      // committed once, then nothing else of the segment until the answer resolves it.
      if (seg.lastRevision <= pending.baseRevision) desired.push({ target, body: desiredSegmentBody(probeView(seg, pending), mapping, now, undefined, "pending") });
      continue;
    }
    const last = ctx.store.getLastCommitted("segment", seg.id);
    const usage = usageForRevision(ctx.store, target);
    let quality: UsageQuality = "pending";
    if (seg.final) {
      const computed: FinalQuality = usage?.clamped ? "incomplete" : finalQuality(ctx.store, seg, now, contextOf(seg.sessionId));
      quality = nextQuality(committedQuality(last), computed, { segment: true, final: true });
    }
    const body = desiredSegmentBody(seg, mapping, now, usage?.usage, quality);
    const wait = refreshWait(last, body, now);
    if (wait !== null) {
      due = minDue(due, wait);
      continue;
    }
    desired.push({ target, body });
    // A working segment turns working: false once its event is older than WORKING_FRESH_MS.
    if (body.working) due = minDue(due, Date.parse(seg.observedAt) + WORKING_FRESH_MS + 1 - now.getTime());
  }
  return { desired, dueInMs: due };
};

/** Where a delegated entry stands in its turn (D16): the first one receives the turn's tokens. */
export interface DelegatedPlace {
  /** The turn the entry was created in, or null when no turn contains it. */
  turn: Turn | null;
  /** The first delegated entry of that turn. */
  first: boolean;
}

/** The turn of each delegated entry of one session, from its journalled events. */
export function delegatedPlaces(store: Store, sessionId: string): Map<string, DelegatedPlace> {
  const events = store.attributionEvents(sessionId);
  const turns = buildTurns(sessionId, events);
  const out = new Map<string, DelegatedPlace>();
  for (const [promptId, entries] of delegatedByTurn(events, turns)) {
    const turn = turns.find((t) => t.promptId === promptId) ?? null;
    entries.forEach((entryId, i) => out.set(entryId, { turn, first: i === 0 }));
  }
  return out;
}

/**
 * The body a delegated entry should have on the server now (without its revision): always both
 * agentSessionId and usage (the usage route requires usage; [] until a complete set exists). The
 * first delegated entry of a turn carries the turn's tokens as the ledger attributed them (final
 * response included); the others carry the session link only (their own tokens, none in
 * practice) with usageQuality complete.
 */
export function desiredDelegatedBody(
  store: Store,
  row: DelegatedRow,
  place: DelegatedPlace | undefined,
  ctx: SessionContext,
  previous: UsageQuality | null = null,
): Omit<UsageBody, "revision"> {
  const usage = usageForRevision(store, { kind: "delegated", id: row.entryId });
  const computed = usage?.clamped ? "incomplete" : delegatedQuality(place, ctx.subagents, ctx.reads, ctx.ended, ctx.provisional);
  return { agentSessionId: row.sessionId, usageQuality: nextQuality(previous, computed, { segment: false, final: false }), usage: usage?.usage ?? [] };
}

/** Delegated entries: one desired usage body each (PUT /api/v1/entries/{id}/agent-usage). */
export const delegatedRevisions: RevisionSource = (ctx) => {
  const now = ctx.now();
  const rows = ctx.store.delegatedForRevision(new Date(now.getTime() - LEDGER_WINDOW_MS).toISOString());
  const places = new Map<string, Map<string, DelegatedPlace>>();
  const contextOf = contexts(ctx.store, now);
  const desired: DesiredRevision[] = [];
  for (const row of rows) {
    if (!places.has(row.sessionId)) places.set(row.sessionId, delegatedPlaces(ctx.store, row.sessionId));
    const previous = committedQuality(ctx.store.getLastCommitted("delegated", row.entryId));
    const body = desiredDelegatedBody(ctx.store, row, places.get(row.sessionId)!.get(row.entryId), contextOf(row.sessionId), previous);
    desired.push({ target: { kind: "delegated", id: row.entryId }, body });
  }
  return { desired, dueInMs: null };
};

/** The sources the stage asks, in order: segments, then delegated entries. */
export const REVISION_SOURCES: readonly RevisionSource[] = [segmentRevisions, delegatedRevisions];

export function revisionsStage(sources: readonly RevisionSource[] = REVISION_SOURCES): StageRun {
  return (ctx) => {
    let due: number | null = null;
    for (const source of sources) {
      const plan = source(ctx);
      due = minDue(due, plan.dueInMs);
      for (const { target, body } of plan.desired) {
        if (ctx.remainingMs() <= 0) return { dueInMs: 0 };
        if (commitIfChanged(ctx.store, ctx.generation, target, body, ctx.now()) !== null) ctx.boundary("revision_committed");
      }
    }
    return due === null ? {} : { dueInMs: Math.max(0, due) };
  };
}
