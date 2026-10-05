import { describe, expect, it } from "vitest";
import { ToolError } from "../src/api/errors.js";
import { MAX_REFERENCE_ITEMS, pageReferenceList } from "../src/tools/paging.js";

const item = (name: string, n: number) => ({ id: `00000000-0000-7000-8000-${String(n).padStart(12, "0")}`, name });
const names = (r: { items: { name: string }[] }) => r.items.map((i) => i.name);
const key = { a: false };

describe("pageReferenceList", () => {
  const list = [item("beta", 2), item("Alpha", 1), item("gamma", 3), item("alpha", 4)];

  it("sorts by lower-cased name then id and pages with a keyset cursor", () => {
    const p1 = pageReferenceList(list, { filterKey: key, limit: 2 });
    expect(names(p1)).toEqual(["Alpha", "alpha"]);
    expect(p1).toMatchObject({ total: 4, has_more: true });
    const p2 = pageReferenceList(list, { filterKey: key, limit: 2, cursor: p1.next_cursor! });
    expect(names(p2)).toEqual(["beta", "gamma"]);
    expect(p2).toMatchObject({ has_more: false, next_cursor: null });
  });

  it("filters by name_contains case-insensitively and counts after filtering", () => {
    const r = pageReferenceList(list, { filterKey: key, nameContains: "ALP" });
    expect(names(r)).toEqual(["Alpha", "alpha"]);
    expect(r.total).toBe(2);
  });

  it("does not shift pages when an item is created or deleted between pages", () => {
    const p1 = pageReferenceList(list, { filterKey: key, limit: 2 });
    const changed = [item("aaa-new", 9), ...list.filter((i) => i.name !== "Alpha")];
    const p2 = pageReferenceList(changed, { filterKey: key, limit: 2, cursor: p1.next_cursor! });
    expect(names(p2)).toEqual(["beta", "gamma"]);
  });

  it("rejects a cursor reused with other filters", () => {
    const p1 = pageReferenceList(list, { filterKey: key, limit: 1 });
    expect(() => pageReferenceList(list, { filterKey: key, limit: 1, nameContains: "a", cursor: p1.next_cursor! })).toThrow(ToolError);
    expect(() => pageReferenceList(list, { filterKey: { a: true }, limit: 1, cursor: p1.next_cursor! })).toThrow(ToolError);
  });

  it("rejects a malformed cursor", () => {
    expect(() => pageReferenceList(list, { filterKey: key, cursor: "not-a-cursor" })).toThrow(/Invalid cursor/);
  });

  it("refuses lists above the supported size instead of truncating", () => {
    const big = Array.from({ length: MAX_REFERENCE_ITEMS + 1 }, (_, n) => item(`p${n}`, n));
    expect(() => pageReferenceList(big, { filterKey: key })).toThrow(/too large/);
  });

  it("defaults to 50 items", () => {
    const many = Array.from({ length: 60 }, (_, n) => item(`p${String(n).padStart(2, "0")}`, n));
    const r = pageReferenceList(many, { filterKey: key });
    expect(r.items).toHaveLength(50);
    expect(r.has_more).toBe(true);
  });
});
