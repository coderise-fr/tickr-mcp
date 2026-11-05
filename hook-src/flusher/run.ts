// The detached flusher of one instance: open the store (and migrate it), claim ownership, then
// run passes (fallback import, then the PIPELINE stages) until nothing is due within the wake
// budget or the budget is spent. It never prints anything (stdio is ignored by the spawner).
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
  const boundary = (point: FlusherBoundary) => deps.onBoundary?.(point);
  const nowIso = () => deps.now().toISOString();
  const endAt = clock() + deps.wakeBudgetMs;

  const opened = openStore(join(instanceDir, DB_FILE), { role: "flusher", busyTimeoutMs: deps.busyTimeoutMs ?? FLUSHER_BUSY_TIMEOUT_MS });
  if (typeof opened === "string") return "newer_schema";
  const store = opened;
  try {
    const gen = claimOwnership(store, deps.pid ?? process.pid, nowIso());
    if (gen === null) return store.schemaVersion() > SCHEMA_VERSION ? "newer_schema" : "not_owner";
    boundary("claimed");

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

    for (;;) {
      ctx.guarded(() => undefined); // heartbeat, and stop early when ownership was lost
      importFallback(store, gen, fallback, { now: deps.now, onCommitted: () => boundary("fallback_committed") });
      const seen = store.maxEventSeq();

      let due: number | null = null;
      for (const stage of stages) {
        const result = await stage.run(ctx);
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
        return "done";
      }
    }
  } catch (error) {
    if (error instanceof LostOwnership) return error.reason === "newer_schema" ? "newer_schema" : "lost_ownership";
    throw error;
  } finally {
    store.close();
  }
}
