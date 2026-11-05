// Synthetic Claude Code transcripts (placeholders only) and a session driver over the stage harness.
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { segmentationStage } from "../../../hook-src/flusher/segmentation.js";
import { ledgerStage } from "../../../hook-src/ledger.js";
import { revisionsStage } from "../../../hook-src/flusher/revisions.js";
import { stageHarness, type StageHarness } from "./stage.js";

export interface Msg {
  id: string;
  at: string;
  model?: string;
  input?: number;
  output?: number;
  cacheCreation?: number;
  cacheRead?: number;
  agentId?: string;
  agentCall?: string;
}

/** One transcript line of an assistant message. */
export function line(m: Msg, sessionId = "s-1"): string {
  const content: unknown[] = [{ type: "text", text: "<redacted>" }];
  if (m.agentCall) content.push({ type: "tool_use", id: m.agentCall, name: "Agent", input: { prompt: "<redacted>" } });
  return `${JSON.stringify({
    type: "assistant",
    timestamp: m.at,
    sessionId,
    version: "2.1.300",
    isSidechain: m.agentId !== undefined,
    ...(m.agentId ? { agentId: m.agentId } : {}),
    message: {
      id: m.id,
      model: m.model ?? "claude-opus-4-7",
      role: "assistant",
      content,
      usage: {
        input_tokens: m.input ?? 1,
        output_tokens: m.output ?? 10,
        cache_creation_input_tokens: m.cacheCreation ?? 0,
        cache_read_input_tokens: m.cacheRead ?? 0,
      },
    },
  })}\n`;
}

export function writeTranscript(path: string, msgs: Msg[]): void {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, msgs.map((m) => line(m)).join(""));
}

export function appendTranscript(path: string, msgs: Msg[]): void {
  appendFileSync(path, msgs.map((m) => line(m)).join(""));
}

/** Appends the first `bytes` of a line without its newline: a line cut mid-write. */
export function appendPartial(path: string, m: Msg, bytes = 40): void {
  appendFileSync(path, line(m).slice(0, bytes));
}

export interface SessionDriver {
  h: StageHarness;
  transcript: string;
  /** Journals an event of session s-1 at `at` (uptime follows the wall clock). */
  ev(type: string, at: string, extra?: Parameters<StageHarness["journal"]>[3]): void;
  /** One flusher pass without sending: segmentation, ledger, revisions. */
  pass(at: string): Promise<void>;
}

export function sessionDriver(now: string): SessionDriver {
  const h = stageHarness({ now });
  const transcript = join(h.dir, "transcripts", "s-1.jsonl");
  const t0 = Date.parse("2026-11-01T00:00:00.000Z");
  return {
    h,
    transcript,
    ev: (type, at, extra = {}) => h.journal(type, at, 1000 + (Date.parse(at) - t0) / 1000, { transcriptPath: transcript, ...extra }),
    pass: async (at) => {
      h.setNow(at);
      await segmentationStage(h.ctx);
      await ledgerStage(h.ctx);
      await revisionsStage()(h.ctx);
    },
  };
}

/** The body of the latest committed revision of a target, or null. */
export function lastBody(h: StageHarness, kind: "segment" | "delegated", id: string): Record<string, unknown> | null {
  const row = h.store.getLastCommitted(kind, id);
  return row === null ? null : (JSON.parse(row.bodyJson) as Record<string, unknown>);
}
