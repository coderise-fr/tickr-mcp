import { describe, expect, it } from "vitest";
import { NetworkError } from "../src/api/errors.js";
import { BAD_CURSOR, CURSOR_MISMATCH, TOO_LARGE } from "../src/tools/paging.js";
import { listProjectsTool, listTagsTool, listTasksTool } from "../src/tools/reference.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { IDS, NOW, projectFixture, tagFixture, taskFixture } from "./helpers/fixtures.js";

const d = (api = fakeApi()) => ({ api, now: () => NOW });

/** The messages an input schema reports, or [] when the arguments are valid. */
const inputErrors = (schema: { safeParse(v: unknown): { success: boolean; error?: { issues: { message: string }[] } } }, args: unknown) =>
  schema.safeParse(args).error?.issues.map((i) => i.message) ?? [];

describe("reference tools", () => {
  it("list_projects maps include_archived to the archived query and projects items", async () => {
    const api = fakeApi();
    const out = await listProjectsTool.run(listProjectsTool.inputSchema.parse({ include_archived: true }), d(api));
    expect(api.listProjects).toHaveBeenCalledWith({ archived: true });
    expect(out).toStrictEqual({
      items: [{ id: IDS.projectA, name: "Acme website", client_name: "Acme", archived: false }],
      total: 1, has_more: false, next_cursor: null,
    });
    expect(listProjectsTool.outputSchema.safeParse(out).success).toBe(true);
  });

  it("list_tasks requires project_id and passes it as project_id", async () => {
    const api = fakeApi();
    expect(listTasksTool.inputSchema.safeParse({}).success).toBe(false);
    await listTasksTool.run(listTasksTool.inputSchema.parse({ project_id: IDS.projectA }), d(api));
    expect(api.listTasks).toHaveBeenCalledWith({ project_id: IDS.projectA, archived: false });
  });

  it("list_tags drops usage statistics", async () => {
    const api = fakeApi();
    api.listTags.mockResolvedValue([tagFixture(), tagFixture({ id: IDS.entry2, name: "deep work" })]);
    const out = await listTagsTool.run(listTagsTool.inputSchema.parse({ name_contains: "deep" }), d(api));
    expect(out.items).toStrictEqual([{ id: IDS.entry2, name: "deep work" }]);
  });

  it("searches the cleaned names the agent sees", async () => {
    const api = fakeApi();
    api.listProjects.mockResolvedValue([projectFixture({ name: "Line\nbreak" })]);
    const out = await listProjectsTool.run(listProjectsTool.inputSchema.parse({ name_contains: "line" }), d(api));
    expect(out.items[0]!.name).toBe("Line break");
  });

  it("turns a download timeout into the dedicated too-large message", async () => {
    const api = fakeApi();
    api.listProjects.mockRejectedValue(new NetworkError(true));
    await expect(listProjectsTool.run(listProjectsTool.inputSchema.parse({}), d(api))).rejects.toThrow(TOO_LARGE);
  });

  it("keeps other network failures as network errors", async () => {
    const api = fakeApi();
    api.listTags.mockRejectedValue(new NetworkError(false));
    await expect(listTagsTool.run(listTagsTool.inputSchema.parse({}), d(api))).rejects.toBeInstanceOf(NetworkError);
  });

  it("rejects a list_tasks cursor reused on another project", async () => {
    const api = fakeApi();
    api.listTasks.mockResolvedValue([taskFixture(), taskFixture({ id: IDS.entry2, name: "Review" })]);
    const first = await listTasksTool.run(listTasksTool.inputSchema.parse({ project_id: IDS.projectA, limit: 1 }), d(api));
    expect(first.next_cursor).not.toBeNull();
    const again = listTasksTool.inputSchema.parse({ project_id: IDS.projectA, limit: 1, cursor: first.next_cursor });
    await expect(listTasksTool.run(again, d(api))).resolves.toMatchObject({ has_more: false });
    expect(inputErrors(listTasksTool.inputSchema, { project_id: IDS.projectB, limit: 1, cursor: first.next_cursor })).toEqual([CURSOR_MISMATCH]);
  });

  it("rejects a list_projects cursor reused on list_tasks", async () => {
    const api = fakeApi();
    api.listProjects.mockResolvedValue([projectFixture(), projectFixture({ id: IDS.projectB, name: "Beta" })]);
    api.listTasks.mockResolvedValue([taskFixture(), taskFixture({ id: IDS.entry2, name: "Review" })]);
    const first = await listProjectsTool.run(listProjectsTool.inputSchema.parse({ limit: 1 }), d(api));
    expect(first.next_cursor).not.toBeNull();
    expect(inputErrors(listTasksTool.inputSchema, { project_id: IDS.projectA, limit: 1, cursor: first.next_cursor })).toEqual([CURSOR_MISMATCH]);
  });

  it("checks the cursor's binding in the input schema: name_contains and include_archived", async () => {
    const api = fakeApi();
    api.listProjects.mockResolvedValue([projectFixture(), projectFixture({ id: IDS.projectB, name: "Acme beta" })]);
    const first = await listProjectsTool.run(listProjectsTool.inputSchema.parse({ limit: 1, name_contains: "ACME" }), d(api));
    const cursor = first.next_cursor;
    expect(inputErrors(listProjectsTool.inputSchema, { name_contains: "acme", cursor })).toEqual([]);
    expect(inputErrors(listProjectsTool.inputSchema, { name_contains: "acm", cursor })).toEqual([CURSOR_MISMATCH]);
    expect(inputErrors(listProjectsTool.inputSchema, { cursor })).toEqual([CURSOR_MISMATCH]);
    expect(inputErrors(listProjectsTool.inputSchema, { name_contains: "acme", include_archived: true, cursor })).toEqual([CURSOR_MISMATCH]);
    expect(inputErrors(listTagsTool.inputSchema, { name_contains: "acme", cursor })).toEqual([CURSOR_MISMATCH]);
  });

  it.each([listProjectsTool, listTagsTool])("$name rejects a malformed cursor in its input schema", (tool) => {
    for (const cursor of ["not-a-cursor", Buffer.from("{}").toString("base64url"), "%%%"]) {
      expect(inputErrors(tool.inputSchema, { cursor })).toEqual([BAD_CURSOR]);
    }
  });

  it("descriptions tell the agent not to conclude absence too early", () => {
    for (const t of [listProjectsTool, listTasksTool, listTagsTool]) {
      expect(t.description).toMatch(/name_contains/);
      expect(t.annotations.readOnlyHint).toBe(true);
    }
  });
});
