// Shared fixtures of the hook tests: temporary directories, a linked checkout, plugin options.
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { DatabaseSync } from "node:sqlite";
import type { PluginConfig } from "../../../hook-src/config.js";
import { instanceDir, instanceId } from "../../../hook-src/identity.js";
import type { HookInput } from "../../../hook-src/io.js";
import { recordLink } from "../../../hook-src/consent.js";
import { findMapping } from "../../../hook-src/mapping.js";
import { loadSqlite } from "../../../hook-src/runtime.js";

export const WS = "6a0c1c9e-2f0e-4a51-9c3b-0d6b8f1e2a01";
export const PROJECT = "0e7a4c1d-5b2f-4c8e-9a1b-3d5f7e9a1c02";
export const OTHER_PROJECT = "1f8b5d2e-6c3a-4d9f-8b2c-4e6a8f0b2d03";
export const KEY = "tkr_test_hook_store_key_0001";
export const BASE_URL = "https://tickr.example.test";

const made: string[] = [];

export function tempDir(prefix = "tickr-hook-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  made.push(dir);
  return dir;
}

/** Removes every directory made by tempDir (call from afterEach / afterAll). */
export function cleanTempDirs(): void {
  while (made.length) rmSync(made.pop()!, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
}

export function writeMapping(dir: string, mapping: Record<string, unknown> = { workspace_id: WS, project_id: PROJECT }): string {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, ".tickr.json"), JSON.stringify(mapping));
  return dir;
}

/** Links the checkout's .tickr.json on this machine, as /tickr:link does (consent.ts). */
export function linkCheckout(dataDir: string, checkout: string): string {
  const found = findMapping(checkout);
  if (found === null || "invalid" in found) throw new Error("no valid .tickr.json to link");
  if (!recordLink(dataDir, found.dir, found.hash)) throw new Error("could not record the link");
  return checkout;
}

export function pluginConfig(dataDir: string): PluginConfig {
  return { apiKey: KEY, baseUrl: BASE_URL, idleMinutes: 15, dataDir, autoContext: false };
}

export function pluginEnv(dataDir: string, extra: Record<string, string> = {}): NodeJS.ProcessEnv {
  return { CLAUDE_PLUGIN_DATA: dataDir, CLAUDE_PLUGIN_OPTION_API_KEY: KEY, CLAUDE_PLUGIN_OPTION_BASE_URL: BASE_URL, ...extra };
}

export function hookInput(event: string, cwd: string, extra: Partial<HookInput> = {}): HookInput {
  return { session_id: "s-1", cwd, hook_event_name: event, ...extra };
}

/** The instance directory the hooks use for this data directory and workspace. */
export function instanceFor(dataDir: string, workspaceId = WS): string {
  return instanceDir(dataDir, instanceId(BASE_URL, workspaceId, KEY));
}

export function rawDb(path: string): DatabaseSync {
  return new (loadSqlite()!.DatabaseSync)(path);
}

export function count(db: DatabaseSync, table: string): number {
  return Number((db.prepare(`SELECT COUNT(*) AS c FROM ${table}`).get() as { c: number }).c);
}

export function listJson(dir: string): string[] {
  try {
    return readdirSync(dir).filter((n) => n.endsWith(".json") && !n.startsWith("."));
  } catch {
    return [];
  }
}
