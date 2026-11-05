// The flusher outlives the hook that started it, and the hook that process's parent ran: Claude
// Code runs a hook, the hook spawns the detached flusher and exits, Claude Code goes on (or quits).
// Runs in the CI matrix on Linux, Windows and macOS.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RELEASED_HEARTBEAT } from "../../hook-src/flusher/owner.js";
import { SEGMENT_BODY_KEYS } from "../../hook-src/flusher/revisions.js";
import { DB_FILE } from "../../hook-src/store/db.js";
import { PLUGIN_VERSION } from "../../hook-src/version.js";
import { json, type RecordedRequest, startServer } from "../helpers/httpServer.js";
import { instanceDir, instanceId } from "../../hook-src/identity.js";
import { PROJECT, rawDb, WS } from "./helpers/env.js";

const buildScript = fileURLToPath(new URL("../../scripts/build-hook.mjs", import.meta.url));
const hooksJson = fileURLToPath(new URL("../../plugins/tickr/hooks/hooks.json", import.meta.url));
const KEY = "tkr_test_survival_key_0001";

// The parent stands for Claude Code: it runs one hook (exec form, stdin JSON), prints the
// hook's exit code and output, and exits at once.
const PARENT = `
const { spawn } = require("node:child_process");
const [command, args, input] = JSON.parse(process.argv[2]);
const hook = spawn(command, args, { stdio: ["pipe", "pipe", "ignore"], env: process.env });
let out = "";
hook.stdout.setEncoding("utf8").on("data", (t) => (out += t));
hook.on("close", (code) => {
  process.stdout.write(JSON.stringify({ code, out }));
  process.exit(0);
});
hook.stdin.end(input);
`;

let root: string;
let pluginRoot: string;
let data: string;
let repo: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tickr survival "));
  pluginRoot = join(root, "plugin root with spaces");
  data = join(root, "plugin data with spaces");
  repo = join(root, "linked repo");
  mkdirSync(data, { recursive: true });
  mkdirSync(repo, { recursive: true });
  writeFileSync(join(repo, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: PROJECT }));
  writeFileSync(join(root, "parent.cjs"), PARENT);
  const built = spawnSync(process.execPath, [buildScript, "--outfile", join(pluginRoot, "hooks", "dist", "tickr-hook.cjs")], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 }));

/** The exec-form command of hooks.json for this event, with CLAUDE_PLUGIN_ROOT substituted. */
function hookCommand(event: string): { command: string; args: string[] } {
  const file = JSON.parse(readFileSync(hooksJson, "utf8")) as { hooks: Record<string, { hooks: { command: string; args: string[] }[] }[]> };
  const { command, args } = file.hooks[event]![0]!.hooks[0]!;
  return { command, args: args.map((a) => a.replace("${CLAUDE_PLUGIN_ROOT}", pluginRoot)) };
}

function runParent(event: string, input: object, env: NodeJS.ProcessEnv) {
  const { command, args } = hookCommand(event);
  return new Promise<{ code: number | null; out: string; exitedAt: number }>((resolve, reject) => {
    const parent = spawn(process.execPath, [join(root, "parent.cjs"), JSON.stringify([command, args, JSON.stringify(input)])], {
      env,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    parent.stdout.setEncoding("utf8").on("data", (t: string) => (stdout += t));
    parent.on("error", reject);
    parent.on("close", () => {
      const exitedAt = Date.now();
      try {
        const { code, out } = JSON.parse(stdout) as { code: number | null; out: string };
        resolve({ code, out, exitedAt });
      } catch (error) {
        reject(new Error(`parent printed ${JSON.stringify(stdout)}: ${String(error)}`));
      }
    });
  });
}

async function waitFor<T>(probe: () => T | undefined, timeoutMs: number): Promise<T | undefined> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined || Date.now() > end) return value;
    await new Promise((r) => setTimeout(r, 100));
  }
}

describe("flusher survival", () => {
  it("a parent process runs the hook, which spawns the flusher, then the parent exits ⇒ the flusher still delivers its PUT within 10 s (exec form, spaces in CLAUDE_PLUGIN_ROOT and CLAUDE_PLUGIN_DATA)", async () => {
    const putAt: number[] = [];
    // /me answers late, so the flusher surely works on after the parent has exited.
    const server = await startServer((req: RecordedRequest) => {
      if (req.url === "/api/v1/me") {
        return {
          ...json(200, { user: { id: "u", displayName: "D", email: "d@example.test", timezone: "UTC" }, workspace: { id: WS, name: "Acme", timezone: "UTC" }, role: "workspace_user", serverTime: new Date().toISOString() }),
          delayMs: 1500,
        };
      }
      putAt.push(Date.now());
      return json(201, { id: "e", agentFinalized: false, agentDetached: false });
    });
    try {
      const env: NodeJS.ProcessEnv = {
        ...process.env,
        CLAUDE_PLUGIN_ROOT: pluginRoot,
        CLAUDE_PLUGIN_DATA: data,
        CLAUDE_PLUGIN_OPTION_API_KEY: KEY,
        CLAUDE_PLUGIN_OPTION_BASE_URL: server.baseUrl,
      };
      // The transcript names the Claude Code version: the creation request carries it.
      const transcript = join(root, "s-survival.jsonl");
      const line = { type: "user", timestamp: new Date().toISOString(), sessionId: "s-survival", version: "2.1.300", message: { role: "user", content: "<redacted>" } };
      writeFileSync(transcript, `${JSON.stringify(line)}\n`);
      const started = Date.now();
      const input = { session_id: "s-survival", transcript_path: transcript, cwd: repo, hook_event_name: "UserPromptSubmit", prompt_id: "p-1" };
      const parent = await runParent("UserPromptSubmit", input, env);
      expect(parent.code).toBe(0);
      expect(parent.out).toBe("");

      const put = await waitFor(() => server.requests.find((r) => r.method === "PUT"), 10_000);
      expect(put, "no PUT within 10 s").toBeDefined();
      expect(putAt[0]! - started).toBeLessThan(10_000);
      expect(putAt[0]!).toBeGreaterThan(parent.exitedAt);

      expect(put!.url).toMatch(/^\/api\/v1\/agent-segments\/[0-9a-f-]{36}$/);
      expect(put!.headers.authorization).toBe(`Bearer ${KEY}`);
      expect(put!.headers["tickr-agent"]).toBe("claude-code/2.1.300");
      expect(put!.headers["user-agent"]).toBe(`tickr-plugin/${PLUGIN_VERSION}`);
      const body = JSON.parse(put!.body) as Record<string, unknown>;
      // The transcript was read to its end: the latest complete usage set (no message yet) goes along.
      expect(Object.keys(body)).toEqual([...SEGMENT_BODY_KEYS]);
      expect(body).toMatchObject({ revision: 1, agentSessionId: "s-survival", projectId: PROJECT, working: true, final: false, usage: [] });

      // The flusher then gives the instance up and exits (so its files can be removed).
      const db = join(instanceDir(data, instanceId(server.baseUrl, WS, KEY)), DB_FILE);
      const released = await waitFor(() => {
        const raw = rawDb(db);
        try {
          const owner = raw.prepare("SELECT heartbeat FROM owner").get() as { heartbeat: string } | undefined;
          return owner?.heartbeat === RELEASED_HEARTBEAT ? true : undefined;
        } catch {
          return undefined; // locked by the flusher for a moment
        } finally {
          raw.close();
        }
      }, 70_000);
      expect(released).toBe(true);
    } finally {
      await server.close();
    }
  }, 90_000);
});
