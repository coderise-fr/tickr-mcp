// The flusher's view of the Tickr agent routes: the outcome classes (PD-12) and the HTTP client.
//
//   GET /api/v1/me                          workspace check and clock skew (once per instance)
//   PUT /api/v1/agent-segments/{id}         segment revisions (Tickr-Agent header)
//   PUT /api/v1/entries/{id}/agent-usage    usage of delegated entries
//
// The client never follows a redirect (the key and a body must not be replayed elsewhere), never
// reads a body that is not an RFC 7807 problem on an error, and never puts the key anywhere but
// the Authorization header. Node built-ins only (global fetch).
import { AGENT_HEADER } from "../../src/api/agent.js";
import { PLUGIN_VERSION } from "../version.js";
import type { SegmentBody, UsageQuality, UsageRow } from "./revisions.js";

/** Body of PUT /api/v1/entries/{id}/agent-usage: always both agentSessionId and usage. */
export interface UsageBody {
  revision: number;
  agentSessionId: string;
  usageQuality: UsageQuality;
  usage: UsageRow[];
}

/** Every key a usage body carries, in wire order (the REST contract of the usage route). */
export const USAGE_BODY_KEYS = ["revision", "agentSessionId", "usageQuality", "usage"] as const satisfies readonly (keyof UsageBody)[];

export type PauseReason = "unauthorized" | "forbidden_role" | "segments_disabled" | "clock_skew";

/** The task and description of the entry Tickr answered with (read, never stored). */
export interface AppliedEntry {
  description: string;
  taskId: string | null;
}

export type SendOutcome =
  /** entry: present when the answer shows the entry's description (flusher/rename.ts). */
  | { kind: "applied"; created: boolean; finalized: boolean; detached: boolean; entry?: AppliedEntry }
  /** afterMs: the server's Retry-After in milliseconds, or null to back off (sender.ts). */
  | { kind: "retry"; afterMs: number | null }
  | { kind: "pause"; reason: PauseReason }
  | { kind: "terminal"; code: string; closesSegment: boolean };

export interface MeInfo {
  workspaceId: string;
  workspaceName: string;
  serverTime: string;
  /** Local time halfway through the request, to measure the clock skew. */
  localTime: string;
}

export interface AgentApi {
  me(): Promise<MeInfo | SendOutcome>;
  putSegment(id: string, body: SegmentBody, agent: string): Promise<SendOutcome>;
  putUsage(id: string, body: UsageBody): Promise<SendOutcome>;
}

const LATER: SendOutcome = { kind: "retry", afterMs: 60_000 };

/** Sends nothing: every call answers "retry later". */
export const OFFLINE_API: AgentApi = {
  me: () => Promise.resolve(LATER),
  putSegment: () => Promise.resolve(LATER),
  putUsage: () => Promise.resolve(LATER),
};

export const REQUEST_TIMEOUT_MS = 3000;
export const USER_AGENT = `tickr-plugin/${PLUGIN_VERSION}`;
/** detail of the 404 Tickr answers on the segment route while agent segments are switched off. */
export const ROUTE_NOT_FOUND = "Route not found";

/** 409 details that are permanent for the target; the first two also close the open segment. */
const CLOSING_CONFLICTS = new Set(["segment_detached", "segment_finalized"]);

export interface AgentApiOptions {
  baseUrl: string;
  apiKey: string;
  timeoutMs?: number;
  /** Current time in milliseconds (Retry-After dates, skew measurement). */
  now?: () => number;
  fetch?: typeof fetch;
}

/**
 * Retry-After in milliseconds (RFC 9110 §10.2.3): delta-seconds, or an HTTP date turned into the
 * time left from now (0 when past). Anything else is ignored (null).
 */
export function parseRetryAfter(value: string | null, nowMs: number): number | null {
  if (value === null || value.trim() === "") return null;
  const seconds = Number(value);
  if (Number.isFinite(seconds)) return seconds >= 0 ? Math.round(seconds * 1000) : null;
  if (!/[A-Za-z]/.test(value)) return null;
  const date = Date.parse(value);
  return Number.isNaN(date) ? null : Math.max(0, date - nowMs);
}

/** The parts of an RFC 7807 problem the classification reads. */
export interface Problem {
  detail: string | null;
  codes: string[];
}

