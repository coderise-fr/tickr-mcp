// D14 / §7.7: a full session whose prompts, responses, tool inputs and outputs, cwd, branch,
// transcript paths and key all carry a SENTINEL marker goes through the real hook entry point and
// the real flusher against a local Tickr. Nothing of it may leave the machine nor reach the debug
// log, /tickr:status or a message shown to the user; each request body has exactly the contract keys.
import { appendFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { Readable } from "node:stream";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { bodyPropertiesOf } from "../../src/api/contract.js";
import type { UsageRow } from "../../hook-src/flusher/revisions.js";
import { DEBUG_FILE, debugLine, type DebugRecord } from "../../hook-src/flusher/run.js";
import { instanceDir, instanceId } from "../../hook-src/identity.js";
import { main } from "../../hook-src/main.js";
import { json, type RecordedRequest, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, tempDir, WS, writeMapping } from "./helpers/env.js";

interface Step {
  hook?: Record<string, unknown>;
  transcript?: Record<string, unknown>;
  agentTranscript?: Record<string, unknown>;
}
const FIXTURE = JSON.parse(readFileSync(new URL("./fixtures/privacy-session.json", import.meta.url), "utf8")) as { sessionId: string; steps: Step[] };
const KEY = "tkr_test_SENTINEL";
const ENTRY = "0190f0c0-4444-7000-8000-0000000000e1";
const HEX64 = /[0-9a-f]{64}/i;
const DEBUG_KEYS = new Set(["at", "step", "stage", "point", "outcome", "generation", "pass", "dueInMs", "ms", "pendingRevisions", "terminalItems"] satisfies (keyof DebugRecord | "at")[]);

let root: string;
let cwd: string;
let data: string;
let instance: string;
let server: Awaited<ReturnType<typeof startServer>>;
const messages: string[] = [];
let status = "";

const pause = (ms: number) => new Promise((r) => setTimeout(r, ms));

function fill(value: unknown, vars: Record<string, string>): unknown {
  return JSON.parse(JSON.stringify(value).replace(/\{\{(\w+)\}\}/g, (_m, name: string) => JSON.stringify(vars[name]).slice(1, -1)));
}

async function hook(env: NodeJS.ProcessEnv, input: Record<string, unknown>): Promise<void> {
  const write = (text: string) => messages.push(text);
  await main([String(input.hook_event_name)], env, { stdin: Readable.from([JSON.stringify(input)]), deadlineMs: Date.now() + 5000, write });
}

/** Everything a request shows to the network, the Authorization header aside. */
function visible(r: RecordedRequest): string {
  const headers = Object.fromEntries(Object.entries(r.headers).filter(([k]) => k !== "authorization"));
  return [r.method, r.url, JSON.stringify(headers), r.body].join("\n");
}

function expectNothingPrivate(text: string, what: string): void {
  expect(text, what).not.toMatch(/sentinel/i);
  expect(text, what).not.toMatch(HEX64);
  for (const local of [root, cwd, data, instance, KEY, root.replace(/\\/g, "/"), root.replace(/\\/g, "\\\\")]) expect(text.includes(local), `${what}: ${local}`).toBe(false);
}

beforeAll(async () => {
  root = tempDir("tickr privacy ");
  cwd = writeMapping(join(root, "SENTINEL_CWD repo"));
  data = join(root, "data");
  const transcript = join(root, "projects", "-SENTINEL_PROJECT", `${FIXTURE.sessionId}.jsonl`);
  const agentTranscript = join(dirname(transcript), FIXTURE.sessionId, "subagents", "agent-a1b2c3d4e5.jsonl");
  for (const f of [transcript, agentTranscript]) {
    mkdirSync(dirname(f), { recursive: true });
    writeFileSync(f, "");
  }

  server = await startServer((req) => {
    if (req.url === "/api/v1/me") {
      return json(200, { user: { id: "u-1" }, workspace: { id: WS, name: "Acme" }, role: "workspace_user", serverTime: new Date().toISOString() });
    }
    if (req.url.startsWith("/api/v1/agent-segments/")) return json(201, { id: "x", origin: "agent_session", agentFinalized: false, agentDetached: false });
    return json(200, { id: ENTRY, origin: "agent", agentFinalized: false, agentDetached: false });
  });
  instance = instanceDir(data, instanceId(server.baseUrl, WS, KEY));
  const env: NodeJS.ProcessEnv = {
    CLAUDE_PLUGIN_DATA: data,
    CLAUDE_PLUGIN_OPTION_API_KEY: KEY,
    CLAUDE_PLUGIN_OPTION_BASE_URL: server.baseUrl,
    TICKR_PLUGIN_DEBUG: "1",
  };

  const vars = { cwd, transcript, agentTranscript };
  const common = { session_id: FIXTURE.sessionId, transcript_path: transcript, cwd };
  for (const step of FIXTURE.steps) {
    await pause(5); // strictly increasing timestamps
    const now = new Date().toISOString();
    const line = (l: Record<string, unknown>) =>
      `${JSON.stringify({ ...l, timestamp: now, sessionId: FIXTURE.sessionId, version: "2.1.300", cwd, gitBranch: "feature/SENTINEL_BRANCH", uuid: `u-${now}` })}\n`;
    if (step.transcript) appendFileSync(transcript, line(step.transcript));
    if (step.agentTranscript) appendFileSync(agentTranscript, line(step.agentTranscript));
    if (step.hook) await hook(env, { ...common, ...(fill(step.hook, { ...vars, now }) as Record<string, unknown>) });
  }
  // The flusher, as the hooks' spawn would run it (the key in the environment, never in argv).
  await main(["flush", instance], env);

  // Messages a user can see in other checkouts: not linked, and an invalid .tickr.json.
  const untracked = join(root, "SENTINEL_UNTRACKED");
  mkdirSync(untracked, { recursive: true });
  await hook(env, { session_id: "s-other", cwd: untracked, hook_event_name: "SessionStart", source: "startup" });
  const invalid = join(root, "SENTINEL_INVALID");
  mkdirSync(invalid, { recursive: true });
  writeFileSync(join(invalid, ".tickr.json"), "{ SENTINEL_NOT_JSON");
  await hook(env, { session_id: "s-other-2", cwd: invalid, hook_event_name: "SessionStart", source: "startup" });

  await main(["status", data], env, { stdin: Readable.from([]), deadlineMs: Date.now() + 1000, write: (t) => (status += t) });
}, 60_000);

afterAll(async () => {
  await server.close();
  cleanTempDirs();
});

describe("privacy allow-list (D14)", () => {
  it("the session reached Tickr: the workspace check, its segment and its delegated entry, with its tokens", () => {
    const puts = server.requests.filter((r) => r.method === "PUT");
    expect(server.requests[0]!.url).toBe("/api/v1/me");
    expect(puts.some((r) => r.url.startsWith("/api/v1/agent-segments/"))).toBe(true);
    expect(puts.filter((r) => r.url === `/api/v1/entries/${ENTRY}/agent-usage`)).toHaveLength(1);
    const final = puts.map((r) => JSON.parse(r.body) as { final?: boolean; usage?: UsageRow[] }).find((b) => b.final === true);
    expect(final?.usage?.map((u) => [u.model, u.outputTokens])).toEqual([
      ["claude-haiku-4-5", 8],
      ["claude-opus-4-7", 42],
    ]);
  });

  it("no sentinel, cwd, path, key or 64-hex instance id in any request (URL, headers but Authorization, body)", () => {
    expect(server.requests.length).toBeGreaterThan(2);
    for (const r of server.requests) {
      expectNothingPrivate(visible(r), `${r.method} ${r.url}`);
      expect(r.headers.authorization).toBe(`Bearer ${KEY}`);
    }
  });

  it("each request body has exactly the contract keys", () => {
    for (const r of server.requests) {
      if (r.method === "GET") {
        expect(r.body).toBe("");
        continue;
      }
      const keys = Object.keys(JSON.parse(r.body) as object);
      const route = r.url.startsWith("/api/v1/agent-segments/") ? "/api/v1/agent-segments/{segmentId}" : "/api/v1/entries/{id}/agent-usage";
      expect(keys).toEqual([...bodyPropertiesOf("put", route)]);
    }
  });

  it("the debug log holds allow-listed fields only, and nothing private", () => {
    const text = readFileSync(join(instance, DEBUG_FILE), "utf8");
    const lines = text.trim().split("\n");
    expect(lines.length).toBeGreaterThan(5);
    for (const l of lines) for (const k of Object.keys(JSON.parse(l) as object)) expect(DEBUG_KEYS).toContain(k);
    expect(lines.map((l) => (JSON.parse(l) as { step: string }).step)).toContain("end");
    expectNothingPrivate(text, "debug log");
  });

  it("a debug line keeps only allow-listed fields with their expected values", () => {
    const at = new Date("2026-11-05T10:00:00.000Z");
    const rec = { step: "stage", stage: "SENTINEL_STAGE", point: "C:/SENTINEL/path", outcome: "SENTINEL", ms: 1.6, dueInMs: Number.NaN, note: "SENTINEL_NOTE" };
    expect(JSON.parse(debugLine(rec as unknown as DebugRecord, at))).toEqual({ at: at.toISOString(), step: "stage", ms: 2 });
    expect(debugLine({ step: "SENTINEL" } as unknown as DebugRecord, at)).toBe("");
  });

  it("/tickr:status shows nothing private", () => {
    expect(status).toMatch(/Acme/);
    expectNothingPrivate(status, "status");
  });

  it("no message shown to the user carries anything private", () => {
    expect(messages.length).toBeGreaterThanOrEqual(2); // untracked + invalid mapping
    for (const m of messages) expectNothingPrivate(m, "systemMessage");
  });
});
