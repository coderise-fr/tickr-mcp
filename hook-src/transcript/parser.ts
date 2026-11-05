// Claude Code transcript parser (§7.6). The transcript format is internal to Claude Code and
// undocumented: this parser is defensive, keeps only what token accounting needs and drops every
// other field (prompts, responses, tool inputs, paths) as soon as a line is read.
//
// - Only `type: "assistant"` lines whose `message` carries a string `id`, a string `model` and a
//   `usage` object count. Lines with model `<synthetic>` (local placeholders, no API call) are
//   skipped.
// - One response spans several lines with the same `message.id` (one per content block). Its
//   usage is the per-field maximum over those lines (PD-16), its timestamp the earliest one.
// - `tool_use` blocks named Agent (Task in older versions) are kept as subagent launches: the
//   subagent's .meta.json names the launching tool_use id (PD-14 fallback).
// - Parsing stops before a trailing partial line (no final newline): the reader resumes there.

export const SYNTHETIC_MODEL = "<synthetic>";
/** Backend grammar of a usage row's model. */
export const MODEL_GRAMMAR = /^[A-Za-z0-9][A-Za-z0-9._:/@-]{0,127}$/;
/** Model name used when nothing usable is left after sanitising. */
export const UNKNOWN_MODEL = "unknown";
/** Largest token count kept from one line (the backend's bound is 10^12). */
const MAX_COUNT = Number.MAX_SAFE_INTEGER;
const AGENT_TOOLS = new Set(["Agent", "Task"]);

/** One assistant response (one message.id) and its token usage. */
export interface AssistantUsage {
  messageId: string;
  /** Sanitised to MODEL_GRAMMAR. */
  model: string;
  /** Earliest line timestamp of the message (ISO 8601). */
  timestamp: string;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  /** A subagent (sidechain) message. */
  sidechain: boolean;
  /** Claude Code version that wrote the line. */
  version?: string;
  /** The subagent that wrote the line (subagent transcripts carry it on every line). */
  agentId?: string;
}

/** An Agent tool call seen in a transcript: the launch of a subagent. */
export interface AgentLaunch {
  toolUseId: string;
  timestamp: string;
}

export interface ParsedLines {
  messages: AssistantUsage[];
  /** UTF-8 bytes of the complete lines (up to and including the last newline). */
  consumedBytes: number;
  /** Complete lines that are not JSON. */
  malformed: number;
  launches: AgentLaunch[];
  /** The last Claude Code `version` seen on a line. */
  version?: string;
  /**
   * True when the complete lines do not look like a Claude Code transcript: none is a JSON object
   * with a string `type`, or assistant lines exist and none carries a usable message.
   */
  unknownShape: boolean;
}

/** Replaces what the backend grammar refuses: each run of other characters becomes "-". */
export function sanitizeModel(raw: unknown): string {
  if (typeof raw !== "string") return UNKNOWN_MODEL;
  if (MODEL_GRAMMAR.test(raw)) return raw;
  const cleaned = raw
    .trim()
    .replace(/[^A-Za-z0-9._:/@-]+/g, "-")
    .replace(/^[^A-Za-z0-9]+/, "")
    .slice(0, 128)
    .replace(/-+$/, "");
  return MODEL_GRAMMAR.test(cleaned) ? cleaned : UNKNOWN_MODEL;
}

