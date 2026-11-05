// Hook I/O: the event JSON on stdin (read within the hook budget) and at most one JSON object on
// stdout. Only the fields listed in HookInput are kept: prompts, tool inputs and any other field
// Claude Code sends are dropped as soon as they are read.
import { writeSync } from "node:fs";

export interface HookInput {
  session_id: string;
  transcript_path?: string;
  cwd: string;
  hook_event_name: string;
  prompt_id?: string;
  tool_name?: string;
  tool_response?: unknown;
  tool_use_id?: string;
  source?: string;
  reason?: string;
  agent_id?: string;
  agent_transcript_path?: string;
}

const OPTIONAL_STRINGS = [
  "transcript_path",
  "prompt_id",
  "tool_name",
  "tool_use_id",
  "source",
  "reason",
  "agent_id",
  "agent_transcript_path",
] as const;

function toHookInput(raw: unknown): HookInput | null {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const { session_id, cwd, hook_event_name } = record;
  if (typeof session_id !== "string" || session_id === "") return null;
  if (typeof cwd !== "string" || typeof hook_event_name !== "string" || hook_event_name === "") return null;

  const input: HookInput = { session_id, cwd, hook_event_name };
  for (const key of OPTIONAL_STRINGS) {
    const value = record[key];
    if (typeof value === "string") input[key] = value;
  }
  if ("tool_response" in record) input.tool_response = record.tool_response;
  return input;
}

/** Reads and validates the hook input; null when it is malformed or not complete by the deadline. */
export function readHookInput(stdin: NodeJS.ReadableStream, deadlineMs: number): Promise<HookInput | null> {
  return new Promise<HookInput | null>((resolve) => {
    const chunks: Buffer[] = [];
    let settled = false;
    const finish = (value: HookInput | null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      stdin.removeListener("data", onData);
      stdin.removeListener("end", onEnd);
      stdin.removeListener("error", onError);
      resolve(value);
    };
    const onData = (chunk: Buffer | string) => {
      chunks.push(typeof chunk === "string" ? Buffer.from(chunk, "utf8") : chunk);
    };
    const onEnd = () => {
      try {
        finish(toHookInput(JSON.parse(Buffer.concat(chunks).toString("utf8"))));
      } catch {
        finish(null);
      }
    };
    const onError = () => finish(null);
    const timer = setTimeout(() => finish(null), Math.max(0, deadlineMs - Date.now()));
    timer.unref?.();

    stdin.on("data", onData);
    stdin.on("end", onEnd);
    stdin.on("error", onError);
  });
}

export type Write = (text: string) => void;

export const writeStdout: Write = (text) => {
  // Synchronous so that the output is complete before the process exits.
  writeSync(1, text);
};

/** Writes one JSON object with the message, or nothing at all. */
export function writeHookOutput(out: { systemMessage?: string }, write: Write = writeStdout): void {
  if (!out.systemMessage) return;
  write(JSON.stringify({ systemMessage: out.systemMessage }));
}
