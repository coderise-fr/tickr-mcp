import { describe, expect, it } from "vitest";
import { bodyPropertiesOf } from "../src/api/contract.js";
import { createEntryTool, listEntriesTool, updateEntryTool } from "../src/tools/entries.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { entryFixture, IDS, NOW } from "./helpers/fixtures.js";

const d = (api = fakeApi()) => ({ api, now: () => NOW });
const START = "2026-10-01T09:00:00+02:00";
const STOP = "2026-10-01T11:00:00+02:00";
// The same instants in UTC, as sent on the wire.
const START_UTC = "2026-10-01T07:00:00.000Z";
const STOP_UTC = "2026-10-01T09:00:00.000Z";

describe("list_entries", () => {
  it("maps parameters to the declared query names and defaults limit to 50", async () => {
    const api = fakeApi();
    await listEntriesTool.run(listEntriesTool.inputSchema.parse({ from: START, project_id: IDS.projectA, cursor: "abc" }), d(api));
    expect(api.listEntries).toHaveBeenCalledWith({ from: START_UTC, project_id: IDS.projectA, cursor: "abc", limit: 50 });
  });

  it("sends from and to as the same instants in UTC", async () => {
    const api = fakeApi();
    await listEntriesTool.run(listEntriesTool.inputSchema.parse({ from: START, to: STOP }), d(api));
    expect(api.listEntries).toHaveBeenCalledWith({ from: START_UTC, to: STOP_UTC, limit: 50 });
  });

  it("returns items and the API cursor", async () => {
    const api = fakeApi();
    api.listEntries.mockResolvedValue({ data: [entryFixture()], page: { next_cursor: "n1", has_more: true } });
    const out = await listEntriesTool.run({}, d(api));
    expect(out).toMatchObject({ has_more: true, next_cursor: "n1" });
    expect(out.items).toHaveLength(1);
  });

  it("declares the API cursor as a bounded base64 string in its output schema", () => {
    const out = { items: [], has_more: true };
    expect(listEntriesTool.outputSchema.safeParse({ ...out, next_cursor: "eyJrIjoiYSJ9+/=_-" }).success).toBe(true);
    expect(listEntriesTool.outputSchema.safeParse({ ...out, next_cursor: null }).success).toBe(true);
    expect(listEntriesTool.outputSchema.safeParse({ ...out, next_cursor: "c".repeat(1025) }).success).toBe(false);
    expect(listEntriesTool.outputSchema.safeParse({ ...out, next_cursor: "a\u0007b" }).success).toBe(false);
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
      startedAt: START_UTC, stoppedAt: STOP_UTC, projectId: IDS.projectA, taskId: IDS.taskA,
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
    expect(body).toStrictEqual({ projectId: IDS.projectB, description: "x", startedAt: START_UTC, stoppedAt: STOP_UTC, tagIds: [], isBillable: false });
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

describe("datetimes on the wire", () => {
  it("sends a +02:00 input as the same instant in UTC (Z)", async () => {
    const api = fakeApi();
    const input = "2026-10-04T09:00:00+02:00";
    await createEntryTool.run(createEntryTool.inputSchema.parse({ started_at: input, stopped_at: "2026-10-04T11:00:00+02:00" }), d(api));
    const body = api.createEntry.mock.calls[0]![0];
    expect(body.startedAt).toBe("2026-10-04T07:00:00.000Z");
    expect(body.stoppedAt).toBe("2026-10-04T09:00:00.000Z");
    expect(Date.parse(body.startedAt)).toBe(Date.parse(input));
  });
});
