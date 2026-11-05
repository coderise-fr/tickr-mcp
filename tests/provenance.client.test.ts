import { afterEach, describe, expect, it, vi } from "vitest";
import { createTickrClient } from "../src/api/client.js";
import { entryFixture, meFixture } from "./helpers/fixtures.js";
import { json, problem, startServer, type RecordedRequest, type Reply } from "./helpers/httpServer.js";

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

type Api = ReturnType<typeof createTickrClient>;
const ID = "00000000-0000-4000-8000-000000000001";

async function withAgent(responder: (req: RecordedRequest, i: number) => Reply, agent?: () => string) {
  const srv = await startServer(responder);
  close = srv.close;
  const sleep = vi.fn(async () => {});
  return { api: createTickrClient({ baseUrl: srv.baseUrl, apiKey: "tkr_secret_value", sleep, agent }), requests: srv.requests, sleep };
}

describe("agent provenance headers", () => {
  it.each([
    ["startTimer", (a: Api) => a.startTimer({ projectId: ID })],
    ["stopTimer", (a: Api) => a.stopTimer(ID, {})],
    ["createEntry", (a: Api) => a.createEntry({ projectId: ID, startedAt: "2026-10-02T09:00:00Z", stoppedAt: "2026-10-02T10:00:00Z" } as never)],
    ["updateEntry", (a: Api) => a.updateEntry(ID, {})],
  ])("sends Tickr-Origin and Tickr-Agent on %s", async (_name, call) => {
    const { api, requests } = await withAgent(() => json(200, entryFixture()), () => "claude-code/2.1.300");
    await call(api);
    expect(requests[0]!.headers["tickr-origin"]).toBe("agent");
    expect(requests[0]!.headers["tickr-agent"]).toBe("claude-code/2.1.300");
  });

  it.each([
    ["me", (a: Api) => a.me(), meFixture()],
    ["listActiveTimers", (a: Api) => a.listActiveTimers(), []],
    ["listEntries", (a: Api) => a.listEntries({}), { data: [], page: { next_cursor: null, has_more: false } }],
    ["listProjects", (a: Api) => a.listProjects({ archived: false }), []],
    ["listTasks", (a: Api) => a.listTasks({ project_id: ID, archived: false }), []],
    ["listTags", (a: Api) => a.listTags(), []],
  ])("sends no Tickr header on %s", async (_name, call, reply) => {
    const { api, requests } = await withAgent(() => json(200, reply), () => "claude-code/2.1.300");
    await call(api);
    expect(requests[0]!.headers["tickr-origin"]).toBeUndefined();
    expect(requests[0]!.headers["tickr-agent"]).toBeUndefined();
  });

  it("reads the agent at each write", async () => {
    let n = 0;
    const { api, requests } = await withAgent(() => json(200, entryFixture()), () => (n++ === 0 ? "a/1" : "b/2"));
    await api.stopTimer(ID, {});
    await api.stopTimer(ID, {});
    expect(requests.map((r) => r.headers["tickr-agent"])).toEqual(["a/1", "b/2"]);
  });

  it("sends no Tickr header when no agent provider is configured", async () => {
    const { api, requests } = await withAgent(() => json(200, entryFixture()));
    await api.stopTimer(ID, {});
    expect(requests[0]!.headers["tickr-agent"]).toBeUndefined();
    expect(requests[0]!.headers["tickr-origin"]).toBeUndefined();
  });

  it("repeats the headers on the 429 retry", async () => {
    const { api, requests } = await withAgent(
      (_r, i) => (i === 0 ? problem(429, "rate_limited", "x", {}, { "retry-after": "1" }) : json(200, entryFixture())),
      () => "claude-code/2.1.300");
    await api.stopTimer(ID, {});
    expect(requests.map((r) => r.headers["tickr-agent"])).toEqual(["claude-code/2.1.300", "claude-code/2.1.300"]);
  });
});

describe("503 workspace_busy", () => {
  const busy = (retryAfter?: string) =>
    problem(503, "service_unavailable", "workspace_busy", {}, retryAfter ? { "retry-after": retryAfter } : {});

  it("retries a write once after Retry-After: 1, then succeeds", async () => {
    const { api, requests, sleep } = await withAgent((_r, i) => (i === 0 ? busy("1") : json(200, entryFixture())), () => "a/1");
    await api.startTimer({ projectId: ID });
    expect(requests).toHaveLength(2);
    expect(requests[1]!.body).toBe(requests[0]!.body);
    expect(sleep.mock.calls.map((c) => (c as unknown[])[0])).toEqual([1000]);
  });

  it.each([["above 5 s", "30"], ["absent", undefined]])("does not retry with Retry-After %s", async (_label, value) => {
    const { api, requests } = await withAgent(() => busy(value), () => "a/1");
    await expect(api.startTimer({ projectId: ID })).rejects.toMatchObject({ status: 503, detail: "workspace_busy" });
    expect(requests).toHaveLength(1);
  });

  it("retries only once", async () => {
    const { api, requests } = await withAgent(() => busy("1"), () => "a/1");
    await expect(api.startTimer({ projectId: ID })).rejects.toMatchObject({ status: 503 });
    expect(requests).toHaveLength(2);
  });
});
