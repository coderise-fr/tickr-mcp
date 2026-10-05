import { describe, expect, it } from "vitest";
import { bodyPropertiesOf } from "../src/api/contract.js";
import { ApiProblemError, NetworkError, ToolError } from "../src/api/errors.js";
import type { EntryDto } from "../src/api/types.js";
import { KeyGate } from "../src/tools/gate.js";
import { runTool } from "../src/tools/run.js";
import { listActiveTimersTool, startTimerTool, stopTimerTool } from "../src/tools/timers.js";
import { fakeApi } from "./helpers/fakeApi.js";
import { entryFixture, IDS, NOW } from "./helpers/fixtures.js";

const running = (id: string) => entryFixture({ id, stoppedAt: null, durationSeconds: null });

describe("start_timer", () => {
  it("maps every parameter to the camelCase REST body (wire mapping)", async () => {
    const api = fakeApi();
    await startTimerTool.run(startTimerTool.inputSchema.parse({
      project_id: IDS.projectA, task_id: IDS.taskA, description: "Design", tag_ids: [IDS.tag],
      billable: false, started_at: "2026-10-02T09:00:00+02:00",
    }), { api, now: () => NOW });

    const body = api.startTimer.mock.calls[0]![0];
    expect(body).toStrictEqual({
      projectId: IDS.projectA, taskId: IDS.taskA, description: "Design", tagIds: [IDS.tag],
      isBillable: false, startedAt: "2026-10-02T07:00:00.000Z",
    });
    expect(Object.keys(body).every((k) => bodyPropertiesOf("post", "/api/v1/timers/start").includes(k))).toBe(true);
  });

  it("sends an empty body when no parameter is given", async () => {
    const api = fakeApi();
    const out = await startTimerTool.run(startTimerTool.inputSchema.parse({}), { api, now: () => NOW });
    expect(api.startTimer.mock.calls[0]![0]).toStrictEqual({});
    expect(out.entry.running).toBe(true);
  });

  it("rejects null instead of forwarding it", () => {
    const r = startTimerTool.inputSchema.safeParse({ project_id: null });
    expect(r.success).toBe(false);
  });

  it("rejects a datetime without offset", () => {
    const r = startTimerTool.inputSchema.safeParse({ started_at: "2026-10-02T09:00:00" });
    expect(r.success).toBe(false);
    expect(JSON.stringify(r.error)).toMatch(/explicit offset.*get_context/);
  });

  it("rejects unknown parameters and a task without project", () => {
    expect(startTimerTool.inputSchema.safeParse({ projectId: IDS.projectA }).success).toBe(false);
    expect(startTimerTool.inputSchema.safeParse({ task_id: IDS.taskA }).success).toBe(false);
  });

  it("keeps the verify hint when the projection fails after a successful start (real tool, via runTool)", async () => {
    const api = fakeApi();
    // The API accepted the start, but its answer lacks tagIds: toEntry throws a TypeError
    // inside tool.run, before any output-schema check.
    api.startTimer.mockResolvedValue({ id: IDS.entry, description: "x", startedAt: "2026-10-02T09:00:00+00:00", stoppedAt: null } as unknown as EntryDto);
    const res = await runTool(startTimerTool, {}, { api, now: () => NOW, gate: new KeyGate(api), baseUrl: "https://t.example.com" });

    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toMatch(/may or may not have been applied/);
    expect(api.startTimer).toHaveBeenCalledTimes(1);
  });

  it("lists the visible running timers when the cap is reached", async () => {
    const api = fakeApi();
    api.startTimer.mockRejectedValue(new ApiProblemError({
      status: 409, code: "conflict", detail: "timer_limit_reached", correlationId: "corr-9", fieldErrors: [],
    }));
    api.listActiveTimers.mockResolvedValue([running(IDS.entry), running(IDS.entry2)]);

    const err = await startTimerTool.run({}, { api, now: () => NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toContain(IDS.entry2);
    expect((err as Error).message).toMatch(/another workspace/);
    expect((err as Error).message).toContain("correlation id: corr-9");
  });

  it("hides the timer list when reading it fails (network or timeout)", async () => {
    const api = fakeApi();
    api.startTimer.mockRejectedValue(new ApiProblemError({
      status: 409, code: "conflict", detail: "timer_limit_reached", correlationId: "corr-9", fieldErrors: [],
    }));
    api.listActiveTimers.mockRejectedValue(new NetworkError(true));

    const err = await startTimerTool.run({}, { api, now: () => NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).toMatch(/Three timers/);
    expect((err as Error).message).not.toMatch(/another workspace/);
    expect((err as Error).message).not.toMatch(/Running in this workspace/);
    expect((err as Error).message).toContain("correlation id: corr-9");
  });

  it("omits 'another workspace' when all three visible timers run in this workspace", async () => {
    const api = fakeApi();
    api.startTimer.mockRejectedValue(new ApiProblemError({
      status: 409, code: "conflict", detail: "timer_limit_reached", fieldErrors: [],
    }));
    api.listActiveTimers.mockResolvedValue([running(IDS.entry), running(IDS.entry2), running("0199a000-0000-7000-8000-000000000003")]);

    const err = await startTimerTool.run({}, { api, now: () => NOW }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ToolError);
    expect((err as Error).message).not.toMatch(/another workspace/);
  });
});

describe("stop_timer", () => {
  const d = (api: ReturnType<typeof fakeApi>) => ({ api, now: () => NOW });

  it("stops the given id with the optional stop time", async () => {
    const api = fakeApi();
    const out = await stopTimerTool.run({ entry_id: IDS.entry, stopped_at: "2026-10-02T12:00:00+02:00" }, d(api));
    expect(api.stopTimer).toHaveBeenCalledWith(IDS.entry, { stoppedAt: "2026-10-02T10:00:00.000Z" });
    expect(api.listActiveTimers).not.toHaveBeenCalled();
    expect(out.status).toBe("stopped");
  });

  it("reports none running without error", async () => {
    const api = fakeApi();
    expect(await stopTimerTool.run({}, d(api))).toStrictEqual({ status: "none_running" });
    expect(api.stopTimer).not.toHaveBeenCalled();
  });

  it("stops the only running timer by its id", async () => {
    const api = fakeApi();
    api.listActiveTimers.mockResolvedValue([running(IDS.entry2)]);
    await stopTimerTool.run({}, d(api));
    expect(api.stopTimer).toHaveBeenCalledWith(IDS.entry2, {});
  });

  it("reports a timer stopped in the meantime and never tries another id", async () => {
    const api = fakeApi();
    api.listActiveTimers.mockResolvedValue([running(IDS.entry2)]);
    const conflict = new ApiProblemError({ status: 409, code: "conflict", detail: "Timer already stopped", fieldErrors: [] });
    api.stopTimer.mockRejectedValue(conflict);

    await expect(stopTimerTool.run({}, d(api))).rejects.toBe(conflict);
    expect(api.stopTimer).toHaveBeenCalledTimes(1);
    expect(api.stopTimer).toHaveBeenCalledWith(IDS.entry2, {});
  });

  it("stops nothing and returns candidates when several run", async () => {
    const api = fakeApi();
    api.listActiveTimers.mockResolvedValue([running(IDS.entry), running(IDS.entry2), running("0199a000-0000-7000-8000-000000000003"), running("0199a000-0000-7000-8000-000000000004")]);
    const out = await stopTimerTool.run({}, d(api));
    expect(out.status).toBe("multiple_running");
    expect(out.candidates).toHaveLength(4);
    expect(api.stopTimer).not.toHaveBeenCalled();
  });
});

describe("list_active_timers", () => {
  it("returns projected entries", async () => {
    const api = fakeApi();
    api.listActiveTimers.mockResolvedValue([running(IDS.entry)]);
    const out = await listActiveTimersTool.run({}, { api, now: () => NOW });
    expect(out.items[0]).toMatchObject({ id: IDS.entry, running: true });
    expect(listActiveTimersTool.outputSchema.safeParse(out).success).toBe(true);
  });
});

describe("annotations", () => {
  it("declare reads as read-only and writes as non-idempotent open-world calls", () => {
    expect(listActiveTimersTool.annotations).toMatchObject({ readOnlyHint: true });
    expect(startTimerTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
    expect(stopTimerTool.annotations).toMatchObject({ readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true });
  });
});
