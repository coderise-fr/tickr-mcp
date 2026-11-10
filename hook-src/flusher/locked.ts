// A session stopped because Tickr says its period is already submitted (409 entry_locked), and the
// segments of it that must never be sent: the ones Tickr does not hold yet would open new entries
// in that period. Shared by the send stage (sender.ts) and the rename repair (rename.ts), which
// both can produce such a segment; kept apart from both so that neither imports the other.
import type { SegmentRow, Store } from "../store/db.js";
import { ENTRY_LOCKED } from "./api.js";

/** Session state of a session one of whose segments Tickr refused as in a submitted period (entry_locked). */
export const STOPPED_LOCKED = "stopped_locked";

/** Whether the session was stopped by an entry_locked refusal. */
export function isLockedSession(store: Store, sessionId: string): boolean {
  return store.getSession(sessionId)?.state === STOPPED_LOCKED;
}

/**
 * Closes a segment Tickr does not hold locally and makes it terminal: its outbox rows are dropped
 * (the send pass checks the terminal list before every row, including rows it already read), it is
 * final with reason stopped_locked, and its time and tokens stay where they are (a refused
 * recipient keeps its rows). The caller clears any pending rename of it.
 */
export function cancelUnsentSegment(store: Store, segment: SegmentRow, now: Date): void {
  store.deleteOutboxFor("segment", segment.id);
  if (!segment.final) store.upsertSegment({ ...segment, working: false, final: true, finalReason: STOPPED_LOCKED });
  store.addTerminal({
    targetKind: "segment",
    targetId: segment.id,
    revision: segment.lastRevision > 0 ? segment.lastRevision : null,
    code: ENTRY_LOCKED,
    at: now.toISOString(),
    diagnostic: "Not sent: the session was stopped, its period is already submitted.",
  });
}
