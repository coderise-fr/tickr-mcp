import { afterEach, describe, expect, it } from "vitest";
import { AGENT_NAME, AGENT_VERSION } from "../../src/api/agent.js";
import { classify, createAgentApi, parseRetryAfter, ROUTE_NOT_FOUND, type SendOutcome, USER_AGENT } from "../../hook-src/flusher/api.js";
import { SEGMENT_BODY_KEYS, type SegmentBody } from "../../hook-src/flusher/revisions.js";
import { PLUGIN_VERSION } from "../../hook-src/version.js";
import { json, problem, type Reply, startServer } from "../helpers/httpServer.js";

const KEY = "tkr_test_agent_api_key_0001";
const SEGMENT = "0190f0c0-0000-7000-8000-00000000000a";
const ENTRY = "0190f0c0-0000-7000-8000-00000000000b";

const BODY: SegmentBody = {
  revision: 3,
  agentSessionId: "s-1",
  startedAt: "2026-11-05T10:00:00.000Z",
  stoppedAt: "2026-11-05T10:05:00.000Z",
  projectId: "p-1",
  taskId: null,
  tagIds: [],
  description: "Claude Code session",
  working: true,
  observedAt: "2026-11-05T10:05:00.000Z",
  final: false,
  usageQuality: "pending",
};

const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => s.close()));
});

async function serve(responder: (index: number) => Reply) {
  const server = await startServer((_req, i) => responder(i));
  servers.push(server);
  return { server, api: createAgentApi({ baseUrl: server.baseUrl, apiKey: KEY, timeoutMs: 3000 }) };
}

const entry = (extra: Record<string, unknown> = {}) => ({ id: SEGMENT, origin: "agent_session", agentFinalized: false, agentDetached: false, ...extra });

