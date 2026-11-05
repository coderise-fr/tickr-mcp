// /tickr:status: one block per instance of the plugin data directory, in plain text.
//
// Shown: the host of the Tickr URL, the workspace name (from the cached GET /me), the state
// (active, paused: <reason>, previous key or URL), pending revisions and terminal items (code,
// target kind, date, short diagnostic). Never shown: the instance id (a key fingerprint), the key,
// any path, any description or other mapping content.
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { FALLBACK_DIR } from "./fallback.js";
import { readPause, readWorkspace } from "./flusher/sender.js";
import { INSTANCE_FILE, instanceId, readInstanceInfo } from "./identity.js";
import { INTAKE_PAUSED_KEY } from "./intake.js";
import { DB_FILE, MAX_DIAGNOSTIC, openStore, type Store, type TerminalRow } from "./store/db.js";

/** Terminal items listed per instance (the most recent ones). */
export const MAX_TERMINAL_LISTED = 20;

const PAUSE_TEXT: Record<string, string> = {
  unauthorized: "the API key was refused",
  forbidden_role: "the API key cannot record time",
  segments_disabled: "this Tickr does not accept agent sessions yet",
  clock_skew: "this computer's clock is ahead of Tickr",
};

/** Identifies the instances of the current options; without it, the most recent one per workspace is current. */
export interface CurrentOptions {
  baseUrl: string;
  apiKey: string;
}

interface InstanceView {
  host: string;
  workspace: string;
  lastActivityMs: number;
  workspaceId: string;
  current: boolean | null;
  lines: string[];
  state: string;
}

function host(baseUrl: string): string {
  try {
    return new URL(baseUrl).host;
  } catch {
    return "unknown host";
  }
}

/** A name that may reach the user: one line, no 64-hex fingerprint, bounded. */
export function safeLine(text: string, max: number): string {
  return text.replace(/[\r\n\t]+/g, " ").replace(/[0-9a-fA-F]{64}/g, "[redacted]").slice(0, max);
}

/** A diagnostic that may reach the user: safeLine, and no path-like token. */
export function safeText(text: string, max = MAX_DIAGNOSTIC): string {
  return safeLine(text.replace(/(?:[A-Za-z]:)?[\\/]\S*/g, "[path]"), max);
}

function mtimeMs(path: string): number {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return 0;
  }
}

function fallbackCount(dir: string): number {
  try {
    return readdirSync(join(dir, FALLBACK_DIR)).filter((n) => n.endsWith(".json") && !n.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function terminalLine(t: TerminalRow): string {
  const kind = t.targetKind === "delegated" ? "delegated entry" : t.targetKind;
  const day = t.at.slice(0, 10);
  const diagnostic = t.diagnostic ? ` (${safeText(t.diagnostic)})` : "";
  return `    - ${safeText(t.code, 64)}, ${kind}, ${day}${diagnostic}`;
}

function describeStore(store: Store, view: InstanceView): void {
  const ws = readWorkspace(store);
  if (ws !== null && ws.workspaceName !== "") view.workspace = `workspace ${safeLine(ws.workspaceName, 80)}`;
  const pause = readPause(store);
  if (pause !== null) view.state = `paused: ${PAUSE_TEXT[pause.reason] ?? pause.reason} (since ${pause.since.slice(0, 10)})`;
  else if (ws === null) view.state = "active, waiting for the first contact with Tickr";
  if (store.getMeta(INTAKE_PAUSED_KEY) !== null) view.lines.push("  intake paused: the local queue reached its size limit");
  view.lines.push(`  pending revisions: ${store.pendingOutboxCount()}`);
  const terminal = store.listTerminal();
  if (terminal.length === 0) {
    view.lines.push("  terminal items: none");
    return;
  }
  const shown = terminal.slice(-MAX_TERMINAL_LISTED);
  view.lines.push(`  terminal items (never sent again): ${terminal.length}`);
  if (shown.length < terminal.length) view.lines.push(`    (the ${shown.length} most recent)`);
  for (const t of shown) view.lines.push(terminalLine(t));
}

function viewInstance(dir: string, name: string, current: CurrentOptions | undefined): InstanceView | null {
  const info = readInstanceInfo(dir);
  if (info === null) return null;
  const view: InstanceView = {
    host: host(info.base_url),
    workspace: "workspace not checked yet",
    lastActivityMs: Math.max(mtimeMs(join(dir, DB_FILE)), mtimeMs(join(dir, FALLBACK_DIR)), Date.parse(info.created_at) || 0),
    workspaceId: info.workspace_id,
    current: current ? instanceId(current.baseUrl, info.workspace_id, current.apiKey) === name : null,
    lines: [],
    state: "active",
  };
  let opened: ReturnType<typeof openStore> | undefined;
  try {
    opened = openStore(join(dir, DB_FILE), { role: "hook", busyTimeoutMs: 1000 });
    if (opened === "not_migrated") view.lines.push("  nothing sent yet");
    else if (opened === "newer_schema") view.lines.push("  written by a newer version of the plugin");
    else describeStore(opened, view);
  } catch {
    view.lines.push("  busy, try again in a moment");
  } finally {
    if (opened !== undefined && typeof opened !== "string") opened.close();
  }
  const waiting = fallbackCount(dir);
  if (waiting > 0) view.lines.push(`  events waiting to be journalled: ${waiting}`);
  return view;
}

export function renderStatus(dataDir: string, current?: CurrentOptions): string {
  let names: string[] = [];
  try {
    names = readdirSync(dataDir).filter((n) => {
      try {
        return statSync(join(dataDir, n, INSTANCE_FILE)).isFile();
      } catch {
        return false;
      }
    });
  } catch {
    // No data directory yet.
  }
  const views = names.map((n) => viewInstance(join(dataDir, n), n, current)).filter((v): v is InstanceView => v !== null);
  if (views.length === 0) return "Tickr: nothing tracked yet. Link a repository with /tickr:link, then work in it.\n";

  // Without the current options: the most recently active instance of each workspace is current.
  for (const v of views) {
    if (v.current !== null) continue;
    v.current = !views.some((o) => o !== v && o.workspaceId === v.workspaceId && o.lastActivityMs > v.lastActivityMs);
  }
  views.sort((a, b) => Number(b.current) - Number(a.current) || a.host.localeCompare(b.host) || a.workspace.localeCompare(b.workspace));

  const out = ["Tickr plugin status"];
  for (const v of views) {
    const state = v.current ? v.state : "previous key or URL (kept for reference, never sent again under the current options)";
    out.push("", `${v.host}, ${v.workspace}: ${state}`, ...v.lines);
  }
  return `${out.join("\n")}\n`;
}
