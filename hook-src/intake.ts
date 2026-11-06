// Hook intake: one hook event becomes one journalled event, inside the hook's 1 s budget and
// without any network. Order of preference: the store (one short transaction), else a fallback
// file, else the gaps counter. The flusher is started afterwards when none is alive.
import { createHash } from "node:crypto";
import { uptime as osUptime } from "node:os";
import { join } from "node:path";
import type { PluginConfig } from "./config.js";
import { linkKey } from "./consent.js";
import { effectiveMapping, readContext, sameId, type SessionContext } from "./context.js";
import { entryIdForEvent } from "./delegated.js";
import { FALLBACK_DIR, recordGap, takeGaps, writeFallback } from "./fallback.js";
import { isOwnerFresh } from "./flusher/owner.js";
import { instanceDir, instanceId, writeInstanceInfo } from "./identity.js";
import { ulid } from "./ids.js";
import type { HookInput, HookOutput } from "./io.js";
import { canonicalJson, findMapping, type NormalizedMapping } from "./mapping.js";
import { collectionInterruptedMessage, takeNoticeMessages } from "./notices.js";
import { DB_FILE, type JournalEvent, openStore } from "./store/db.js";
import { SCHEMA_VERSION } from "./store/schema.js";

export type { JournalEvent } from "./store/db.js";

/** Hooks wait at most this long for the database lock (the flusher waits 5 s). */
export const HOOK_BUSY_TIMEOUT_MS = 250;
/** meta key set by the flusher when a local bound is reached: hooks then journal nothing. */
export const INTAKE_PAUSED_KEY = "intake_paused";
/** Shown when a session starts in a checkout whose .tickr.json was not linked on this machine. */
export const NOT_LINKED_MESSAGE =
  "Tickr: this repository's .tickr.json has not been linked on this machine, so this session is not tracked. Run /tickr:link to confirm it.";
/** Shown when a session starts in a checkout without .tickr.json. */
export const UNTRACKED_MESSAGE = "Tickr: this session is not tracked. Run /tickr:link to link this repository to a Tickr project.";

/**
 * The untracked message is shown once per session: at its SessionStart, but not again when the
 * same session resumes or is compacted (/clear starts a new session, which is told again).
 */
function untracked(input: HookInput): { systemMessage?: string } {
  if (input.hook_event_name !== "SessionStart" || input.source === "resume" || input.source === "compact") return {};
  return { systemMessage: UNTRACKED_MESSAGE };
}

/**
 * The note for the model at every SessionStart of a linked checkout (hook additionalContext):
 * the session context mode, the current session context (a task id and a description only) and
 * the rule to follow. Plain text; the description is quoted as JSON.
 */
export function contextNote(autoContext: boolean, ctx: SessionContext | null): string {
  const parts: string[] = [];
  if (ctx !== null && ctx.taskId !== undefined) parts.push(ctx.taskId === null ? "no task" : `task ${ctx.taskId}`);
  if (ctx?.description !== undefined) parts.push(`description ${JSON.stringify(ctx.description)}`);
  const current =
    parts.length > 0
      ? `Current session context: ${parts.join(", ")} (anything not set comes from .tickr.json).`
      : "Current session context: none (the task and description of .tickr.json apply).";
  const rule = autoContext
    ? "Mode: automatic. When the work moves to another existing task of the linked project, or its overall purpose changes, apply /tickr:task (or /tickr:describe) yourself without asking in chat, after reading list_tasks."
    : "Mode: manual. When the work moves to another existing task of the linked project, or its overall purpose changes, propose /tickr:task (or /tickr:describe) to the user and apply it only once they confirm.";
  return `Tickr session context: this session is recorded as Tickr time. ${rule} ${current} Follow the tickr skill: never create tasks or tags, descriptions of at most 10 words, never quote prompts or code.`;
}

export type Provider = "anthropic" | "bedrock" | "vertex" | "foundry";

export interface RecordOptions {
  env?: NodeJS.ProcessEnv;
  now?: () => Date;
  /** Seconds since boot (os.uptime), recorded with each event to prove clock jumps. */
  uptime?: () => number;
  /** Starts a flusher for the instance; called when no flusher is known to be alive. */
  startFlusher?: (instanceDir: string) => void;
  /**
   * Whether the checkout's .tickr.json was linked on this machine (consent.ts). The plugin always
   * passes it; when absent, no check is made (tests of the journal itself).
   */
  linked?: (mappingDir: string, mappingHash: string) => boolean;
  /**
   * Called when the mapping is not linked, by any event but a tool call: revokes the links of the
   * same checkout made for another content (consent.ts revokeStaleLinks), so that the flusher stops
   * the sessions recorded under them. A tool call does not revoke: /tickr:link itself writes a new
   * .tickr.json before linking it; the end of that turn, or the next prompt, does.
   */
  revokeStale?: (mappingDir: string, mappingHash: string) => void;
}

function enabled(value: string | undefined): boolean {
  if (value === undefined) return false;
  const v = value.trim().toLowerCase();
  return v !== "" && v !== "0" && v !== "false";
}

/** The model provider Claude Code is configured for (its CLAUDE_CODE_USE_* switches). */
export function providerFrom(env: NodeJS.ProcessEnv): Provider {
  if (enabled(env.CLAUDE_CODE_USE_BEDROCK)) return "bedrock";
  if (enabled(env.CLAUDE_CODE_USE_VERTEX)) return "vertex";
  if (enabled(env.CLAUDE_CODE_USE_FOUNDRY)) return "foundry";
  return "anthropic";
}

