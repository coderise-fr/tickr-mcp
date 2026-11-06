// Entry point of the plugin bundle (plugins/tickr/hooks/dist/tickr-hook.cjs).
//
//   tickr-hook.cjs <HookEvent>            a Claude Code hook: no network, always exit 0
//   tickr-hook.cjs flush <instanceDir>    the detached flusher
//   tickr-hook.cjs status <dataDir>       /tickr:status (plain text)
//   tickr-hook.cjs accept <dataDir> <checkoutDir>                       /tickr:link
//   tickr-hook.cjs set-context <dataDir> <sessionId> <projectId> [...]  /tickr:task, /tickr:describe
//   tickr-hook.cjs clear-context <dataDir> <sessionId>                  /tickr:task clear
//   tickr-hook.cjs context-info <dataDir> <sessionId> <cwd>             /tickr:task, /tickr:describe (read-only)
import { uptime } from "node:os";
import { join, resolve, sep } from "node:path";
import { readPluginConfig } from "./config.js";
import { isLinked, recordLink, revokeStaleLinks } from "./consent.js";
import {
  clearContext,
  effectiveMapping,
  isSessionId,
  isUuid,
  normalizeDescription,
  readContext,
  sameId,
  type SessionContext,
  writeContext,
} from "./context.js";
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
      revokeStale: (mappingDir, hash) => revokeStaleLinks(config.dataDir, mappingDir, hash),
    }), io.write, event);
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
    write(line("Tickr: usage: accept <plugin data directory> <repository directory>"));
    return;
  }
  const found = findMapping(resolve(checkoutDir));
  if (found === null) write(line("Tickr: no .tickr.json found; nothing was linked."));
  else if ("invalid" in found) write(line(`Tickr: ${found.invalid} Nothing was linked.`));
  else if (recordLink(resolve(dataDir), found.dir, found.hash)) {
    write(line("Tickr: this checkout is linked on this machine. Tracking starts with the next session."));
  } else write(line("Tickr: the link could not be saved (is the plugin data directory writable?)."));
}

const line = (text: string): string => `${text}\n`;

const SET_USAGE =
  'Tickr: usage: set-context <plugin data directory> <session id> <project id> [--task <task id|none>] [--description "<text>"]';

/** The options of set-context; a string is the problem to print. */
function parseSetOptions(args: string[]): { task?: string | null; description?: string } | string {
  const out: { task?: string | null; description?: string } = {};
  for (let i = 0; i < args.length; i += 2) {
    const [name, value] = [args[i], args[i + 1]];
    if (value === undefined) return SET_USAGE;
    if (name === "--task" && !("task" in out)) {
      const task = value.trim();
      if (task.toLowerCase() === "none") out.task = null;
      else if (isUuid(task)) out.task = task.toLowerCase();
      else return "Tickr: --task must be a task id or none. Nothing was changed.";
    } else if (name === "--description" && !("description" in out)) {
      const description = normalizeDescription(value);
      if (typeof description !== "string") return `Tickr: ${description.invalid} Nothing was changed.`;
      out.description = description;
    } else return SET_USAGE;
  }
  if (!("task" in out) && !("description" in out)) return "Tickr: give --task and/or --description. Nothing was changed.";
  return out;
}

/**
 * `set-context <dataDir> <sessionId> <projectId> [--task <uuid|none>] [--description "<text>"]`,
 * run by /tickr:task and /tickr:describe once the user confirmed: sets the task and/or the
 * description of this session (context.ts). What is not given is kept from the session's current
 * context for the same project. Plain text on stdout, without any id; no network.
 */
