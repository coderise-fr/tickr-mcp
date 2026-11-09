// One-time messages the next hook shows (systemMessage). The flusher queues them in the store;
// collection gaps are counted in a file because they happen precisely when the store is unusable.
import type { Store } from "./store/db.js";

export type NoticeKind =
  | "intake_paused"
  | "unauthorized"
  | "forbidden_role"
  | "segments_disabled"
  | "clock_skew"
  | "workspace_mismatch"
  | "not_project_member"
  | "unlinked"
  | "entry_locked"
  /** A rename refused by Tickr, with the refusal's code (letters, digits and underscores only). */
  | `${typeof RENAME_REFUSED}:${string}`;

/** Notice kind prefix of a rename Tickr refused (`rename_refused:<code>`). */
export const RENAME_REFUSED = "rename_refused";

const MESSAGES: Record<Exclude<NoticeKind, `${typeof RENAME_REFUSED}:${string}`>, string> = {
  intake_paused:
    "Tickr: time tracking is paused because the local queue reached its size limit. Run /tickr:status for details.",
  unauthorized: "Tickr: the API key was refused. Check the Tickr plugin option api_key; sending is paused until then.",
  forbidden_role: "Tickr: this API key cannot record time (read-only role). Sending is paused.",
  segments_disabled: "Tickr: this Tickr instance does not accept agent sessions yet. Sending is paused and retried later.",
  clock_skew: "Tickr: this computer's clock is ahead of Tickr. Sending is paused until the clocks agree.",
  workspace_mismatch:
    "Tickr: .tickr.json names another workspace than the API key's. This session is not tracked; run /tickr:link.",
  not_project_member: "Tickr: you are not a member of the project named in .tickr.json. Run /tickr:link to pick another one.",
  unlinked:
    "Tickr: this repository is no longer linked on this machine, so its session stopped being tracked. Run /tickr:link to link it again.",
  entry_locked: "Tickr says this period is already submitted; the session is not recorded further.",
};

/** The notice kind of a rename refused with this code (already reduced to [a-z0-9_] by api.ts). */
export function renameRefusedKind(code: string): NoticeKind {
  const clean = code.toLowerCase().replace(/[^a-z0-9_]/g, "").slice(0, 64);
  return `${RENAME_REFUSED}:${clean === "" ? "validation" : clean}`;
}

export function noticeMessage(kind: string): string {
  if (kind.startsWith(`${RENAME_REFUSED}:`)) {
    const code = kind.slice(RENAME_REFUSED.length + 1).replace(/[^a-z0-9_]/g, "");
    return `Tickr refused the new task or description of this session (${code}); the previous ones are kept.`;
  }
  return (MESSAGES as Record<string, string>)[kind] ?? "Tickr: something needs your attention. Run /tickr:status for details.";
}

export function collectionInterruptedMessage(gaps: number): string {
  const events = gaps === 1 ? "1 event" : `${gaps} events`;
  return `Tickr: collection interrupted: ${events} could not be recorded (the plugin data directory was not writable).`;
}

/** Queues a notice for the next hook (one unshown notice per kind). */
export function addNotice(store: Store, kind: NoticeKind, now: Date): boolean {
  return store.addNotice(kind, now.toISOString());
}

/** The messages of the unshown notices, marked shown. Call inside the hook's transaction. */
export function takeNoticeMessages(store: Store, now: Date): string[] {
  return store.takeUnshownNotices(now.toISOString()).map((notice) => noticeMessage(notice.kind));
}
