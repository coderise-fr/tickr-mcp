import { z } from "zod";
import { ApiProblemError, ToolError } from "../api/errors.js";
import { cleanDetail } from "../sanitize.js";
import { entrySchema, toEntry, type Entry } from "./shapes.js";
import { compact, defineTool, id, offsetDateTime, READ_ANNOTATIONS, toUtc, UNTRUSTED } from "./tool.js";

const WRITE = { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true } as const;

export const listActiveTimersTool = defineTool({
  name: "list_active_timers",
  title: "List running timers",
  description: `Lists the timers currently running for the key's user in this workspace. ${UNTRUSTED}`,
  access: "read",
  inputSchema: z.strictObject({}),
  outputSchema: z.strictObject({ items: z.array(entrySchema) }),
  annotations: READ_ANNOTATIONS,
  run: async (_args, { api, now }) => ({ items: (await api.listActiveTimers()).map((e) => toEntry(e, now())) }),
});

function timerLimitMessage(visible: Entry[] | undefined): string {
  if (visible === undefined) {
    return (
      "Three timers are already running for this user (the limit counts every workspace). " +
      "Stop one with stop_timer, then try again."
    );
  }
  const summary = visible.map((e) => ({ id: e.id, description: e.description, project_name: e.project_name, started_at: e.started_at }));
  return (
    "Three timers are already running for this user (the limit counts every workspace). " +
    `Running in this workspace: ${JSON.stringify(summary)}.` +
    (visible.length < 3 ? " Other timers are running in another workspace." : "") +
    " Stop one with stop_timer, then try again."
  );
}

export const startTimerTool = defineTool({
  name: "start_timer",
  title: "Start a timer",
  description:
    "Starts a running timer for the key's user. All fields are optional; project_id, task_id and tag_ids are ids " +
    "from list_projects, list_tasks and list_tags. task_id requires project_id and must belong to it. started_at " +
    "defaults to now; for relative times call get_context and use user.timezone. Up to three timers may run at once. " +
    UNTRUSTED,
  access: "write",
  inputSchema: z
    .strictObject({
      project_id: id.optional(),
      task_id: id.optional(),
      description: z.string().optional(),
      tag_ids: z.array(id).optional(),
      billable: z.boolean().optional(),
      started_at: offsetDateTime.optional(),
    })
    .refine((a) => a.task_id === undefined || a.project_id !== undefined, {
      error: "task_id requires project_id.",
      path: ["task_id"],
    }),
  outputSchema: z.strictObject({ entry: entrySchema }),
  annotations: WRITE,
  run: async (a, { api, now }) => {
    const body = compact({
      projectId: a.project_id,
      taskId: a.task_id,
      description: a.description,
      tagIds: a.tag_ids,
      startedAt: toUtc(a.started_at),
      isBillable: a.billable,
    });
    try {
      return { entry: toEntry(await api.startTimer(body), now()) };
    } catch (e) {
      if (e instanceof ApiProblemError && e.status === 409 && e.detail === "timer_limit_reached") {
        let visible: Entry[] | undefined;
        try {
          visible = (await api.listActiveTimers()).map((x) => toEntry(x, now()));
        } catch {
          visible = undefined;
        }
        const correlation = e.correlationId ? ` (correlation id: ${cleanDetail(e.correlationId)})` : "";
        throw new ToolError(timerLimitMessage(visible) + correlation);
      }
      throw e;
    }
  },
});

export const stopTimerTool = defineTool({
  name: "stop_timer",
  title: "Stop a timer",
  description:
    "Stops a running timer. With entry_id, stops that timer. Without it: if exactly one timer runs it is stopped; " +
    "if none runs, status is none_running; if several run, nothing is stopped and status is multiple_running with " +
    "the candidates, so ask the user which one. stopped_at defaults to now. " + UNTRUSTED,
  access: "write",
  inputSchema: z.strictObject({ entry_id: id.optional(), stopped_at: offsetDateTime.optional() }),
  outputSchema: z.strictObject({
    status: z.enum(["stopped", "none_running", "multiple_running"]),
    entry: entrySchema.optional(),
    candidates: z.array(entrySchema).optional(),
  }),
  annotations: WRITE,
  run: async (a, { api, now }) => {
    const body = compact({ stoppedAt: toUtc(a.stopped_at) });
    if (a.entry_id !== undefined) {
      return { status: "stopped" as const, entry: toEntry(await api.stopTimer(a.entry_id, body), now()) };
    }
    const runningTimers = await api.listActiveTimers();
    if (runningTimers.length === 0) return { status: "none_running" as const };
    if (runningTimers.length > 1) {
      return { status: "multiple_running" as const, candidates: runningTimers.map((e) => toEntry(e, now())) };
    }
    // Stop the id that was read, so a timer started in between is never touched.
    const only = runningTimers[0]!;
    return { status: "stopped" as const, entry: toEntry(await api.stopTimer(only.id, body), now()) };
  },
});
