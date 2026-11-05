// Revoking a link stops the sessions already in the store (consent.ts, flusher/workspace.ts
// checkLinks): once the link of a session's last event is revoked (its file deleted, or removed by a
// hook that found the checkout's .tickr.json changed), the flusher no longer reads the session's
// transcripts nor sends anything of it.
import { readdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { Readable } from "node:stream";
import { afterEach, describe, expect, it } from "vitest";
import { isLinked, isLinkKeyActive, linkKey, LINKS_DIR } from "../../hook-src/consent.js";
import { createAgentApi } from "../../hook-src/flusher/api.js";
import { STOPPED_MISMATCH, stopMismatchedSession, UNLINKED } from "../../hook-src/flusher/sender.js";
import { PIPELINE, STAGE_NAMES } from "../../hook-src/flusher/stages.js";
import { checkLinks, LINK_CHECK_WINDOW_MS } from "../../hook-src/flusher/workspace.js";
import { main } from "../../hook-src/main.js";
import { findMapping, type FoundMapping } from "../../hook-src/mapping.js";
import { noticeMessage } from "../../hook-src/notices.js";
import { safeText } from "../../hook-src/status.js";
import type { JournalEvent } from "../../hook-src/store/db.js";
import { json, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, hookInput, linkCheckout, OTHER_PROJECT, pluginEnv, tempDir, WS, writeMapping } from "./helpers/env.js";
import { type StageHarness, stageHarness } from "./helpers/stage.js";
import { appendTranscript, writeTranscript } from "./helpers/transcript.js";

const NOW = "2026-11-05T10:00:00.000Z";
const MIN = 60_000;
const ENTRY = "0190f0c0-4444-7000-8000-0000000000e2";
const HEX64 = /[0-9a-f]{64}/i;
const plus = (iso: string, ms: number) => new Date(Date.parse(iso) + ms).toISOString();

const harnesses: StageHarness[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

/** A flusher harness against a local Tickr, a checkout linked in the harness's plugin data directory, a transcript. */
async function setup() {
  const h = stageHarness({ now: NOW });
  harnesses.push(h);
  const server = await startServer((req) => {
    if (req.url === "/api/v1/me") {
      return json(200, { user: { id: "u-1" }, workspace: { id: WS, name: "Acme" }, role: "workspace_user", serverTime: h.ctx.now().toISOString() });
    }
    return json(req.url.startsWith("/api/v1/agent-segments/") ? 201 : 200, { id: "e", origin: "agent_session", agentFinalized: false, agentDetached: false });
  });
  servers.push(server);
  h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_unlinked_key_0001", timeoutMs: 3000, now: () => h.ctx.now().getTime() });
  const data = h.ctx.config.dataDir;
  const root = tempDir();
  const cwd = writeMapping(join(root, "repo"));
  linkCheckout(data, cwd);
  const linkOf = () => {
    const found = findMapping(cwd);
    if (found === null || "invalid" in found) throw new Error("no mapping");
    return { linkKey: linkKey(found.dir, found.hash) };
  };
  const link = linkOf();
  const transcript = join(root, "projects", "s-1.jsonl");
  writeTranscript(transcript, [{ id: "msg_1", at: NOW }]);
  return {
    h,
    server,
    data,
    cwd,
    link,
    linkOf,
    transcript,
    puts: () => server.requests.filter((r) => r.method === "PUT"),
    /** One hook event of a linked checkout, as intake journals it (with its link). */
    event: (type: string, at: string, extra: Partial<JournalEvent> = {}) =>
      h.journal(type, at, 1000 + Date.parse(at) / 1000, { transcriptPath: transcript, ...link, ...extra }),
    /** One flusher pass: every stage in pipeline order. */
    pass: async () => {
      for (const name of STAGE_NAMES) await PIPELINE[name](h.ctx);
    },
    revoke: () => rmSync(join(data, LINKS_DIR, link.linkKey)),
    /** A hook of the checkout through the real entry point (it journals nothing when the checkout is not linked). */
    hook: async (type: string) => {
      const out: string[] = [];
      await main([type], pluginEnv(data), { stdin: Readable.from([JSON.stringify(hookInput(type, cwd))]), deadlineMs: Date.now() + 1000, write: (s) => void out.push(s) });
      return out.join("");
    },
  };
}

describe("revoking a link stops the sessions already recorded", () => {
  it("the link file removed ⇒ segments and delegated entries terminal 'unlinked', outbox empty, nothing sent nor read again", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW, { promptId: "p-1" });
    t.event("PostToolUse", plus(NOW, 1000), { promptId: "p-1", toolName: "mcp__plugin_tickr_tickr__start_timer", entryId: ENTRY });
    await t.pass();
    expect(t.puts().some((r) => r.url.startsWith("/api/v1/agent-segments/"))).toBe(true);
    const offset = t.h.store.getTranscriptOffset(t.transcript)!.offset;
    expect(offset).toBeGreaterThan(0);

    // More activity, journalled before the link is revoked; a pending revision of the delegated entry.
    t.h.setNow(plus(NOW, 2 * MIN));
    t.event("Stop", plus(NOW, 2 * MIN), { promptId: "p-1" });
    appendTranscript(t.transcript, [{ id: "msg_2", at: plus(NOW, 2 * MIN) }]);
    t.h.store.insertOutbox({ targetKind: "delegated", targetId: ENTRY, revision: 99, bodyJson: "{}", attempts: 0, nextAttemptAt: NOW });
    const sent = t.puts().length;
    t.revoke();
    await t.pass();

    expect(t.h.store.getSession("s-1")!.state).toBe(UNLINKED);
    const segments = t.h.store.segmentsForSession("s-1");
    expect(segments.length).toBeGreaterThan(0);
    expect(segments.every((s) => s.final)).toBe(true);
    const terminal = t.h.store.listTerminal();
    expect(terminal.map((r) => [r.targetKind, r.code]).sort()).toEqual(
      [...segments.map(() => ["segment", UNLINKED]), ["delegated", UNLINKED]].sort(),
    );
    expect(t.h.store.pendingOutboxCount()).toBe(0);
    expect(t.puts()).toHaveLength(sent);
    // The transcript is no longer read: neither its offset nor the ledger moved.
    expect(t.h.store.getTranscriptOffset(t.transcript)!.offset).toBe(offset);
    expect(t.h.store.db.prepare("SELECT COUNT(*) AS c FROM ledger WHERE message_id = 'msg_2'").get()).toEqual({ c: 0 });

    // Later passes (and later activity) change nothing; the notice is queued once.
    t.h.setNow(plus(NOW, 30 * MIN));
    t.event("UserPromptSubmit", plus(NOW, 30 * MIN), { promptId: "p-2" });
    await t.pass();
    await t.pass();
    expect(t.puts()).toHaveLength(sent);
    expect(t.h.store.segmentsForSession("s-1")).toHaveLength(segments.length);
    expect(t.h.store.listNotices().map((n) => n.kind)).toEqual([UNLINKED]);
    expect(t.h.store.takeUnshownNotices(NOW).map((n) => noticeMessage(n.kind))).toEqual([
      "Tickr: this repository is no longer linked on this machine, so its session stopped being tracked. Run /tickr:link to link it again.",
    ]);
  });

  it("a changed .tickr.json (new hash): the next hook of the checkout revokes the old link, the flusher stops the session", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    await t.pass();
    const sent = t.puts().length;
    expect(sent).toBeGreaterThan(0);
    const other = writeMapping(join(t.cwd, "..", "other"));
    linkCheckout(t.data, other);
    writeMapping(t.cwd, { workspace_id: WS, project_id: OTHER_PROJECT });
    expect(isLinkKeyActive(t.data, t.link.linkKey)).toBe(true);
    expect(await t.hook("UserPromptSubmit")).toBe(""); // not journalled
    expect(isLinkKeyActive(t.data, t.link.linkKey)).toBe(false);
    // Only the links of this checkout go: another checkout stays linked.
    expect(readdirSync(join(t.data, LINKS_DIR))).toHaveLength(1);
    expect(isLinked(t.data, other, (findMapping(other) as FoundMapping).hash)).toBe(true);
    t.h.setNow(plus(NOW, MIN));
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe(UNLINKED);
    expect(t.h.store.listTerminal().map((r) => r.code)).toEqual([UNLINKED]);
    expect(t.puts()).toHaveLength(sent);
  });

  it("a session whose last event has no link (journalled before schema v3) is left alone", async () => {
    const t = await setup();
    t.h.journal("UserPromptSubmit", NOW, 1000, { transcriptPath: t.transcript });
    t.revoke();
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe("active");
    expect(t.h.store.listTerminal()).toEqual([]);
    expect(t.puts().some((r) => r.url.startsWith("/api/v1/agent-segments/"))).toBe(true);
  });

  it("events not segmented yet are judged too: a session revoked before its first pass never gets a segment", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    t.revoke();
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe(UNLINKED);
    expect(t.h.store.segmentsForSession("s-1")).toEqual([]);
    expect(t.h.store.getTranscriptOffset(t.transcript)).toBeNull();
    expect(t.puts()).toHaveLength(0);
  });

  it("sessions outside the window without an open segment are not judged", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    await t.pass();
    t.h.setNow(plus(NOW, LINK_CHECK_WINDOW_MS + 60 * MIN));
    await t.pass(); // the segment goes final once idle
    expect(t.h.store.openSegmentFor("s-1")).toBeNull();
    t.revoke();
    t.h.ctx.guarded(() => checkLinks(t.h.store, t.data, t.h.ctx.now()));
    expect(t.h.store.getSession("s-1")!.state).toBe("active");
  });
});

