import { getContextTool } from "./context.js";
import { createEntryTool, listEntriesTool, updateEntryTool } from "./entries.js";
import { listProjectsTool, listTagsTool, listTasksTool } from "./reference.js";
import { listActiveTimersTool, startTimerTool, stopTimerTool } from "./timers.js";
import type { AnyTool } from "./tool.js";

// Exactly the ten V1 tools. tests/protocol.test.ts pins this list.
export const ALL_TOOLS: readonly AnyTool[] = [
  getContextTool,
  listActiveTimersTool,
  startTimerTool,
  stopTimerTool,
  listEntriesTool,
  createEntryTool,
  updateEntryTool,
  listProjectsTool,
  listTasksTool,
  listTagsTool,
];
