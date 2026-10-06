import { fetchMe } from "./gate.js";
import { contextSchema, toContext } from "./shapes.js";
import { defineTool, READ_ANNOTATIONS, strictInput, UNTRUSTED } from "./tool.js";

export const getContextTool = defineTool({
  name: "get_context",
  title: "Get Tickr context",
  description:
    "Returns who the API key acts for (user, with their timezone), the workspace, the key's effective role and the " +
    "server's current time. Call it first whenever the user speaks in relative dates or times (today, yesterday, " +
    "this morning): interpret them in user.timezone and send datetimes with an explicit offset. " + UNTRUSTED,
  access: "read",
  inputSchema: strictInput({}),
  outputSchema: contextSchema,
  annotations: READ_ANNOTATIONS,
  run: async (_args, { api }) => toContext(await fetchMe(api)),
});
