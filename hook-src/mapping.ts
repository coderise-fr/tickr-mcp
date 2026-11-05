// .tickr.json: which Tickr workspace / project / task / tags a checkout's sessions go to.
// snake_case on disk, converted explicitly; looked up from cwd upwards, first file wins.
import { createHash } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export const MAPPING_FILE = ".tickr.json";
export const DEFAULT_DESCRIPTION = "Claude Code session";
export const MAX_DESCRIPTION = 2000;
/** A .tickr.json larger than this is refused (it holds a handful of ids). */
export const MAX_MAPPING_BYTES = 64 * 1024;

export interface NormalizedMapping {
  workspaceId: string;
  projectId: string;
  taskId: string | null;
  tagIds: string[];
  description: string;
}

/** `dir` is the directory that holds the .tickr.json (the checkout the mapping links). */
export type FoundMapping = { mapping: NormalizedMapping; json: string; hash: string; dir: string };

/** JSON with object keys sorted at every depth: equal values give equal text. */
export function canonicalJson(value: unknown): string {
  return JSON.stringify(sortKeys(value));
}

function sortKeys(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(sortKeys);
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      Object.keys(record)
        .sort()
        .map((key) => [key, sortKeys(record[key])]),
    );
  }
  return value;
}

function requiredId(record: Record<string, unknown>, key: string): string | { invalid: string } {
  const value = record[key];
  if (typeof value !== "string" || value.trim() === "") return { invalid: `${MAPPING_FILE} needs a "${key}" text value.` };
  return value.trim();
}

export function normalizeMapping(raw: unknown): NormalizedMapping | { invalid: string } {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return { invalid: `${MAPPING_FILE} must hold one JSON object.` };
  }
  const record = raw as Record<string, unknown>;

  const workspaceId = requiredId(record, "workspace_id");
  if (typeof workspaceId !== "string") return workspaceId;
  const projectId = requiredId(record, "project_id");
  if (typeof projectId !== "string") return projectId;

  let taskId: string | null = null;
  if (record.task_id !== undefined && record.task_id !== null) {
    if (typeof record.task_id !== "string") return { invalid: `${MAPPING_FILE}: "task_id" must be a text value.` };
    taskId = record.task_id.trim() === "" ? null : record.task_id.trim();
  }

  let tagIds: string[] = [];
  if (record.tag_ids !== undefined && record.tag_ids !== null) {
    const tags = record.tag_ids;
    if (!Array.isArray(tags) || tags.some((tag) => typeof tag !== "string" || tag.trim() === "")) {
      return { invalid: `${MAPPING_FILE}: "tag_ids" must be a list of tag ids.` };
    }
    tagIds = [...new Set((tags as string[]).map((tag) => tag.trim()))].sort();
  }

  let description = DEFAULT_DESCRIPTION;
  if (record.description !== undefined && record.description !== null) {
    if (typeof record.description !== "string") return { invalid: `${MAPPING_FILE}: "description" must be text.` };
    if (record.description.length > MAX_DESCRIPTION) {
      return { invalid: `${MAPPING_FILE}: "description" is longer than ${MAX_DESCRIPTION} characters.` };
    }
    if (record.description !== "") description = record.description;
  }

  return { workspaceId, projectId, taskId, tagIds, description };
}

/** Reads a stored mapping version (the canonical JSON of a NormalizedMapping); null when unusable. */
export function parseStoredMapping(json: string): NormalizedMapping | null {
  let raw: Partial<Record<keyof NormalizedMapping, unknown>>;
  try {
    raw = JSON.parse(json) as typeof raw;
  } catch {
    return null;
  }
  if (typeof raw !== "object" || raw === null) return null;
  if (typeof raw.workspaceId !== "string" || raw.workspaceId === "" || typeof raw.projectId !== "string" || raw.projectId === "") return null;
  return {
    workspaceId: raw.workspaceId,
    projectId: raw.projectId,
    taskId: typeof raw.taskId === "string" && raw.taskId !== "" ? raw.taskId : null,
    tagIds: Array.isArray(raw.tagIds) ? raw.tagIds.filter((t): t is string => typeof t === "string") : [],
    description: typeof raw.description === "string" && raw.description !== "" ? raw.description : DEFAULT_DESCRIPTION,
  };
}

function parseMapping(text: string): Omit<FoundMapping, "dir"> | { invalid: string } {
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    return { invalid: `${MAPPING_FILE} is not valid JSON.` };
  }
  const mapping = normalizeMapping(raw);
  if ("invalid" in mapping) return mapping;
  const json = canonicalJson(mapping);
  return { mapping, json, hash: createHash("sha256").update(json, "utf8").digest("hex") };
}

/** Walks from cwd up to the file-system root and reads the first .tickr.json found. */
export function findMapping(cwd: string): FoundMapping | { invalid: string } | null {
  let dir = resolve(cwd);
  for (;;) {
    let text: string | undefined;
    try {
      const file = join(dir, MAPPING_FILE);
      // Only a small regular file is read: a device, a pipe or a huge file would stall every hook.
      const info = statSync(file);
      if (!info.isFile()) return { invalid: `${MAPPING_FILE} is not a regular file.` };
      if (info.size > MAX_MAPPING_BYTES) return { invalid: `${MAPPING_FILE} is larger than ${MAX_MAPPING_BYTES / 1024} KB.` };
      text = readFileSync(file, "utf8");
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      // Present but unreadable (no permission ...): the first file still wins.
      if (code !== "ENOENT" && code !== "ENOTDIR") return { invalid: `${MAPPING_FILE} could not be read.` };
    }
    if (text !== undefined) {
      const parsed = parseMapping(text);
      return "invalid" in parsed ? parsed : { ...parsed, dir };
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}
