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
//                                 existed before the probe); when only the tags differ (a tag
//                                 deleted on Tickr is dropped, never refused) the segment adopts
//                                 the tags Tickr holds for its next revisions (wireMapping)
//   applied with the old values   rename_support unsupported, and the repair: the segment is put
//                                 back as the split would have left it (its previous mapping,
//                                 final, stopped at the change) and a new segment carries the new
//                                 mapping from the change on, with the time, the activity and the
//                                 tokens the segment had after the change
//   422 immutable                 the same repair (a project change is always a split anyway)
//   other 422 (too_long,          the change is given up (revertRename): the segment goes on with
//   invalid, required...)         the accepted mapping, its end and usage, one notice; the refused
//                                 mapping is not tried again in the session (keepsMapping)
//   refused otherwise (terminal)  the repair, the capability unchanged: the change is never lost
//                                 and the segment is never left stuck (entry_locked excepted:
//                                 sender.ts stops the session instead of opening another entry)
//
// Every revision carries projectId, taskId (a value or null), tagIds and description explicitly:
// Tickr reads an absent taskId as "keep" and null as "clear", so neither is ever left out, and a
// retry replays the committed bytes. A change of tags is renamed in place only once the instance
// is known to apply renames (supported): only then does an answer without a sent tag mean a tag
// deleted on Tickr rather than a change ignored.
//
// Revisions already committed are never rewritten: the probe the server ignored is superseded by
// the final revision of the old segment, which carries the old task and description again.
import { SNAPSHOT_OWED, SNAPSHOT_OWED_PREFIX, snapshotUsage } from "../ledger.js";
import { canonicalJson, type NormalizedMapping, parseStoredMapping } from "../mapping.js";
import { sessionReads } from "../quality.js";
import type { SegmentRow, Store } from "../store/db.js";
import { type AppliedEntry, IMMUTABLE } from "./api.js";
import { cancelUnsentSegment, isLockedSession } from "./locked.js";
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

/**
 * The two mappings differ in taskId and/or description only, or also in tagIds when `tags`. A
 * change of workspace or project is never one: Tickr refuses a new project on an entry
 * (422 immutable), so it is always a split, the old segment keeping its project.
 */
export function contextOnlyChange(from: NormalizedMapping, to: NormalizedMapping, tags = false): boolean {
  if (from.workspaceId !== to.workspaceId || from.projectId !== to.projectId) return false;
  const tagsDiffer = canonicalJson(from.tagIds) !== canonicalJson(to.tagIds);
  if (tagsDiffer && !tags) return false;
  return tagsDiffer || from.taskId !== to.taskId || from.description !== to.description;
}

/** meta key prefix (+ session id) of the last rename Tickr refused (422) in a session. */
export const REFUSED_RENAME_PREFIX = "session_refused:";
/** meta key prefix of the tags Tickr holds for a segment instead of those of its mapping. */
export const ADOPTED_TAGS_PREFIX = "segment_tags:";

/** Tickr refused (422) the rename from mapping version `from` to `to`: it is not asked again. */
interface RefusedRename {
  from: number;
  to: number;
}

/** The tags Tickr holds for a segment whose mapping names the tags `from` (some deleted on Tickr). */
interface AdoptedTags {
  from: string[];
  to: string[];
}

/**
 * Whether an event's mapping version is taken as the open segment's own (segmenter
 * SegmenterConfig.keepMapping): Tickr refused this very rename in the session. The segment goes
 * on with the mapping Tickr accepted; the refused payload is never sent again.
 */
export function keepsMapping(store: Store, sessionId: string, fromVersionId: number, toVersionId: number): boolean {
  const refused = readJson<RefusedRename>(store, REFUSED_RENAME_PREFIX + sessionId);
  return refused?.from === fromVersionId && refused.to === toVersionId;
}

