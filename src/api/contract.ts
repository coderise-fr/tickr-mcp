// Every REST route, query parameter and request-body property the client and the Claude Code
// plugin use. Checked against the published OpenAPI document by tests/contract, and against
// the bodies the tools and the plugin build by the wire-mapping tests.
export interface RestRoute {
  method: "get" | "post" | "patch" | "put";
  path: string;
  query: readonly string[];
  body: readonly string[] | null;
  /**
   * Only served by a Tickr with agent provenance. The contract test skips it, with a message,
   * when the default (production) document does not publish it yet; never when
   * TICKR_SWAGGER_URL names the document explicitly.
   */
  optional?: true;
}

export const REST_CONTRACT: readonly RestRoute[] = [
  { method: "get", path: "/api/v1/me", query: [], body: null },
  { method: "get", path: "/api/v1/timers/active", query: [], body: null },
  {
    method: "post", path: "/api/v1/timers/start", query: [],
    body: ["projectId", "taskId", "description", "tagIds", "startedAt", "isBillable"],
  },
  { method: "post", path: "/api/v1/timers/{id}/stop", query: [], body: ["stoppedAt"] },
  {
    method: "get", path: "/api/v1/entries",
    query: ["from", "to", "project_id", "task_id", "tag_id", "cursor", "limit"], body: null,
  },
  {
    method: "post", path: "/api/v1/entries", query: [],
    body: ["projectId", "taskId", "description", "startedAt", "stoppedAt", "tagIds", "isBillable"],
  },
  {
    method: "patch", path: "/api/v1/entries/{id}", query: [],
    body: ["projectId", "clearProject", "taskId", "clearTask", "description", "startedAt", "stoppedAt", "tagIds", "isBillable"],
  },
  { method: "get", path: "/api/v1/projects", query: ["archived"], body: null },
  { method: "get", path: "/api/v1/tasks", query: ["project_id", "archived"], body: null },
  { method: "get", path: "/api/v1/tags", query: [], body: null },
  // The Claude Code plugin (plugins/tickr): agent session segments and the usage of delegated entries.
  {
    method: "put", path: "/api/v1/agent-segments/{segmentId}", query: [], optional: true,
    body: [
      "revision", "agentSessionId", "startedAt", "stoppedAt", "projectId", "taskId", "tagIds", "description",
      "working", "observedAt", "final", "usageQuality", "usage",
    ],
  },
  {
    method: "put", path: "/api/v1/entries/{id}/agent-usage", query: [], optional: true,
    body: ["revision", "agentSessionId", "usageQuality", "usage"],
  },
];

export function bodyPropertiesOf(method: RestRoute["method"], path: string): readonly string[] {
  const route = REST_CONTRACT.find((r) => r.method === method && r.path === path);
  if (!route?.body) throw new Error(`No body contract for ${method.toUpperCase()} ${path}`);
  return route.body;
}
