import { describe, expect, it } from "vitest";
import { getContextTool } from "../src/tools/context.js";
import { KeyGate } from "../src/tools/gate.js";
import { runTool } from "../src/tools/run.js";
import { UNTRUSTED } from "../src/tools/tool.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { meFixture, NOW } from "./helpers/fixtures.js";

describe("get_context", () => {
  it("returns a fresh projection of /me on every call", async () => {
    const api = fakeApi();
    api.me
      .mockResolvedValueOnce(meFixture({ role: "project_lead" }))
      .mockResolvedValueOnce(meFixture({ role: "workspace_user", serverTime: "2026-10-03T00:00:01+00:00" }));
    const d = { api, now: () => NOW };

    expect((await getContextTool.run({}, d)).role).toBe("project_lead");
    const second = await getContextTool.run({}, d);
    expect(second.role).toBe("workspace_user");
    expect(second.server_time).toBe("2026-10-03T00:00:01+00:00");
    expect(api.me).toHaveBeenCalledTimes(2);
  });

  it("is read-only and declares an output schema", () => {
    expect(getContextTool.access).toBe("read");
    expect(getContextTool.annotations.readOnlyHint).toBe(true);
  });

  it("warns in its description that names are untrusted data", () => {
    expect(getContextTool.description).toContain(UNTRUSTED);
  });

  it("declares the role as one of the five known roles", () => {
    for (const role of ["owner", "admin", "project_lead", "analyst", "workspace_user"]) {
      expect(getContextTool.outputSchema.shape.role.safeParse(role).success).toBe(true);
    }
    expect(getContextTool.outputSchema.shape.role.safeParse("superuser").success).toBe(false);
  });

  it("reports an unknown effective role as an unreadable answer", async () => {
    const api = fakeApi();
    api.me.mockResolvedValue(meFixture({ role: "superuser" }));
    const res = await runTool(getContextTool, {}, { api, now: () => NOW, gate: new KeyGate(api), baseUrl: "https://t.example.com" });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/could not be read or did not have the expected shape/);
    expect(JSON.stringify(res.content)).not.toContain("superuser");
  });
});
