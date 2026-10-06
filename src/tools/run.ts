import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import type { TickrApi } from "../api/client.js";
import { toAgentMessage, UnreadableResponseError } from "../api/errors.js";
import { redact } from "../sanitize.js";
import type { KeyGate } from "./gate.js";
import type { AnyTool, ToolDeps } from "./tool.js";

export interface RunDeps extends ToolDeps {
  gate: KeyGate;
  baseUrl: string;
  /** The configured API key: replaced by "[redacted]" wherever it would reach the agent. */
  apiKey: string;
}

const WRITE_METHODS = ["startTimer", "stopTimer", "createEntry", "updateEntry"] as const;

/** Wraps the API so the run knows whether a write method was called (sent or not). */
function trackWrites(api: TickrApi): { api: TickrApi; writeAttempted: () => boolean } {
  let attempted = false;
  // Reads are inherited from the real API object; only the write methods are wrapped.
  const tracked = Object.create(api) as TickrApi;
  for (const name of WRITE_METHODS) {
    const call = api[name] as (...args: unknown[]) => Promise<unknown>;
    (tracked[name] as (...args: unknown[]) => Promise<unknown>) = (...args) => {
      attempted = true;
      return call.apply(api, args);
    };
  }
  return { api: tracked, writeAttempted: () => attempted };
}

/**
 * Order of checks: arguments were already validated by the SDK against inputSchema
 * (no network); then the key-role gate; then the business call. Never throws.
 */
export async function runTool(tool: AnyTool, args: unknown, deps: RunDeps): Promise<CallToolResult> {
  const { api, writeAttempted } = trackWrites(deps.api);
  try {
    await deps.gate.check(tool.access);
    // Redacted before the output check, so the result the agent gets still meets the schema.
    const raw: unknown = redact(await tool.run(args, { ...deps, api }), deps.apiKey);
    // Validate here rather than letting the SDK reject the output after we return: a write
    // has already happened, and the agent must get the "check before retrying" hint.
    const parsed = tool.outputSchema.safeParse(raw);
    if (!parsed.success) throw new UnreadableResponseError(undefined);
    const out = parsed.data as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  } catch (err) {
    const message = toAgentMessage(err, {
      baseUrl: deps.baseUrl, isWrite: tool.access === "write", writeAttempted: writeAttempted(),
    });
    return { isError: true, content: [{ type: "text", text: redact(message, deps.apiKey) }] };
  }
}
