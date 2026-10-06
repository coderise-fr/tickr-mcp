import { describe, expect, it } from "vitest";
import { z } from "zod";
import { ApiHttpError, ApiProblemError } from "../src/api/errors.js";
import type { MeDto, RoleCode } from "../src/api/types.js";
import { BAD_ME_CONTRACT, KeyGate, TOO_OLD, TOO_OLD_OR_NOT_TICKR } from "../src/tools/gate.js";
import { runTool } from "../src/tools/run.js";
import { defineTool, READ_ANNOTATIONS } from "../src/tools/tool.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { meFixture, NOW } from "./helpers/fixtures.js";

const echo = (access: "read" | "write") => defineTool({
  name: `echo_${access}`, title: "Echo", description: "test", access,
  inputSchema: z.strictObject({}), outputSchema: z.strictObject({ ok: z.boolean() }),
  annotations: READ_ANNOTATIONS,
  run: async () => ({ ok: true }),
});

function deps(role: RoleCode) {
  const api = fakeApi();
  api.me.mockResolvedValue(meFixture({ keyRole: role }));
  return { api, deps: { api, now: () => NOW, gate: new KeyGate(api), baseUrl: "https://t.example.com", apiKey: "tkr_test" } };
}

describe("KeyGate via runTool", () => {
  it.each<RoleCode>(["workspace_user", "project_lead"])("%s may read and write", async (role) => {
    const { deps: d } = deps(role);
    expect((await runTool(echo("read"), {}, d)).isError).toBeFalsy();
    expect((await runTool(echo("write"), {}, d)).isError).toBeFalsy();
  });

  it("analyst may read but not write", async () => {
    const { deps: d } = deps("analyst");
    expect((await runTool(echo("read"), {}, d)).isError).toBeFalsy();
    const res = await runTool(echo("write"), {}, d);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/read-only/);
  });

  it.each<RoleCode>(["admin", "owner"])("%s key is refused for every tool", async (role) => {
    const { deps: d } = deps(role);
    for (const tool of [echo("read"), echo("write")]) {
      const res = await runTool(tool, {}, d);
      expect(res.isError).toBe(true);
      expect(JSON.stringify(res.content)).toMatch(new RegExp(`${role} role.*Workspace user`));
    }
  });

  it("caches keyRole only: /me is called once across tool calls", async () => {
    const { api, deps: d } = deps("workspace_user");
    await runTool(echo("read"), {}, d);
    await runTool(echo("write"), {}, d);
    expect(api.me).toHaveBeenCalledTimes(1);
  });

  it("reports a Tickr 404 problem on /me as an instance too old", async () => {
    const { api, deps: d } = deps("workspace_user");
    api.me.mockRejectedValue(new ApiProblemError({ status: 404, code: "not_found", fieldErrors: [] }));
    const res = await runTool(echo("read"), {}, d);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: TOO_OLD }]);
  });

  it("reports a non-API 404 on /me as too old or not a Tickr instance", async () => {
    const { api, deps: d } = deps("workspace_user");
    api.me.mockRejectedValue(new ApiHttpError(404, "GET"));
    const res = await runTool(echo("read"), {}, d);
    expect(res.isError).toBe(true);
    expect(res.content).toEqual([{ type: "text", text: TOO_OLD_OR_NOT_TICKR }]);
    expect(TOO_OLD_OR_NOT_TICKR.startsWith(TOO_OLD)).toBe(true);
    expect(TOO_OLD_OR_NOT_TICKR).toMatch(/TICKR_BASE_URL does not point to a Tickr instance/);
  });

  it("returns structured content plus its JSON text on success", async () => {
    const { deps: d } = deps("workspace_user");
    const res = await runTool(echo("read"), {}, d);
    expect(res.structuredContent).toEqual({ ok: true });
    expect(res.content).toEqual([{ type: "text", text: JSON.stringify({ ok: true }) }]);
  });

  it.each([
    ["missing keyRole with an admin effective role", { keyRole: undefined, role: "admin" }],
    ["unknown keyRole", { keyRole: "superuser" }],
    ["null keyRole", { keyRole: null }],
  ])("refuses every call on a non-conforming /me (%s)", async (_label, patch) => {
    const { api, deps: d } = deps("workspace_user");
    api.me.mockResolvedValue({ ...meFixture(), ...patch } as unknown as MeDto);
    let ran = false;
    const spy = { ...echo("write"), run: async () => { ran = true; return { ok: true }; } };
    for (const tool of [echo("read"), spy]) {
      const res = await runTool(tool, {}, d);
      expect(res.content).toEqual([{ type: "text", text: BAD_ME_CONTRACT }]);
    }
    expect(ran).toBe(false);
  });

  it("reports an output that breaks the schema after a write as unconfirmed, without a second call", async () => {
    const { deps: d } = deps("workspace_user");
    let calls = 0;
    const broken = { ...echo("write"), run: async () => { calls++; return { ok: "yes" }; } };
    const res = await runTool(broken, {}, d);
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/may or may not have been applied/);
    expect(calls).toBe(1);
  });

  it("does not cache a failed /me", async () => {
    const { api, deps: d } = deps("workspace_user");
    api.me.mockRejectedValueOnce(new ApiHttpError(502));
    expect((await runTool(echo("read"), {}, d)).isError).toBe(true);
    expect((await runTool(echo("read"), {}, d)).isError).toBeFalsy();
    expect(api.me).toHaveBeenCalledTimes(2);
  });
});
