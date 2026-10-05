import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { toAgentMessage, UnreadableResponseError } from "../api/errors.js";
import type { KeyGate } from "./gate.js";
import type { AnyTool, ToolDeps } from "./tool.js";

export interface RunDeps extends ToolDeps {
  gate: KeyGate;
  baseUrl: string;
}

/**
 * Spec §4 order: arguments were already validated by the SDK against inputSchema
 * (no network); then the key-role gate; then the business call. Never throws.
 */
export async function runTool(tool: AnyTool, args: unknown, deps: RunDeps): Promise<CallToolResult> {
  try {
    await deps.gate.check(tool.access);
    const raw: unknown = await tool.run(args, deps);
    // Validate here rather than letting the SDK reject the output after we return: a write
    // has already happened, and the agent must get the "check before retrying" hint.
    const parsed = tool.outputSchema.safeParse(raw);
    if (!parsed.success) throw new UnreadableResponseError(undefined);
    const out = parsed.data as Record<string, unknown>;
    return { content: [{ type: "text", text: JSON.stringify(out) }], structuredContent: out };
  } catch (err) {
    return {
      isError: true,
      content: [{ type: "text", text: toAgentMessage(err, { baseUrl: deps.baseUrl, isWrite: tool.access === "write" }) }],
    };
  }
}
