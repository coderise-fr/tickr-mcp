import { z } from "zod";
import { entrySchema, toEntry } from "./shapes.js";
import { compact, defineTool, id, isAfter, offsetDateTime, READ_ANNOTATIONS, UNTRUSTED } from "./tool.js";

const DATES =
  "Datetimes need an explicit offset; for relative dates call get_context and interpret them in user.timezone. " +
  "If a local time is ambiguous or does not exist (daylight-saving change), ask the user.";

export const listEntriesTool = defineTool({
  name: "list_entries",
  title: "List my time entries",
  description:
    "Lists the key owner's own time entries, newest first, optionally between from (inclusive) and to (exclusive) " +
    `on start time, and filtered by project, task or tag id. Follow next_cursor while has_more is true. ${DATES} ${UNTRUSTED}`,
  access: "read",
  inputSchema: z
    .strictObject({
      from: offsetDateTime.optional(),
      to: offsetDateTime.optional(),
      project_id: id.optional(),
      task_id: id.optional(),
      tag_id: id.optional(),
      limit: z.int().min(1).max(200).optional(),
      cursor: z.string().min(1).optional(),
    })
    .refine((a) => a.from === undefined || a.to === undefined || isAfter(a.to, a.from), {
      error: "to must be after from.",
      path: ["to"],
    }),
  outputSchema: z.strictObject({ items: z.array(entrySchema), has_more: z.boolean(), next_cursor: z.string().nullable() }),
  annotations: READ_ANNOTATIONS,
  run: async (a, { api, now }) => {
    const res = await api.listEntries(compact({
      from: a.from, to: a.to, project_id: a.project_id, task_id: a.task_id, tag_id: a.tag_id,
      cursor: a.cursor, limit: a.limit ?? 50,
    }));
    return {
      items: res.data.map((e) => toEntry(e, now())),
      has_more: res.page.has_more,
      next_cursor: res.page.next_cursor,
    };
  },
});

export const createEntryTool = defineTool({
  name: "create_entry",
  title: "Create a time entry",
  description:
    "Creates a finished time entry for the key's user (use start_timer for a running one). task_id requires " +
    `project_id and must belong to it. Not idempotent: if the call fails without an answer, check list_entries before retrying. ${DATES} ${UNTRUSTED}`,
  access: "write",
  inputSchema: z
    .strictObject({
      started_at: offsetDateTime,
      stopped_at: offsetDateTime,
      project_id: id.optional(),
      task_id: id.optional(),
      description: z.string().optional(),
      tag_ids: z.array(id).optional(),
      billable: z.boolean().optional(),
    })
    .refine((a) => isAfter(a.stopped_at, a.started_at), { error: "stopped_at must be after started_at.", path: ["stopped_at"] })
    .refine((a) => a.task_id === undefined || a.project_id !== undefined, { error: "task_id requires project_id.", path: ["task_id"] }),
  outputSchema: z.strictObject({ entry: entrySchema }),
  annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
  run: async (a, { api, now }) => {
    const body = compact({
      startedAt: a.started_at,
      stoppedAt: a.stopped_at,
      projectId: a.project_id,
      taskId: a.task_id,
      description: a.description,
      tagIds: a.tag_ids,
      isBillable: a.billable,
    });
    return { entry: toEntry(await api.createEntry(body), now()) };
  },
});

const updateInput = z
  .strictObject({
    entry_id: id,
    project_id: id.optional(),
    task_id: id.optional(),
    clear_project: z.boolean().optional(),
    clear_task: z.boolean().optional(),
    description: z.string().optional(),
    started_at: offsetDateTime.optional(),
    stopped_at: offsetDateTime.optional(),
    tag_ids: z.array(id).optional(),
    billable: z.boolean().optional(),
  })
  .superRefine((a, ctx) => {
    if (a.clear_project && a.project_id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["clear_project"], message: "clear_project and project_id cannot be combined." });
    }
    if (a.clear_task && a.task_id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["clear_task"], message: "clear_task and task_id cannot be combined." });
    }
    if (a.clear_project && a.task_id !== undefined) {
      ctx.addIssue({ code: "custom", path: ["task_id"], message: "clear_project also clears the task; task_id cannot be set in the same call." });
    }
    if (a.started_at !== undefined && a.stopped_at !== undefined && !isAfter(a.stopped_at, a.started_at)) {
      ctx.addIssue({ code: "custom", path: ["stopped_at"], message: "stopped_at must be after started_at." });
    }
    const changes = [
      a.project_id, a.task_id, a.clear_project ? true : undefined, a.clear_task ? true : undefined,
      a.description, a.started_at, a.stopped_at, a.tag_ids, a.billable,
    ];
    if (changes.every((v) => v === undefined)) {
      ctx.addIssue({ code: "custom", path: ["entry_id"], message: "Nothing to change: pass at least one field besides entry_id." });
    }
  });

export const updateEntryTool = defineTool({
  name: "update_entry",
  title: "Update a time entry",
  description:
    "Changes fields of one of the key owner's entries; omitted fields stay unchanged and null is not accepted. " +
    "To remove the project or task use clear_project: true (it also clears the task) or clear_task: true. " +
    "Changing the project clears the task, unless you pass a task_id of the new project in the same call. " +
    "tag_ids replaces the whole tag list ([] removes all tags). Last write wins: there is no conflict check, so " +
    `re-read the entry with list_entries just before replacing tag_ids. ${DATES} ${UNTRUSTED}`,
  access: "write",
  inputSchema: updateInput,
  outputSchema: z.strictObject({ entry: entrySchema }),
  annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true },
  run: async (a, { api, now }) => {
    const body = compact({
      projectId: a.project_id,
      clearProject: a.clear_project ? true : undefined,
      taskId: a.task_id,
      clearTask: a.clear_task ? true : undefined,
      description: a.description,
      startedAt: a.started_at,
      stoppedAt: a.stopped_at,
      tagIds: a.tag_ids,
      isBillable: a.billable,
    });
    return { entry: toEntry(await api.updateEntry(a.entry_id, body), now()) };
  },
});
