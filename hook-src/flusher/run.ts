// The detached flusher of one instance: open the store (and migrate it), claim ownership, then
// run passes (fallback import, then the PIPELINE stages) until nothing is due within the wake
// budget or the budget is spent. It never prints anything (stdio is ignored by the spawner).
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
import type { AgentApi } from "./api.js";
import { claimOwnership, guarded, LostOwnership, releaseOwnership } from "./owner.js";
import { type FlusherBoundary, PIPELINE, STAGE_NAMES, type StageContext, type StageName, type StageRun } from "./stages.js";

export const FLUSHER_BUSY_TIMEOUT_MS = 5000;
export const WAKE_BUDGET_MS = 60_000;

/** Environment switch of the debug log ("1" turns it on). */
export const DEBUG_ENV = "TICKR_PLUGIN_DEBUG";
export const DEBUG_FILE = "debug.log";
/** The debug log starts again from empty past this size. */
export const DEBUG_MAX_BYTES = 1_000_000;

/** One debug line. Only these fields, with these types, are ever written. */
export interface DebugRecord {
  step: "start" | "claimed" | "pass" | "stage" | "boundary" | "end";
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

const STEPS = new Set<DebugRecord["step"]>(["start", "claimed", "pass", "stage", "boundary", "end"]);
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
}

/**
 * done: passes ran and the instance was released; not_owner: another flusher is alive;
 * newer_schema: newer code migrated the store (nothing written); lost_ownership: another flusher
 * took over during the run.
 */
export type FlushOutcome = "done" | "not_owner" | "newer_schema" | "lost_ownership";

const realSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export async function runFlusher(instanceDir: string, deps: FlusherDeps): Promise<FlushOutcome> {
  const clock = deps.clock ?? (() => performance.now());
  const sleep = deps.sleep ?? realSleep;
  const debug = deps.debug ?? (() => undefined);
  const boundary = (point: FlusherBoundary) => {
    deps.onBoundary?.(point);
    if (!point.startsWith("stage:")) debug({ step: "boundary", point });
  };
  const nowIso = () => deps.now().toISOString();
  const endAt = clock() + deps.wakeBudgetMs;
  const started = clock();
  debug({ step: "start" });

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

    let pass = 0;
    for (;;) {
      pass += 1;
      debug({ step: "pass", pass });
      ctx.guarded(() => undefined); // heartbeat, and stop early when ownership was lost
      importFallback(store, gen, fallback, { now: deps.now, onCommitted: () => boundary("fallback_committed") });
      const seen = store.maxEventSeq();

      let due: number | null = null;
      for (const stage of stages) {
        const stageStart = clock();
        const result = await stage.run(ctx);
        debug({ step: "stage", stage: stage.name, ms: clock() - stageStart, dueInMs: result.dueInMs ?? null });
        boundary(`stage:${stage.name}`);
        if (typeof result.dueInMs === "number") due = due === null ? result.dueInMs : Math.min(due, result.dueInMs);
        if (result.halt) break;
      }

      const left = endAt - clock();
      if (due !== null && due < left) {
        await sleep(Math.max(0, due));
        continue;
      }
      // Nothing due within the budget: give the instance up, unless an event or a fallback file
      // arrived during the pass (its hook saw a fresh heartbeat and started no flusher). Once
      // the budget is spent, the next hook starts a new flusher instead.
      const idle = () => left <= 0 || (store.maxEventSeq() === seen && pendingFallbackCount(fallback) === 0);
      if (releaseOwnership(store, gen, nowIso(), idle)) {
        boundary("released");
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
