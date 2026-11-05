import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isLinked, linkKey, MAX_LINKS, recordLink } from "../../hook-src/consent.js";
import { NOT_LINKED_MESSAGE } from "../../hook-src/intake.js";
import { findMapping } from "../../hook-src/mapping.js";
import { main } from "../../hook-src/main.js";
import { cleanTempDirs, hookInput, instanceFor, linkCheckout, pluginEnv, tempDir, WS, writeMapping } from "./helpers/env.js";

afterEach(() => cleanTempDirs());

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
    expect(started.out).toBe(JSON.stringify({ systemMessage: NOT_LINKED_MESSAGE }));
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

  it("keeps the most recent links only, and stores hashes, never paths or ids", () => {
    const data = tempDir();
    for (let i = 0; i < MAX_LINKS + 5; i += 1) recordLink(data, data, `hash-${i}`);
    expect(isLinked(data, data, "hash-0")).toBe(false);
    expect(isLinked(data, data, `hash-${MAX_LINKS + 4}`)).toBe(true);
  });

  it("an unreadable links file means not linked", () => {
    const data = tempDir();
    writeFileSync(join(data, "linked.json"), "{ broken");
    expect(isLinked(data, data, "h")).toBe(false);
    expect(recordLink(data, data, "h")).toBe(true);
    expect(isLinked(data, data, "h")).toBe(true);
  });
});

function readdirOf(dir: string): string[] {
  return readdirSync(dir);
}
function hashOf(cwd: string): string {
  const found = findMapping(cwd);
  if (found === null || "invalid" in found) throw new Error("no mapping");
  return found.hash;
}
