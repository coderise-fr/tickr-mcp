// Starts the detached flusher of an instance from a hook. The hook calls it only when no owner
// heartbeat is fresh (< 2 min, read in its own transaction; always after a fallback file). The
// API key travels in the inherited environment only, never in argv (PD-18): argv is visible in
// process lists.
//
// A flusher that stops with work left behind starts ONE successor the same way (spawnSuccessor,
// flusher/run.ts): same bundle, same `flush <instanceDir>` argv, the environment it inherited
// plus its start delay and its place in the chain. A chain of successors stops after
// MAX_SUCCESSOR_CHAIN links; the next hook (whose flusher starts a new chain) takes over then.
import { spawn } from "node:child_process";
import { MAX_SUCCESSOR_DELAY_MS } from "./flusher/run.js";

/** Milliseconds a successor waits before it claims the instance. */
export const SUCCESSOR_DELAY_ENV = "TICKR_FLUSHER_DELAY_MS";
/** How many successors started one another before this flusher (absent: started by a hook). */
export const SUCCESSOR_CHAIN_ENV = "TICKR_FLUSHER_CHAIN";
/** Successors in one chain at most (each one runs at least a wake-up, or waits for a retry). */
export const MAX_SUCCESSOR_CHAIN = 10;

export function spawnFlusher(bundlePath: string, instanceDir: string, env: NodeJS.ProcessEnv): void {
  const child = spawn(process.execPath, ["--no-warnings", bundlePath, "flush", instanceDir], {
    detached: true,
    windowsHide: true,
    stdio: "ignore",
    env,
  });
  child.on("error", () => undefined);
  child.unref();
}

function nonNegativeInt(value: string | undefined): number {
  const n = Number.parseInt(value ?? "", 10);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** This flusher's place in its chain of successors (0: started by a hook). */
export function successorChain(env: NodeJS.ProcessEnv): number {
  return nonNegativeInt(env[SUCCESSOR_CHAIN_ENV]);
}

/** The start delay a successor was given, bounded by MAX_SUCCESSOR_DELAY_MS (0: none). */
export function successorStartDelay(env: NodeJS.ProcessEnv): number {
  return Math.min(nonNegativeInt(env[SUCCESSOR_DELAY_ENV]), MAX_SUCCESSOR_DELAY_MS);
}

/**
 * Starts the successor of a flusher that runs with `env`, waiting delayMs before it claims the
 * instance. Returns false, starting nothing, once the chain reached MAX_SUCCESSOR_CHAIN.
 */
export function spawnSuccessor(bundlePath: string, instanceDir: string, env: NodeJS.ProcessEnv, delayMs: number): boolean {
  const chain = successorChain(env);
  if (chain >= MAX_SUCCESSOR_CHAIN) return false;
  const delay = String(Math.min(Math.max(0, Math.round(delayMs)), MAX_SUCCESSOR_DELAY_MS));
  spawnFlusher(bundlePath, instanceDir, { ...env, [SUCCESSOR_DELAY_ENV]: delay, [SUCCESSOR_CHAIN_ENV]: String(chain + 1) });
  return true;
}
