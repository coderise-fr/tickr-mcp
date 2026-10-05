import { cleanDetail } from "../sanitize.js";

export interface FieldError {
  field: string;
  code: string;
  message: string;
}

export interface ProblemInit {
  status: number;
  code: string;
  detail?: string;
  correlationId?: string;
  fieldErrors: FieldError[];
  retryAfterSeconds?: number;
  /** HTTP method of the failed request; set by the client. */
  method?: string;
}

/** RFC 7807 response from the Tickr API. */
export class ApiProblemError extends Error {
  readonly status: number;
  readonly code: string;
  readonly detail?: string;
  readonly correlationId?: string;
  readonly fieldErrors: FieldError[];
  readonly retryAfterSeconds?: number;
  readonly method?: string;

  constructor(init: ProblemInit) {
    super(`Tickr API ${init.status} ${init.code}`);
    this.name = "ApiProblemError";
    this.status = init.status;
    this.code = init.code;
    this.detail = init.detail;
    this.correlationId = init.correlationId;
    this.fieldErrors = init.fieldErrors;
    this.retryAfterSeconds = init.retryAfterSeconds;
    this.method = init.method;
  }
}

/** Non-API response (proxy page, empty body). Its body is never kept. */
export class ApiHttpError extends Error {
  constructor(readonly status: number, readonly method?: string) {
    super(`HTTP ${status}`);
    this.name = "ApiHttpError";
  }
}

export class NetworkError extends Error {
  constructor(readonly timedOut: boolean, readonly method?: string) {
    super(timedOut ? "timeout" : "network failure");
    this.name = "NetworkError";
  }
}

/**
 * The request reached Tickr, but its answer could not be read (truncated JSON, stream
 * cut) or did not match the expected shape. For a write, the change may have been applied.
 */
export class UnreadableResponseError extends Error {
  constructor(readonly status: number | undefined, readonly method?: string) {
    super("unreadable response");
    this.name = "UnreadableResponseError";
  }
}

/** Error whose message is written for the agent and shown as is. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

export function problemCode(type: unknown): string {
  if (typeof type !== "string" || type.length === 0) return "unknown";
  const segment = type.split("/").filter(Boolean).pop();
  return segment ?? "unknown";
}

const WRITE_HINT =
  " The change may or may not have been applied: check with list_entries or list_active_timers before trying again.";

/**
 * True when the failed request may have changed data: the tool is a write and the request
 * that failed was not a read. An error without a method (raised after the requests, e.g. while
 * checking the answer of a write that succeeded) counts as a write when the tool is one.
 */
function mayHaveWritten(err: { method?: string }, isWrite: boolean): boolean {
  return isWrite && err.method !== "GET";
}

export function toAgentMessage(err: unknown, ctx: { baseUrl: string; isWrite: boolean }): string {
  if (err instanceof ToolError) return err.message;
  if (err instanceof NetworkError) {
    const base = err.timedOut
      ? `Tickr did not answer within 30 seconds at ${ctx.baseUrl}.`
      : `Tickr is unreachable at ${ctx.baseUrl}.`;
    return base + (mayHaveWritten(err, ctx.isWrite) ? WRITE_HINT : "");
  }
  if (err instanceof UnreadableResponseError) {
    return `Tickr's answer${err.status !== undefined ? ` (HTTP ${err.status})` : ""} could not be read or did not have the expected shape.` +
      (mayHaveWritten(err, ctx.isWrite) ? WRITE_HINT : "");
  }
  if (err instanceof ApiHttpError) {
    return `Tickr answered HTTP ${err.status} with a non-API response (often a proxy or gateway error).` +
      (err.status >= 500 && mayHaveWritten(err, ctx.isWrite) ? WRITE_HINT : "");
  }
  if (err instanceof ApiProblemError) {
    return problemMessage(err) +
      (err.status >= 500 && mayHaveWritten(err, ctx.isWrite) ? WRITE_HINT : "") +
      (err.correlationId ? ` (correlation id: ${cleanDetail(err.correlationId)})` : "");
  }
  // Anything else is a bug or an unexpected answer shape, possibly raised while projecting
  // the result of a write that already succeeded: keep the "check before retrying" hint.
  return "Unexpected error in the Tickr MCP server." + (ctx.isWrite ? WRITE_HINT : "");
}

function problemMessage(e: ApiProblemError): string {
  const detail = e.detail === undefined ? undefined : cleanDetail(e.detail);
  switch (e.status) {
    case 401:
      return "Tickr rejected the API key: it is missing, invalid, revoked, expired, or no longer matches its owner's role. " +
        "Create a new key in Tickr (Settings → API keys) and update the MCP server configuration.";
    case 403:
      if (e.detail === "analyst_read_only") return "This API key is read-only (analyst role): it cannot create or change entries.";
      if (e.detail === "not_project_member") return "The user is not a member of this project. Pick a project from list_projects.";
      return `Tickr refused the operation (forbidden${detail ? `: ${detail}` : ""}).`;
    case 404:
      return "Not found: the id does not exist or is not visible to this user. " +
        "Check it with the matching list tool (list_entries, list_projects, list_tasks, list_tags).";
    case 409:
      if (e.detail === "timer_limit_reached") {
        return "Three timers are already running for this user (the limit counts every workspace). Stop one with stop_timer, then try again.";
      }
      if (e.detail === "entry_locked") {
        return "This entry belongs to a submitted timesheet and is locked. It must be reopened in Tickr before it can be changed.";
      }
      if (e.detail === "Timer already stopped") return "This timer is already stopped.";
      return `Conflict: ${detail ?? "the request conflicts with the current state"}.`;
    case 422: {
      const fields = e.fieldErrors
        .map((f) => `${cleanDetail(f.field)}: ${cleanDetail(f.message)} (${cleanDetail(f.code)})`)
        .join("; ");
      return `Tickr rejected the input: ${fields || detail || "validation failed"}.`;
    }
    case 429:
      return `Tickr's rate limit is reached. Wait ${e.retryAfterSeconds !== undefined ? `${e.retryAfterSeconds} seconds` : "a minute"} and try again.`;
    default:
      if (e.status >= 500) return `Tickr returned a server error (HTTP ${e.status}).`;
      return `Tickr returned HTTP ${e.status} (${cleanDetail(e.code)}${detail ? `: ${detail}` : ""}).`;
  }
}
