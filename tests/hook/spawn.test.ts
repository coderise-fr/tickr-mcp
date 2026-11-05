import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { FALLBACK_DIR } from "../../hook-src/fallback.js";
import { RELEASED_HEARTBEAT } from "../../hook-src/flusher/owner.js";
import { spawnFlusher } from "../../hook-src/spawn.js";
import { instanceDir, instanceId } from "../../hook-src/identity.js";
import { DB_FILE } from "../../hook-src/store/db.js";
import { problem, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, hookInput, KEY, listJson, pluginEnv, rawDb, tempDir, WS, writeMapping } from "./helpers/env.js";

afterAll(() => cleanTempDirs());

async function until<T>(probe: () => T | undefined, timeoutMs = 10_000): Promise<T> {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = probe();
    if (value !== undefined) return value;
    if (Date.now() > end) throw new Error("condition not met in time");
    await delay(50);
  }
}

describe("spawnFlusher", () => {
  it("starts the bundle detached as `flush <instanceDir>` with the key in the environment only", async () => {
    const root = tempDir("tickr spawn ");
    const instance = join(root, "data with spaces", "instance");
    const report = join(root, "report.json");
    const fake = join(root, "fake bundle.cjs");
    writeFileSync(
      fake,
      [
        'const { writeFileSync } = require("node:fs");',
        `writeFileSync(${JSON.stringify(report)}, JSON.stringify({`,
        "  args: process.argv.slice(2),",
        "  execArgv: process.execArgv,",
        `  keyInEnv: process.env.CLAUDE_PLUGIN_OPTION_API_KEY === ${JSON.stringify(KEY)},`,
        "}));",
      ].join("\n"),
    );

    spawnFlusher(fake, instance, { ...process.env, ...pluginEnv(join(root, "data with spaces")) });

    const text = await until(() => (existsSync(report) ? readFileSync(report, "utf8") : undefined));
    expect(JSON.parse(text)).toEqual({ args: ["flush", instance], execArgv: ["--no-warnings"], keyInEnv: true });
    expect(text).not.toContain(KEY);
  });
});

describe("hook to flusher, through the built bundle", () => {
  const buildScript = fileURLToPath(new URL("../../scripts/build-hook.mjs", import.meta.url));
  let bundle: string;
  // A local Tickr that is busy: the flusher's GET /me fails at once, and nothing is sent.
  let tickr: Awaited<ReturnType<typeof startServer>>;
  beforeEach(async () => {
    tickr = await startServer(() => problem(503, "service_unavailable", "workspace_busy"));
  });
  afterEach(() => tickr.close());

  beforeAll(() => {
    bundle = join(tempDir("tickr bundle "), "plugin root", "tickr-hook.cjs");
    const built = spawnSync(process.execPath, [buildScript, "--outfile", bundle], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
  });

  function runHook(event: string, cwd: string, data: string) {
    return new Promise<{ code: number | null; stdout: string }>((resolve, reject) => {
      const child = spawn(process.execPath, ["--no-warnings", bundle, event], {
        env: { ...process.env, ...pluginEnv(data, { CLAUDE_PLUGIN_OPTION_BASE_URL: tickr.baseUrl }) },
        stdio: ["pipe", "pipe", "ignore"],
      });
      let stdout = "";
      child.stdout.setEncoding("utf8").on("data", (t: string) => (stdout += t));
      child.on("error", reject);
      child.on("close", (code) => resolve({ code, stdout }));
      child.stdin.end(JSON.stringify(hookInput(event, cwd)));
    });
  }

  it("the first hook of an instance writes a fallback file and starts a flusher that imports it", async () => {
    const root = tempDir("tickr e2e ");
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "plugin data");
    const dir = instanceDir(data, instanceId(tickr.baseUrl, WS, KEY));

    const result = await runHook("UserPromptSubmit", cwd, data);
    expect(result).toEqual({ code: 0, stdout: "" });

    const owner = await until(() => {
      if (!existsSync(join(dir, DB_FILE)) || listJson(join(dir, FALLBACK_DIR)).length > 0) return undefined;
      const db = rawDb(join(dir, DB_FILE));
      try {
        const row = db.prepare("SELECT heartbeat FROM owner").get() as { heartbeat: string } | undefined;
        return row?.heartbeat === RELEASED_HEARTBEAT ? row : undefined;
      } catch {
        return undefined;
      } finally {
        db.close();
      }
    });
    expect(owner.heartbeat).toBe(RELEASED_HEARTBEAT);

    const db = rawDb(join(dir, DB_FILE));
    expect(db.prepare("SELECT type FROM events").all()).toEqual([{ type: "UserPromptSubmit" }]);
    db.close();

    // The store now exists: the next hook journals directly, and starts a new flusher.
    expect(await runHook("Stop", cwd, data)).toEqual({ code: 0, stdout: "" });
    const types = await until(() => {
      const d = rawDb(join(dir, DB_FILE));
      try {
        const rows = d.prepare("SELECT type FROM events ORDER BY seq").all() as { type: string }[];
        return rows.length === 2 ? rows.map((r) => r.type) : undefined;
      } catch {
        return undefined; // locked by the flusher for a moment
      } finally {
        d.close();
      }
    });
    expect(types).toEqual(["UserPromptSubmit", "Stop"]);
    // Let the second flusher finish before the directory is removed.
    await until(() => {
      const d = rawDb(join(dir, DB_FILE));
      try {
        const row = d.prepare("SELECT generation, heartbeat FROM owner").get() as { generation: number; heartbeat: string };
        return row.generation === 2 && row.heartbeat === RELEASED_HEARTBEAT ? true : undefined;
      } catch {
        return undefined; // locked by the flusher for a moment
      } finally {
        d.close();
      }
    });
  });
});