describe("linking again", () => {
  it("/tickr:link replacing the file mid-session: the tool calls before `accept` revoke nothing, the session goes on", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    await t.pass();
    // The command writes the new file (PostToolUse of the write and of the exclude step), then runs accept.
    writeMapping(t.cwd, { workspace_id: WS, project_id: OTHER_PROJECT });
    expect(await t.hook("PostToolUse")).toBe("");
    expect(await t.hook("PostToolUse")).toBe("");
    expect(isLinkKeyActive(t.data, t.link.linkKey)).toBe(true);
    linkCheckout(t.data, t.cwd);
    t.h.setNow(plus(NOW, 2 * MIN));
    t.event("Stop", plus(NOW, 2 * MIN), t.linkOf());
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe("active");
    expect(t.h.store.listTerminal()).toEqual([]);
  });

  it("a changed .tickr.json left unlinked is revoked by the end of the turn (Stop) or the next prompt", async () => {
    for (const event of ["Stop", "UserPromptSubmit", "SessionStart"]) {
      const t = await setup();
      writeMapping(t.cwd, { workspace_id: WS, project_id: OTHER_PROJECT });
      await t.hook(event);
      expect(isLinkKeyActive(t.data, t.link.linkKey), event).toBe(false);
    }
  });

  it("reactivates an unlinked session, whose next activity opens a new segment; a stopped_mismatch session stays stopped", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    t.event("UserPromptSubmit", NOW, { sessionId: "s-2" });
    await t.pass();
    t.h.ctx.guarded(() => stopMismatchedSession(t.h.store, "s-2", t.h.ctx.now()));
    t.revoke();
    t.h.setNow(plus(NOW, MIN));
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe(UNLINKED);
    const stopped = t.h.store.segmentsForSession("s-1").map((s) => s.id);
    const sent = t.puts().length;

    linkCheckout(t.data, t.cwd);
    t.h.setNow(plus(NOW, 20 * MIN));
    t.event("UserPromptSubmit", plus(NOW, 20 * MIN));
    t.event("UserPromptSubmit", plus(NOW, 20 * MIN), { sessionId: "s-2" });
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe("active");
    expect(t.h.store.getSession("s-2")!.state).toBe(STOPPED_MISMATCH);
    const fresh = t.h.store.segmentsForSession("s-1").filter((s) => !stopped.includes(s.id));
    expect(fresh).toHaveLength(1);
    const newPuts = t.puts().slice(sent);
    expect(newPuts.map((r) => r.url)).toEqual([`/api/v1/agent-segments/${fresh[0]!.id}`]);
    // The stopped segments stay terminal.
    const unlinked = t.h.store.listTerminal().filter((r) => r.code === UNLINKED);
    expect(unlinked.map((r) => r.targetId).sort()).toEqual([...stopped].sort());
  });

  it("a session stopped for a changed .tickr.json is tracked again once the new content is linked", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    await t.pass();
    writeMapping(t.cwd, { workspace_id: WS, project_id: OTHER_PROJECT });
    await t.hook("Stop");
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe(UNLINKED);
    linkCheckout(t.data, t.cwd);
    t.h.setNow(plus(NOW, 20 * MIN));
    t.event("UserPromptSubmit", plus(NOW, 20 * MIN), t.linkOf());
    await t.pass();
    expect(t.h.store.getSession("s-1")!.state).toBe("active");
  });
});

describe("privacy of the unlinked stop", () => {
  it("its notice and terminal diagnostics carry no path nor hash", async () => {
    const t = await setup();
    t.event("UserPromptSubmit", NOW);
    await t.pass();
    t.revoke();
    await t.pass();
    const texts = [noticeMessage(UNLINKED), ...t.h.store.listTerminal().map((r) => `${r.code} ${safeText(r.diagnostic)} ${r.diagnostic}`)];
    for (const text of texts) {
      expect(text).not.toMatch(HEX64);
      expect(text.replaceAll("/tickr:link", "")).not.toMatch(/[\\/]/);
      expect(text.includes(t.cwd)).toBe(false);
    }
  });
});

