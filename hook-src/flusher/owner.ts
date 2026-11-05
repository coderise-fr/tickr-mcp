// Flusher ownership: a compare-and-swap on owner.generation. One flusher owns an instance; every
// state transaction it runs is guarded by its generation and aborts when another flusher took
// over (stale heartbeat) or when newer code migrated the schema.
import type { OwnerRow, Store } from "../store/db.js";
import { SCHEMA_VERSION } from "../store/schema.js";

/** A heartbeat older than this (or this far in the future, after a clock change) may be taken over. */
export const OWNER_STALE_MS = 2 * 60_000;
/** Heartbeat written by a flusher that exits cleanly: the next hook starts a new one at once. */
export const RELEASED_HEARTBEAT = "1970-01-01T00:00:00.000Z";

export type LostOwnershipReason = "generation" | "newer_schema";

export class LostOwnership extends Error {
  constructor(readonly reason: LostOwnershipReason = "generation") {
    super(reason === "newer_schema" ? "The store was migrated by newer code." : "Another flusher owns this instance.");
    this.name = "LostOwnership";
  }
}

function shift(nowIso: string, ms: number): string {
  return new Date(Date.parse(nowIso) + ms).toISOString();
}

/** True while a flusher's heartbeat is recent enough that no other one may take over. */
export function isOwnerFresh(owner: OwnerRow | null, now: Date): boolean {
  if (owner === null) return false;
  const beat = Date.parse(owner.heartbeat);
  if (Number.isNaN(beat)) return false;
  const nowMs = now.getTime();
  return beat >= nowMs - OWNER_STALE_MS && beat <= nowMs + OWNER_STALE_MS;
}

/**
 * Claims the instance: generation 1 on the first run, else generation + 1 when the current
 * heartbeat is stale (> 2 min). Returns the new generation, or null when another flusher is alive
 * or the schema is newer than this code.
 */
export function claimOwnership(store: Store, pid: number, nowIso: string): number | null {
  return store.transaction(() => {
    if (store.schemaVersion() > SCHEMA_VERSION) return null;
    if (store.insertFirstOwner(pid, nowIso)) return 1;
    if (!store.takeOverOwner(pid, nowIso, shift(nowIso, -OWNER_STALE_MS), shift(nowIso, OWNER_STALE_MS))) return null;
    return store.readOwner()!.generation;
  });
}

/**
 * Runs fn in a BEGIN IMMEDIATE transaction that first refreshes the heartbeat WHERE generation =
 * gen. Zero rows (another flusher took over), or a schema newer than this code, rolls back and
 * throws LostOwnership. fn must not do any network I/O.
 */
export function guarded<T>(store: Store, gen: number, nowIso: string, fn: () => T): T {
  return store.transaction(() => {
    if (store.schemaVersion() > SCHEMA_VERSION) throw new LostOwnership("newer_schema");
    if (store.setOwnerHeartbeat(gen, nowIso) === 0) throw new LostOwnership("generation");
    return fn();
  });
}

/**
 * Gives the instance up when `idle()` still holds inside the guarded transaction (no event nor
 * fallback file arrived since the last pass). Hooks that run after the release see a stale
 * heartbeat and start a new flusher. Returns false, keeping ownership, when work arrived.
 */
export function releaseOwnership(store: Store, gen: number, nowIso: string, idle: () => boolean): boolean {
  return guarded(store, gen, nowIso, () => {
    if (!idle()) return false;
    store.setOwnerHeartbeat(gen, RELEASED_HEARTBEAT);
    return true;
  });
}
