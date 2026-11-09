import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Readable } from "node:stream";
import { fileURLToPath } from "node:url";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { isLinked, isLinkKeyActive, linkKey, LINKS_DIR, MAX_LINKS, recordLink } from "../../hook-src/consent.js";
import { NOT_LINKED_MESSAGE, NOT_LINKED_NOTE } from "../../hook-src/intake.js";
import { findMapping } from "../../hook-src/mapping.js";
import { main } from "../../hook-src/main.js";
import { cleanTempDirs, hookInput, instanceFor, linkCheckout, pluginEnv, tempDir, WS, writeMapping } from "./helpers/env.js";

afterEach(() => cleanTempDirs());

const buildScript = fileURLToPath(new URL("../../scripts/build-hook.mjs", import.meta.url));

const run = async (argv: string[], env: NodeJS.ProcessEnv, input?: unknown) => {
  const out: string[] = [];
  const code = await main(argv, env, {
    stdin: Readable.from(input === undefined ? [] : [JSON.stringify(input)]),
    deadlineMs: Date.now() + 1000,
    write: (text) => void out.push(text),
  });
  return { code, out: out.join("") };
};

describe("consent to a .tickr.json", () => {
  it("a mapping that arrived with a clone tracks nothing and says so once, at SessionStart", async () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "cloned repo"));
    const data = join(root, "data");
    const started = await run(["SessionStart"], pluginEnv(data), hookInput("SessionStart", cwd, { source: "startup" }));
    expect(started.out).toBe(JSON.stringify({ systemMessage: NOT_LINKED_MESSAGE, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: NOT_LINKED_NOTE } }));
    const prompt = await run(["UserPromptSubmit"], pluginEnv(data), hookInput("UserPromptSubmit", cwd));
    expect(prompt).toEqual({ code: 0, out: "" });
    expect(() => readdirOf(instanceFor(data))).toThrow(); // no instance directory, no store
  });

  it("`accept` links the checkout, after which its hooks journal events", async () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "data");
    const accepted = await run(["accept", data, cwd], pluginEnv(data));
    expect(accepted.out).toMatch(/linked on this machine/);
    expect(accepted.out).not.toContain(WS);
    expect(isLinked(data, cwd, hashOf(cwd))).toBe(true);
    const prompt = await run(["UserPromptSubmit"], pluginEnv(data), hookInput("UserPromptSubmit", cwd));
    expect(prompt.code).toBe(0);
    expect(readdirOf(instanceFor(data))).toEqual(expect.arrayContaining(["instance.json", "fallback"])); // no store yet: the first event goes to a fallback file
  });

  it("a mapping changed after the link (a pull) is no longer linked", async () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "data");
    linkCheckout(data, cwd);
    writeFileSync(join(cwd, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: "9f8e7d6c-5b4a-4c3d-8e2f-1a0b9c8d7e6f" }));
    const prompt = await run(["UserPromptSubmit"], pluginEnv(data), hookInput("UserPromptSubmit", cwd));
    expect(prompt.out).toBe("");
    expect(() => readdirOf(instanceFor(data))).toThrow();
  });

  it("the same file in another directory is not linked", () => {
    const root = tempDir();
    const a = writeMapping(join(root, "a"));
    const b = writeMapping(join(root, "b"));
    const data = join(root, "data");
    linkCheckout(data, a);
    expect(isLinked(data, b, hashOf(b))).toBe(false);
    expect(linkKey(a, "h")).not.toBe(linkKey(b, "h"));
  });

  it("accept refuses a missing or invalid mapping and links nothing", async () => {
    const root = tempDir();
    const data = join(root, "data");
    const empty = join(root, "empty");
    mkdirSync(empty);
    expect((await run(["accept", data, empty], pluginEnv(data))).out).toMatch(/no \.tickr\.json found/);
    writeFileSync(join(empty, ".tickr.json"), "{ not json");
    expect((await run(["accept", data, empty], pluginEnv(data))).out).toMatch(/not valid JSON.*Nothing was linked/);
  });

  it("each link is one empty file named by its key: no path, no id", async () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "data");
    await run(["accept", data, cwd], pluginEnv(data));
    const key = linkKey(cwd, hashOf(cwd));
    expect(readdirSync(data)).toEqual([LINKS_DIR]);
    expect(readdirSync(join(data, LINKS_DIR))).toEqual([key]);
    expect(readFileSync(join(data, LINKS_DIR, key), "utf8")).toBe("");
    expect(isLinkKeyActive(data, key)).toBe(true);
    // Deleting the file revokes the link.
    rmSync(join(data, LINKS_DIR, key));
    expect(isLinked(data, cwd, hashOf(cwd))).toBe(false);
  });

  it("isLinkKeyActive accepts only a link key", () => {
    const data = tempDir();
    mkdirSync(join(data, LINKS_DIR, "sub"), { recursive: true });
    expect(isLinkKeyActive(data, "sub")).toBe(false);
    expect(isLinkKeyActive(data, "..")).toBe(false);
    expect(isLinkKeyActive(data, "")).toBe(false);
  });

  it("keeps MAX_LINKS links at most: the least recently linked one goes", () => {
    const data = tempDir();
    const dir = join(data, LINKS_DIR);
    mkdirSync(dir);
    const old = Date.now() / 1000 - 10 * 86_400;
    const keys = Array.from({ length: MAX_LINKS }, (_, i) => linkKey(data, `hash-${i}`));
    keys.forEach((key, i) => {
      writeFileSync(join(dir, key), "");
      utimesSync(join(dir, key), old + i, old + i);
    });
    expect(recordLink(data, data, "hash-new")).toBe(true);
    expect(readdirSync(dir)).toHaveLength(MAX_LINKS);
    expect(isLinked(data, data, "hash-0")).toBe(false);
    expect(isLinked(data, data, "hash-1")).toBe(true);
    expect(isLinked(data, data, "hash-new")).toBe(true);
    // Linking an old one again makes it the most recent: the next link drops another one.
    expect(recordLink(data, data, "hash-1")).toBe(true);
    expect(recordLink(data, data, "hash-newer")).toBe(true);
    expect(isLinked(data, data, "hash-1")).toBe(true);
    expect(isLinked(data, data, "hash-2")).toBe(false);
    expect(readdirSync(dir)).toHaveLength(MAX_LINKS);
  });

  it("links recorded one after the other within a burst never replace one another", async () => {
    const data = tempDir();
    const results = await Promise.all(Array.from({ length: 50 }, async (_, i) => recordLink(data, data, `burst-${i}`)));
    expect(results.every(Boolean)).toBe(true);
    for (let i = 0; i < 50; i += 1) expect(isLinked(data, data, `burst-${i}`)).toBe(true);
  });

  it("a stray file where the links directory belongs: not linked, and the link fails", () => {
    const data = tempDir();
    writeFileSync(join(data, LINKS_DIR), "x");
    expect(isLinked(data, data, "h")).toBe(false);
    expect(recordLink(data, data, "h")).toBe(false);
  });
});

