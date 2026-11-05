// The detached flusher of one instance: open the store (and migrate it), claim ownership, then
// run passes (fallback import, then the PIPELINE stages) until nothing is due within the wake
// budget or the budget is spent. It never prints anything (stdio is ignored by the spawner).
//
// Waiting and handing over (a hook that sees a fresh heartbeat starts no flusher, and the
// SessionEnd of a session is its last hook, so the owner must not leave work behind):
//
//   - a wait for a due stage is slept in slices of POLL_MS; the flusher wakes at once when an
//     event or a fallback file arrived since the pass started;
//   - the send stage of a pass that committed revisions gets at least SEND_RESERVE_MS (one
//     request), past the wake budget when needed, once per run (a run always ends);
//   - after releasing the instance, a flusher that leaves work behind hands it over to ONE
//     successor (FlusherDeps.handover, a new detached flusher): at once for events or fallback
//     files that arrived, for a stage cut short by the budget or due within SUCCESSOR_HORIZON_MS;
//     after the delay of a send retry due within MAX_SUCCESSOR_DELAY_MS. A successor never starts
//     sooner than SUCCESSOR_MIN_INTERVAL_MS after its predecessor, and the chain is capped
//     (spawn.ts). Anything else (a lease refresh or idle finalisation later on, a longer
//     Retry-After) waits for the next hook, as before.
//
// With TICKR_PLUGIN_DEBUG=1 in its environment, the flusher appends one JSON line per step to
// <instance>/debug.log (kept under DEBUG_MAX_BYTES). A line is built field by field from an
// allow-list (DebugRecord): fixed step names, stage names, counts and durations. Never a key, a
// path, an id, a description, a body or any text that came from Claude Code or from Tickr.
import { appendFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { PluginConfig } from "../config.js";
import { FALLBACK_DIR, importFallback, pendingFallbackCount } from "../fallback.js";
import { DB_FILE, openStore } from "../store/db.js";
import { SCHEMA_VERSION } from "../store/schema.js";
import { type AgentApi, REQUEST_TIMEOUT_MS } from "./api.js";
import { claimOwnership, guarded, LostOwnership, releaseOwnership } from "./owner.js";
import { canSend, MAX_BACKOFF_MS } from "./sender.js";
import { type FlusherBoundary, PIPELINE, STAGE_NAMES, type StageContext, type StageName, type StageRun } from "./stages.js";

export const FLUSHER_BUSY_TIMEOUT_MS = 5000;
export const WAKE_BUDGET_MS = 60_000;
/** A wait is slept in slices of this length, watching for new events and fallback files. */
export const POLL_MS = 250;
/** Time the send stage of a pass that committed revisions gets at least (one request and a margin). */
export const SEND_RESERVE_MS = REQUEST_TIMEOUT_MS + 1000;
/** Work due within this time when the flusher stops is handed over to a successor at once. */
export const SUCCESSOR_HORIZON_MS = 5000;
/** A send retry due within this time is handed over to a successor started that much later. */
export const MAX_SUCCESSOR_DELAY_MS = MAX_BACKOFF_MS;
/** A successor never starts sooner than this after its predecessor started. */
export const SUCCESSOR_MIN_INTERVAL_MS = 5000;

/** Environment switch of the debug log ("1" turns it on). */
export const DEBUG_ENV = "TICKR_PLUGIN_DEBUG";
export const DEBUG_FILE = "debug.log";
/** The debug log starts again from empty past this size. */
export const DEBUG_MAX_BYTES = 1_000_000;

/** One debug line. Only these fields, with these types, are ever written. */
export interface DebugRecord {
  step: "start" | "claimed" | "pass" | "stage" | "boundary" | "handover" | "end";
  stage?: StageName;
  point?: FlusherBoundary;
  outcome?: FlushOutcome;
  generation?: number;
  pass?: number;
  dueInMs?: number | null;
  ms?: number;
  pendingRevisions?: number;
  terminalItems?: number;
}

const STEPS = new Set<DebugRecord["step"]>(["start", "claimed", "pass", "stage", "boundary", "handover", "end"]);
const OUTCOMES = new Set<FlushOutcome>(["done", "not_owner", "newer_schema", "lost_ownership"]);
const BOUNDARY = /^(claimed|fallback_committed|revision_committed|sent|acknowledged|released|stage:[a-z]+)$/;
const NUMBERS = ["generation", "pass", "dueInMs", "ms", "pendingRevisions", "terminalItems"] as const;

/** The JSON line of a record: allow-listed fields only, anything unexpected dropped. */
export function debugLine(rec: DebugRecord, at: Date): string {
  const out: Record<string, string | number | null> = { at: at.toISOString() };
  if (!STEPS.has(rec.step)) return "";
  out.step = rec.step;
  if (rec.stage !== undefined && (STAGE_NAMES as readonly string[]).includes(rec.stage)) out.stage = rec.stage;
  if (rec.point !== undefined && BOUNDARY.test(rec.point)) out.point = rec.point;
  if (rec.outcome !== undefined && OUTCOMES.has(rec.outcome)) out.outcome = rec.outcome;
  for (const key of NUMBERS) {
    const v = rec[key];
    if (v === null) out[key] = null;
    else if (typeof v === "number" && Number.isFinite(v)) out[key] = Math.round(v);
  }
  return `${JSON.stringify(out)}\n`;
}

/** A debug log at `path` that never throws (a failed write is dropped). */
export function debugLogger(path: string, now: () => Date = () => new Date()): (rec: DebugRecord) => void {
  try {
    if (statSync(path).size > DEBUG_MAX_BYTES) writeFileSync(path, "");
  } catch {
    // No log yet.
  }
  return (rec) => {
    try {
      const text = debugLine(rec, now());
      if (text !== "") appendFileSync(path, text);
    } catch {
      // Debugging never fails the flusher.
    }
  };
}

export interface FlusherDeps {
  now(): Date;
  uptime(): number;
  api: AgentApi;
  config: PluginConfig;
  /** Real time one wake-up may last (60 000). */
  wakeBudgetMs: number;
  /** Replaces stages of PIPELINE (tests). */
  stages?: Partial<Record<StageName, StageRun>>;
  pid?: number;
  busyTimeoutMs?: number;
  /** Monotonic milliseconds (performance.now), for the budget. */
  clock?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** Progress points, see FlusherBoundary. */
  onBoundary?: (point: FlusherBoundary) => void;
  /** The debug log (TICKR_PLUGIN_DEBUG=1), see debugLogger. */
  debug?: (rec: DebugRecord) => void;
  /**
   * Starts a successor flusher that waits delayMs before it claims the instance, called after
   * the release when work is left behind (spawn.ts spawnSuccessor). Absent: nobody is started.
   */
  handover?: (delayMs: number) => void;
  /** Milliseconds to wait before opening the store (a successor's start delay). */
  startDelayMs?: number;
}

/**
 * done: passes ran and the instance was released; not_owner: another flusher is alive;
 * newer_schema: newer code migrated the store (nothing written); lost_ownership: another flusher
 * took over during the run.
 */
export type FlushOutcome = "done" | "not_owner" | "newer_schema" | "lost_ownership";

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/** What a run leaves behind when it stops. */
export interface LeftBehind {
  /** An event or a fallback file arrived after the last pass started. */
  arrived: boolean;
  /** The earliest due of the last pass (any stage), or null. */
  dueInMs: number | null;
  /** The due of the send stage in the last pass (a retry, a row not due yet), or null. */
  sendDueInMs: number | null;
}

/**
 * The start delay of the successor that takes over what a run of `ranMs` leaves behind, or null
 * when the next hook can take it: at once for arrived work or work due within
 * SUCCESSOR_HORIZON_MS, after the retry delay for a send due within MAX_SUCCESSOR_DELAY_MS; never
 * sooner than SUCCESSOR_MIN_INTERVAL_MS after the run started (no spawn storm).
 */
export function successorDelay(left: LeftBehind, ranMs: number): number | null {
  let delay: number | null = null;
  if (left.arrived) delay = 0;
  else if (left.dueInMs !== null && left.dueInMs <= SUCCESSOR_HORIZON_MS) delay = left.dueInMs;
  else if (left.sendDueInMs !== null && left.sendDueInMs <= MAX_SUCCESSOR_DELAY_MS) delay = left.sendDueInMs;
  if (delay === null) return null;
  return Math.max(0, delay, SUCCESSOR_MIN_INTERVAL_MS - ranMs);
}

interface PassResult {
  due: number | null;
  sendDue: number | null;
  /** A stage stopped for lack of budget: its work is due at once. */
  outOfBudget: boolean;
}

function minDue(a: number | null, b: number | null): number | null {
  if (a === null) return b;
  if (b === null) return a;
  return Math.min(a, b);
}

/**
 * Sleeps up to `ms` in slices of POLL_MS, and returns as soon as `arrived()` holds (an event or a
 * fallback file came in: a hook that saw this flusher alive started no other one).
 */
async function waitForWork(ms: number, clock: () => number, sleep: (ms: number) => Promise<void>, arrived: () => boolean): Promise<void> {
  const wakeAt = clock() + ms;
  for (;;) {
    if (arrived()) return;
    const rest = wakeAt - clock();
    if (rest <= 0) return;
    await sleep(Math.min(POLL_MS, rest));
  }
}

export async function runFlusher(instanceDir: string, deps: FlusherDeps): Promise<FlushOutcome> {
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? realSleep;
  const debug = deps.debug ?? (() => undefined);
  let committed = false; // a revision was committed in the current pass
  const boundary = (point: FlusherBoundary) => {
    if (point === "revision_committed") committed = true;
    deps.onBoundary?.(point);
    if (!point.startsWith("stage:")) debug({ step: "boundary", point });
  };
  const nowIso = () => deps.now().toISOString();
  debug({ step: "start" });
  if (deps.startDelayMs !== undefined && deps.startDelayMs > 0) await sleep(deps.startDelayMs);
  let endAt = clock() + deps.wakeBudgetMs;
  const started = clock();

  const opened = openStore(join(instanceDir, DB_FILE), { role: "flusher", busyTimeoutMs: deps.busyTimeoutMs ?? FLUSHER_BUSY_TIMEOUT_MS });
  if (typeof opened === "string") {
    debug({ step: "end", outcome: "newer_schema" });
    return "newer_schema";
  }
  const store = opened;
  const end = (outcome: FlushOutcome): FlushOutcome => {
    let counts: Pick<DebugRecord, "pendingRevisions" | "terminalItems"> = {};
    try {
      counts = { pendingRevisions: store.pendingOutboxCount(), terminalItems: store.listTerminal().length };
    } catch {
      // The counts are only a help.
    }
    debug({ step: "end", outcome, ms: clock() - started, ...counts });
    return outcome;
  };
  try {
    const gen = claimOwnership(store, deps.pid ?? process.pid, nowIso());
    if (gen === null) return end(store.schemaVersion() > SCHEMA_VERSION ? "newer_schema" : "not_owner");
    boundary("claimed");
    debug({ step: "claimed", generation: gen });

    const stages = STAGE_NAMES.map((name) => ({ name, run: deps.stages?.[name] ?? PIPELINE[name] }));
    const ctx: StageContext = {
      store,
      generation: gen,
      instanceDir,
      config: deps.config,
      api: deps.api,
      now: () => deps.now(),
      uptime: () => deps.uptime(),
      remainingMs: () => Math.max(0, endAt - clock()),
      guarded: (fn) => guarded(store, gen, nowIso(), fn),
      boundary,
    };
    const fallback = join(instanceDir, FALLBACK_DIR);
    let reserved = false; // the send reserve is granted once per run, so that a run always ends

    const runStages = async (): Promise<PassResult> => {
      const out: PassResult = { due: null, sendDue: null, outOfBudget: false };
      for (const stage of stages) {
        if (stage.name === "send" && committed && !reserved && endAt - clock() < SEND_RESERVE_MS && canSend(store)) {
          // Revisions were committed and may be sent: send at least one, past the soft budget if need be.
          endAt = clock() + SEND_RESERVE_MS;
          reserved = true;
        }
        const stageStart = clock();
        const result = await stage.run(ctx);
        debug({ step: "stage", stage: stage.name, ms: clock() - stageStart, dueInMs: result.dueInMs ?? null });
        boundary(`stage:${stage.name}`);
        const due = typeof result.dueInMs === "number" ? result.dueInMs : null;
        out.due = minDue(out.due, due);
        if (stage.name === "send") out.sendDue = due;
        if (result.outOfBudget) out.outOfBudget = true;
        if (result.halt) break;
      }
      return out;
    };

    let pass = 0;
    for (;;) {
      pass += 1;
      debug({ step: "pass", pass });
      ctx.guarded(() => undefined); // heartbeat, and stop early when ownership was lost
      importFallback(store, gen, fallback, { now: deps.now, onCommitted: () => boundary("fallback_committed") });
      const seen = store.maxEventSeq();
      const arrived = () => {
        try {
          return store.maxEventSeq() !== seen || pendingFallbackCount(fallback) > 0;
        } catch {
          return false; // the store is busy for a moment: look again at the next slice
        }
      };
      committed = false;
      const result = await runStages();

      const left = endAt - clock();
      if (!result.outOfBudget && result.due !== null && result.due < left) {
        await waitForWork(Math.max(0, result.due), clock, sleep, arrived);
        continue;
      }
      // Nothing due within the budget: give the instance up, unless an event or a fallback file
      // arrived during the pass (its hook saw a fresh heartbeat and started no flusher). Once
      // the budget is spent, what is left is handed over to a successor.
      const spent = left <= 0 || result.outOfBudget;
      if (releaseOwnership(store, gen, nowIso(), () => spent || !arrived())) {
        boundary("released");
        const delay = successorDelay({ arrived: arrived(), dueInMs: result.due, sendDueInMs: result.sendDue }, clock() - started);
        if (delay !== null && deps.handover) {
          debug({ step: "handover", dueInMs: delay });
          try {
            deps.handover(delay);
          } catch {
            // The next hook starts a flusher instead.
          }
        }
        return end("done");
      }
    }
  } catch (error) {
    if (error instanceof LostOwnership) return end(error.reason === "newer_schema" ? "newer_schema" : "lost_ownership");
    throw error;
  } finally {
    store.close();
  }
}
