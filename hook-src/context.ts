// Session context: a task of the linked project and a short description of the work, set for ONE
// Claude Code session by /tickr:task or /tickr:describe (the `set-context` mode of the bundle,
// confirmed by the user). It is a label, not conversation content.
//
// The context lives on this machine only, in <plugin data>/context/<tag>.json, where <tag> is the
// first 32 hex digits of the SHA-256 of the session id; the file holds the project id, the task
// id (or null: no task), the description and the time it was set, never a path. On every hook
// event the intake overrides the task and/or description of the checkout's .tickr.json with it,
// only when it names the same project (effectiveMapping): the result is the event's mapping
// version, so a change splits the segment and the next one carries the new task and description.
// The consent link stays computed from .tickr.json itself.
//
// Everything read from a context file is untrusted: a file that is not a small regular file, or
// whose content does not follow the rules below exactly, is ignored.
import { createHash, randomBytes } from "node:crypto";
import { lstatSync, mkdirSync, readdirSync, readFileSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { NormalizedMapping } from "./mapping.js";

export const CONTEXT_DIR = "context";
/** A context file larger than this is ignored (it holds two ids, a short text and a date). */
export const MAX_CONTEXT_BYTES = 4096;
export const MAX_CONTEXT_WORDS = 10;
export const MAX_CONTEXT_CHARS = 100;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
const CONTEXT_FILE = /^[0-9a-f]{32}\.json$/;
const TEMP_FILE = /^[0-9a-f]{32}\.json\.[0-9a-f]+\.tmp$/;
// Control and format characters (bidirectional overrides, zero-width marks), line separators.
const FORBIDDEN = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}]/u;
const SHELL_SPECIAL = /["`$\\]/;
const LETTER = /\p{L}/u;

export interface SessionContext {
  projectId: string;
  /** Absent: the task of .tickr.json is kept; null: no task. */
  taskId?: string | null;
  /** Absent: the description of .tickr.json is kept. */
  description?: string;
  setAt: string;
}

export const isUuid = (value: string): boolean => UUID.test(value);
export const isSessionId = (value: string): boolean => SESSION_ID.test(value);

/**
 * Two ids name the same thing when they are equal ignoring case: .tickr.json may hold a UUID in
 * upper or mixed case (kept as written, since its content is what the link is computed from),
 * while the session context holds ids in lower case.
 */
export const sameId = (a: string, b: string): boolean => a.toLowerCase() === b.toLowerCase();

/**
 * A description as the user may set it: whitespace collapsed to single spaces and trimmed, no
 * control character nor any of " ` $ \, at most MAX_CONTEXT_WORDS words and MAX_CONTEXT_CHARS
 * characters. A word holds at least one letter: numbers such as ticket numbers ("Fix tickets
 * 1 2 3 4 5 6 7 110 210") do not count as words; the character limit bounds them.
 */
export function normalizeDescription(text: string): string | { invalid: string } {
  if (FORBIDDEN.test(text)) return { invalid: "the description may not contain control characters." };
  // Plain text that a shell command line carries safely between double quotes.
  if (SHELL_SPECIAL.test(text)) return { invalid: "the description may not contain \", `, $ or \\." };
  const clean = text.replace(/\s+/g, " ").trim();
  if (clean === "") return { invalid: "the description is empty." };
  if ([...clean].length > MAX_CONTEXT_CHARS) return { invalid: `the description is longer than ${MAX_CONTEXT_CHARS} characters.` };
  if (clean.split(" ").filter((token) => LETTER.test(token)).length > MAX_CONTEXT_WORDS) return { invalid: `the description has more than ${MAX_CONTEXT_WORDS} words.` };
  return clean;
}

const sha256 = (text: string): string => createHash("sha256").update(text, "utf8").digest("hex");

/** The context file of a session. */
export function contextFile(dataDir: string, sessionId: string): string {
  return join(dataDir, CONTEXT_DIR, `${sha256(sessionId).slice(0, 32)}.json`);
}

/** The stored form (snake_case) of a context, validated; null when anything is off. */
export function parseContext(raw: unknown): SessionContext | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const r = raw as Record<string, unknown>;
  if (typeof r.project_id !== "string" || !isUuid(r.project_id)) return null;
  if (typeof r.set_at !== "string" || !Number.isFinite(Date.parse(r.set_at))) return null;
  // Ids in lower case: the task id sent to Tickr is a UUID in one case, whoever wrote the file.
  const ctx: SessionContext = { projectId: r.project_id.toLowerCase(), setAt: r.set_at };
  if (r.task_id !== undefined) {
    if (r.task_id !== null && (typeof r.task_id !== "string" || !isUuid(r.task_id))) return null;
    ctx.taskId = r.task_id === null ? null : r.task_id.toLowerCase();
  }
  if (r.description !== undefined) {
    if (typeof r.description !== "string" || normalizeDescription(r.description) !== r.description) return null;
    ctx.description = r.description;
  }
  return ctx;
}

