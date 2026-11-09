import { mkdirSync, utimesSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { claimOwnership } from "../../hook-src/flusher/owner.js";
import { commitIfChanged } from "../../hook-src/flusher/revisions.js";
import { pauseSending, writeWorkspace } from "../../hook-src/flusher/sender.js";
import { instanceDir, instanceId, writeInstanceInfo } from "../../hook-src/identity.js";
import { INTAKE_PAUSED_KEY, recordEvent, UNTRACKED_MESSAGE, UNTRACKED_NOTE } from "../../hook-src/intake.js";
import { main } from "../../hook-src/main.js";
import { canonicalJson } from "../../hook-src/mapping.js";
import { renderStatus } from "../../hook-src/status.js";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import { BASE_URL, cleanTempDirs, hookInput, KEY, pluginConfig, pluginEnv, tempDir, WS } from "./helpers/env.js";
import { MAPPING } from "./helpers/stage.js";

afterEach(() => cleanTempDirs());

const NOW = new Date("2026-11-05T10:00:00.000Z");
const SECRET_DESCRIPTION = "Refactor of the SENTINEL billing module";

function makeInstance(data: string, apiKey: string, fill: (store: Store, gen: number) => void, mtime?: Date): string {
  const dir = instanceDir(data, instanceId(BASE_URL, WS, apiKey));
  writeInstanceInfo(dir, { baseUrl: BASE_URL, workspaceId: WS }, NOW);
  const store = openStore(join(dir, DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
  const gen = claimOwnership(store, 1, NOW.toISOString())!;
  store.upsertMapping("h", canonicalJson({ ...MAPPING, description: SECRET_DESCRIPTION }));
  fill(store, gen);
  store.close();
  if (mtime) utimesSync(join(dir, DB_FILE), mtime, mtime);
  return dir;
}

function expectPrivate(text: string, data: string) {
  expect(text).not.toMatch(/[0-9a-f]{64}/i);
  expect(text).not.toContain(KEY);
  expect(text).not.toContain("tkr_");
  expect(text).not.toContain(data);
  expect(text).not.toMatch(/[A-Za-z]:\\|\/tmp\/|Temp/);
  expect(text).not.toContain("SENTINEL");
  expect(text).not.toContain(WS);
}

async function runStatus(data: string, env: NodeJS.ProcessEnv): Promise<string> {
  let out = "";
  await main(["status", data], env, { stdin: Readable.from([]), deadlineMs: Date.now() + 1000, write: (t) => (out += t) });
  return out;
}

describe("renderStatus", () => {
  it("status lists a paused instance and its terminal items without any 64-hex string, key or path", async () => {
    const data = tempDir();
    const current = makeInstance(data, KEY, (store, gen) => {
      store.transaction(() => {
        writeWorkspace(store, { workspaceId: WS, workspaceName: "Acme", checkedAt: NOW.toISOString(), skewMs: 0 });
        pauseSending(store, "unauthorized", NOW);
        store.addTerminal({
          targetKind: "segment",
          targetId: "0190f0c0-0000-7000-8000-00000000000a",
          revision: 2,
          code: "not_project_member",
          at: NOW.toISOString(),
          diagnostic: `Refused at ${data}${"/x".repeat(3)} by ${"ab".repeat(32)} ${"z".repeat(400)}`,
        });
        store.addTerminal({ targetKind: "delegated", targetId: "e-1", revision: 1, code: "entry_locked", at: NOW.toISOString(), diagnostic: "" });
        store.setMeta(INTAKE_PAUSED_KEY, NOW.toISOString());
      });
      commitIfChanged(store, gen, { kind: "segment", id: "s" }, { description: SECRET_DESCRIPTION }, NOW);
    });
    mkdirSync(join(current, "fallback"), { recursive: true });
    writeFileSync(join(current, "fallback", "01J.json"), "{}");
    makeInstance(data, "tkr_test_previous_key_0002", () => undefined, new Date(Date.now() + 60_000));

    const text = renderStatus(data, { baseUrl: BASE_URL, apiKey: KEY });
    expect(text).toContain("tickr.example.test, workspace Acme: paused: the API key was refused (since 2026-11-05)");
    expect(text).toContain("intake paused");
    expect(text).toContain("pending revisions: 1");
    expect(text).toContain("terminal items (never sent again): 2");
    expect(text).toMatch(/- not_project_member, segment, 2026-11-05 \(Refused at \[path\] by \[redacted\] z+\)/);
    expect(text).toContain("- entry_locked, delegated entry, 2026-11-05");
    expect(text).toContain("events waiting to be journalled: 1");
    expect(text).toContain("tickr.example.test, workspace not checked yet: previous key or URL");
    for (const line of text.split("\n")) expect(line.length).toBeLessThan(300);
    expectPrivate(text, data);

    // Through the bundle's status mode, with the options of the environment.
    const viaMain = await runStatus(data, pluginEnv(data));
    expect(viaMain).toBe(text);
    expectPrivate(viaMain, data);
  });

  it("without the options, the most recently active instance of a workspace is the current one", () => {
    const data = tempDir();
    makeInstance(data, KEY, (store) => store.transaction(() => writeWorkspace(store, { workspaceId: WS, workspaceName: "Old", checkedAt: NOW.toISOString(), skewMs: 0 })), new Date(Date.now() - 3_600_000));
    makeInstance(data, "tkr_test_newer_key_0003", (store) => store.transaction(() => writeWorkspace(store, { workspaceId: WS, workspaceName: "New", checkedAt: NOW.toISOString(), skewMs: 0 })));
    const text = renderStatus(data);
    expect(text).toContain("workspace New: active");
    expect(text).toContain("workspace Old: previous key or URL");
    expect(text.indexOf("New")).toBeLessThan(text.indexOf("Old"));
    expectPrivate(text, data);
  });

  it("an instance not contacted yet, an empty data directory and a missing one", () => {
    const data = tempDir();
    expect(renderStatus(data)).toMatch(/nothing tracked yet/);
    expect(renderStatus(join(data, "missing"))).toMatch(/nothing tracked yet/);
    writeInstanceInfo(join(data, "x"), { baseUrl: BASE_URL, workspaceId: WS }, NOW);
    expect(renderStatus(data)).toContain("nothing sent yet");
    makeInstance(data, KEY, () => undefined);
    expect(renderStatus(data, { baseUrl: BASE_URL, apiKey: KEY })).toContain("active, waiting for the first contact with Tickr");
  });
});

describe("untracked sessions", () => {
  it("SessionStart without .tickr.json ⇒ the untracked message, once per session", async () => {
    const root = tempDir();
    const cfg = pluginConfig(join(root, "data"));
    const soon = () => Date.now() + 1000;
    expect(recordEvent(hookInput("SessionStart", root, { source: "startup" }), cfg, soon())).toEqual({ systemMessage: UNTRACKED_MESSAGE, additionalContext: UNTRACKED_NOTE });
    expect(recordEvent(hookInput("UserPromptSubmit", root), cfg, soon())).toEqual({});
    expect(recordEvent(hookInput("PostToolUse", root), cfg, soon())).toEqual({});
    expect(recordEvent(hookInput("SessionStart", root, { source: "compact" }), cfg, soon())).toEqual({});
    expect(recordEvent(hookInput("SessionStart", root, { source: "resume" }), cfg, soon())).toEqual({});
    // /clear starts a new session.
    expect(recordEvent(hookInput("SessionStart", root, { session_id: "s-2", source: "clear" }), cfg, soon())).toEqual({ systemMessage: UNTRACKED_MESSAGE, additionalContext: UNTRACKED_NOTE });
    expect(UNTRACKED_MESSAGE).toMatch(/not tracked.*\/tickr:link/);

    let out = "";
    const input = JSON.stringify({ session_id: "s-3", cwd: root, hook_event_name: "SessionStart", source: "startup" });
    await main(["SessionStart"], pluginEnv(join(root, "data")), { stdin: Readable.from([input]), deadlineMs: Date.now() + 1000, write: (t) => (out += t) });
    expect(JSON.parse(out)).toEqual({ systemMessage: UNTRACKED_MESSAGE, hookSpecificOutput: { hookEventName: "SessionStart", additionalContext: UNTRACKED_NOTE } });
  });
});
