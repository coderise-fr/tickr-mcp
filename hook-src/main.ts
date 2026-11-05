// Entry point of the plugin bundle (plugins/tickr/hooks/dist/tickr-hook.cjs).
//
//   tickr-hook.cjs <HookEvent>            a Claude Code hook: no network, always exit 0
//   tickr-hook.cjs flush <instanceDir>    the detached flusher
//   tickr-hook.cjs status <dataDir>       /tickr:status
import { uptime } from "node:os";
import { resolve, sep } from "node:path";
import { readPluginConfig } from "./config.js";
import { OFFLINE_API } from "./flusher/api.js";
import { runFlusher, WAKE_BUDGET_MS } from "./flusher/run.js";
import { recordEvent } from "./intake.js";
import { type HookInput, readHookInput, type Write, writeHookOutput, writeStdout } from "./io.js";
import { loadSqlite, unsupportedRuntimeMessage } from "./runtime.js";
import { spawnFlusher } from "./spawn.js";

/** Global budget of a hook, counted from process start (below the 1.5 s of SessionEnd). */
export const HOOK_BUDGET_MS = 1000;

export const HOOK_EVENTS = [
  "SessionStart",
  "UserPromptSubmit",
  "PostToolUse",
  "Stop",
  "SessionEnd",
  "SubagentStart",
  "SubagentStop",
] as const;
export type HookEvent = (typeof HOOK_EVENTS)[number];

export function isHookEvent(value: string | undefined): value is HookEvent {
  return (HOOK_EVENTS as readonly (string | undefined)[]).includes(value);
}

export interface HookIo {
  stdin: NodeJS.ReadableStream;
  /** Absolute time (ms since the epoch) by which the hook must be done. */
  deadlineMs: number;
  write: Write;
  /** Path of the running bundle, used to start the flusher; absent: no flusher is started. */
  bundlePath?: string;
}

// Set to true by scripts/build-hook.mjs: the bundle runs main(), the sources imported by tests do not.
declare const TICKR_HOOK_BUNDLE: boolean | undefined;
const IS_BUNDLE = typeof TICKR_HOOK_BUNDLE !== "undefined" && TICKR_HOOK_BUNDLE;

function processIo(): HookIo {
  const io: HookIo = { stdin: process.stdin, deadlineMs: performance.timeOrigin + HOOK_BUDGET_MS, write: writeStdout };
  if (IS_BUNDLE && process.argv[1]) io.bundlePath = process.argv[1];
  return io;
}

async function runHook(event: HookEvent, env: NodeJS.ProcessEnv, io: HookIo): Promise<void> {
  if (loadSqlite() === null) {
    // Hooks become no-ops; say it once, when the session starts.
    if (event === "SessionStart") writeHookOutput({ systemMessage: unsupportedRuntimeMessage() }, io.write);
    return;
  }
  const input: HookInput | null = await readHookInput(io.stdin, io.deadlineMs);
  if (input === null) return;

  const config = readPluginConfig(env);
  if ("problem" in config) {
    if (event === "SessionStart") writeHookOutput({ systemMessage: `Tickr: ${config.problem}` }, io.write);
    return;
  }
  // The argv event is the wiring of hooks.json: it wins over the event name in the input.
  const bundlePath = io.bundlePath;
  const startFlusher = bundlePath ? (dir: string) => spawnFlusher(bundlePath, dir, env) : undefined;
  writeHookOutput(recordEvent({ ...input, hook_event_name: event }, config, io.deadlineMs, { env, startFlusher }), io.write);
}

/** The flusher of one instance directory, which must lie inside the plugin data directory. */
async function runFlush(dir: string | undefined, env: NodeJS.ProcessEnv): Promise<void> {
  if (!dir || loadSqlite() === null) return;
  const config = readPluginConfig(env);
  if ("problem" in config) return;
  const instanceDir = resolve(dir);
  if (!instanceDir.startsWith(resolve(config.dataDir) + sep)) return;
  await runFlusher(instanceDir, { now: () => new Date(), uptime, api: OFFLINE_API, config, wakeBudgetMs: WAKE_BUDGET_MS });
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: HookIo = processIo()): Promise<number> {
  const [mode] = argv;
  try {
    if (isHookEvent(mode)) await runHook(mode, env, io);
    else if (mode === "flush") await runFlush(argv[1], env);
    // "status" is added with /tickr:status.
  } catch {
    // A hook never fails the user's session; a failed flusher is started again by the next hook.
  }
  return 0;
}

if (IS_BUNDLE) {
  void main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