/**
 * The mapping version a segment opened in the session takes for an event of mapping version
 * `versionId`: the one Tickr accepted when it refused this very mapping in the session (a
 * creation with it would be refused the same way), else `versionId`.
 */
export function openingMapping(store: Store, sessionId: string, versionId: number): number {
  const refused = readJson<RefusedRename>(store, REFUSED_RENAME_PREFIX + sessionId);
  return refused?.to === versionId && store.getMapping(refused.from) !== null ? refused.from : versionId;
}

/** The mapping a segment's revisions carry: its mapping, with the tags Tickr holds when adopted. */
export function wireMapping(store: Store, segmentId: string, mapping: NormalizedMapping): NormalizedMapping {
  const adopted = readJson<AdoptedTags>(store, ADOPTED_TAGS_PREFIX + segmentId);
  if (adopted === null || !Array.isArray(adopted.to) || canonicalJson(adopted.from) !== canonicalJson(mapping.tagIds)) return mapping;
  return { ...mapping, tagIds: [...adopted.to] };
}

const tagSet = (tags: readonly string[]): string => canonicalJson([...new Set(tags.map((t) => t.toLowerCase()))].sort());

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
  // A terminal segment is never sent again: a change on it splits, so that the new mapping goes
  // to a new, sendable segment (an in-place probe of it would never leave the store).
  if (store.isTerminal("segment", segmentId)) return false;
  const from = mappingOf(store, fromVersionId);
  const to = mappingOf(store, toVersionId);
  // A change of tags too, once this instance is known to apply renames: its answer then tells a
  // tag Tickr dropped from a change Tickr ignored only with that knowledge (resolveAppliedProbe).
  if (from === null || to === null || !contextOnlyChange(from, to, renameSupportState(store) === "supported")) return false;
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

/**
 * The tags of an answer that holds the sent task and description: "same" as sent; "adopt" when
 * Tickr holds a subset of them (a tag deleted on Tickr is dropped, never refused: the change was
 * applied, the segment's next revisions carry the tags Tickr holds); "ignored" only when the
 * probe changed the tags and the answer shows the previous ones, which are not a subset of those
 * sent (the change was not applied); any other difference is adopted too.
 */
function tagVerdict(entry: AppliedEntry, sent: Partial<SegmentBody>, previousTags: readonly string[] | null): "same" | "ignored" | "adopt" {
  if (entry.tagIds === undefined || !Array.isArray(sent.tagIds)) return "same";
  const got = tagSet(entry.tagIds);
  if (got === tagSet(sent.tagIds)) return "same";
  // Tags Tickr dropped (deleted ones) leave a subset of those sent: applied, whatever it equals.
  const sentSet = new Set(sent.tagIds.map((t) => t.toLowerCase()));
  if (entry.tagIds.every((t) => sentSet.has(t.toLowerCase()))) return "adopt";
  if (previousTags !== null && tagSet(previousTags) !== tagSet(sent.tagIds) && got === tagSet(previousTags)) return "ignored";
  return "adopt";
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
  const previous = mappingOf(store, pending.fromMappingVersionId);
  const previousTags = previous === null ? null : wireMapping(store, segmentId, previous).tagIds;
  const tags = entry !== undefined && holdsSent(entry, sent) ? tagVerdict(entry, sent, previousTags) : "ignored";
  if (entry !== undefined && tags !== "ignored") {
    clearPendingRename(store, segmentId);
    if (existed) writeRenameSupport(store, "supported", now);
    if (tags === "adopt") adoptTags(store, segmentId, entry.tagIds!);
    return true;
  }
  // An answer that does not show the entry says nothing about the capability.
  if (entry !== undefined && existed) writeRenameSupport(store, "unsupported", now);
  repairRename(store, segmentId, pending, newId(), now);
  return true;
}

