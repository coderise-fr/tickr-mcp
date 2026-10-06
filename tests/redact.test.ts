import { afterEach, describe, expect, it } from "vitest";
import { createTickrClient } from "../src/api/client.js";
import { ApiProblemError } from "../src/api/errors.js";
import { listEntriesTool } from "../src/tools/entries.js";
import { KeyGate } from "../src/tools/gate.js";
import { listProjectsTool } from "../src/tools/reference.js";
import { runTool } from "../src/tools/run.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { entryFixture, meFixture, NOW, projectFixture } from "./helpers/fixtures.js";
import { json, problem, startServer } from "./helpers/httpServer.js";

// The configured API key must never reach the agent, even when Tickr echoes it back.
const KEY = "tkr_synthetic_redaction_canary_0123456789";
const text = (res: { content: unknown }) => JSON.stringify(res.content);

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

function fakeDeps(api = fakeApi()) {
  return { api, deps: { api, now: () => NOW, gate: new KeyGate(api), baseUrl: "https://t.example.com", apiKey: KEY } };
}

async function realDeps(reply: Parameters<typeof startServer>[0]) {
  const srv = await startServer(reply);
  close = srv.close;
  const api = createTickrClient({ baseUrl: srv.baseUrl, apiKey: KEY });
  return { api, now: () => NOW, gate: new KeyGate(api), baseUrl: srv.baseUrl, apiKey: KEY };
}

describe("API key redaction", () => {
  it("replaces the key in an error message", async () => {
    const { api, deps } = fakeDeps();
    api.listProjects.mockRejectedValue(new ApiProblemError({ status: 403, code: "forbidden", detail: `key ${KEY} refused`, fieldErrors: [] }));
    const res = await runTool(listProjectsTool, {}, deps);
    expect(res.isError).toBe(true);
    expect(text(res)).toContain("[redacted]");
    expect(text(res)).not.toContain(KEY);
  });

  it("replaces the key in every string of a result, in both copies, and still meets the output schema", async () => {
    const { api, deps } = fakeDeps();
    api.listEntries.mockResolvedValue({
      data: [entryFixture({ description: `pasted ${KEY} here`, projectName: KEY })],
      page: { next_cursor: null, has_more: false },
    });
    const res = await runTool(listEntriesTool, {}, deps);
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).not.toContain(KEY);
    expect(res.structuredContent).toMatchObject({ items: [{ description: "pasted [redacted] here", project_name: "[redacted]" }] });
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify(res.structuredContent) }]);
    expect(listEntriesTool.outputSchema.safeParse(res.structuredContent).success).toBe(true);
  });

  it("leaves no part of the key when a problem detail is cut at its length limit", async () => {
    const deps = await realDeps((r) => r.url === "/api/v1/me"
      ? json(200, meFixture())
      : problem(403, "forbidden", "x".repeat(290) + KEY));
    const res = await runTool(listProjectsTool, {}, deps);
    expect(res.isError).toBe(true);
    expect(text(res)).not.toContain(KEY.slice(0, 8));
  });

  it("leaves no part of the key when a name is cut at its length limit", async () => {
    const deps = await realDeps((r) => r.url === "/api/v1/me"
      ? json(200, meFixture())
      : json(200, [projectFixture({ name: "p".repeat(190) + KEY })]));
    const res = await runTool(listProjectsTool, {}, deps);
    expect(res.isError).toBeFalsy();
    expect(JSON.stringify(res)).not.toContain(KEY.slice(0, 8));
  });
});
