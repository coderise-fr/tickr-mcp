// Capability check: hooks need node:sqlite loaded without any flag (Node 22.13+, 24, 26).
// It is looked up lazily, never imported at module top level, so the bundle loads on any Node.
import type * as Sqlite from "node:sqlite";

export type SqliteModule = typeof Sqlite;

type BuiltinLookup = (id: string) => unknown;

export function loadSqlite(): SqliteModule | null {
  try {
    // process.getBuiltinModule (Node 20.16+, 22.3+) works from both the CommonJS bundle and the
    // ESM sources; runtimes without it never have a flag-free node:sqlite either.
    const lookup = (process as unknown as { getBuiltinModule?: BuiltinLookup }).getBuiltinModule;
    if (typeof lookup !== "function") return null;
    const sqlite = lookup.call(process, "node:sqlite") as Partial<SqliteModule> | undefined;
    return sqlite && typeof sqlite.DatabaseSync === "function" ? (sqlite as SqliteModule) : null;
  } catch {
    return null;
  }
}

export function unsupportedRuntimeMessage(): string {
  return (
    `Tickr: time tracking is off because this Node.js (${process.version}) cannot load node:sqlite ` +
    "without a flag. Put Node.js 22.13 or later on PATH to enable it."
  );
}
