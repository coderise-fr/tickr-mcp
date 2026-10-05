import { describe, expect, it } from "vitest";
import { bodyPropertiesOf } from "../src/api/contract.js";
import { createEntryTool, listEntriesTool, updateEntryTool } from "../src/tools/entries.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { entryFixture, IDS, NOW } from "./helpers/fixtures.js";

const d = (api = fakeApi()) => ({ api, now: () => NOW });
const START = "2026-10-01T09:00:00+02:00";
const STOP = "2026-10-01T11:00:00+02:00";

describe("list_entries", () => {
  it("maps parameters to the declared query names and defaults limit to 50", async () => {
    const api = fakeApi();
    await listEntriesTool.run(listEntriesTool.inputSchema.parse({ from: START, project_id: IDS.projectA, cursor: "abc" }), d(api));
    expect(api.listEntries).toHaveBeenCalledWith({ from: START, project_id: IDS.projectA, cursor: "abc", limit: 50 });
  });

  it("returns items and the API cursor", async () => {
    const api = fakeApi();
    api.listEntries.mockResolvedValue({ data: [entryFixture()], page: { next_cursor: "n1", has_more: true } });
    const out = await listEntriesTool.run({}, d(api));
    expect(out).toMatchObject({ has_more: true, next_cursor: "n1" });
    expect(out.items).toHaveLength(1);
  });

  it("validates limit and the from/to order", () => {
    expect(listEntriesTool.inputSchema.safeParse({ limit: 201 }).success).toBe(false);
    expect(listEntriesTool.inputSchema.safeParse({ from: STOP, to: START }).success).toBe(false);
  });
});

describe("create_entry", () => {
  it("maps every parameter to the camelCase REST body without a client id", async () => {
    const api = fakeApi();
    await createEntryTool.run(createEntryTool.inputSchema.parse({
      started_at: START, stopped_at: STOP, project_id: IDS.projectA, task_id: IDS.taskA,
      description: "Review", tag_ids: [IDS.tag], billable: true,
    }), d(api));
    const body = api.createEntry.mock.calls[0]![0];
    expect(body).toStrictEqual({
      startedAt: START, stoppedAt: STOP, projectId: IDS.projectA, taskId: IDS.taskA,
      description: "Review", tagIds: [IDS.tag], isBillable: true,
    });
    expect(Object.keys(body).every((k) => bodyPropertiesOf("post", "/api/v1/entries").includes(k))).toBe(true);
  });

  it.each([
    [{ stopped_at: STOP }, "started_at missing"],
    [{ started_at: STOP, stopped_at: START }, "stop before start"],
    [{ started_at: START, stopped_at: START }, "zero length"],
    [{ started_at: "2026-10-01T09:00:00", stopped_at: STOP }, "no offset"],
    [{ started_at: START, stopped_at: STOP, task_id: IDS.taskA }, "task without project"],
  ])("rejects %o (%s)", (input, reason) => {
    expect(createEntryTool.inputSchema.safeParse(input).success, reason).toBe(false);
  });
});

describe("update_entry", () => {
  const parse = (input: unknown) => updateEntryTool.inputSchema.safeParse(input);

  it("sends only the changed fields", async () => {
    const api = fakeApi();
    await updateEntryTool.run(updateEntryTool.inputSchema.parse({ entry_id: IDS.entry, description: "renamed" }), d(api));
    expect(api.updateEntry).toHaveBeenCalledWith(IDS.entry, { description: "renamed" });
  });

  it("maps every parameter to the camelCase REST body", async () => {
    const api = fakeApi();
    await updateEntryTool.run(updateEntryTool.inputSchema.parse({
      entry_id: IDS.entry, project_id: IDS.projectB, description: "x", started_at: START, stopped_at: STOP,
      tag_ids: [], billable: false,
    }), d(api));
    const body = api.updateEntry.mock.calls[0]![1];
    expect(body).toStrictEqual({ projectId: IDS.projectB, description: "x", startedAt: START, stoppedAt: STOP, tagIds: [], isBillable: false });
    expect(Object.keys(body).every((k) => bodyPropertiesOf("patch", "/api/v1/entries/{id}").includes(k))).toBe(true);
  });

  it("turns clear flags into clearProject / clearTask", async () => {
    const api = fakeApi();
    await updateEntryTool.run(updateEntryTool.inputSchema.parse({ entry_id: IDS.entry, clear_project: true }), d(api));
    await updateEntryTool.run(updateEntryTool.inputSchema.parse({ entry_id: IDS.entry, clear_task: true }), d(api));
    expect(api.updateEntry.mock.calls[0]![1]).toStrictEqual({ clearProject: true });
    expect(api.updateEntry.mock.calls[1]![1]).toStrictEqual({ clearTask: true });
  });

  it.each([
    [{ entry_id: IDS.entry }, "nothing to change"],
    [{ entry_id: IDS.entry, clear_project: false }, "a false flag is not a change"],
    [{ entry_id: IDS.entry, project_id: null }, "null"],
    [{ entry_id: IDS.entry, task_id: null }, "null task"],
    [{ entry_id: IDS.entry, clear_project: true, project_id: IDS.projectA }, "clear + id"],
    [{ entry_id: IDS.entry, clear_task: true, task_id: IDS.taskA }, "clear task + id"],
    [{ entry_id: IDS.entry, clear_project: true, task_id: IDS.taskA }, "clear project + task"],
    [{ entry_id: IDS.entry, started_at: STOP, stopped_at: START }, "stop before start"],
    [{ entry_id: IDS.entry, clear_stop: true }, "resume is not exposed"],
  ])("rejects %o (%s)", (input, reason) => {
    expect(parse(input).success, reason).toBe(false);
  });

  it("is annotated destructive and not idempotent", () => {
    expect(updateEntryTool.annotations).toMatchObject({ destructiveHint: true, idempotentHint: false, readOnlyHint: false });
    expect(createEntryTool.annotations).toMatchObject({ destructiveHint: false, idempotentHint: false });
  });

  it("explains in its description that changing the project clears the task", () => {
    expect(updateEntryTool.description).toMatch(/project.*clears the task/i);
    expect(updateEntryTool.description).toMatch(/last write wins/i);
  });
});
