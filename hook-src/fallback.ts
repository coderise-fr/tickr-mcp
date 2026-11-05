// Fallback files: when a hook cannot journal its event in the store within its budget (database
// locked, missing, older or newer schema), it writes one file per event to <instance>/fallback/,
// under a temporary name then renamed (atomic publish). The flusher imports each file in one
// guarded transaction and deletes it only after the commit: a re-import after a crash is a no-op
// (UNIQUE event_id). When even that fails, the gap is counted in <instance>/gaps.
import { readdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { guarded } from "./flusher/owner.js";
import type { JournalEvent, Store } from "./store/db.js";

export const FALLBACK_DIR = "fallback";
export const GAPS_FILE = "gaps";
const FORMAT = 1;
/** A temporary file older than this was left by a hook that died while writing it. */
const STALE_TEMP_MS = 10 * 60_000;

function removeQuietly(path: string): void {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
}

/** Publishes one event as <dir>/<eventId>.json; false when the file could not be written. */
export function writeFallback(dir: string, ev: JournalEvent): boolean {
  const temp = join(dir, `.${ev.eventId}.${process.pid}.tmp`);
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(temp, JSON.stringify({ format: FORMAT, event: ev }), { flag: "wx" });
    renameSync(temp, join(dir, `${ev.eventId}.json`));
    return true;
  } catch {
    removeQuietly(temp);
    return false;
  }
}

const OPTIONAL = ["transcriptPath", "provider", "promptId", "toolName", "toolUseId", "entryId", "agentId", "agentTranscriptPath"] as const;

function parseFallback(text: string): JournalEvent | null {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    return null;
  }
  const doc = raw as { format?: unknown; event?: Record<string, unknown> } | null;
  if (!doc || doc.format !== FORMAT || typeof doc.event !== "object" || doc.event === null) return null;
  const e = doc.event;
  for (const key of ["eventId", "sessionId", "type", "localTime"] as const) {
    if (typeof e[key] !== "string" || e[key] === "") return null;
  }
  if (typeof e.uptimeS !== "number" || !Number.isFinite(e.uptimeS)) return null;
  let mapping: JournalEvent["mapping"] = null;
  if (e.mapping !== null) {
    const m = e.mapping as { hash?: unknown; json?: unknown } | undefined;
    if (!m || typeof m.hash !== "string" || typeof m.json !== "string") return null;
    mapping = { hash: m.hash, json: m.json };
  }
  const ev: JournalEvent = {
    eventId: e.eventId as string,
    sessionId: e.sessionId as string,
    type: e.type as string,
    localTime: e.localTime as string,
    uptimeS: e.uptimeS,
    mapping,
  };
  for (const key of OPTIONAL) {
    if (typeof e[key] === "string") ev[key] = e[key];
  }
  return ev;
}

export interface ImportOptions {
  now?: () => Date;
  /** Called after a file's transaction committed and before the file is deleted. */
  onCommitted?: (fileName: string) => void;
}

/**
 * Imports the published fallback files, oldest event first: mapping version upserted by hash,
 * event inserted unless its event_id is known, file deleted after the commit. A file that is not
 * a fallback document is renamed *.invalid and kept. Returns the number of new events.
 */
export function importFallback(store: Store, gen: number, dir: string, opts: ImportOptions = {}): number {
  const now = opts.now ?? (() => new Date());
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }

  for (const name of names) {
    if (!name.startsWith(".") || !name.endsWith(".tmp")) continue;
    try {
      if (now().getTime() - statSync(join(dir, name)).mtimeMs > STALE_TEMP_MS) removeQuietly(join(dir, name));
    } catch {
      // Published or removed meanwhile.
    }
  }

  let imported = 0;
  for (const name of names.filter((n) => n.endsWith(".json") && !n.startsWith(".")).sort()) {
    const file = join(dir, name);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      continue; // Removed meanwhile.
    }
    const ev = parseFallback(text);
    if (ev === null) {
      try {
        renameSync(file, `${file}.invalid`);
      } catch {
        // Left for the next pass.
      }
      continue;
    }
    if (guarded(store, gen, now().toISOString(), () => store.journal(ev))) imported += 1;
    opts.onCommitted?.(name);
    removeQuietly(file);
  }
  return imported;
}

/** Number of published fallback files waiting for an import. */
export function pendingFallbackCount(dir: string): number {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith(".")).length;
  } catch {
    return 0;
  }
}

function readGaps(file: string): number {
  try {
    const value = Number.parseInt(readFileSync(file, "utf8"), 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  } catch {
    return 0;
  }
}

/** Counts one event that could be neither journalled nor written as a fallback file. */
export function recordGap(instanceDir: string): boolean {
  const file = join(instanceDir, GAPS_FILE);
  const temp = join(instanceDir, `.${GAPS_FILE}.${process.pid}.tmp`);
  try {
    writeFileSync(temp, String(readGaps(file) + 1));
    renameSync(temp, file);
    return true;
  } catch {
    removeQuietly(temp);
    return false;
  }
}

/** Returns the gaps counted so far and resets the counter (claimed by a rename, so shown once). */
export function takeGaps(instanceDir: string): number {
  const file = join(instanceDir, GAPS_FILE);
  const claimed = join(instanceDir, `.${GAPS_FILE}.${process.pid}.taken`);
  try {
    renameSync(file, claimed);
  } catch {
    return 0;
  }
  const gaps = readGaps(claimed);
  removeQuietly(claimed);
  return gaps;
}
