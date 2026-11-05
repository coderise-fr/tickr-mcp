import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { canonicalJson, DEFAULT_DESCRIPTION, findMapping, normalizeMapping } from "../../hook-src/mapping.js";

const WS = "6a0c1c9e-2f0e-4a51-9c3b-0d6b8f1e2a01";
const PROJECT = "1f6a2b3c-4d5e-4f60-8a71-92b3c4d5e6f7";
const TASK = "2a7b3c4d-5e6f-4071-8b82-a3c4d5e6f708";
const TAG_A = "3b8c4d5e-6f70-4182-9c93-b4d5e6f70819";
const TAG_B = "4c9d5e6f-7081-4293-8da4-c5e6f708192a";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

function repo(): string {
  const dir = mkdtempSync(join(tmpdir(), "tickr-mapping-"));
  dirs.push(dir);
  return dir;
}

describe("findMapping", () => {
  it("mapping found in a parent directory", () => {
    const root = repo();
    writeFileSync(join(root, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: PROJECT }));
    const deep = join(root, "src", "a", "b");
    mkdirSync(deep, { recursive: true });
    const found = findMapping(deep);
    expect(found).toMatchObject({ mapping: { workspaceId: WS, projectId: PROJECT } });
  });

  it("stops at the first .tickr.json walking up", () => {
    const root = repo();
    writeFileSync(join(root, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: PROJECT }));
    const child = join(root, "child");
    mkdirSync(child);
    writeFileSync(join(child, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: TASK }));
    expect(findMapping(child)).toMatchObject({ mapping: { projectId: TASK } });
  });

  it("returns null when no .tickr.json exists up to the root", () => {
    const root = repo();
    const deep = join(root, "x");
    mkdirSync(deep);
    // The temporary directory's ancestors are not expected to hold a .tickr.json.
    expect(findMapping(deep)).toBeNull();
  });

  it("invalid JSON ⇒ { invalid } and no throw", () => {
    const root = repo();
    writeFileSync(join(root, ".tickr.json"), '{ "workspace_id": "x", ');
    const found = findMapping(root);
    expect(found).toEqual({ invalid: expect.any(String) });
  });

  it("accepts a file saved with a UTF-8 byte order mark", () => {
    const root = repo();
    writeFileSync(join(root, ".tickr.json"), `﻿${JSON.stringify({ workspace_id: WS, project_id: PROJECT })}`);
    expect(findMapping(root)).toMatchObject({ mapping: { workspaceId: WS } });
  });

  it("a .tickr.json that is a directory ⇒ { invalid }", () => {
    const root = repo();
    mkdirSync(join(root, ".tickr.json"));
    expect(findMapping(root)).toEqual({ invalid: expect.any(String) });
  });

  it("same content with different key order or whitespace ⇒ same hash", () => {
    const a = repo();
    const b = repo();
    writeFileSync(
      join(a, ".tickr.json"),
      JSON.stringify({ workspace_id: WS, project_id: PROJECT, task_id: TASK, tag_ids: [TAG_A, TAG_B] }),
    );
    writeFileSync(
      join(b, ".tickr.json"),
      `{\n  "tag_ids": ["${TAG_B}", "${TAG_A}", "${TAG_B}"],\r\n  "task_id": "${TASK}",\n\t"project_id": "${PROJECT}", "workspace_id": "${WS}",\n  "comment": "ignored"\n}\n`,
    );
    const fa = findMapping(a);
    const fb = findMapping(b);
    if (!fa || "invalid" in fa || !fb || "invalid" in fb) throw new Error("expected two mappings");
    expect(fa.json).toBe(fb.json);
    expect(fa.hash).toBe(fb.hash);
    expect(fa.hash).toBe(createHash("sha256").update(fa.json, "utf8").digest("hex"));
    expect(fa.json).toBe(canonicalJson(fa.mapping));
  });

  it("a different value ⇒ a different hash", () => {
    const a = repo();
    const b = repo();
    writeFileSync(join(a, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: PROJECT }));
    writeFileSync(join(b, ".tickr.json"), JSON.stringify({ workspace_id: WS, project_id: PROJECT, description: "Other" }));
    const fa = findMapping(a);
    const fb = findMapping(b);
    if (!fa || "invalid" in fa || !fb || "invalid" in fb) throw new Error("expected two mappings");
    expect(fa.hash).not.toBe(fb.hash);
  });
});

describe("normalizeMapping", () => {
  it("snake_case keys converted, unknown keys ignored, task_id without project_id ⇒ invalid", () => {
    expect(
      normalizeMapping({
        workspace_id: WS,
        project_id: PROJECT,
        task_id: TASK,
        tag_ids: [TAG_B, TAG_A, TAG_A],
        description: "Pairing on the importer",
        projectId: "ignored",
        extra: true,
      }),
    ).toEqual({
      workspaceId: WS,
      projectId: PROJECT,
      taskId: TASK,
      tagIds: [TAG_A, TAG_B],
      description: "Pairing on the importer",
    });
    expect(normalizeMapping({ workspace_id: WS, task_id: TASK })).toEqual({ invalid: expect.stringContaining("project_id") });
  });

  it("applies the defaults of the optional keys", () => {
    expect(normalizeMapping({ workspace_id: WS, project_id: PROJECT })).toEqual({
      workspaceId: WS,
      projectId: PROJECT,
      taskId: null,
      tagIds: [],
      description: DEFAULT_DESCRIPTION,
    });
    expect(DEFAULT_DESCRIPTION).toBe("Claude Code session");
    expect(normalizeMapping({ workspace_id: WS, project_id: PROJECT, task_id: null, description: "" })).toMatchObject({
      taskId: null,
      description: DEFAULT_DESCRIPTION,
    });
  });

  it.each([
    ["not an object", "x"],
    ["an array", [WS]],
    ["null", null],
    ["no workspace_id", { project_id: PROJECT }],
    ["an empty workspace_id", { workspace_id: " ", project_id: PROJECT }],
    ["a numeric project_id", { workspace_id: WS, project_id: 12 }],
    ["a numeric task_id", { workspace_id: WS, project_id: PROJECT, task_id: 3 }],
    ["tag_ids not an array", { workspace_id: WS, project_id: PROJECT, tag_ids: TAG_A }],
    ["a non-string tag", { workspace_id: WS, project_id: PROJECT, tag_ids: [TAG_A, 1] }],
    ["a numeric description", { workspace_id: WS, project_id: PROJECT, description: 5 }],
    ["a description over 2000 characters", { workspace_id: WS, project_id: PROJECT, description: "x".repeat(2001) }],
  ])("%s ⇒ invalid", (_label, raw) => {
    expect(normalizeMapping(raw)).toEqual({ invalid: expect.any(String) });
  });

  it("accepts a description of exactly 2000 characters", () => {
    expect(normalizeMapping({ workspace_id: WS, project_id: PROJECT, description: "x".repeat(2000) })).toMatchObject({
      description: "x".repeat(2000),
    });
  });
});

describe("canonicalJson", () => {
  it("sorts keys at every depth and keeps array order", () => {
    expect(canonicalJson({ b: 1, a: { d: [3, { y: 1, x: 2 }], c: null } })).toBe('{"a":{"c":null,"d":[3,{"x":2,"y":1}]},"b":1}');
  });
});
