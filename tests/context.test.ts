import { describe, expect, it } from "vitest";
import { getContextTool } from "../src/tools/context.js";
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
});