async function readProblem(res: Response): Promise<Problem | null> {
  const type = (res.headers.get("content-type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (type !== "application/problem+json") {
    await res.body?.cancel().catch(() => undefined);
    return null;
  }
  try {
    const body = (await res.json()) as { detail?: unknown; errors?: unknown } | null;
    if (typeof body !== "object" || body === null) return null;
    const codes = Array.isArray(body.errors)
      ? body.errors.map((e) => (e as { code?: unknown } | null)?.code).filter((c): c is string => typeof c === "string")
      : [];
    return { detail: typeof body.detail === "string" ? body.detail : null, codes };
  } catch {
    return null;
  }
}

/** A short, safe code: letters, digits and underscores only (problem texts are never stored raw). */
function code(raw: string | null | undefined, fallback: string): string {
  if (typeof raw !== "string") return fallback;
  const parts = raw.toLowerCase().split(/[^a-z0-9]/).filter((part) => part !== "");
  const clean = parts.join("_").slice(0, 64);
  return clean === "" ? fallback : clean;
}

export type Route = "segment" | "usage" | "me";

/** PD-12: the outcome of an answer that is not a 2xx. */
export function classify(route: Route, status: number, problem: Problem | null, retryAfterMs: number | null): SendOutcome {
  const detail = problem?.detail ?? null;
  if (status === 401) return { kind: "pause", reason: "unauthorized" };
  if (status === 403) {
    if (detail === "not_project_member") return { kind: "terminal", code: "not_project_member", closesSegment: false };
    return { kind: "pause", reason: "forbidden_role" }; // analyst_read_only, and every other 403
  }
  // GET /me names no target: anything else is a reason to ask again later.
  if (route === "me") return { kind: "retry", afterMs: retryAfterMs };
  if (status === 404) {
    // The segment route answers "Route not found" while the feature is off; a Tickr without the
    // route at all answers a 404 that is not a problem document. Neither is about the target.
    if (route !== "usage" && (detail === ROUTE_NOT_FOUND || problem === null)) return { kind: "pause", reason: "segments_disabled" };
    return { kind: "terminal", code: "not_found", closesSegment: false };
  }
  if (status === 409) {
    const c = code(detail, "conflict");
    return { kind: "terminal", code: c, closesSegment: route === "segment" && CLOSING_CONFLICTS.has(c) };
  }
  if (status === 422) return { kind: "terminal", code: code(problem?.codes[0], "validation"), closesSegment: false };
  if (status === 429 || status >= 500) return { kind: "retry", afterMs: retryAfterMs };
  // A redirect (never followed) or any other answer: transient as far as the plugin can tell.
  if (status < 400) return { kind: "retry", afterMs: retryAfterMs };
  return { kind: "terminal", code: `http_${status}`, closesSegment: false };
}

/** A 2xx: applied; the EntryDto adds whether the server has finalised or detached the entry. */
async function applied(res: Response): Promise<SendOutcome> {
  const entry = (await res.json().catch(() => null)) as {
    agentFinalized?: unknown;
    agentDetached?: unknown;
    description?: unknown;
    taskId?: unknown;
  } | null;
  // An unreadable answer is applied all the same: it only adds the server state.
  const out: SendOutcome = {
    kind: "applied",
    created: res.status === 201,
    finalized: entry?.agentFinalized === true,
    detached: entry?.agentDetached === true,
  };
  // The entry's task and description: whether Tickr applied a rename (flusher/rename.ts).
  if (typeof entry?.description === "string" && (entry.taskId === null || entry.taskId === undefined || typeof entry.taskId === "string")) {
    out.entry = { description: entry.description, taskId: typeof entry.taskId === "string" ? entry.taskId : null };
  }
  return out;
}

export function createAgentApi(o: AgentApiOptions): AgentApi {
  const timeoutMs = o.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const now = o.now ?? Date.now;
  const doFetch = o.fetch ?? fetch;
  const base = o.baseUrl; // normalised by readPluginConfig: no trailing slash

  async function send(
    route: Route,
    method: "GET" | "PUT",
    path: string,
    body: object | undefined,
    extra: Record<string, string>,
  ): Promise<{ res: Response; startedMs: number } | SendOutcome> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${o.apiKey}`,
      Accept: "application/json",
      "User-Agent": USER_AGENT,
      ...extra,
    };
    if (body !== undefined) headers["Content-Type"] = "application/json";
    const startedMs = now();
    let res: Response;
    try {
      res = await doFetch(base + path, {
        method,
        headers,
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(timeoutMs),
        redirect: "manual",
      });
    } catch {
      return { kind: "retry", afterMs: null }; // network failure or timeout
    }
    if (res.status >= 200 && res.status < 300) return { res, startedMs };
    const retryAfter = parseRetryAfter(res.headers.get("retry-after"), now());
    const problem = await readProblem(res);
    return classify(route, res.status, problem, retryAfter);
  }

  const id = (value: string) => encodeURIComponent(value);

  return {
    async me() {
      const out = await send("me", "GET", "/api/v1/me", undefined, {});
      if (!("res" in out)) return out;
      const endedMs = now();
      try {
        const body = (await out.res.json()) as { workspace?: { id?: unknown; name?: unknown }; serverTime?: unknown } | null;
        const workspaceId = body?.workspace?.id;
        const serverTime = body?.serverTime;
        if (typeof workspaceId !== "string" || typeof serverTime !== "string" || Number.isNaN(Date.parse(serverTime))) {
          return { kind: "retry", afterMs: null };
        }
        const name = body?.workspace?.name;
        return {
          workspaceId,
          workspaceName: typeof name === "string" ? name : "",
          serverTime,
          localTime: new Date((out.startedMs + endedMs) / 2).toISOString(),
        };
      } catch {
        return { kind: "retry", afterMs: null };
      }
    },
    async putSegment(segmentId, body, agent) {
      const out = await send("segment", "PUT", `/api/v1/agent-segments/${id(segmentId)}`, body, { [AGENT_HEADER]: agent });
      return "res" in out ? applied(out.res) : out;
    },
    async putUsage(entryId, body) {
      const out = await send("usage", "PUT", `/api/v1/entries/${id(entryId)}/agent-usage`, body, {});
      return "res" in out ? applied(out.res) : out;
    },
  };
}