function count(value: unknown): number | null {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return null;
  return Math.min(Math.floor(value), MAX_COUNT);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function validTime(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

function earlier(a: string, b: string): string {
  return Date.parse(b) < Date.parse(a) ? b : a;
}

function nonEmpty(value: unknown): string | undefined {
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** The Agent tool calls of one assistant message. */
function agentLaunches(content: unknown, timestamp: string): AgentLaunch[] {
  if (!Array.isArray(content)) return [];
  const out: AgentLaunch[] = [];
  for (const block of content) {
    if (!isRecord(block) || block.type !== "tool_use" || typeof block.name !== "string" || !AGENT_TOOLS.has(block.name)) continue;
    const id = nonEmpty(block.id);
    if (id !== undefined) out.push({ toolUseId: id, timestamp });
  }
  return out;
}

/** What one assistant line carries: null when its message or usage is not usable. */
function assistantLine(doc: Record<string, unknown>): { usage: AssistantUsage; synthetic: boolean; launches: AgentLaunch[] } | null {
  const message = doc.message;
  if (!isRecord(message) || nonEmpty(message.id) === undefined || typeof message.model !== "string") return null;
  const usage = message.usage;
  if (!isRecord(usage)) return null;
  const input = count(usage.input_tokens);
  const output = count(usage.output_tokens);
  const timestamp = validTime(doc.timestamp);
  if (input === null || output === null || timestamp === null) return null;
  const row: AssistantUsage = {
    messageId: message.id as string,
    model: sanitizeModel(message.model),
    timestamp,
    input,
    output,
    cacheCreation: count(usage.cache_creation_input_tokens) ?? 0,
    cacheRead: count(usage.cache_read_input_tokens) ?? 0,
    sidechain: doc.isSidechain === true,
  };
  const version = nonEmpty(doc.version);
  if (version !== undefined) row.version = version;
  const agentId = nonEmpty(doc.agentId);
  if (agentId !== undefined) row.agentId = agentId;
  return { usage: row, synthetic: message.model === SYNTHETIC_MODEL, launches: agentLaunches(message.content, timestamp) };
}

/** Folds another line of the same message.id into `seen` (PD-16: per-field maximum). */
function merge(seen: AssistantUsage, next: AssistantUsage): void {
  seen.timestamp = earlier(seen.timestamp, next.timestamp);
  seen.input = Math.max(seen.input, next.input);
  seen.output = Math.max(seen.output, next.output);
  seen.cacheCreation = Math.max(seen.cacheCreation, next.cacheCreation);
  seen.cacheRead = Math.max(seen.cacheRead, next.cacheRead);
  seen.sidechain ||= next.sidechain;
  if (next.version !== undefined) seen.version = next.version;
  if (seen.agentId === undefined && next.agentId !== undefined) seen.agentId = next.agentId;
}

function parseJson(line: string): { ok: true; doc: unknown } | { ok: false } {
  try {
    return { ok: true, doc: JSON.parse(line) };
  } catch {
    return { ok: false };
  }
}

/** Parses the complete lines of `text`; see the file comment for the rules. */
export function parseLines(text: string): ParsedLines {
  const complete = text.slice(0, text.lastIndexOf("\n") + 1);
  const byId = new Map<string, AssistantUsage>();
  const launches: AgentLaunch[] = [];
  const n = { lines: 0, malformed: 0, recognised: 0, assistant: 0, usable: 0 };
  let version: string | undefined;

  for (const raw of complete.split("\n")) {
    const line = raw.trim();
    if (line === "") continue;
    n.lines++;
    const parsed = parseJson(line);
    if (!parsed.ok) {
      n.malformed++;
      continue;
    }
    const doc = parsed.doc;
    if (!isRecord(doc) || typeof doc.type !== "string") continue;
    n.recognised++;
    version = nonEmpty(doc.version) ?? version;
    if (doc.type !== "assistant") continue;
    n.assistant++;
    const found = assistantLine(doc);
    if (found === null) continue;
    n.usable++;
    launches.push(...found.launches);
    if (found.synthetic) continue;
    const seen = byId.get(found.usage.messageId);
    if (seen === undefined) byId.set(found.usage.messageId, found.usage);
    else merge(seen, found.usage);
  }

  const result: ParsedLines = {
    messages: [...byId.values()],
    consumedBytes: Buffer.byteLength(complete, "utf8"),
    malformed: n.malformed,
    launches,
    // Malformed lines alone (a corrupted write) are counted, not taken for another format.
    unknownShape: (n.lines > n.malformed && n.recognised === 0) || (n.assistant > 0 && n.usable === 0),
  };
  if (version !== undefined) result.version = version;
  return result;
}
