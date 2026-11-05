// Child-process harness for the process-level hook tests, bundled with esbuild by children.ts.
//
//   hold-insert <dbPath>                       opens a transaction, journals one event, prints
//                                              "holding" and waits to be killed
//   produce <fallbackDir> <count> <prefix>     writes <count> fallback files, prints their ids
import { writeFallback } from "../../../hook-src/fallback.js";
import { ulid } from "../../../hook-src/ids.js";
import { type JournalEvent, openStore, type Store } from "../../../hook-src/store/db.js";

export const CHILD_MAPPING = {
  hash: "",
  json: JSON.stringify({ description: "Claude Code session", projectId: "p-1", tagIds: [], taskId: null, workspaceId: "w-1" }),
};

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
  process.stdout.write(`${line}\n`);
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
} else {
  say(`unknown mode ${String(mode)}`);
  process.exit(2);
}
