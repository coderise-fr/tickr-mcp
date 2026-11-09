// Renaming a session's Tickr entry in place (a change of task and/or description only).
//
// A context-only change (the event's mapping differs from the open segment's in taskId and/or
// description only: same workspace, project and tags) does not split the segment while this
// instance's rename capability is not known to be unsupported: the segment keeps its id and takes
// the new mapping version, so its next revision carries the new task and description.
//
// Whether Tickr applies such a change to an existing entry is learnt from its answers, per
// instance (meta rename_support):
//
//   unknown      nothing learnt yet: try in place
//   supported    an update of an existing entry came back with the new values: try in place
//   unsupported  it came back with the old values: split as before; tried in place again on the
//                first change at least REPROBE_MS after it was learnt (a Tickr upgrade is picked up)
//
// The change is recorded on the segment as a pending rename (meta segment_rename:<id>) when the
// server may already hold a revision of the segment. Until Tickr answers the first revision that
// carries the change (the probe), the segment commits no other revision; the probe stops at the
// change and carries no usage, so that nothing the server keeps from it has to be taken back.
// Then (sender.ts):
//
//   applied with the new values   the rename stands (rename_support supported when the entry
//                                 existed before the probe)
//   applied with the old values   rename_support unsupported, and the repair: the segment is put
//                                 back as the split would have left it (its previous mapping,
//                                 final, stopped at the change) and a new segment carries the new
//                                 mapping from the change on, with the time, the activity and the
//                                 tokens the segment had after the change
//   refused (terminal)            the same repair, the capability unchanged: the change is never
//                                 lost and the segment is never left stuck
//
// Revisions already committed are never rewritten: the probe the server ignored is superseded by
// the final revision of the old segment, which carries the old task and description again.
import { snapshotUsage } from "../ledger.js";
import { canonicalJson, type NormalizedMapping, parseStoredMapping } from "../mapping.js";
import { sessionReads } from "../quality.js";
import type { SegmentRow, Store } from "../store/db.js";
import type { AppliedEntry } from "./api.js";
import type { SegmentBody } from "./revisions.js";

export const RENAME_SUPPORT_KEY = "rename_support";
/** meta key prefix of a segment's pending rename. */
export const PENDING_RENAME_PREFIX = "segment_rename:";
/** An instance known not to apply renames is tried in place again this long after it was learnt. */
export const REPROBE_MS = 24 * 3_600_000;

export type RenameSupportState = "unknown" | "supported" | "unsupported";

export interface RenameSupport {
  state: Exclude<RenameSupportState, "unknown">;
  /** When the state was learnt. */
  at: string;
}

