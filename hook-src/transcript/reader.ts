// Incremental transcript reads (§7.6). Each file keeps a read offset in transcript_offsets: the
// offset only advances past complete lines, so a line cut mid-write is read again, whole, next
// time. A file smaller than its offset, or whose first bytes changed (replaced, rewritten by
// compaction), is read again from the start; the ledger deduplicates messages by message.id.
//
// readTranscript only reads: it returns the messages and the offset row to save, which the
// caller writes with commitRead in the same guarded transaction as the ledger rows, so a crash
// in between never skips a message.
import { createHash } from "node:crypto";
import { closeSync, fstatSync, openSync, readdirSync, readFileSync, readSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import type { Store, TranscriptOffsetRow } from "../store/db.js";
import { type AgentLaunch, type AssistantUsage, parseLines } from "./parser.js";

/** Bytes hashed at the start of a file to notice that it was replaced. */
export const HEAD_BYTES = 4096;

/**
 * complete: every line up to the end of the file was read; partial: a trailing line is not
 * complete yet or a malformed line was skipped; unavailable: the file is missing, unreadable or
 * not in a known format (nothing is read).
 */
export type ReadStatus = "complete" | "partial" | "unavailable";

export interface TranscriptRead {
  path: string;
  status: ReadStatus;
  messages: AssistantUsage[];
  /** Agent tool calls read (subagent launches). */
  launches: AgentLaunch[];
  /** The last Claude Code version written in the lines read. */
  version?: string;
  /** The file was read again from the start. */
  rescanned: boolean;
  malformed: number;
  /** Saved by commitRead. */
  next: TranscriptOffsetRow;
}

export interface ReadOptions {
  sessionId?: string;
  now?: Date;
}

function readRange(fd: number, start: number, length: number): Buffer {
  const buf = Buffer.alloc(length);
  let done = 0;
  while (done < length) {
    const n = readSync(fd, buf, done, length - done, start + done);
    if (n === 0) break;
    done += n;
  }
  return done === length ? buf : buf.subarray(0, done);
}

function headHash(fd: number, length: number): string {
  return createHash("sha256").update(readRange(fd, 0, length)).digest("hex");
}

const EMPTY_HASH = createHash("sha256").digest("hex");

/** Reads what was appended to the transcript since its saved offset (or all of it, see above). */
export function readTranscript(store: Store, path: string, opts: ReadOptions = {}): TranscriptRead {
  const readAt = (opts.now ?? new Date()).toISOString();
  const prev = store.getTranscriptOffset(path);
  const keep: TranscriptOffsetRow = prev ?? { path, offset: 0, size: 0, headHash: EMPTY_HASH, sessionId: null, status: null, readAt: null };
  const unavailable = (rescanned: boolean): TranscriptRead => ({
    path,
    status: "unavailable",
    messages: [],
    launches: [],
    rescanned,
    malformed: 0,
    next: { ...keep, sessionId: opts.sessionId ?? keep.sessionId, status: "unavailable", readAt },
  });

  let fd: number;
  try {
    fd = openSync(path, "r");
  } catch {
    return unavailable(false);
  }
  try {
    const size = fstatSync(fd).size;
    let start = prev?.offset ?? 0;
    let rescanned = false;
    if (prev !== null && (size < prev.offset || headHash(fd, Math.min(HEAD_BYTES, prev.offset)) !== prev.headHash)) {
      start = 0;
      rescanned = true;
    }
    const buf = readRange(fd, start, Math.max(0, size - start));
    const end = buf.lastIndexOf(0x0a) + 1;
    const parsed = parseLines(buf.subarray(0, end).toString("utf8"));
    if (parsed.unknownShape) return unavailable(rescanned);

    const offset = start + end;
    const status: ReadStatus = end < buf.length || parsed.malformed > 0 ? "partial" : "complete";
    const read: TranscriptRead = {
      path,
      status,
      messages: parsed.messages,
      launches: parsed.launches,
      rescanned,
      malformed: parsed.malformed,
      next: {
        path,
        offset,
        size: start + buf.length,
        headHash: headHash(fd, Math.min(HEAD_BYTES, offset)),
        sessionId: opts.sessionId ?? keep.sessionId,
        status,
        readAt,
      },
    };
    if (parsed.version !== undefined) read.version = parsed.version;
    return read;
  } catch {
    return unavailable(false);
  } finally {
    closeSync(fd);
  }
}

/** Saves the read's offset (inside the caller's guarded transaction, with the ledger rows). */
export function commitRead(store: Store, read: TranscriptRead): void {
  store.putTranscriptOffset(read.next);
}

const SUBAGENT_FILE = /^agent-([A-Za-z0-9._-]+)\.jsonl$/;

/** The subagent transcripts of a session: <main transcript without .jsonl>/subagents/agent-<id>.jsonl. */
export function subagentTranscripts(mainPath: string): { agentId: string; path: string }[] {
  const dir = join(dirname(mainPath), basename(mainPath).replace(/\.jsonl$/, ""), "subagents");
  let names: string[];
  try {
    names = readdirSync(dir);
  } catch {
    return [];
  }
  const out: { agentId: string; path: string }[] = [];
  for (const name of names.sort()) {
    const m = SUBAGENT_FILE.exec(name);
    if (m) out.push({ agentId: m[1]!, path: join(dir, name) });
  }
  return out;
}

/** The agent id in a subagent transcript's file name, if it has the agent-<id>.jsonl form. */
export function agentIdOfPath(path: string): string | null {
  return SUBAGENT_FILE.exec(basename(path))?.[1] ?? null;
}

export interface SubagentMeta {
  /** The tool_use id of the Agent call that launched the subagent. */
  toolUseId?: string;
}

/** The .meta.json beside a subagent transcript (only the launching tool_use id is kept). */
export function readSubagentMeta(transcriptPath: string): SubagentMeta | null {
  try {
    const doc = JSON.parse(readFileSync(transcriptPath.replace(/\.jsonl$/, ".meta.json"), "utf8")) as unknown;
    if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
    const toolUseId = (doc as Record<string, unknown>).toolUseId;
    return typeof toolUseId === "string" && toolUseId !== "" ? { toolUseId } : {};
  } catch {
    return null;
  }
}
