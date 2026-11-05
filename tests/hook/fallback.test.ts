import { readdirSync, readFileSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { FALLBACK_DIR, importFallback, pendingFallbackCount, writeFallback } from "../../hook-src/fallback.js";
import { claimOwnership, LostOwnership } from "../../hook-src/flusher/owner.js";
import { ulid } from "../../hook-src/ids.js";
import { recordEvent } from "../../hook-src/intake.js";
import { DB_FILE, type JournalEvent, openStore, type Store } from "../../hook-src/store/db.js";
import { buildChild, startChild } from "./helpers/children.js";
import { cleanTempDirs, hookInput, instanceFor, KEY, listJson, OTHER_PROJECT, pluginConfig, tempDir, WS, writeMapping } from "./helpers/env.js";

afterEach(() => cleanTempDirs());

const NOW = "2026-11-05T10:00:00.000Z";

function flusherStore(path: string): Store {
  return openStore(path, { role: "flusher", busyTimeoutMs: 5000 }) as Store;
}

function event(extra: Partial<JournalEvent> = {}): JournalEvent {
  return {
    eventId: ulid(Date.now()),
    sessionId: "s-1",
    type: "PostToolUse",
    localTime: NOW,
    uptimeS: 10,
    mapping: { hash: "ignored", json: JSON.stringify({ description: "d", projectId: "p-1", tagIds: [], taskId: null, workspaceId: WS }) },
    ...extra,
  };
}

function owned(dir: string) {
  const store = flusherStore(join(dir, DB_FILE));
  const gen = claimOwnership(store, process.pid, new Date().toISOString())!;
  return { store, gen };
}

describe("writeFallback", () => {
  it("publishes one complete file per event, named by its event id, with the full mapping", () => {
    const dir = join(tempDir(), FALLBACK_DIR);
    const ev = event({ promptId: "p-1" });
    expect(writeFallback(dir, ev)).toBe(true);
    expect(readdirSync(dir)).toEqual([`${ev.eventId}.json`]);
    const doc = JSON.parse(readFileSync(join(dir, `${ev.eventId}.json`), "utf8"));
    expect(doc).toEqual({ format: 1, event: ev });
    expect(JSON.parse(doc.event.mapping.json)).toMatchObject({ workspaceId: WS, projectId: "p-1" });
  });

  it("a fallback file carries the subagent fields to the store", () => {
    const dir = tempDir();
    const ev = event({ type: "SubagentStop", agentId: "a-1", agentTranscriptPath: "/t/agent-a-1.jsonl" });
    writeFallback(join(dir, FALLBACK_DIR), ev);
    const store = flusherStore(join(dir, DB_FILE));
    const gen = claimOwnership(store, 1, new Date().toISOString())!;
    expect(importFallback(store, gen, join(dir, FALLBACK_DIR))).toBe(1);
    expect(store.eventsAfter(0)[0]).toMatchObject({ eventId: ev.eventId, agentId: "a-1", agentTranscriptPath: "/t/agent-a-1.jsonl" });
    store.close();
  });

  it("a fallback file carries the event's link to the store", () => {
    const dir = tempDir();
    const ev = event({ linkKey: LINK });
    writeFallback(join(dir, FALLBACK_DIR), ev);
    const store = flusherStore(join(dir, DB_FILE));
    const gen = claimOwnership(store, 1, new Date().toISOString())!;
    expect(importFallback(store, gen, join(dir, FALLBACK_DIR))).toBe(1);
    expect(store.eventsAfter(0)[0]).toMatchObject({ eventId: ev.eventId, linkKey: LINK });
    expect(store.lastLinkKey(ev.sessionId)).toBe(LINK);
    store.close();
  });

  it("a hook's fallback file holds no key and no prompt text", () => {
    const root = tempDir();
    const cwd = writeMapping(join(root, "repo"));
    const data = join(root, "data");
    recordEvent({ ...hookInput("PostToolUse", cwd), tool_response: { stdout: "SENTINEL" } }, pluginConfig(data), Date.now() + 1000);
    const dir = join(instanceFor(data), FALLBACK_DIR);
    const [file] = listJson(dir);
    const text = readFileSync(join(dir, file!), "utf8");
    expect(text).not.toContain(KEY);
    expect(text).not.toContain("SENTINEL");
    expect(text).not.toContain(cwd.replace(/\\/g, "\\\\"));
  });

  it("returns false when the directory cannot be created", () => {
    const root = tempDir();
    writeFileSync(join(root, "file"), "");
    expect(writeFallback(join(root, "file", FALLBACK_DIR), event())).toBe(false);
  });
});

const LINK = `${"a".repeat(32)}-${"b".repeat(64)}`;

describe("importFallback", () => {
  it("fallback carrying a mapping never seen ⇒ version created", () => {
    const dir = tempDir();
    const fallback = join(dir, FALLBACK_DIR);
    const json = JSON.stringify({ description: "d", projectId: OTHER_PROJECT, tagIds: [], taskId: null, workspaceId: WS });
    const ev = event({ mapping: { hash: "not-trusted", json } });
    writeFallback(fallback, ev);

    const { store, gen } = owned(dir);
    expect(store.listMappings()).toEqual([]);
    expect(importFallback(store, gen, fallback)).toBe(1);
    const [version] = store.listMappings();
    expect(version!.normalizedJson).toBe(json);
    expect(version!.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(store.eventsAfter(0)).toEqual([expect.objectContaining({ eventId: ev.eventId, mappingVersionId: version!.id })]);
    expect(pendingFallbackCount(fallback)).toBe(0);
    store.close();
  });

  it("re-importing an event already journalled is a no-op and still removes the file", () => {
    const dir = tempDir();
    const fallback = join(dir, FALLBACK_DIR);
    const ev = event();
    const { store, gen } = owned(dir);
    store.journal(ev);
    writeFallback(fallback, ev);
    expect(importFallback(store, gen, fallback)).toBe(0);
    expect(store.eventsAfter(0)).toHaveLength(1);
    expect(listJson(fallback)).toEqual([]);
    store.close();
  });

  it("sets a malformed file aside and removes temporary files left by a dead hook", () => {
    const dir = tempDir();
    const fallback = join(dir, FALLBACK_DIR);
    writeFallback(fallback, event());
    writeFileSync(join(fallback, "01BROKEN.json"), "{ cut");
    const temp = join(fallback, ".01DEAD.123.tmp");
    writeFileSync(temp, "{");
    const old = new Date(Date.now() - 3_600_000);
    utimesSync(temp, old, old);

    const { store, gen } = owned(dir);
    expect(importFallback(store, gen, fallback)).toBe(1);
    expect(readdirSync(fallback).sort()).toEqual(["01BROKEN.json.invalid"]);
    store.close();
  });

  it("an importer that lost ownership writes nothing and keeps the file", () => {
    const dir = tempDir();
    const fallback = join(dir, FALLBACK_DIR);
    writeFallback(fallback, event());
    const { store, gen } = owned(dir);
    store.setOwnerHeartbeat(gen, "2000-01-01T00:00:00.000Z");
    const other = flusherStore(join(dir, DB_FILE));
    expect(claimOwnership(other, 2, new Date().toISOString())).toBe(gen + 1);

    expect(() => importFallback(store, gen, fallback)).toThrow(LostOwnership);
    expect(store.eventsAfter(0)).toEqual([]);
    expect(listJson(fallback)).toHaveLength(1);
    store.close();
    other.close();
  });
});

describe("fallback under concurrency", () => {
  let harness: ReturnType<typeof buildChild>;
  let bundle: string;
  beforeAll(() => {
    harness = buildChild();
    bundle = harness.path;
  });
  afterAll(() => harness.remove());

  it("fallback from two producers + concurrent import + crash after commit before unlink ⇒ each event once", async () => {
    const dir = tempDir();
    const fallback = join(dir, FALLBACK_DIR);
    const { store, gen } = owned(dir);

    const producers = [startChild(bundle, ["produce", fallback, "40", "a"]), startChild(bundle, ["produce", fallback, "40", "b"])];
    let running = true;
    void Promise.all(producers.map((p) => p.exited)).then(() => (running = false));

    let commits = 0;
    let crashes = 0;
    const crashOnce = (name: string) => {
      commits += 1;
      if (commits === 5 || commits === 23) {
        crashes += 1;
        throw new Error(`crash after committing ${name}, before unlinking it`);
      }
    };
    while (running) {
      try {
        importFallback(store, gen, fallback, { onCommitted: crashOnce });
      } catch (error) {
        expect(String(error)).toMatch(/crash after committing/);
      }
      await delay(5);
    }
    // Restarts after each simulated crash until the directory is drained.
    for (let attempt = 0; attempt < 5 && listJson(fallback).length > 0; attempt++) {
      try {
        importFallback(store, gen, fallback, { onCommitted: crashOnce });
      } catch (error) {
        expect(String(error)).toMatch(/crash after committing/);
      }
    }

    const produced = producers.flatMap((p) => JSON.parse(p.lines.find((l) => l.startsWith("["))!) as string[]);
    expect(produced).toHaveLength(80);
    expect(crashes).toBeGreaterThan(0);
    const journalled = store.eventsAfter(0, 10_000).map((e) => e.eventId);
    expect(journalled).toHaveLength(80);
    expect(new Set(journalled)).toEqual(new Set(produced));
    expect(readdirSync(fallback)).toEqual([]);
    store.close();
  });
});
