import { readdirSync, readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import type { ZodType } from "zod";
import { createTickrClient, type TickrApi } from "../src/api/client.js";
import { ApiProblemError, toAgentMessage, UnreadableResponseError } from "../src/api/errors.js";
import type { EntryDto, MeDto, ProjectDto, TagDto, TaskDto } from "../src/api/types.js";
import {
  contextSchema, entrySchema, projectSchema, tagSchema, taskSchema, toContext, toEntry, toProject, toTag, toTask,
} from "../src/tools/shapes.js";
import { startServer } from "./helpers/httpServer.js";

interface Recording { status: number; contentType: string; body: unknown; retryAfter: number | null }
const dir = new URL("./fixtures/api/", import.meta.url);
const load = (name: string): Recording => JSON.parse(readFileSync(new URL(`${name}.json`, dir), "utf8")) as Recording;

let close: (() => Promise<void>) | undefined;
afterEach(async () => { await close?.(); close = undefined; });

async function clientServing(rec: Recording) {
  const srv = await startServer(() => ({
    status: rec.status,
    headers: { "content-type": rec.contentType, ...(rec.retryAfter !== null ? { "retry-after": String(rec.retryAfter) } : {}) },
    body: JSON.stringify(rec.body),
  }));
  close = srv.close;
  return createTickrClient({ baseUrl: srv.baseUrl, apiKey: "tkr_test" });
}

describe("recorded API responses", () => {
  it("all expected recordings exist", () => {
    const files = readdirSync(dir).map((f) => f.replace(/\.json$/, "")).sort();
    expect(files).toEqual([
      "entries", "err-401", "err-403-analyst", "err-409-limit", "err-422-task",
      "me", "projects", "tags", "tasks", "timers-active",
    ]);
  });

  it("me projects into the context schema and carries a known keyRole", async () => {
    const me = await (await clientServing(load("me"))).me();
    expect(["owner", "admin", "project_lead", "analyst", "workspace_user"]).toContain(me.keyRole);
    expect(conforms(() => toContext(me), contextSchema)).toBe(true);
    const { user: _user, ...withoutUser } = me;
    void _user;
    expect(conforms(() => toContext(withoutUser as unknown as MeDto), contextSchema)).toBe(false);
  });

  it("the entry list keeps its pagination block", async () => {
    const entries = await (await clientServing(load("entries"))).listEntries({ limit: 2 });
    expect(typeof entries.page.has_more).toBe("boolean");
    expect(entries.page.next_cursor === null || typeof entries.page.next_cursor === "string").toBe(true);
  });
});

type Row = Record<string, unknown>;
const NOW_ = new Date();

/** True when the projection runs and its result satisfies the declared output schema. */
function conforms(project: () => unknown, schema: ZodType): boolean {
  try {
    return schema.safeParse(project()).success;
  } catch {
    return false;
  }
}

interface ListCase {
  name: string;
  fetch: (api: TickrApi) => Promise<unknown[]>;
  project: (row: Row) => unknown;
  schema: ZodType;
  required: string[];
}

const LIST_CASES: ListCase[] = [
  {
    name: "timers-active", fetch: (a) => a.listActiveTimers(),
    project: (r) => toEntry(r as unknown as EntryDto, NOW_), schema: entrySchema,
    required: ["id", "description", "startedAt", "tagIds", "isBillable"],
  },
  {
    name: "entries", fetch: async (a) => (await a.listEntries({ limit: 2 })).data,
    project: (r) => toEntry(r as unknown as EntryDto, NOW_), schema: entrySchema,
    required: ["id", "description", "startedAt", "tagIds", "isBillable"],
  },
  {
    name: "projects", fetch: (a) => a.listProjects({ archived: false }),
    project: (r) => toProject(r as unknown as ProjectDto), schema: projectSchema,
    required: ["id", "name", "isArchived"],
  },
  {
    name: "tasks", fetch: (a) => a.listTasks({ project_id: "x", archived: false }),
    project: (r) => toTask(r as unknown as TaskDto), schema: taskSchema,
    required: ["id", "projectId", "name", "isArchived"],
  },
  {
    name: "tags", fetch: (a) => a.listTags(),
    project: (r) => toTag(r as unknown as TagDto), schema: tagSchema,
    required: ["id", "name"],
  },
];

describe.each(LIST_CASES)("$name recording", (c) => {
  async function rows(): Promise<Row[]> {
    return (await c.fetch(await clientServing(load(c.name)))) as Row[];
  }

  it("is non-empty and every row projects into its output schema", async () => {
    const all = await rows();
    expect(all.length).toBeGreaterThan(0);
    for (const row of all) expect(conforms(() => c.project(row), c.schema)).toBe(true);
  });

  it.each(c.required)("the client rejects a recording whose first row lacks %s", async (field) => {
    const rec = structuredClone(load(c.name));
    const list = (Array.isArray(rec.body) ? rec.body : (rec.body as { data: Row[] }).data) as Row[];
    delete list[0]![field];
    await expect(c.fetch(await clientServing(rec))).rejects.toBeInstanceOf(UnreadableResponseError);
  });

  it.each(c.required)("a row without %s is rejected (counter-test)", async (field) => {
    const broken: Row = { ...(await rows())[0]! };
    delete broken[field];
    expect(conforms(() => c.project(broken), c.schema)).toBe(false);
  });
});

describe("recorded API errors", () => {

  it.each([
    ["err-401", 401, "unauthorized", /rejected the API key/],
    ["err-403-analyst", 403, "forbidden", /read-only/],
    ["err-422-task", 422, "validation", /rejected the input: .*task/],
    ["err-409-limit", 409, "conflict", /Three timers/],
  ])("%s parses into the expected problem and message", async (name, status, code, message) => {
    const api = await clientServing(load(name));
    const err = await api.listTags().catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ApiProblemError);
    expect(err).toMatchObject({ status, code });
    expect((err as ApiProblemError).correlationId).toBeTypeOf("string");
    expect(toAgentMessage(err, { baseUrl: "x", isWrite: true })).toMatch(message);
  });

  it("the 422 recording carries field errors, not just a detail", async () => {
    const err = (await (await clientServing(load("err-422-task"))).listTags().catch((e: unknown) => e)) as ApiProblemError;
    expect(err.fieldErrors.length).toBeGreaterThan(0);
    for (const f of err.fieldErrors) {
      expect(f.field).toMatch(/\S/);
      expect(f.code).toMatch(/\S/);
      expect(f.message).toMatch(/\S/);
    }
    expect(err.fieldErrors.some((f) => /task/i.test(f.field))).toBe(true);
  });
});