/** The context of a session, or null (none, or an unusable file). Never throws. */
export function readContext(dataDir: string, sessionId: string): SessionContext | null {
  if (!isSessionId(sessionId)) return null;
  try {
    const file = contextFile(dataDir, sessionId);
    // Only a small regular file: not a link, a device or a pipe that would stall the hook.
    const info = lstatSync(file);
    if (!info.isFile() || info.size > MAX_CONTEXT_BYTES) return null;
    return parseContext(JSON.parse(readFileSync(file, "utf8")));
  } catch {
    return null;
  }
}

function serialize(ctx: SessionContext): string {
  const out: Record<string, unknown> = { project_id: ctx.projectId };
  if (ctx.taskId !== undefined) out.task_id = ctx.taskId;
  if (ctx.description !== undefined) out.description = ctx.description;
  out.set_at = ctx.setAt;
  return `${JSON.stringify(out)}\n`;
}

/**
 * Writes the context atomically (a temporary file renamed over the old one): a hook reads the
 * old context or the new one, never a part of it. Throws when it cannot be written.
 */
export function writeContext(dataDir: string, sessionId: string, ctx: SessionContext): void {
  const file = contextFile(dataDir, sessionId);
  mkdirSync(join(dataDir, CONTEXT_DIR), { recursive: true });
  const temp = `${file}.${randomBytes(6).toString("hex")}.tmp`;
  writeFileSync(temp, serialize(ctx), { flag: "wx" });
  try {
    renameWithRetry(temp, file);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      // Left behind: pruneContexts removes it later.
    }
    throw error;
  }
}

/** Windows refuses a rename over a file another process has open for a moment: retry briefly. */
function renameWithRetry(from: string, to: string): void {
  for (let attempt = 0; ; attempt++) {
    try {
      renameSync(from, to);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (attempt >= 20 || (code !== "EPERM" && code !== "EACCES" && code !== "EBUSY")) throw error;
      const until = Date.now() + 10;
      while (Date.now() < until) {
        // Short busy wait: this runs in a one-shot command, not in a hook.
      }
    }
  }
}

/** Removes the context of a session; true when there was one. */
export function clearContext(dataDir: string, sessionId: string): boolean {
  try {
    unlinkSync(contextFile(dataDir, sessionId));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

/**
 * The mapping the session's events are recorded under: .tickr.json with the task and/or the
 * description of the session context, when the context names the same project (ignoring case).
 * The workspace, project and tags stay as .tickr.json writes them.
 */
export function effectiveMapping(mapping: NormalizedMapping, ctx: SessionContext | null): NormalizedMapping {
  if (ctx === null || !sameId(ctx.projectId, mapping.projectId)) return mapping;
  return {
    ...mapping,
    taskId: ctx.taskId === undefined ? mapping.taskId : ctx.taskId,
    description: ctx.description ?? mapping.description,
  };
}

/**
 * Retention: removes the context files (and temporary files left behind) not written for
 * `maxAgeMs`. The context of an ended session is never read again. Returns the number removed.
 */
export function pruneContexts(dataDir: string, now: Date, maxAgeMs: number): number {
  const dir = join(dataDir, CONTEXT_DIR);
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return 0;
  }
  let removed = 0;
  for (const name of names) {
    if (!CONTEXT_FILE.test(name) && !TEMP_FILE.test(name)) continue;
    const path = join(dir, name);
    try {
      const info = lstatSync(path);
      if (now.getTime() - info.mtimeMs < maxAgeMs) continue;
      unlinkSync(path);
      removed++;
    } catch {
      // Removed meanwhile, or not removable: the next pass tries again.
    }
  }
  return removed;
}
