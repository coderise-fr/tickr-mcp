import { afterEach, describe, expect, it } from "vitest";
import { createTickrClient } from "../src/api/client.js";
import { KeyGate } from "../src/tools/gate.js";
import { runTool } from "../src/tools/run.js";
import { startTimerTool, stopTimerTool } from "../src/tools/timers.js";
import { meFixture, NOW } from "./helpers/fixtures.js";
import { json, problem, startServer, type RecordedRequest, type Reply } from "./helpers/httpServer.js";

// The "may or may not have been applied" hint, end to end through the real client.
const HINT = /may or may not have been applied/;

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function depsFor(responder: (req: RecordedRequest) => Reply) {
  const srv = await startServer(responder);
  close = srv.close;
  const api = createTickrClient({ baseUrl: srv.baseUrl, apiKey: "tkr_test" });
  return { requests: srv.requests, deps: { api, now: () => NOW, gate: new KeyGate(api), baseUrl: srv.baseUrl, apiKey: "tkr_test" } };
}

const text = (res: { content: unknown }) => JSON.stringify(res.content);

describe("write hint", () => {
  it("is not given when /me is unreachable before a write tool runs", async () => {
    const api = createTickrClient({ baseUrl: "http://127.0.0.1:1", apiKey: "tkr_test" });
    const res = await runTool(startTimerTool, {}, { api, now: () => NOW, gate: new KeyGate(api), baseUrl: "http://127.0.0.1:1", apiKey: "tkr_test" });
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/unreachable/);
    expect(text(res)).not.toMatch(HINT);
  });

  it("is not given when /me fails with a server error before a write tool runs", async () => {
    const { deps, requests } = await depsFor(() => problem(503, "service_unavailable"));
    const res = await runTool(startTimerTool, {}, deps);
    expect(text(res)).toMatch(/server error/);
    expect(text(res)).not.toMatch(HINT);
    expect(requests.map((r) => r.method)).toEqual(["GET"]);
  });

  it("is not given when stop_timer without id cannot read the running timers", async () => {
    const { deps, requests } = await depsFor((r) =>
      r.url === "/api/v1/me" ? json(200, meFixture()) : problem(503, "service_unavailable"));
    const res = await runTool(stopTimerTool, {}, deps);
    expect(res.isError).toBe(true);
    expect(text(res)).not.toMatch(HINT);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/v1/me", "GET /api/v1/timers/active"]);
  });

  it("is given when the POST itself fails", async () => {
    const { deps, requests } = await depsFor((r) =>
      r.url === "/api/v1/me" ? json(200, meFixture()) : problem(503, "service_unavailable"));
    const res = await runTool(startTimerTool, {}, deps);
    expect(text(res)).toMatch(HINT);
    expect(requests.map((r) => `${r.method} ${r.url}`)).toEqual(["GET /api/v1/me", "POST /api/v1/timers/start"]);
  });
});
