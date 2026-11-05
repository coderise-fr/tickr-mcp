// The "workspace" stage: GET /api/v1/me once per instance (§7.3, PD-13).
//
// - The answer (workspace id and name, measured clock skew) is cached in meta; sending waits
//   for it. A failed probe is retried with backoff by a later pass or wake-up.
// - A local clock more than 4 min ahead of Tickr pauses sending (clock_skew) instead of letting
//   Tickr refuse every live segment; it resumes once a re-probe measures less than 4 min.
// - A paused instance re-probes at most once an hour (PROBE_INTERVAL_MS).
// - Sessions whose mapping names another workspace than the key's stop being tracked
//   (sender.stopMismatchedSession): their segments go terminal, one notice.
//
// The stage never halts the pass: segmentation, revisions and bounds run while offline or paused.
import { parseStoredMapping } from "../mapping.js";
import type { Store } from "../store/db.js";
import type { MeInfo } from "./api.js";
import {
  allowProbeSend,
  PAUSE_KEY,
  PROBE_INTERVAL_MS,
  pauseSending,
  readPause,
  readWorkspace,
  resumeSending,
  retryDelayMs,
  stopMismatchedSession,
  writeWorkspace,
} from "./sender.js";
import type { StageRun } from "./stages.js";

/** A local clock further ahead of Tickr than this pauses sending. */
export const CLOCK_SKEW_LIMIT_MS = 4 * 60_000;
/** meta: { attempts, at } of the next probe of an instance never checked yet. */
export const PROBE_RETRY_KEY = "workspace_probe_retry";
/** meta: the last event seq checked for a workspace mismatch. */
export const MISMATCH_CURSOR_KEY = "workspace_checked_seq";

interface ProbeRetry {
  attempts: number;
  at: string;
}

function readRetry(store: Store): ProbeRetry | null {
  const raw = store.getMeta(PROBE_RETRY_KEY);
  if (raw === null) return null;
  try {
    return JSON.parse(raw) as ProbeRetry;
  } catch {
    return null;
  }
}

/** True when this pass should call GET /me. */
export function probeDue(store: Store, now: Date): boolean {
  const pause = readPause(store);
  if (pause !== null) return pause.probing !== true && now.getTime() >= Date.parse(pause.probeAt);
  if (readWorkspace(store) !== null) return false;
  const retry = readRetry(store);
  return retry === null || now.getTime() >= Date.parse(retry.at);
}

/** Stops the sessions with events after the cursor whose mapping names another workspace. */
export function checkMismatch(store: Store, workspaceId: string, now: Date): void {
  const after = Number(store.getMeta(MISMATCH_CURSOR_KEY) ?? "0");
  const last = store.maxEventSeq();
  if (last <= after) return;
  const foreign = store
    .listMappings()
    .filter((m) => {
      const mapping = parseStoredMapping(m.normalizedJson);
      return mapping !== null && mapping.workspaceId !== workspaceId;
    })
    .map((m) => m.id);
  if (foreign.length > 0) {
    for (const sessionId of store.sessionsWithMappingsAfter(after, foreign)) stopMismatchedSession(store, sessionId, now);
  }
  store.setMeta(MISMATCH_CURSOR_KEY, String(last));
}

export function workspaceStage(opts: { random?: () => number } = {}): StageRun {
  return async (ctx) => {
    const { store } = ctx;
    if (probeDue(store, ctx.now())) {
      const answer = await ctx.api.me();
      const now = ctx.now();
      ctx.guarded(() => {
        if ("workspaceId" in answer) {
          applyMe(store, answer, now);
        } else if (answer.kind === "pause") {
          pauseSending(store, answer.reason, now);
        } else {
          // Network failure, timeout or an unexpected answer: probe again later.
          const pause = readPause(store);
          if (pause !== null) {
            store.setMeta(PAUSE_KEY, JSON.stringify({ ...pause, probeAt: new Date(now.getTime() + PROBE_INTERVAL_MS).toISOString() }));
          } else {
            const attempts = (readRetry(store)?.attempts ?? 0) + 1;
            const delay = retryDelayMs(answer.kind === "retry" ? answer.afterMs : null, attempts, opts.random);
            store.setMeta(PROBE_RETRY_KEY, JSON.stringify({ attempts, at: new Date(now.getTime() + delay).toISOString() }));
          }
        }
      });
    }
    const known = readWorkspace(store);
    if (known !== null) ctx.guarded(() => checkMismatch(store, known.workspaceId, ctx.now()));
    return {};
  };
}

/** A successful GET /me (inside a guarded transaction). */
function applyMe(store: Store, me: MeInfo, now: Date): void {
  store.deleteMeta(PROBE_RETRY_KEY);
  const skewMs = Date.parse(me.localTime) - Date.parse(me.serverTime);
  if (skewMs > CLOCK_SKEW_LIMIT_MS) {
    pauseSending(store, "clock_skew", now);
    return;
  }
  writeWorkspace(store, { workspaceId: me.workspaceId, workspaceName: me.workspaceName, checkedAt: now.toISOString(), skewMs });
  const pause = readPause(store);
  // The clocks agree again: over. Any other pause is decided by the next send (allowProbeSend).
  if (pause?.reason === "clock_skew") resumeSending(store);
  else if (pause !== null) allowProbeSend(store);
}
