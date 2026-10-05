import { z } from "zod";
import { NetworkError, ToolError } from "../api/errors.js";
import { pageReferenceList, TOO_LARGE } from "./paging.js";
import { projectSchema, tagSchema, taskSchema, toProject, toTag, toTask } from "./shapes.js";
import { defineTool, id, READ_ANNOTATIONS, UNTRUSTED } from "./tool.js";

/** Spec §6.5: a whole-list download that times out gets the dedicated "too large" message. */
async function fetchWhole<T>(load: () => Promise<T[]>): Promise<T[]> {
  try {
    return await load();
  } catch (e) {
    if (e instanceof NetworkError && e.timedOut) throw new ToolError(TOO_LARGE);
    throw e;
  }
}

const pageFields = {
  name_contains: z.string().min(1).max(200).optional(),
  limit: z.int().min(1).max(200).optional(),
  cursor: z.string().min(1).optional(),
};

const listOf = <S extends z.ZodType>(item: S) =>
  z.strictObject({ items: z.array(item), total: z.int(), has_more: z.boolean(), next_cursor: z.string().nullable() });

const PAGING =
  "Results are sorted by name, 50 per page by default; follow next_cursor while has_more is true. Before concluding " +
  "that something does not exist, search again with name_contains.";

export const listProjectsTool = defineTool({
  name: "list_projects",
  title: "List projects",
  description: `Lists the projects visible to the key's user, to find a project_id. ${PAGING} ${UNTRUSTED}`,
  access: "read",
  inputSchema: z.strictObject({ include_archived: z.boolean().optional(), ...pageFields }),
  outputSchema: listOf(projectSchema),
  annotations: READ_ANNOTATIONS,
  run: async (a, { api }) => {
    const archived = a.include_archived ?? false;
    const projects = (await fetchWhole(() => api.listProjects({ archived }))).map(toProject);
    return pageReferenceList(projects, { nameContains: a.name_contains, filterKey: { a: archived }, limit: a.limit, cursor: a.cursor });
  },
});

export const listTasksTool = defineTool({
  name: "list_tasks",
  title: "List tasks of a project",
  description: `Lists the tasks of one project (project_id from list_projects), to find a task_id. ${PAGING} ${UNTRUSTED}`,
  access: "read",
  inputSchema: z.strictObject({ project_id: id, include_archived: z.boolean().optional(), ...pageFields }),
  outputSchema: listOf(taskSchema),
  annotations: READ_ANNOTATIONS,
  run: async (a, { api }) => {
    const archived = a.include_archived ?? false;
    const tasks = (await fetchWhole(() => api.listTasks({ project_id: a.project_id, archived }))).map(toTask);
    return pageReferenceList(tasks, { nameContains: a.name_contains, filterKey: { a: archived }, limit: a.limit, cursor: a.cursor });
  },
});

export const listTagsTool = defineTool({
  name: "list_tags",
  title: "List tags",
  description: `Lists the workspace tags, to find tag ids. ${PAGING} ${UNTRUSTED}`,
  access: "read",
  inputSchema: z.strictObject(pageFields),
  outputSchema: listOf(tagSchema),
  annotations: READ_ANNOTATIONS,
  run: async (a, { api }) => {
    const tags = (await fetchWhole(() => api.listTags())).map(toTag);
    return pageReferenceList(tags, { nameContains: a.name_contains, filterKey: { a: null }, limit: a.limit, cursor: a.cursor });
  },
});
