import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { ALL_TOOLS } from "./tools/index.js";
import { runTool, type RunDeps } from "./tools/run.js";
import { MAX_INPUT_ELEMENTS } from "./tools/tool.js";
import { VERSION } from "./version.js";

export function createServer(deps: RunDeps): McpServer {
  const server = new McpServer({ name: "tickr", version: VERSION }, { maxToolInputElements: MAX_INPUT_ELEMENTS });
  for (const tool of ALL_TOOLS) {
    server.registerTool(
      tool.name,
      {
        title: tool.title,
        description: tool.description,
        inputSchema: tool.inputSchema,
        outputSchema: tool.outputSchema,
        annotations: { title: tool.title, ...tool.annotations },
      },
      async (args: unknown) => runTool(tool, args, deps),
    );
  }
  return server;
}