/** The segment's next revisions carry the tags Tickr holds, while its mapping names the same tags. */
function adoptTags(store: Store, segmentId: string, held: readonly string[]): void {
  const seg = store.getSegment(segmentId);
  const mapping = seg ? mappingOf(store, seg.mappingVersionId) : null;
  if (mapping === null) return;
  store.setMeta(ADOPTED_TAGS_PREFIX + segmentId, JSON.stringify({ from: [...mapping.tagIds], to: [...held] } satisfies AdoptedTags));
}

/** How a refused probe was resolved: split at the change, or the change given up. */
export type RefusedProbe = "repaired" | "reverted";

/**
 * Tickr refused the probe of a pending rename (inside the send's guarded transaction), or null
 * when `revision` is not one:
 *
 *   422 immutable      the split (repairRename): the old segment keeps its project, final at the
 *                      change, its end and usage sent again in its final revision (Tickr wrote
 *                      nothing of the refused one); a new segment carries the new mapping
 *   other 422          the change is given up (revertRename): the segment goes on with the
 *                      mapping Tickr accepted, its end and usage included; the refused mapping is
 *                      never sent again on it
 *   anything else      the split, as before
 */
export function resolveRefusedProbe(
  store: Store,
  segmentId: string,
  refusal: { revision: number; code: string; validation: boolean },
  newId: () => string,
  now: Date,
): RefusedProbe | null {
  const pending = readPendingRename(store, segmentId);
  if (pending === null || !isProbe(pending, refusal.revision)) return null;
  if (refusal.validation && refusal.code !== IMMUTABLE && revertRename(store, segmentId, pending)) return "reverted";
  repairRename(store, segmentId, pending, newId(), now);
  return "repaired";
}

/**
 * Gives a refused rename up (inside a guarded transaction): the segment takes its previous mapping
 * back and stays as it is (open or final, its end and activity unchanged), the refused mapping
 * version is remembered (keepsMapping), the unsent revisions (the refused probe) are dropped: the
 * next revision carries the accepted mapping with the up-to-date end and usage. False when the
 * previous mapping is gone (the caller splits instead).
 */
export function revertRename(store: Store, segmentId: string, pending: PendingRename): boolean {
  const seg = store.getSegment(segmentId);
  if (seg === null || seg.serverState !== null || store.getMapping(pending.fromMappingVersionId) === null) return false;
  clearPendingRename(store, segmentId);
  const refused: RefusedRename = { from: pending.fromMappingVersionId, to: seg.mappingVersionId };
  store.setMeta(REFUSED_RENAME_PREFIX + seg.sessionId, JSON.stringify(refused));
  store.upsertSegment({ ...seg, mappingVersionId: pending.fromMappingVersionId });
  store.deleteOutboxFor("segment", segmentId);
  return true;
}

/**
 * Tickr holds revision `revision` of the segment with another content (409 agent_revision_conflict):
 * a pending rename's probe is committed again under the next number (its base moves to `revision`).
 */
export function supersedeProbe(store: Store, segmentId: string, revision: number): void {
  const pending = readPendingRename(store, segmentId);
  if (pending !== null && isProbe(pending, revision)) writePendingRename(store, segmentId, { ...pending, baseRevision: revision });
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
  // The old segment sends its final revision again with the up-to-date end and usage (below): a
  // last committed revision that Tickr refused (422) wrote nothing, it is superseded all the same.
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
  // The session was locked (entry_locked on another segment) while the probe was in flight: the
  // child would open a new entry in a submitted period. It is cancelled as the locked session's
  // other unsent segments are (sender.ts); the old segment, which Tickr holds, keeps its update.
  if (isLockedSession(store, seg.sessionId)) cancelUnsentSegment(store, next, now);

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
    // The session stays read (and its segments evaluated) past the ledger window until a
    // complete read has snapshotted both again (ledger.ts sessionsToRead, revisions stage).
    owe(store, seg.sessionId);
  }
}

function owe(store: Store, sessionId: string): void {
  store.setMeta(SNAPSHOT_OWED_PREFIX + sessionId, SNAPSHOT_OWED);
}