function runSetContext(args: string[], write: Write, now: Date = new Date()): void {
  const [dataDir, sessionId, projectId, ...rest] = args;
  if (!dataDir?.trim() || !sessionId || !projectId) return write(line(SET_USAGE));
  if (!isSessionId(sessionId)) return write(line("Tickr: the session id is not valid. Nothing was changed."));
  if (!isUuid(projectId.trim())) return write(line("Tickr: the project id is not valid. Nothing was changed."));
  const options = parseSetOptions(rest);
  if (typeof options === "string") return write(line(options));

  const dir = resolve(dataDir);
  const project = projectId.trim().toLowerCase();
  const current = readContext(dir, sessionId);
  const ctx: SessionContext = current?.projectId === project ? { ...current, setAt: now.toISOString() } : { projectId: project, setAt: now.toISOString() };
  if ("task" in options) ctx.taskId = options.task ?? null;
  if (options.description !== undefined) ctx.description = options.description;
  try {
    writeContext(dir, sessionId, ctx);
  } catch {
    return write(line("Tickr: the session context could not be saved (is the plugin data directory writable?)."));
  }
  const task = ctx.taskId === undefined ? "the task of .tickr.json" : ctx.taskId === null ? "no task" : "the chosen task";
  const description = ctx.description === undefined ? "the description of .tickr.json" : `the description "${ctx.description}"`;
  write(line(`Tickr: from now on this session is recorded with ${task} and ${description}.`));
}

/** `clear-context <dataDir> <sessionId>`: the session goes back to the task and description of .tickr.json. */
function runClearContext(dataDir: string | undefined, sessionId: string | undefined, write: Write): void {
  if (!dataDir?.trim() || !sessionId) return write(line("Tickr: usage: clear-context <plugin data directory> <session id>"));
  if (!isSessionId(sessionId)) return write(line("Tickr: the session id is not valid. Nothing was changed."));
  let removed: boolean;
  try {
    removed = clearContext(resolve(dataDir), sessionId);
  } catch {
    return write(line("Tickr: the session context could not be removed (is the plugin data directory writable?)."));
  }
  write(
    line(
      removed
        ? "Tickr: the session context is removed: this session is recorded with the task and description of .tickr.json again."
        : "Tickr: this session has no session context. Nothing was changed.",
    ),
  );
}

/** An id as context-info prints it: a UUID in lower case, any other id as written. */
const printedId = (id: string): string => (isUuid(id) ? id.toLowerCase() : id);

/**
 * `context-info <dataDir> <sessionId> <cwd>`, run first by /tickr:task and /tickr:describe: the
 * mapping the hooks of this session use, found the same way (the nearest .tickr.json from cwd
 * upwards, linked on this machine) with the session context applied. Read-only, no network. One
 * JSON line on stdout: {"linked":false} when there is no usable, linked .tickr.json (nothing of an
 * unlinked file is printed), otherwise {"linked":true,"project_id","task_id","description",
 * "session_context"}; never a path, a key or a hash.
 */
function runContextInfo(dataDir: string | undefined, sessionId: string | undefined, cwd: string | undefined, write: Write): void {
  if (!dataDir?.trim() || !sessionId || !cwd?.trim()) {
    return write(line("Tickr: usage: context-info <plugin data directory> <session id> <directory>"));
  }
  const dir = resolve(dataDir);
  const found = findMapping(resolve(cwd));
  if (found === null || "invalid" in found || !isLinked(dir, found.dir, found.hash)) return write(line(JSON.stringify({ linked: false })));
  const ctx = isSessionId(sessionId) ? readContext(dir, sessionId) : null;
  const applied = ctx !== null && sameId(ctx.projectId, found.mapping.projectId) ? ctx : null;
  const mapping = effectiveMapping(found.mapping, applied);
  write(
    line(
      JSON.stringify({
        linked: true,
        project_id: printedId(mapping.projectId),
        task_id: mapping.taskId === null ? null : printedId(mapping.taskId),
        description: mapping.description,
        session_context: applied !== null,
      }),
    ),
  );
}

export async function main(argv: string[], env: NodeJS.ProcessEnv, io: HookIo = processIo()): Promise<number> {
  const [mode] = argv;
  try {
    if (isHookEvent(mode)) await runHook(mode, env, io);
    else if (mode === "flush") await runFlush(argv[1], env, io.bundlePath);
    else if (mode === "status") runStatus(argv[1], env, io.write);
    else if (mode === "accept") runAccept(argv[1], argv[2], io.write);
    else if (mode === "set-context") runSetContext(argv.slice(1), io.write);
    else if (mode === "clear-context") runClearContext(argv[1], argv[2], io.write);
    else if (mode === "context-info") runContextInfo(argv[1], argv[2], argv[3], io.write);
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
