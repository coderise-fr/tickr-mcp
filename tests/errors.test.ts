import { describe, expect, it } from "vitest";
import {
  ApiHttpError, ApiProblemError, NetworkError, ToolError, UnreadableResponseError, problemCode, toAgentMessage,
} from "../src/api/errors.js";

const ctx = { baseUrl: "https://t.example.com", isWrite: false };
const write = { ...ctx, isWrite: true };
const p = (status: number, code: string, detail?: string, extra: Partial<ConstructorParameters<typeof ApiProblemError>[0]> = {}) =>
  new ApiProblemError({ status, code, detail, correlationId: "corr-1", fieldErrors: [], ...extra });

describe("problemCode", () => {
  it("takes the last path segment of type", () => {
    expect(problemCode("https://docs.tickr.coderise.cloud/errors/conflict")).toBe("conflict");
    expect(problemCode(undefined)).toBe("unknown");
  });
});

describe("toAgentMessage", () => {
  it.each([
    [p(401, "unauthorized", "anything"), /rejected the API key.*Settings → API keys/],
    [p(403, "forbidden", "analyst_read_only"), /read-only/],
    [p(403, "forbidden", "not_project_member"), /not a member of this project.*list_projects/],
    [p(403, "forbidden", "workspace_mismatch"), /refused.*workspace_mismatch/],
    [p(404, "not_found", "Entry"), /Not found.*list_entries/],
    [p(409, "conflict", "timer_limit_reached"), /Three timers/],
    [p(409, "conflict", "entry_locked"), /submitted timesheet/],
    [p(409, "conflict", "Timer already stopped"), /already stopped/],
    [p(409, "conflict", "something else"), /Conflict: something else/],
    [p(429, "rate_limited", undefined, { retryAfterSeconds: 30 }), /Wait 30 seconds/],
    [p(500, "internal", "boom"), /server error \(HTTP 500\)/],
  ])("translates %o", (err, expected) => {
    expect(toAgentMessage(err, ctx)).toMatch(expected);
  });

  it("lists field errors on 422", () => {
    const err = p(422, "validation", "Validation failed", {
      fieldErrors: [{ field: "task_id", code: "invalid", message: "task_id does not belong to project_id" }],
    });
    expect(toAgentMessage(err, ctx)).toContain("task_id: task_id does not belong to project_id (invalid)");
  });

  it("appends the correlation id when present", () => {
    expect(toAgentMessage(p(404, "not_found"), ctx)).toContain("correlation id: corr-1");
    expect(toAgentMessage(p(404, "not_found", undefined, { correlationId: undefined }), ctx)).not.toContain("correlation");
  });

  it("warns that a failed write may have been applied", () => {
    expect(toAgentMessage(new NetworkError(false), write)).toMatch(/unreachable at https:\/\/t.example.com.*check with list_entries/);
    expect(toAgentMessage(new NetworkError(true), write)).toMatch(/30 seconds/);
    expect(toAgentMessage(p(503, "service_unavailable"), write)).toMatch(/check with list_entries/);
    expect(toAgentMessage(new NetworkError(false), ctx)).not.toMatch(/check with list_entries/);
  });

  it("warns on an unreadable answer to a write", () => {
    expect(toAgentMessage(new UnreadableResponseError(201), write))
      .toMatch(/\(HTTP 201\) could not be read.*may or may not have been applied/);
    expect(toAgentMessage(new UnreadableResponseError(undefined), ctx)).not.toMatch(/applied/);
  });

  it("reports a non-API response by status only", () => {
    expect(toAgentMessage(new ApiHttpError(502), ctx)).toBe(
      "Tickr answered HTTP 502 with a non-API response (often a proxy or gateway error).",
    );
  });

  it("passes ToolError messages through and hides unexpected errors", () => {
    expect(toAgentMessage(new ToolError("custom"), ctx)).toBe("custom");
    expect(toAgentMessage(new Error("internal secret"), ctx)).toBe("Unexpected error in the Tickr MCP server.");
    const onWrite = toAgentMessage(new TypeError("internal secret"), write);
    expect(onWrite).toMatch(/^Unexpected error in the Tickr MCP server\. The change may or may not have been applied/);
    expect(onWrite).not.toContain("internal secret");
  });

  it("bounds and cleans the API detail", () => {
    const msg = toAgentMessage(p(409, "conflict", "a\nb" + "x".repeat(500)), ctx);
    expect(msg).not.toContain("\n");
    expect(msg).toContain("…[truncated]");
  });

  it("adds the write hint only when the failed request was not a GET", () => {
    const hint = /may or may not have been applied/;
    for (const method of ["POST", "PATCH"]) {
      expect(toAgentMessage(new NetworkError(false, method), write)).toMatch(hint);
      expect(toAgentMessage(new UnreadableResponseError(201, method), write)).toMatch(hint);
      expect(toAgentMessage(new ApiHttpError(502, method), write)).toMatch(hint);
      expect(toAgentMessage(p(503, "service_unavailable", undefined, { method }), write)).toMatch(hint);
    }
    expect(toAgentMessage(new NetworkError(true, "GET"), write)).not.toMatch(hint);
    expect(toAgentMessage(new UnreadableResponseError(200, "GET"), write)).not.toMatch(hint);
    expect(toAgentMessage(new ApiHttpError(502, "GET"), write)).not.toMatch(hint);
    expect(toAgentMessage(p(503, "service_unavailable", undefined, { method: "GET" }), write)).not.toMatch(hint);
  });

  it("keeps the write hint for errors without a request method on a write tool", () => {
    expect(toAgentMessage(new UnreadableResponseError(undefined), write)).toMatch(/may or may not have been applied/);
    expect(toAgentMessage(new NetworkError(false), write)).toMatch(/may or may not have been applied/);
  });
});
