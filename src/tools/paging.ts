import { ToolError } from "../api/errors.js";

export const MAX_REFERENCE_ITEMS = 5000;

export const TOO_LARGE =
  `This workspace's list is too large for this MCP server version (more than ${MAX_REFERENCE_ITEMS} items, ` +
  "or too slow to download within 30 seconds). Ask your Tickr administrator.";
export const BAD_CURSOR = "Invalid cursor: restart from the first page without cursor.";
export const CURSOR_MISMATCH =
  "This cursor was issued for another list or other filters (tool, project_id, name_contains, include_archived). " +
  "Restart from the first page without cursor.";

/** What a cursor is bound to: the tool (t), the project (p) and the archived filter (a). */
export interface FilterKey {
  t: string;
  p: string | null;
  a: boolean | null;
}

export interface PageRequest {
  nameContains?: string;
  filterKey: FilterKey;
  limit?: number;
  cursor?: string;
}

export interface PageResult<T> {
  items: T[];
  total: number;
  has_more: boolean;
  next_cursor: string | null;
}

type Key = [string, string];
interface CursorPayload extends FilterKey { k: Key; q: string | null }

const keyOf = (i: { id: string; name: string }): Key => [i.name.toLowerCase(), i.id];

function compareKeys(x: Key, y: Key): number {
  if (x[0] !== y[0]) return x[0] < y[0] ? -1 : 1;
  if (x[1] !== y[1]) return x[1] < y[1] ? -1 : 1;
  return 0;
}

function encodeCursor(payload: CursorPayload): string {
  return Buffer.from(JSON.stringify(payload), "utf8").toString("base64url");
}

function decodeCursor(cursor: string): CursorPayload {
  try {
    const p = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8")) as CursorPayload;
    const ok = Array.isArray(p.k) && p.k.length === 2 && typeof p.k[0] === "string" && typeof p.k[1] === "string" &&
      (p.q === null || typeof p.q === "string") && (p.a === null || typeof p.a === "boolean") &&
      typeof p.t === "string" && (p.p === null || typeof p.p === "string");
    if (!ok) throw new Error("shape");
    return p;
  } catch {
    throw new ToolError(BAD_CURSOR);
  }
}

const queryOf = (nameContains: string | undefined): string | null =>
  nameContains !== undefined ? nameContains.toLowerCase() : null;

function checkBinding(c: CursorPayload, f: FilterKey, q: string | null): void {
  if (c.t !== f.t || c.p !== f.p || c.q !== q || c.a !== f.a) throw new ToolError(CURSOR_MISMATCH);
}

/**
 * Checks a cursor before anything is downloaded: it must decode, and be bound to the same tool,
 * project, name filter and archived filter. Returns the message for the agent, or undefined.
 */
export function cursorProblem(cursor: string, filterKey: FilterKey, nameContains: string | undefined): string | undefined {
  try {
    checkBinding(decodeCursor(cursor), filterKey, queryOf(nameContains));
    return undefined;
  } catch (e) {
    if (e instanceof ToolError) return e.message;
    throw e;
  }
}

/** Local keyset paging over a list the API returns whole (projects, tasks, tags). */
export function pageReferenceList<T extends { id: string; name: string }>(items: T[], req: PageRequest): PageResult<T> {
  if (items.length > MAX_REFERENCE_ITEMS) throw new ToolError(TOO_LARGE);

  const q = queryOf(req.nameContains);
  const filtered = (q === null ? [...items] : items.filter((i) => i.name.toLowerCase().includes(q)))
    .sort((x, y) => compareKeys(keyOf(x), keyOf(y)));

  let start = 0;
  if (req.cursor !== undefined) {
    const c = decodeCursor(req.cursor);
    checkBinding(c, req.filterKey, q);
    const idx = filtered.findIndex((i) => compareKeys(keyOf(i), c.k) > 0);
    start = idx === -1 ? filtered.length : idx;
  }

  const limit = req.limit ?? 50;
  const page = filtered.slice(start, start + limit);
  const hasMore = start + limit < filtered.length;
  const last = page.at(-1);
  return {
    items: page,
    total: filtered.length,
    has_more: hasMore,
    next_cursor: hasMore && last ? encodeCursor({ k: keyOf(last), q, t: req.filterKey.t, p: req.filterKey.p, a: req.filterKey.a }) : null,
  };
}
