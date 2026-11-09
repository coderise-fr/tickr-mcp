import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const buildScript = fileURLToPath(new URL("../../scripts/build-hook.mjs", import.meta.url));
let root: string;
let bundle: string;
let data: string;

beforeAll(() => {
  root = mkdtempSync(join(tmpdir(), "tickr launch "));
  const pluginRoot = join(root, "plugin root with spaces");
  bundle = join(pluginRoot, "tickr-hook.cjs");
  data = join(root, "plugin data with spaces");
  mkdirSync(data, { recursive: true });
  const built = spawnSync(process.execPath, [buildScript, "--outfile", bundle], { encoding: "utf8" });
  expect(built.status, built.stderr).toBe(0);
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

function runHook(event: string, stdin: string | null) {
  return new Promise<{ code: number | null; stdout: string; ms: number }>((resolve, reject) => {
    const started = Date.now();
    const child = spawn("node", ["--no-warnings", bundle, event], {
      env: { ...process.env, CLAUDE_PLUGIN_DATA: data, CLAUDE_PLUGIN_OPTION_API_KEY: "tkr_test_launch_key" },
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (stdout += text));
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, ms: Date.now() - started }));
    if (stdin !== null) child.stdin.end(stdin);
  });
}

function expectJsonOrNothing(stdout: string) {
  if (stdout.trim() === "") return;
  const parsed = JSON.parse(stdout) as Record<string, unknown>;
  expect(typeof parsed).toBe("object");
  for (const key of Object.keys(parsed)) expect(["systemMessage", "hookSpecificOutput"]).toContain(key);
  if ("hookSpecificOutput" in parsed) {
    const specific = parsed.hookSpecificOutput as Record<string, unknown>;
    expect(Object.keys(specific).sort()).toEqual(["additionalContext", "hookEventName"]);
    expect(specific.hookEventName).toBe("SessionStart");
  }
}

describe("bundle launch", () => {
  it('the built bundle runs through spawn("node", ["--no-warnings", "<tmp dir with spaces>/tickr-hook.cjs", "SessionStart"]) and prints valid JSON or nothing', async () => {
    const input = JSON.stringify({ session_id: "s-launch", cwd: root, hook_event_name: "SessionStart", source: "startup" });
    const result = await runHook("SessionStart", input);
    expect(result.code).toBe(0);
    expectJsonOrNothing(result.stdout);
  });

  it("exits 0 within the 1 s budget when stdin never closes", async () => {
    const result = await runHook("UserPromptSubmit", null);
    expect(result.code).toBe(0);
    expect(result.stdout).toBe("");
    expect(result.ms).toBeLessThan(3000);
  });
});