describe("concurrent `accept` processes", () => {
  let bundleDir: string;
  let bundle: string;
  beforeAll(() => {
    bundleDir = mkdtempSync(join(tmpdir(), "tickr-accept-"));
    bundle = join(bundleDir, "tickr-hook.cjs");
    const built = spawnSync(process.execPath, [buildScript, "--outfile", bundle], { encoding: "utf8" });
    expect(built.status, built.stderr).toBe(0);
  });
  afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

  it("8 checkouts accepted at once by 8 processes of the bundle all end up linked", async () => {
    const root = tempDir();
    const data = join(root, "data");
    const checkouts = Array.from({ length: 8 }, (_, i) => writeMapping(join(root, `repo-${i}`)));
    const outputs = await Promise.all(checkouts.map((cwd) => accept(bundle, data, cwd)));
    for (const out of outputs) expect(out).toMatch(/linked on this machine/);
    for (const cwd of checkouts) expect(isLinked(data, cwd, hashOf(cwd))).toBe(true);
    expect(readdirSync(join(data, LINKS_DIR))).toHaveLength(8);
  });
});

function accept(bundle: string, data: string, cwd: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, ["--no-warnings", bundle, "accept", data, cwd], { stdio: ["ignore", "pipe", "pipe"] });
    let out = "";
    child.stdout.setEncoding("utf8").on("data", (text: string) => (out += text));
    child.on("error", reject);
    child.on("close", () => resolve(out));
  });
}

function readdirOf(dir: string): string[] {
  return readdirSync(dir);
}
function hashOf(cwd: string): string {
  const found = findMapping(cwd);
  if (found === null || "invalid" in found) throw new Error("no mapping");
  return found.hash;
}
