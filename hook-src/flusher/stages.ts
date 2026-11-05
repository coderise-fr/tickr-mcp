// The flusher pipeline, run in this order on every pass after the fallback import:
//
//   workspace     GET /me once per instance: workspace check and clock skew
//   segmentation  events -> segments (pure reducer, flusher/segmenter.ts)
//   revisions     desired state -> immutable outbox revisions (flusher/revisions.ts)
//   send          latest due revision of each target -> Tickr (flusher/sender.ts)
//   bounds        local quotas and retention (flusher/bounds.ts)
//
// Each stage is plugged in by name in PIPELINE; run.ts never changes when a stage does.
import type { PluginConfig } from "../config.js";
import type { Store } from "../store/db.js";
import type { AgentApi } from "./api.js";
import { revisionsStage } from "./revisions.js";
import { segmentationStage } from "./segmentation.js";

export const STAGE_NAMES = ["workspace", "segmentation", "revisions", "send", "bounds"] as const;
export type StageName = (typeof STAGE_NAMES)[number];

/**
 * Points where the flusher reports its progress (FlusherDeps.onBoundary); crash tests kill the
 * process there. run.ts reports "claimed", "fallback_committed", "stage:<name>" (after each
 * stage) and "released"; the revision and send stages report the other three.
 */
export type FlusherBoundary =
  | "claimed"
  | "fallback_committed"
  | `stage:${StageName}`
  | "revision_committed"
  | "sent"
  | "acknowledged"
  | "released";

export interface StageContext {
  store: Store;
  /** Ownership generation of this flusher: every state transaction goes through guarded(). */
  generation: number;
  instanceDir: string;
  config: PluginConfig;
  api: AgentApi;
  now(): Date;
  /** Seconds since boot (os.uptime). */
  uptime(): number;
  /** Real time left in this wake-up, in milliseconds. */
  remainingMs(): number;
  /** guarded(store, generation, now, fn): a transaction that aborts when ownership was lost. */
  guarded<T>(fn: () => T): T;
  boundary(point: FlusherBoundary): void;
}

export interface StageResult {
  /** The stage has more work in this many milliseconds (0: at once); absent: nothing pending. */
  dueInMs?: number | null;
  /** Skip the later stages of this pass (for example a paused instance skips sending). */
  halt?: boolean;
}

export type StageRun = (ctx: StageContext) => StageResult | Promise<StageResult>;

/** A stage with nothing to do. */
export const idleStage: StageRun = () => ({});

/** The stage behind each name. */
export const PIPELINE: Record<StageName, StageRun> = {
  workspace: idleStage,
  segmentation: segmentationStage,
  revisions: revisionsStage(),
  send: idleStage,
  bounds: idleStage,
};
