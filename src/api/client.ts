import { z } from "zod";
import { VERSION } from "../version.js";
import {
  entryDtoSchema, meDtoSchema, pagedEntriesDtoSchema, projectDtoSchema, tagDtoSchema, taskDtoSchema,
} from "./dto.js";
import {
  ApiHttpError, ApiProblemError, NetworkError, UnreadableResponseError, problemCode, type FieldError,
} from "./errors.js";
import type {
  CreateEntryBody, EntryDto, ListEntriesQuery, MeDto, PagedDto, ProjectDto, StartTimerBody,
  StopTimerBody, TagDto, TaskDto, UpdateEntryBody,
} from "./types.js";

export interface TickrApi {
  me(): Promise<MeDto>;
  listActiveTimers(): Promise<EntryDto[]>;
  startTimer(body: StartTimerBody): Promise<EntryDto>;
  stopTimer(entryId: string, body: StopTimerBody): Promise<EntryDto>;
  listEntries(query: ListEntriesQuery): Promise<PagedDto<EntryDto>>;
  createEntry(body: CreateEntryBody): Promise<EntryDto>;
  updateEntry(entryId: string, body: UpdateEntryBody): Promise<EntryDto>;
  listProjects(query: { archived: boolean }): Promise<ProjectDto[]>;
  listTasks(query: { project_id: string; archived: boolean }): Promise<TaskDto[]>;
  listTags(): Promise<TagDto[]>;
}

export interface ClientOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<void>;
}

type Query = Record<string, string | number | boolean | undefined>;

const MAX_RETRY_AFTER_SECONDS = 5;

export function createTickrClient(opts: ClientOptions): TickrApi {
  const timeoutMs = opts.timeoutMs ?? 30_000;
  const sleep = opts.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  async function request<S extends z.ZodType>(
    method: string,
    path: string,
    schema: S,
    init: { query?: Query; body?: unknown } = {},
  ): Promise<z.infer<S>> {
    const url = new URL(opts.baseUrl + path);
    for (const [k, v] of Object.entries(init.query ?? {})) {
      if (v !== undefined) url.searchParams.set(k, String(v));
    }
    const headers: Record<string, string> = {
      Authorization: `Bearer ${opts.apiKey}`,
      Accept: "application/json",
      "User-Agent": `tickr-mcp/${VERSION}`,
    };
    if (init.body !== undefined) headers["Content-Type"] = "application/json";

    for (let attempt = 0; ; attempt++) {
      let res: Response;
      try {
        res = await fetch(url, {
          method,
          headers,
          body: init.body === undefined ? undefined : JSON.stringify(init.body),
          signal: AbortSignal.timeout(timeoutMs),
        });
      } catch (e) {
        const name = e instanceof Error ? e.name : "";
        throw new NetworkError(name === "TimeoutError" || name === "AbortError");
      }

      if (res.ok) {
        // The body is read inside the same error boundary as the request: a write may
        // already be applied when its answer is cut or truncated, and the agent must be told.
        let body: unknown;
        try {
          body = res.status === 204 ? undefined : await res.json();
        } catch (e) {
          const name = e instanceof Error ? e.name : "";
          if (name === "TimeoutError" || name === "AbortError") throw new NetworkError(true);
          throw new UnreadableResponseError(res.status);
        }
        // Checked here, so a missing or null field is reported as an unreadable answer
        // instead of breaking a projection later.
        const parsed = schema.safeParse(body);
        if (!parsed.success) throw new UnreadableResponseError(res.status);
        return parsed.data;
      }

      const retryAfter = parseRetryAfter(res.headers.get("retry-after"));
      // A 429 was not executed by the server, so one short retry is safe even for writes.
      if (res.status === 429 && attempt === 0 && retryAfter !== undefined && retryAfter <= MAX_RETRY_AFTER_SECONDS) {
        await res.body?.cancel();
        await sleep(retryAfter * 1000);
        continue;
      }
      throw await toError(res, retryAfter);
    }
  }

  const id = (value: string) => encodeURIComponent(value);

  const entries = z.array(entryDtoSchema);

  return {
    me: () => request("GET", "/api/v1/me", meDtoSchema),
    listActiveTimers: () => request("GET", "/api/v1/timers/active", entries),
    startTimer: (body) => request("POST", "/api/v1/timers/start", entryDtoSchema, { body }),
    stopTimer: (entryId, body) => request("POST", `/api/v1/timers/${id(entryId)}/stop`, entryDtoSchema, { body }),
    listEntries: (query) => request("GET", "/api/v1/entries", pagedEntriesDtoSchema, { query: { ...query } }),
    createEntry: (body) => request("POST", "/api/v1/entries", entryDtoSchema, { body }),
    updateEntry: (entryId, body) => request("PATCH", `/api/v1/entries/${id(entryId)}`, entryDtoSchema, { body }),
    listProjects: (query) => request("GET", "/api/v1/projects", z.array(projectDtoSchema), { query: { ...query } }),
    listTasks: (query) => request("GET", "/api/v1/tasks", z.array(taskDtoSchema), { query: { ...query } }),
    listTags: () => request("GET", "/api/v1/tags", z.array(tagDtoSchema)),
  };
}

function parseRetryAfter(value: string | null): number | undefined {
  if (value === null) return undefined;
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds : undefined;
}

async function toError(res: Response, retryAfterSeconds: number | undefined): Promise<Error> {
  const contentType = res.headers.get("content-type") ?? "";
  if (!contentType.includes("json")) {
    await res.body?.cancel();
    return new ApiHttpError(res.status);
  }
  let parsed: unknown;
  try {
    parsed = await res.json();
  } catch {
    return new ApiHttpError(res.status);
  }
  if (typeof parsed !== "object" || parsed === null || typeof (parsed as { type?: unknown }).type !== "string") {
    return new ApiHttpError(res.status);
  }
  const body = parsed as { type: string; detail?: unknown; correlationId?: unknown; errors?: unknown };
  return new ApiProblemError({
    status: res.status,
    code: problemCode(body.type),
    detail: typeof body.detail === "string" ? body.detail : undefined,
    correlationId: typeof body.correlationId === "string" ? body.correlationId : undefined,
    fieldErrors: Array.isArray(body.errors) ? body.errors.filter(isFieldError) : [],
    retryAfterSeconds,
  });
}

function isFieldError(v: unknown): v is FieldError {
  if (typeof v !== "object" || v === null) return false;
  const f = v as Record<string, unknown>;
  return typeof f.field === "string" && typeof f.code === "string" && typeof f.message === "string";
}
