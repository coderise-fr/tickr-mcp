import { afterEach, describe, expect, it, vi } from "vitest";
import { createTickrClient } from "../src/api/client.js";
import {
  ApiHttpError, ApiProblemError, NetworkError, UnreadableResponseError, toAgentMessage,
} from "../src/api/errors.js";
import { BAD_ME_CONTRACT, KeyGate } from "../src/tools/gate.js";
import { runTool } from "../src/tools/run.js";
import { toEntry } from "../src/tools/shapes.js";
import { listTagsTool } from "../src/tools/reference.js";
import { entryFixture, meFixture, NOW } from "./helpers/fixtures.js";
import { json, problem, startServer, type Reply, type RecordedRequest } from "./helpers/httpServer.js";

const KEY = "tkr_secret_value";
let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function setup(responder: (req: RecordedRequest, i: number) => Reply, opts: { timeoutMs?: number } = {}) {
  const srv = await startServer(responder);
  close = srv.close;
  const sleep = vi.fn(async () => {});
  const api = createTickrClient({ baseUrl: srv.baseUrl, apiKey: KEY, sleep, ...opts });
  return { api, requests: srv.requests, sleep };
}

describe("createTickrClient", () => {
  it("sends the bearer key, accept header and user agent", async () => {
    const { api, requests } = await setup(() => json(200, []));
    await api.listActiveTimers();
    expect(requests[0]!.method).toBe("GET");
    expect(requests[0]!.url).toBe("/api/v1/timers/active");
    expect(requests[0]!.headers.authorization).toBe(`Bearer ${KEY}`);
    expect(requests[0]!.headers.accept).toBe("application/json");
    expect(requests[0]!.headers["user-agent"]).toMatch(/^tickr-mcp\//);
  });

  it("sends the exact camelCase JSON body", async () => {
    const { api, requests } = await setup(() => json(200, entryFixture()));
    await api.startTimer({ projectId: "p1", startedAt: "2026-10-02T09:00:00+02:00" });
    expect(requests[0]!.url).toBe("/api/v1/timers/start");
    expect(requests[0]!.headers["content-type"]).toBe("application/json");
    expect(JSON.parse(requests[0]!.body)).toStrictEqual({ projectId: "p1", startedAt: "2026-10-02T09:00:00+02:00" });
  });

  it("builds query strings with the declared names and skips undefined", async () => {
    const { api, requests } = await setup(() => json(200, { data: [], page: { next_cursor: null, has_more: false } }));
    await api.listEntries({ from: "2026-10-01T00:00:00+02:00", project_id: "p1", limit: 50 });
    const url = new URL(requests[0]!.url, "http://x");
    expect(url.pathname).toBe("/api/v1/entries");
    expect(Object.fromEntries(url.searchParams)).toStrictEqual({
      from: "2026-10-01T00:00:00+02:00", project_id: "p1", limit: "50",
    });
  });

  it("encodes ids in paths", async () => {
    const { api, requests } = await setup(() => json(200, entryFixture()));
    await api.stopTimer("a/b", {});
    expect(requests[0]!.url).toBe("/api/v1/timers/a%2Fb/stop");
  });

  it("parses RFC 7807 problems", async () => {
    const { api } = await setup(() =>
      problem(422, "validation", "Validation failed", { errors: [{ field: "task_id", code: "invalid", message: "bad" }] }));
    const err = await api.createEntry({ startedAt: "a", stoppedAt: "b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblemError);
    expect(err).toMatchObject({
      status: 422, code: "validation", detail: "Validation failed", correlationId: "corr-1",
      fieldErrors: [{ field: "task_id", code: "invalid", message: "bad" }],
    });
  });

  it("never keeps the body of a non-API response", async () => {
    const { api } = await setup(() => ({ status: 502, headers: { "content-type": "text/html" }, body: "<html>secret proxy page</html>" }));
    const err = await api.listTags().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect(JSON.stringify(err)).not.toContain("secret proxy page");
    expect((err as ApiHttpError).status).toBe(502);
  });

  it.each([
    [302, "GET"],
    [307, "POST"],
  ])("does not follow a %i redirect on %s: one request, reported by status only", async (status, method) => {
    const { api, requests } = await setup((r) =>
      r.url === "/elsewhere" ? json(200, []) : {
        status,
        headers: { location: "/elsewhere", "content-type": "application/problem+json" },
        body: JSON.stringify({ type: "https://x/errors/moved", detail: "secret redirect detail" }),
      });
    const err = await (method === "GET" ? api.listTags() : api.startTimer({})).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiHttpError);
    expect((err as ApiHttpError).status).toBe(status);
    expect(requests).toHaveLength(1);
    const msg = toAgentMessage(err, { baseUrl: "x", isWrite: false });
    expect(msg).toBe(`Tickr answered HTTP ${status} with a non-API response (often a proxy or gateway error).`);
    expect(msg).not.toMatch(/elsewhere|secret/);
  });

  it("retries once after a short Retry-After on 429", async () => {
    const { api, requests, sleep } = await setup((_r, i) =>
      i === 0 ? problem(429, "rate_limited", "Too many requests", {}, { "retry-after": "2" }) : json(200, []));
    await expect(api.listTags()).resolves.toEqual([]);
    expect(requests).toHaveLength(2);
    expect(sleep).toHaveBeenCalledWith(2000);
  });

  describe("429 whose body is not an API problem", () => {
    const proxy429 = (headers: Record<string, string> = {}) => ({
      status: 429,
      headers: { "content-type": "text/html", ...headers },
      body: "<html>secret proxy page</html>",
    });
    const ask = (api: Awaited<ReturnType<typeof setup>>["api"]) => api.startTimer({}).catch((e: unknown) => e);

    it("reports the rate limit and the wait time, never the body, after one request", async () => {
      const { api, requests } = await setup(() => proxy429({ "retry-after": "30" }));
      const err = await ask(api);
      const msg = toAgentMessage(err, { baseUrl: "x", isWrite: true });
      expect(msg).toBe("Tickr's rate limit is reached. Wait 30 seconds and try again.");
      expect(JSON.stringify(err)).not.toContain("secret proxy page");
      expect(requests).toHaveLength(1);
    });

    it("retries once after a short Retry-After, then succeeds", async () => {
      const { api, requests, sleep } = await setup((_r, i) => (i === 0 ? proxy429({ "retry-after": "2" }) : json(200, entryFixture())));
      await expect(api.startTimer({})).resolves.toBeDefined();
      expect(requests).toHaveLength(2);
      expect(sleep).toHaveBeenCalledWith(2000);
    });

    it("asks to wait a minute without a usable Retry-After", async () => {
      const { api, requests } = await setup(() => proxy429());
      expect(toAgentMessage(await ask(api), { baseUrl: "x", isWrite: true }))
        .toBe("Tickr's rate limit is reached. Wait a minute and try again.");
      expect(requests).toHaveLength(1);
    });

    it("reports a malformed JSON 429 the same way", async () => {
      const { api } = await setup(() => ({ status: 429, headers: { "content-type": "application/json", "retry-after": "30" }, body: "{oops" }));
      expect(toAgentMessage(await ask(api), { baseUrl: "x", isWrite: true }))
        .toBe("Tickr's rate limit is reached. Wait 30 seconds and try again.");
    });
  });

  it("does not retry a long Retry-After", async () => {
    const { api, requests } = await setup(() => problem(429, "rate_limited", "x", {}, { "retry-after": "30" }));
    const err = await api.listTags().catch((e: unknown) => e);
    expect(err).toMatchObject({ status: 429, retryAfterSeconds: 30 });
    expect(requests).toHaveLength(1);
  });

  it("does not retry a 5xx, even on reads", async () => {
    const { api, requests } = await setup(() => problem(503, "service_unavailable"));
    await expect(api.listTags()).rejects.toBeInstanceOf(ApiProblemError);
    expect(requests).toHaveLength(1);
  });

  it("times out", async () => {
    const { api } = await setup(() => ({ ...json(200, []), delayMs: 500 }), { timeoutMs: 50 });
    const err = await api.listTags().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(true);
  });

  it("treats a success whose body never completes as an unconfirmed write, after one request", async () => {
    const { api, requests } = await setup(
      () => ({ status: 200, headers: { "content-type": "application/json" }, stallAfter: '{"id":' }),
      { timeoutMs: 100 },
    );
    const err = await api.startTimer({}).catch((e: unknown) => e);
    // Depending on the Node version the cut stream surfaces as a timeout or as a read failure.
    expect(err instanceof NetworkError || err instanceof UnreadableResponseError).toBe(true);
    expect(toAgentMessage(err, { baseUrl: "x", isWrite: true })).toMatch(/may or may not have been applied/);
    expect(requests).toHaveLength(1);
  });

  it("treats a truncated JSON success as unreadable, after one request", async () => {
    const { api, requests } = await setup(() => ({ status: 201, headers: { "content-type": "application/json" }, body: '{"id":' }));
    const err = await api.createEntry({ startedAt: "a", stoppedAt: "b" }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(UnreadableResponseError);
    expect((err as UnreadableResponseError).status).toBe(201);
    expect(requests).toHaveLength(1);
  });

  it("reports an unreachable host as a network error", async () => {
    const api = createTickrClient({ baseUrl: "http://127.0.0.1:1", apiKey: KEY });
    const err = await api.listTags().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(NetworkError);
    expect((err as NetworkError).timedOut).toBe(false);
  });

  it("calls every route of the contract with the right method and path", async () => {
    const { api, requests } = await setup((r) => {
      if (r.url === "/api/v1/me") return json(200, meFixture());
      if (r.url.startsWith("/api/v1/entries")) return json(200, entryFixture());
      return json(200, []);
    });
    await api.me();
    await api.listProjects({ archived: false });
    await api.listTasks({ project_id: "p1", archived: true });
    await api.updateEntry("e1", { description: "x" });
    await api.createEntry({ startedAt: "a", stoppedAt: "b" });
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual([
      "GET /api/v1/me",
      "GET /api/v1/projects?archived=false",
      "GET /api/v1/tasks?project_id=p1&archived=true",
      "PATCH /api/v1/entries/e1",
      "POST /api/v1/entries",
    ]);
  });

  describe("validates answers before handing them to the tools", () => {
    it("accepts a null entry description, projected as an empty string", async () => {
      const { api } = await setup(() => json(200, [entryFixture({ description: null })]));
      const [entry] = await api.listActiveTimers();
      expect(entry!.description).toBeNull();
      expect(toEntry(entry!, NOW).description).toBe("");
    });

    it("keeps unknown extra fields out of the way (taskName)", async () => {
      const { api } = await setup(() => json(200, [{ ...entryFixture(), taskName: "Design" }]));
      await expect(api.listActiveTimers()).resolves.toHaveLength(1);
    });

    it("rejects an entry without startedAt as unreadable, with the HTTP status", async () => {
      const { startedAt: _s, ...broken } = entryFixture();
      void _s;
      const { api } = await setup(() => json(200, { data: [broken], page: { next_cursor: null, has_more: false } }));
      const err = await api.listEntries({ limit: 50 }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnreadableResponseError);
      expect((err as UnreadableResponseError).status).toBe(200);
      expect(toAgentMessage(err, { baseUrl: "x", isWrite: false })).toMatch(/HTTP 200.*could not be read or did not have the expected shape/);
    });

    it("rejects /me answering 200 null as unreadable", async () => {
      const { api } = await setup(() => json(200, null));
      const err = await api.me().catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnreadableResponseError);
      expect((err as UnreadableResponseError).status).toBe(200);
    });

    it("rejects /me without its user block, but leaves keyRole to the gate", async () => {
      const { user: _u, ...noUser } = meFixture();
      void _u;
      const srv = await setup((_r, i) => (i === 0 ? json(200, noUser) : json(200, { ...meFixture(), keyRole: null })));
      await expect(srv.api.me()).rejects.toBeInstanceOf(UnreadableResponseError);
      await expect(srv.api.me()).resolves.toMatchObject({ keyRole: null });
    });

    it.each([
      ["without keyRole", (() => { const { keyRole: _k, ...rest } = meFixture(); void _k; return rest; })()],
      ["with a null keyRole", { ...meFixture(), keyRole: null }],
      ["with an unknown keyRole", { ...meFixture(), keyRole: "superuser" }],
    ])("lets the gate answer the contract error for /me %s (real client, runTool)", async (_label, body) => {
      const srv = await startServer(() => json(200, body));
      close = srv.close;
      const api = createTickrClient({ baseUrl: srv.baseUrl, apiKey: KEY });
      const res = await runTool(listTagsTool, {}, { api, now: () => NOW, gate: new KeyGate(api), baseUrl: srv.baseUrl });
      expect(res.isError).toBe(true);
      expect(res.content).toEqual([{ type: "text", text: BAD_ME_CONTRACT }]);
      expect(srv.requests.map((r) => r.url)).toEqual(["/api/v1/me"]);
    });

    it("rejects a project, task or tag without its name", async () => {
      const { api } = await setup(() => json(200, [{ id: "x" }]));
      await expect(api.listProjects({ archived: false })).rejects.toBeInstanceOf(UnreadableResponseError);
      await expect(api.listTasks({ project_id: "p", archived: false })).rejects.toBeInstanceOf(UnreadableResponseError);
      await expect(api.listTags()).rejects.toBeInstanceOf(UnreadableResponseError);
    });

    it("tells the agent to check before retrying when the answer to a write is unreadable", async () => {
      const { api, requests } = await setup(() => json(201, { id: "e1" }));
      const err = await api.createEntry({ startedAt: "a", stoppedAt: "b" }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(UnreadableResponseError);
      expect((err as UnreadableResponseError).status).toBe(201);
      expect(toAgentMessage(err, { baseUrl: "x", isWrite: true })).toMatch(/may or may not have been applied/);
      expect(requests).toHaveLength(1);
    });
  });
});
