import { afterEach, describe, expect, it } from "vitest";
import { createTickrClient } from "../src/api/client.js";
import { KeyGate } from "../src/tools/gate.js";
import { runTool } from "../src/tools/run.js";
import { startTimerTool, stopTimerTool } from "../src/tools/timers.js";
import type { EntryDto } from "../src/api/types.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { entryFixture, IDS, meFixture, NOW } from "./helpers/fixtures.js";
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

describe("write hint after an unexpected failure", () => {
  const fakeDeps = (api = fakeApi()) => ({ api, now: () => NOW, gate: new KeyGate(api), baseUrl: "https://t.example.com", apiKey: "tkr_test" });

  it("is not given when stop_timer without id fails while projecting the candidates (only reads were sent)", async () => {
    const api = fakeApi();
    const broken = { ...entryFixture({ id: IDS.entry2, stoppedAt: null, durationSeconds: null }), tagIds: undefined } as unknown as EntryDto;
    api.listActiveTimers.mockResolvedValue([entryFixture({ stoppedAt: null, durationSeconds: null }), broken]);
    const res = await runTool(stopTimerTool, {}, fakeDeps(api));
    expect(res.isError).toBe(true);
    expect(text(res)).toMatch(/Unexpected error/);
    expect(text(res)).not.toMatch(HINT);
    expect(api.stopTimer).not.toHaveBeenCalled();
  });

  it("is given when stop_timer fails while projecting the timer it stopped", async () => {
    const api = fakeApi();
    api.listActiveTimers.mockResolvedValue([entryFixture({ stoppedAt: null, durationSeconds: null })]);
    api.stopTimer.mockResolvedValue({ ...entryFixture(), tagIds: undefined } as unknown as EntryDto);
    const res = await runTool(stopTimerTool, {}, fakeDeps(api));
    expect(text(res)).toMatch(HINT);
  });
});
