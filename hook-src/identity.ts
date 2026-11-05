// Instance identity: one store per (base URL, workspace, full API key). A key or URL change gives
// a new instance; older ones are never replayed under the new identity. The id is a key
// fingerprint: it names the directory and is never logged nor shown.
import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

export const INSTANCE_FILE = "instance.json";

export interface InstanceInfo {
  base_url: string;
  workspace_id: string;
  created_at: string;
}

export function instanceId(baseUrl: string, workspaceId: string, apiKey: string): string {
  return createHash("sha256").update(JSON.stringify([baseUrl, workspaceId, apiKey]), "utf8").digest("hex");
}

export function instanceDir(dataDir: string, id: string): string {
  return join(dataDir, id);
}

/** Creates the instance directory and its instance.json (no key, no hash) unless it exists. */
export function writeInstanceInfo(dir: string, who: { baseUrl: string; workspaceId: string }, now: Date): void {
  mkdirSync(dir, { recursive: true });
  const info: InstanceInfo = { base_url: who.baseUrl, workspace_id: who.workspaceId, created_at: now.toISOString() };
  try {
    writeFileSync(join(dir, INSTANCE_FILE), `${JSON.stringify(info)}\n`, { flag: "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  }
}

export function readInstanceInfo(dir: string): InstanceInfo | null {
  try {
    const raw = JSON.parse(readFileSync(join(dir, INSTANCE_FILE), "utf8")) as Partial<InstanceInfo> | null;
    if (!raw || typeof raw.base_url !== "string" || typeof raw.workspace_id !== "string" || typeof raw.created_at !== "string") {
      return null;
    }
    return { base_url: raw.base_url, workspace_id: raw.workspace_id, created_at: raw.created_at };
  } catch {
    return null;
  }
}
