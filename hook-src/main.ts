// Entry point of the plugin bundle (plugins/tickr/hooks/dist/tickr-hook.cjs).
//
//   tickr-hook.cjs <HookEvent>            a Claude Code hook: no network, always exit 0
//   tickr-hook.cjs flush <instanceDir>    the detached flusher
//   tickr-hook.cjs status <dataDir>       /tickr:status
import { readPluginConfig } from "./config.js";
import { recordEvent } from "./intake.js";
import { type HookInput, readHookInput, type Write, writeHookOutput, writeStdout } from "./io.js";
import { loadSqlite, unsupportedRuntimeMessage } from "./runtime.js";

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
}

function processIo(): HookIo {
  return { stdin: process.stdin, deadlineMs: performance.timeOrigin + HOOK_BUDGET_MS, write: writeStdout };
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
  writeHookOutput(recordEvent({ ...input, hook_event_name: event }, config, io.deadlineMs, { env }), io.write);
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: HookIo = processIo()): Promise<number> {
  const [mode] = argv;
  try {
    if (isHookEvent(mode)) await runHook(mode, env, io);
    // "flush" and "status" are added with the flusher and /tickr:status.
  } catch {
    // A hook never fails the user's session.
  }
  return 0;
}

// Set to true by scripts/build-hook.mjs: the bundle runs main(), the sources imported by tests do not.
declare const TICKR_HOOK_BUNDLE: boolean | undefined;
if (typeof TICKR_HOOK_BUNDLE !== "undefined" && TICKR_HOOK_BUNDLE) {
  void main(process.argv.slice(2), process.env).then(
    (code) => process.exit(code),
    () => process.exit(0),
  );
}
