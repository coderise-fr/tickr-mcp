// Child-process harness for the process-level hook tests, bundled with esbuild by children.ts.
//
//   hold-insert <dbPath>                       opens a transaction, journals one event, prints
//                                              "holding" and waits to be killed
//   produce <fallbackDir> <count> <prefix>     writes <count> fallback files, prints their ids
//   flush <instanceDir> <options JSON>         runs the flusher (see FlushOptions), prints
//                                              "at <boundary>" lines, "handover <ms>" and
//                                              "outcome <outcome>"; a successor it starts is
//                                              this harness again, as `flush <instanceDir>`
import { writeSync } from "node:fs";
import { dirname } from "node:path";
import { writeFallback } from "../../../hook-src/fallback.js";
import { createAgentApi, OFFLINE_API } from "../../../hook-src/flusher/api.js";
import { runFlusher } from "../../../hook-src/flusher/run.js";
import { spawnSuccessor, successorStartDelay } from "../../../hook-src/spawn.js";
import type { FlusherBoundary, StageName, StageResult } from "../../../hook-src/flusher/stages.js";
import { ulid } from "../../../hook-src/ids.js";
import { type JournalEvent, openStore, type Store } from "../../../hook-src/store/db.js";

export const CHILD_MAPPING = {
  hash: "",
  json: JSON.stringify({ description: "Claude Code session", projectId: "p-1", tagIds: [], taskId: null, workspaceId: "w-1" }),
};

export interface FlushOptions {
  /** Killed (SIGKILL, by itself) when it reaches this boundary. */
  crashAt?: FlusherBoundary;
  /** This stage prints "holding" and waits holdMs. */
  holdStage?: StageName;
  holdMs?: number;
  /** Added to the wall clock (to look past another flusher's heartbeat). */
  clockOffsetMs?: number;
  /** A local Tickr to send to (default: OFFLINE_API, nothing is sent). */
  baseUrl?: string;
  /** The wake budget (default 30 000). */
  wakeBudgetMs?: number;
  /** The bounds stage of the first pass reports this due (a long wait, as for a lease refresh). */
  firstDueInMs?: number;
  /** Work left behind is handed over to a successor (this harness, started detached). */
  handover?: boolean;
}

function event(sessionId: string, now: Date): JournalEvent {
  return {
    eventId: ulid(now.getTime()),
    sessionId,
    type: "PostToolUse",
    localTime: now.toISOString(),
    uptimeS: 1000,
    mapping: CHILD_MAPPING,
    provider: "anthropic",
  };
}

function say(line: string): void {
  // Synchronous, so that the line is out before a self-inflicted kill.
  writeSync(1, `${line}\n`);
}

const [mode, ...args] = process.argv.slice(2);

if (mode === "hold-insert") {
  const store = openStore(args[0]!, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
  store.db.exec("BEGIN IMMEDIATE");
  store.journal(event("s-killed", new Date()));
  say("holding");
  setInterval(() => undefined, 1000);
} else if (mode === "produce") {
  const ids: string[] = [];
  const count = Number(args[1]);
  for (let i = 0; i < count; i++) {
    const ev = event(`${args[2]}-session`, new Date());
    if (writeFallback(args[0]!, ev)) ids.push(ev.eventId);
  }
  say(JSON.stringify(ids));
} else if (mode === "flush") {
  const dir = args[0]!;
  const opts = JSON.parse(args[1] ?? "{}") as FlushOptions;
  const offset = opts.clockOffsetMs ?? 0;
  const stages: Partial<Record<StageName, () => Promise<StageResult>>> = {};
  if (opts.firstDueInMs !== undefined) {
    let first = true;
    stages.bounds = () => {
      const due = first ? opts.firstDueInMs : undefined;
      first = false;
      return Promise.resolve(due === undefined ? {} : { dueInMs: due });
    };
  }
  if (opts.holdStage) {
    stages[opts.holdStage] = async () => {
      say("holding");
      await new Promise((resolve) => setTimeout(resolve, opts.holdMs ?? 1000));
      return {};
    };
  }
  runFlusher(dir, {
    now: () => new Date(Date.now() + offset),
    uptime: () => 1000,
    api: opts.baseUrl ? createAgentApi({ baseUrl: opts.baseUrl, apiKey: "tkr_test_child_flusher_key", timeoutMs: 3000 }) : OFFLINE_API,
    config: { apiKey: "tkr_test_child_flusher_key", baseUrl: "https://tickr.example.test", idleMinutes: 15, dataDir: dirname(dir) },
    wakeBudgetMs: opts.wakeBudgetMs ?? 30_000,
    startDelayMs: successorStartDelay(process.env),
    stages,
    ...(opts.handover
      ? {
          handover: (delayMs: number) => {
            say(`handover ${Math.round(delayMs)}`);
            spawnSuccessor(process.argv[1]!, dir, process.env, delayMs);
          },
        }
      : {}),
    onBoundary: (point) => {
      say(`at ${point}`);
      if (point === opts.crashAt) process.kill(process.pid, "SIGKILL");
    },
  }).then(
    (outcome) => say(`outcome ${outcome}`),
    (error: unknown) => {
      say(`error ${String(error)}`);
      process.exitCode = 1;
    },
  );
} else {
  say(`unknown mode ${String(mode)}`);
  process.exit(2);
}