export function buildEvent(
  input: HookInput,
  mapping: JournalEvent["mapping"],
  now: Date,
  uptimeS: number,
  env: NodeJS.ProcessEnv,
  link?: string,
): JournalEvent {
  const ev: JournalEvent = {
    eventId: ulid(now.getTime()),
    sessionId: input.session_id,
    type: input.hook_event_name,
    localTime: now.toISOString(),
    uptimeS,
    mapping,
    provider: providerFrom(env),
  };
  if (input.transcript_path !== undefined) ev.transcriptPath = input.transcript_path;
  if (input.prompt_id !== undefined) ev.promptId = input.prompt_id;
  if (input.tool_name !== undefined) ev.toolName = input.tool_name;
  if (input.tool_use_id !== undefined) ev.toolUseId = input.tool_use_id;
  if (input.agent_id !== undefined) ev.agentId = input.agent_id;
  if (input.agent_transcript_path !== undefined) ev.agentTranscriptPath = input.agent_transcript_path;
  if (link !== undefined) ev.linkKey = link;
  // A delegated entry (start_timer / create_entry of the plugin's MCP server): only its id is kept.
  const entryId = entryIdForEvent(input.hook_event_name, input.tool_name, input.tool_response);
  if (entryId !== null) ev.entryId = entryId;
  return ev;
}

interface Journalled {
  paused: boolean;
  messages: string[];
  ownerFresh: boolean;
}

/** One short transaction: the event, its mapping version, the unshown notices, the owner. */
function journalInStore(dbPath: string, ev: JournalEvent, now: Date): Journalled | null {
  let opened: ReturnType<typeof openStore> | undefined;
  try {
    opened = openStore(dbPath, { role: "hook", busyTimeoutMs: HOOK_BUSY_TIMEOUT_MS });
    if (typeof opened === "string") return null;
    const store = opened;
    return store.transaction((): Journalled | null => {
      if (store.schemaVersion() !== SCHEMA_VERSION) return null;
      const paused = store.getMeta(INTAKE_PAUSED_KEY) !== null;
      if (!paused) store.journal(ev);
      return { paused, messages: takeNoticeMessages(store, now), ownerFresh: isOwnerFresh(store.readOwner(), now) };
    });
  } catch {
    return null;
  } finally {
    if (opened !== undefined && typeof opened !== "string") opened.close();
  }
}

/**
 * Journals one hook event for the instance of the checkout's .tickr.json. Never throws, never
 * waits past `deadlineMs` for the store; returns the message to show, if any.
 */
export function recordEvent(input: HookInput, cfg: PluginConfig, deadlineMs: number, opts: RecordOptions = {}): HookOutput {
  const env = opts.env ?? process.env;
  const found = findMapping(input.cwd);
  if (found === null) return untracked(input);
  if ("invalid" in found) {
    return input.hook_event_name === "SessionStart" ? { systemMessage: `Tickr: ${found.invalid} This session is not tracked.` } : {};
  }

  if (opts.linked && !opts.linked(found.dir, found.hash)) {
    try {
      if (input.hook_event_name !== "PostToolUse") opts.revokeStale?.(found.dir, found.hash);
    } catch {
      // Best effort: the next hook of this checkout tries again.
    }
    return input.hook_event_name === "SessionStart" && input.source !== "resume" && input.source !== "compact"
      ? { systemMessage: NOT_LINKED_MESSAGE }
      : {};
  }

  const now = (opts.now ?? (() => new Date()))();
  const dir = instanceDir(cfg.dataDir, instanceId(cfg.baseUrl, found.mapping.workspaceId, cfg.apiKey));
  // The session context overrides the task and/or description of .tickr.json (context.ts); the
  // link stays the one of .tickr.json itself. Ids are compared ignoring case (context.ts sameId).
  const sessionCtx = readContext(cfg.dataDir, input.session_id);
  const applied = sessionCtx !== null && sameId(sessionCtx.projectId, found.mapping.projectId) ? sessionCtx : null;
  // The link the event is journalled under: the flusher stops the session once it is revoked.
  const ev = buildEvent(input, mappingVersion(effectiveMapping(found.mapping, applied)), now, (opts.uptime ?? osUptime)(), env, linkKey(found.dir, found.hash));
  const note: HookOutput = input.hook_event_name === "SessionStart" ? { additionalContext: contextNote(cfg.autoContext, applied) } : {};

  let dirReady = true;
  try {
    writeInstanceInfo(dir, { baseUrl: cfg.baseUrl, workspaceId: found.mapping.workspaceId }, now);
  } catch {
    dirReady = false;
  }

  // Opening (version read) and the transaction may each wait HOOK_BUSY_TIMEOUT_MS for the lock.
  const room = deadlineMs - Date.now() > 2 * HOOK_BUSY_TIMEOUT_MS + 100;
  const journalled = dirReady && room ? journalInStore(join(dir, DB_FILE), ev, now) : null;
  if (journalled === null && !writeFallback(join(dir, FALLBACK_DIR), ev)) {
    recordGap(dir);
    return note;
  }

  const messages: string[] = [];
  const gaps = takeGaps(dir);
  if (gaps > 0) messages.push(collectionInterruptedMessage(gaps));
  if (journalled) messages.push(...journalled.messages);
  if (!journalled?.ownerFresh) {
    try {
      opts.startFlusher?.(dir);
    } catch {
      // The next hook tries again.
    }
  }
  return messages.length > 0 ? { systemMessage: messages.join("\n"), ...note } : note;
}

/** The journal form of a mapping: its canonical JSON and the SHA-256 of it. */
function mappingVersion(m: NormalizedMapping): { hash: string; json: string } {
  const json = canonicalJson(m);
  return { hash: createHash("sha256").update(json, "utf8").digest("hex"), json };
}
