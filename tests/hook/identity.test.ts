import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { instanceDir, instanceId, readInstanceInfo, writeInstanceInfo } from "../../hook-src/identity.js";

const URL_A = "https://tickr.example.test";
const WS = "6a0c1c9e-2f0e-4a51-9c3b-0d6b8f1e2a01";
const KEY_1 = "tkr_live_aaaaaaaa_first_key_secret";
const KEY_2 = "tkr_live_aaaaaaaa_other_key_secret";

const dirs: string[] = [];
afterEach(() => {
  while (dirs.length) rmSync(dirs.pop()!, { recursive: true, force: true });
});

describe("instanceId", () => {
  it("is the SHA-256 hex of the JSON array (base URL, workspace, full key)", () => {
    const id = instanceId(URL_A, WS, KEY_1);
    expect(id).toMatch(/^[0-9a-f]{64}$/);
    expect(instanceId(URL_A, WS, KEY_1)).toBe(id);
  });

  it("two keys sharing the tkr_live prefix ⇒ two instances", () => {
    expect(KEY_1.slice(0, 17)).toBe(KEY_2.slice(0, 17));
    expect(instanceId(URL_A, WS, KEY_1)).not.toBe(instanceId(URL_A, WS, KEY_2));
  });

  it("URL or key change ⇒ new instance id", () => {
    const base = instanceId(URL_A, WS, KEY_1);
    expect(instanceId("https://other.example.test", WS, KEY_1)).not.toBe(base);
    expect(instanceId(URL_A, WS, KEY_2)).not.toBe(base);
    expect(instanceId(URL_A, "7b1d2dae-3f1f-4b62-8d4c-1e7c9f2f3b12", KEY_1)).not.toBe(base);
  });

  it("does not collide when parts shift between fields", () => {
    expect(instanceId("https://a.test", "bc", "d")).not.toBe(instanceId("https://a.test", "b", "cd"));
  });
});

describe("instance directory", () => {
  it("lives under the plugin data directory, named by the instance id", () => {
    const id = instanceId(URL_A, WS, KEY_1);
    expect(instanceDir("/data/tickr", id)).toBe(join("/data/tickr", id));
  });

  it("instance.json holds base_url, workspace_id and created_at only, never the key or the hash", () => {
    const data = mkdtempSync(join(tmpdir(), "tickr-identity-"));
    dirs.push(data);
    const id = instanceId(URL_A, WS, KEY_1);
    const dir = instanceDir(data, id);
    writeInstanceInfo(dir, { baseUrl: URL_A, workspaceId: WS }, new Date("2026-11-05T10:00:00.000Z"));
    const text = readFileSync(join(dir, "instance.json"), "utf8");
    expect(JSON.parse(text)).toEqual({ base_url: URL_A, workspace_id: WS, created_at: "2026-11-05T10:00:00.000Z" });
    expect(text).not.toContain(KEY_1);
    expect(text).not.toContain(id);

    // Written once: a later call keeps the original creation time.
    writeInstanceInfo(dir, { baseUrl: URL_A, workspaceId: WS }, new Date("2026-11-06T10:00:00.000Z"));
    expect(readInstanceInfo(dir)).toEqual({ base_url: URL_A, workspace_id: WS, created_at: "2026-11-05T10:00:00.000Z" });
  });

  it("readInstanceInfo returns null for a missing or damaged file", () => {
    const data = mkdtempSync(join(tmpdir(), "tickr-identity-"));
    dirs.push(data);
    expect(readInstanceInfo(join(data, "missing"))).toBeNull();
    writeFileSync(join(data, "instance.json"), "{ damaged");
    expect(readInstanceInfo(data)).toBeNull();
    writeFileSync(join(data, "instance.json"), JSON.stringify({ base_url: 1 }));
    expect(readInstanceInfo(data)).toBeNull();
  });
});
