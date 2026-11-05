// Entry point of the plugin bundle (plugins/tickr/hooks/dist/tickr-hook.cjs).
//
//   tickr-hook.cjs <HookEvent>            a Claude Code hook: no network, always exit 0
//   tickr-hook.cjs flush <instanceDir>    the detached flusher
//   tickr-hook.cjs status <dataDir>       /tickr:status (plain text)
import { uptime } from "node:os";
import { join, resolve, sep } from "node:path";
import { readPluginConfig } from "./config.js";
import { isLinked, recordLink } from "./consent.js";
import { createAgentApi, REQUEST_TIMEOUT_MS } from "./flusher/api.js";
import { DEBUG_ENV, DEBUG_FILE, debugLogger, runFlusher, WAKE_BUDGET_MS } from "./flusher/run.js";
import { recordEvent } from "./intake.js";
import { findMapping } from "./mapping.js";
import { type HookInput, readHookInput, type Write, writeHookOutput, writeStdout } from "./io.js";
import { loadSqlite, unsupportedRuntimeMessage } from "./runtime.js";
import { spawnFlusher, spawnSuccessor, successorStartDelay } from "./spawn.js";
import { renderStatus } from "./status.js";

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
  writeHookOutput(recordEvent({ ...input, hook_event_name: event }, config, io.deadlineMs, {
      env,
      startFlusher,
      linked: (mappingDir, hash) => isLinked(config.dataDir, mappingDir, hash),
    }), io.write);
}

/**
 * The flusher of one instance directory, which must lie inside the plugin data directory. A
 * flusher of the bundle hands the work it leaves behind over to a successor (same bundle, same
 * environment); a successor first waits the delay its predecessor gave it.
 */
async function runFlush(dir: string | undefined, env: NodeJS.ProcessEnv, bundlePath: string | undefined): Promise<void> {
  if (!dir || loadSqlite() === null) return;
  const config = readPluginConfig(env);
  if ("problem" in config) return;
  const instanceDir = resolve(dir);
  if (!instanceDir.startsWith(resolve(config.dataDir) + sep)) return;
  // The key comes from the inherited environment (PD-18), never from argv.
  const api = createAgentApi({ baseUrl: config.baseUrl, apiKey: config.apiKey, timeoutMs: REQUEST_TIMEOUT_MS });
  const debug = env[DEBUG_ENV] === "1" ? debugLogger(join(instanceDir, DEBUG_FILE)) : undefined;
  const handover = bundlePath ? (delayMs: number) => void spawnSuccessor(bundlePath, instanceDir, env, delayMs) : undefined;
  await runFlusher(instanceDir, {
    now: () => new Date(),
    uptime,
    api,
    config,
    wakeBudgetMs: WAKE_BUDGET_MS,
    startDelayMs: successorStartDelay(env),
    ...(debug ? { debug } : {}),
    ...(handover ? { handover } : {}),
  });
}

/**
 * /tickr:status: plain text on stdout. When the environment carries the plugin options, they
 * tell which instances are current; otherwise the most recent one of each workspace is.
 */
function runStatus(dir: string | undefined, env: NodeJS.ProcessEnv, write: Write): void {
  if (loadSqlite() === null) {
    write(`${unsupportedRuntimeMessage()}\n`);
    return;
  }
  const dataDir = dir?.trim() || env.CLAUDE_PLUGIN_DATA?.trim();
  if (!dataDir) {
    write("Tickr: no plugin data directory was given.\n");
    return;
  }
  const config = readPluginConfig({ ...env, CLAUDE_PLUGIN_DATA: dataDir });
  write(renderStatus(resolve(dataDir), "problem" in config ? undefined : { baseUrl: config.baseUrl, apiKey: config.apiKey }));
}

/**
 * `accept <dataDir> <checkoutDir>`, run by /tickr:link once the user chose the project: records on
 * this machine that the checkout's .tickr.json is linked (consent.ts). Plain text on stdout.
 */
function runAccept(dataDir: string | undefined, checkoutDir: string | undefined, write: Write): void {
  if (!dataDir?.trim() || !checkoutDir?.trim()) {
    write("Tickr: usage: accept <plugin data directory> <repository directory>
");
    return;
  }
  const found = findMapping(resolve(checkoutDir));
  if (found === null) write("Tickr: no .tickr.json found; nothing was linked.
");
  else if ("invalid" in found) write(`Tickr: ${found.invalid} Nothing was linked.
`);
  else if (recordLink(resolve(dataDir), found.dir, found.hash)) write("Tickr: this checkout is linked on this machine. Tracking starts with the next session.
");
  else write("Tickr: the link could not be saved (is the plugin data directory writable?).
");
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: HookIo = processIo()): Promise<number> {
  const [mode] = argv;
  try {
    if (isHookEvent(mode)) await runHook(mode, env, io);
    else if (mode === "flush") await runFlush(argv[1], env, io.bundlePath);
    else if (mode === "status") runStatus(argv[1], env, io.write);
    else if (mode === "accept") runAccept(argv[1], argv[2], io.write);
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
