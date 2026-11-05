// Delegated entries (§7.6 rule 3, D16): a time entry the agent created through the plugin's own
// MCP server (start_timer, create_entry). The PostToolUse hook of those tools reads the new
// entry's id from the tool response and journals it with the event (events.entry_id); the store
// records it in `delegated` (store/db.ts). Nothing else of the response is kept.
//
// The response is read defensively: the MCP result's structuredContent.entry.id, else the JSON
// of its first text content (the same object, serialised). A result marked isError, a text that
// is not JSON, or an id that is not a UUID gives no candidate: the turn's tokens then stay with
// rules 2 and 4.

/** The plugin's MCP tools that create an entry (server "tickr" of plugin "tickr"). */
export const DELEGATED_TOOL = /^mcp__plugin_tickr_tickr__(start_timer|create_entry)$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => typeof v === "object" && v !== null && !Array.isArray(v);

function entryIdOf(value: unknown): string | null {
  if (!isObj(value) || !isObj(value.entry)) return null;
  const id = value.entry.id;
  return typeof id === "string" && UUID.test(id) ? id : null;
}

function parseJson(text: unknown): unknown {
  if (typeof text !== "string") return undefined;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
}

function firstText(content: unknown): unknown {
  if (!Array.isArray(content)) return undefined;
  const block = content.find((b): b is Obj => isObj(b) && b.type === "text");
  return block === undefined ? undefined : parseJson(block.text);
}

/**
 * The id of the entry a delegated tool created, from its tool_response, or null. Accepts the MCP
 * result object ({ content, structuredContent, isError }), a bare content array, or either one
 * serialised as a JSON string, or the tool's own result (`{ entry: { id } }`) as an object or string.
 */
export function delegatedEntryId(toolResponse: unknown): string | null {
  const response = typeof toolResponse === "string" ? parseJson(toolResponse) : toolResponse;
  if (Array.isArray(response)) return entryIdOf(firstText(response));
  if (!isObj(response) || response.isError === true) return null;
  // Claude Code 2.1 hands the plugin the tool's JSON text itself, i.e. { entry: { id } } directly.
  return entryIdOf(response.structuredContent) ?? entryIdOf(firstText(response.content)) ?? entryIdOf(response);
}

/** The entry id to journal with a hook event: PostToolUse of a delegated tool only. */
export function entryIdForEvent(event: string, toolName: string | undefined, toolResponse: unknown): string | null {
  if (event !== "PostToolUse" || toolName === undefined || !DELEGATED_TOOL.test(toolName)) return null;
  return delegatedEntryId(toolResponse);
}