/** A context-only change of a segment the server may already hold, not yet confirmed by Tickr. */
export interface PendingRename {
  /** The segment's mapping version before the change. */
  fromMappingVersionId: number;
  /** The change: the event that carried the new mapping. */
  at: string;
  /** The segment's last activity and observation before the change. */
  lastActivityAt: string;
  observedAt: string;
  /** The segment's last committed revision before the change: the probe is the next one. */
  baseRevision: number;
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

export function readRenameSupport(store: Store): RenameSupport | null {
  const v = readJson<RenameSupport>(store, RENAME_SUPPORT_KEY);
  return v !== null && (v.state === "supported" || v.state === "unsupported") && typeof v.at === "string" ? v : null;
}

export function renameSupportState(store: Store): RenameSupportState {
  return readRenameSupport(store)?.state ?? "unknown";
}

export function writeRenameSupport(store: Store, state: RenameSupport["state"], now: Date): void {
  store.setMeta(RENAME_SUPPORT_KEY, JSON.stringify({ state, at: now.toISOString() } satisfies RenameSupport));
}

/** Whether a context-only change is tried in place now (not unsupported, or learnt REPROBE_MS ago). */
export function tryInPlace(store: Store, now: Date): boolean {
  const support = readRenameSupport(store);
  if (support === null || support.state === "supported") return true;
  const at = Date.parse(support.at);
  return !Number.isFinite(at) || now.getTime() - at >= REPROBE_MS;
}

export function readPendingRename(store: Store, segmentId: string): PendingRename | null {
  const v = readJson<PendingRename>(store, PENDING_RENAME_PREFIX + segmentId);
  if (v === null || typeof v.fromMappingVersionId !== "number" || typeof v.at !== "string" || typeof v.baseRevision !== "number") return null;
  return v;
}

export function writePendingRename(store: Store, segmentId: string, pending: PendingRename): void {
  store.setMeta(PENDING_RENAME_PREFIX + segmentId, JSON.stringify(pending));
}

export function clearPendingRename(store: Store, segmentId: string): void {
  store.deleteMeta(PENDING_RENAME_PREFIX + segmentId);
}

/** The two mappings differ in taskId and/or description only. */
export function contextOnlyChange(from: NormalizedMapping, to: NormalizedMapping): boolean {
  if (from.workspaceId !== to.workspaceId || from.projectId !== to.projectId) return false;
  if (canonicalJson(from.tagIds) !== canonicalJson(to.tagIds)) return false;
  return from.taskId !== to.taskId || from.description !== to.description;
}

function mappingOf(store: Store, versionId: number): NormalizedMapping | null {
  const version = store.getMapping(versionId);
  return version ? parseStoredMapping(version.normalizedJson) : null;
}

/**
 * Whether the open segment takes the event's mapping version in place (segmenter
 * SegmenterConfig.renameInPlace): a context-only change, no rename of the segment waiting for
 * Tickr's answer, and the instance not known to ignore renames.
 */
export function mayRenameInPlace(store: Store, segmentId: string, fromVersionId: number, toVersionId: number, now: Date): boolean {
  if (readPendingRename(store, segmentId) !== null) return false;
  const from = mappingOf(store, fromVersionId);
  const to = mappingOf(store, toVersionId);
  if (from === null || to === null || !contextOnlyChange(from, to)) return false;
  return tryInPlace(store, now);
}

/** The probe of a pending rename: the segment seen as it was at the change, live, with the new mapping. */
export function probeView(seg: SegmentRow, pending: PendingRename): SegmentRow {
  return { ...seg, stoppedAt: pending.at, lastActivityAt: pending.at, observedAt: pending.at, working: true, final: false };
}

/** The answer holds the task and description that were sent. */
function holdsSent(entry: AppliedEntry, sent: Partial<SegmentBody>): boolean {
  const sentTask = typeof sent.taskId === "string" ? sent.taskId.toLowerCase() : null;
  const gotTask = entry.taskId === null ? null : entry.taskId.toLowerCase();
  return entry.description === sent.description && gotTask === sentTask;
}

/** The revision `sent` of the segment carries its pending rename (the probe). */
export function isProbe(pending: PendingRename, revision: number): boolean {
  return revision > pending.baseRevision;
}

/** An applied answer to a segment revision. */
export interface AppliedAnswer {
  segmentId: string;
  revision: number;
  /** The body that was sent. */
  sent: Partial<SegmentBody>;
  /** The task and description of the entry in the answer, when readable. */
  entry: AppliedEntry | undefined;
  /** The server held the segment before this revision (not a creation). */
  existed: boolean;
}

/**
 * Tickr applied the probe of a pending rename (inside the send's guarded transaction): the rename
 * stands when the answer holds the sent task and description, else the segment is repaired.
 * `existed`: the server held the segment before the probe (not a creation). Returns true when the
 * rename was resolved (confirmed or repaired).
 */
export function resolveAppliedProbe(store: Store, answer: AppliedAnswer, newId: () => string, now: Date): boolean {
  const { segmentId, revision, sent, entry, existed } = answer;
  const pending = readPendingRename(store, segmentId);
  if (pending === null || !isProbe(pending, revision)) return false;
  if (entry !== undefined && holdsSent(entry, sent)) {
    clearPendingRename(store, segmentId);
    if (existed) writeRenameSupport(store, "supported", now);
    return true;
  }
  // An answer that does not show the entry says nothing about the capability.
  if (entry !== undefined && existed) writeRenameSupport(store, "unsupported", now);
  repairRename(store, segmentId, pending, newId(), now);
  return true;
}

/** Tickr refused the probe of a pending rename (inside the send's guarded transaction): repair. */
export function resolveRefusedProbe(store: Store, segmentId: string, revision: number, newId: () => string, now: Date): boolean {
  const pending = readPendingRename(store, segmentId);
  if (pending === null || !isProbe(pending, revision)) return false;
  repairRename(store, segmentId, pending, newId(), now);
  return true;
}

/**
 * The split the change would have made (inside a guarded transaction): the segment goes back to
 * its previous mapping, final, stopped at the change (reason mapping); a new segment `newId`
 * carries the new mapping from the change to where the segment was (open or final as it was).
 * The segment's main-transcript messages from the change on, and the subagents launched from it,
 * move to the new segment with their messages (the attribution the split would have made). The
 * segment's revisions not sent yet carry the new mapping: they are dropped, the next revision
 * (its final one) supersedes them.
 */
export function repairRename(store: Store, segmentId: string, pending: PendingRename, newId: string, now: Date): void {
  clearPendingRename(store, segmentId);
  const seg = store.getSegment(segmentId);
  if (seg === null || seg.serverState !== null) return;
  // The previous mapping is gone (it cannot be while the rename is pending): the rename stays.
  if (store.getMapping(pending.fromMappingVersionId) === null) return;
  const at = pending.at;
  const next: SegmentRow = {
    ...seg,
    id: newId,
    startedAt: at,
    lastActivityAt: Date.parse(seg.lastActivityAt) >= Date.parse(at) ? seg.lastActivityAt : at,
    stoppedAt: Date.parse(seg.stoppedAt) >= Date.parse(at) ? seg.stoppedAt : at,
    quality: "pending",
    createdOnServer: false,
    serverState: null,
    lastRevision: 0,
  };
  store.upsertSegment({
    ...seg,
    mappingVersionId: pending.fromMappingVersionId,
    lastActivityAt: pending.lastActivityAt,
    observedAt: pending.observedAt,
    stoppedAt: at,
    working: false,
    final: true,
    finalReason: "mapping",
    finalDiagnostic: null,
  });
  store.upsertSegment(next);
  store.deleteOutboxFor("segment", segmentId);

  // Attribution as the split would have made it.
  const db = store.db;
  const moved = db
    .prepare(
      `SELECT agent_id FROM subagents WHERE session_id = ? AND recipient_kind = 'segment' AND recipient_id = ? AND launched_at IS NOT NULL AND launched_at >= ?`,
    )
    .all(seg.sessionId, segmentId, at) as { agent_id: string }[];
  db.prepare(`UPDATE subagents SET recipient_id = ? WHERE session_id = ? AND recipient_kind = 'segment' AND recipient_id = ? AND launched_at IS NOT NULL AND launched_at >= ?`).run(
    newId,
    seg.sessionId,
    segmentId,
    at,
  );
  // Main-transcript messages (and those of a subagent not known as one: placed by their time).
  db.prepare(
    `UPDATE ledger SET recipient_id = ? WHERE recipient_kind = 'segment' AND recipient_id = ? AND folded = 0 AND at >= ?
       AND (agent_id IS NULL OR NOT EXISTS (SELECT 1 FROM subagents s WHERE s.agent_id = ledger.agent_id))`,
  ).run(newId, segmentId, at);
  const toMove = db.prepare(`UPDATE ledger SET recipient_id = ? WHERE recipient_kind = 'segment' AND recipient_id = ? AND folded = 0 AND agent_id = ?`);
  for (const { agent_id } of moved) toMove.run(newId, segmentId, agent_id);

  // The usage of both: the latest complete set, when the session's last reads were complete.
  // Otherwise the segment's set (taken before the move, it holds the tokens moved away) no longer
  // matches either segment: both carry no usage until the next complete read of the ledger stage
  // snapshots them (their quality cannot be complete before that read either).
  const reads = sessionReads(store, seg.sessionId);
  if (reads.length > 0 && reads.every((r) => r.status === "complete")) {
    const nowIso = now.toISOString();
    snapshotUsage(store, { kind: "segment", id: segmentId }, nowIso);
    snapshotUsage(store, { kind: "segment", id: newId }, nowIso);
  } else {
    store.deleteUsageSnapshot("segment", segmentId);
    store.deleteUsageSnapshot("segment", newId);
  }
}