describe("createAgentApi: the wire", () => {
  it("PUTs the segment body with the key, the plugin User-Agent and Tickr-Agent; never follows a redirect", async () => {
    const { server, api } = await serve(() => json(201, entry()));
    expect(await api.putSegment(SEGMENT, BODY, "claude-code/2.1.300")).toEqual({ kind: "applied", created: true, finalized: false, detached: false });
    const req = server.requests[0]!;
    expect(req.method).toBe("PUT");
    expect(req.url).toBe(`/api/v1/agent-segments/${SEGMENT}`);
    expect(req.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(req.headers["user-agent"]).toBe(`tickr-plugin/${PLUGIN_VERSION}`);
    expect(USER_AGENT).toBe(`tickr-plugin/${PLUGIN_VERSION}`);
    expect(req.headers["tickr-agent"]).toBe("claude-code/2.1.300");
    expect(req.headers["tickr-origin"]).toBeUndefined();
    expect(req.headers["content-type"]).toBe("application/json");
    expect(req.body).toBe(JSON.stringify(BODY));
    expect(Object.keys(JSON.parse(req.body))).toEqual(SEGMENT_BODY_KEYS.filter((k) => k !== "usage"));
  });

  it("the usage route carries no Tickr-* header and sends both agentSessionId and usage", async () => {
    const { server, api } = await serve(() => json(200, entry({ id: ENTRY, origin: "agent" })));
    const usage = { revision: 1, agentSessionId: "s-1", usageQuality: "complete" as const, usage: [] };
    expect((await api.putUsage(ENTRY, usage)).kind).toBe("applied");
    const req = server.requests[0]!;
    expect(req.url).toBe(`/api/v1/entries/${ENTRY}/agent-usage`);
    expect(Object.keys(req.headers).filter((h) => h.startsWith("tickr-"))).toEqual([]);
    expect(Object.keys(JSON.parse(req.body))).toEqual(["revision", "agentSessionId", "usageQuality", "usage"]);
  });

  it("reports the server state of the entry (finalised, detached) and 200 as not created", async () => {
    const { api } = await serve((i) => json(200, entry(i === 0 ? { agentFinalized: true } : { agentDetached: true })));
    expect(await api.putSegment(SEGMENT, BODY, "claude-code/unknown")).toEqual({ kind: "applied", created: false, finalized: true, detached: false });
    expect(await api.putSegment(SEGMENT, BODY, "claude-code/unknown")).toEqual({ kind: "applied", created: false, finalized: false, detached: true });
  });

  it("a redirect is not followed and the key is not sent elsewhere", async () => {
    const target = await serve(() => json(200, entry()));
    const { api } = await serve(() => ({ status: 307, headers: { location: `${target.server.baseUrl}/api/v1/agent-segments/${SEGMENT}` } }));
    expect((await api.putSegment(SEGMENT, BODY, "claude-code/unknown")).kind).toBe("retry");
    expect(target.server.requests).toHaveLength(0);
  });

  it("GET /me gives the workspace and the server time, and the local time halfway through the request", async () => {
    const { server, api } = await serve(() =>
      json(200, {
        user: { id: "u-1", displayName: "Dev", email: "dev@example.test", timezone: "UTC" },
        workspace: { id: "w-1", name: "Acme", timezone: "UTC" },
        role: "workspace_user",
        serverTime: "2026-11-05T10:00:00Z",
      }),
    );
    const me = await api.me();
    expect(me).toMatchObject({ workspaceId: "w-1", workspaceName: "Acme", serverTime: "2026-11-05T10:00:00Z" });
    expect(Number.isNaN(Date.parse((me as { localTime: string }).localTime))).toBe(false);
    expect(server.requests[0]!.method).toBe("GET");
    expect(server.requests[0]!.headers["tickr-agent"]).toBeUndefined();
  });

  it("an unreadable /me answer, a network failure and a timeout are retried", async () => {
    const { api } = await serve(() => json(200, { workspace: {} }));
    expect(await api.me()).toEqual({ kind: "retry", afterMs: null });
    const slowServer = await serve(() => ({ status: 200, delayMs: 1500 }));
    const slow = createAgentApi({ baseUrl: slowServer.server.baseUrl, apiKey: KEY, timeoutMs: 200 });
    expect(await slow.putSegment(SEGMENT, BODY, "claude-code/unknown")).toEqual({ kind: "retry", afterMs: null });
    const down = createAgentApi({ baseUrl: "http://127.0.0.1:9", apiKey: KEY, timeoutMs: 1000 });
    expect(await down.putSegment(SEGMENT, BODY, "claude-code/unknown")).toEqual({ kind: "retry", afterMs: null });
  });
});

describe("classification (PD-12)", () => {
  const cases: [string, Reply, SendOutcome][] = [
    ["200", json(200, entry()), { kind: "applied", created: false, finalized: false, detached: false }],
    ["201", json(201, entry()), { kind: "applied", created: true, finalized: false, detached: false }],
    ["503 workspace_busy", problem(503, "service_unavailable", "workspace_busy", {}, { "retry-after": "1" }), { kind: "retry", afterMs: 1000 }],
    ["429 with Retry-After", problem(429, "rate_limited", "Too many requests", {}, { "retry-after": "7" }), { kind: "retry", afterMs: 7000 }],
    ["429 without Retry-After", problem(429, "rate_limited"), { kind: "retry", afterMs: null }],
    ["500", problem(500, "internal"), { kind: "retry", afterMs: null }],
    ["502 proxy page", { status: 502, headers: { "content-type": "text/html" }, body: "<html>" }, { kind: "retry", afterMs: null }],
    ["401", problem(401, "unauthorized", "Unauthorized"), { kind: "pause", reason: "unauthorized" }],
    ["403 analyst_read_only", problem(403, "forbidden", "analyst_read_only"), { kind: "pause", reason: "forbidden_role" }],
    ["404 Route not found", problem(404, "not_found", ROUTE_NOT_FOUND), { kind: "pause", reason: "segments_disabled" }],
    ["404 without a problem document", { status: 404 }, { kind: "pause", reason: "segments_disabled" }],
    ["404 Project not found", problem(404, "not_found", "Project not found"), { kind: "terminal", code: "not_found", closesSegment: false }],
    ["403 not_project_member", problem(403, "forbidden", "not_project_member"), { kind: "terminal", code: "not_project_member", closesSegment: false }],
    ...(["segment_id_unavailable", "agent_session_mismatch", "agent_revision_conflict", "entry_locked"].map((c) => [
      `409 ${c}`,
      problem(409, "conflict", c),
      { kind: "terminal", code: c, closesSegment: false },
    ]) as [string, Reply, SendOutcome][]),
    ["409 segment_detached", problem(409, "conflict", "segment_detached"), { kind: "terminal", code: "segment_detached", closesSegment: true }],
    ["409 segment_finalized", problem(409, "conflict", "segment_finalized"), { kind: "terminal", code: "segment_finalized", closesSegment: true }],
    [
      "422 invalid_segment_bounds",
      problem(422, "validation", "Validation failed", { errors: [{ field: "stoppedAt", code: "invalid_segment_bounds", message: "m" }] }),
      { kind: "terminal", code: "invalid_segment_bounds", closesSegment: false },
    ],
    ["422 without errors", problem(422, "validation"), { kind: "terminal", code: "validation", closesSegment: false }],
  ];

  it.each(cases)("segment route: %s", async (_name, reply, expected) => {
    const { api } = await serve(() => reply);
    expect(await api.putSegment(SEGMENT, BODY, "claude-code/unknown")).toEqual(expected);
  });

  it.each([
    ["404 (entry deleted, foreign or not an agent entry)", problem(404, "not_found", "Entry not found"), { kind: "terminal", code: "not_found", closesSegment: false }],
    ["404 without a problem document", { status: 404 }, { kind: "terminal", code: "not_found", closesSegment: false }],
    ["409 entry_locked", problem(409, "conflict", "entry_locked"), { kind: "terminal", code: "entry_locked", closesSegment: false }],
    ["409 segment_detached (never closes on this route)", problem(409, "conflict", "segment_detached"), { kind: "terminal", code: "segment_detached", closesSegment: false }],
  ] as [string, Reply, SendOutcome][])("usage route: %s", async (_name, reply, expected) => {
    const { api } = await serve(() => reply);
    expect(await api.putUsage(ENTRY, { revision: 1, agentSessionId: "s-1", usageQuality: "pending", usage: [] })).toEqual(expected);
  });

  it("GET /me: 401 pauses, a 404 or 422 is only retried", () => {
    expect(classify("me", 401, null, null)).toEqual({ kind: "pause", reason: "unauthorized" });
    expect(classify("me", 404, null, null)).toEqual({ kind: "retry", afterMs: null });
    expect(classify("me", 422, { detail: null, codes: ["x"] }, null)).toEqual({ kind: "retry", afterMs: null });
  });

  it("problem codes are reduced to a safe token", () => {
    expect(classify("segment", 409, { detail: "Some <b>text</b>\r\nX: 1", codes: [] }, null)).toEqual({ kind: "terminal", code: "some_b_text_b_x_1", closesSegment: false });
  });

  it("parseRetryAfter reads seconds and HTTP dates, ignores the rest", () => {
    const now = Date.parse("2026-11-05T10:00:00Z");
    expect(parseRetryAfter("1", now)).toBe(1000);
    expect(parseRetryAfter("Thu, 05 Nov 2026 10:00:30 GMT", now)).toBe(30_000);
    expect(parseRetryAfter("Thu, 05 Nov 2026 09:00:00 GMT", now)).toBe(0);
    expect(parseRetryAfter("-3", now)).toBeNull();
    expect(parseRetryAfter("soon", now)).toBeNull();
    expect(parseRetryAfter(null, now)).toBeNull();
  });

  it("the Tickr-Agent value the sender builds is grammar-valid", async () => {
    const { agentHeaderValue } = await import("../../src/api/agent.js");
    const [name, version] = agentHeaderValue({ name: "claude-code", version: "unknown" }).split("/");
    expect(name).toMatch(AGENT_NAME);
    expect(version).toMatch(AGENT_VERSION);
  });
});
