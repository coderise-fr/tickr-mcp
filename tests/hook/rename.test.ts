// Renaming a session's entry in place (flusher/rename.ts): a change of task and/or description
// only keeps the segment and its entry while Tickr applies it, and is split as before (repaired)
// when Tickr keeps the old values. A local fake Tickr either applies or ignores such a change.
import { appendFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentApi } from "../../hook-src/flusher/api.js";
import {
  ADOPTED_TAGS_PREFIX,
  contextOnlyChange,
  REFUSED_RENAME_PREFIX,
  PENDING_RENAME_PREFIX,
  readPendingRename,
  readRenameSupport,
  RENAME_SUPPORT_KEY,
  REPROBE_MS,
  tryInPlace,
  writeRenameSupport,
} from "../../hook-src/flusher/rename.js";
import { PIPELINE, STAGE_NAMES } from "../../hook-src/flusher/stages.js";
import { ledgerRowsFor } from "../../hook-src/ledger.js";
import type { UsageRow } from "../../hook-src/flusher/revisions.js";
import { type NormalizedMapping } from "../../hook-src/mapping.js";
import { usageForRevision } from "../../hook-src/quality.js";
import { json, problem, type RecordedRequest, type Reply, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, PROJECT, OTHER_PROJECT, WS } from "./helpers/env.js";
import { journalMapping, MAPPING, type StageHarness, stageHarness } from "./helpers/stage.js";
import { appendPartial, appendTranscript, line, writeTranscript } from "./helpers/transcript.js";

const T0 = "2026-11-05T10:00:00.000Z";
const TASK = "2a9c6e3f-7d4b-4e0a-9c3d-5f7b9d1e3f04";
const TAG = "5c1e8a2b-9f3d-4e6a-8b0c-7d2f4a6c8e06";
const RENAMED: NormalizedMapping = { ...MAPPING, taskId: TASK, description: "Mobile app UI" };
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

const harnesses: StageHarness[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

interface Stored {
  description: string;
  taskId: string | null;
  final: boolean;
}

interface SegmentPut {
  id: string;
  body: { revision: number; taskId: string | null; description: string; final: boolean; startedAt: string; stoppedAt: string; usage?: unknown };
}

/**
 * A fake Tickr: GET /me, and PUT /api/v1/agent-segments/{id} that creates the entry from the first
 * revision and, on a later one, applies its task and description only when `applies()` says so
 * (the answer always shows the entry as stored). `refuse` answers a request instead, when it returns a reply.
 */
async function tickr(h: StageHarness, applies: () => boolean, refuse: (req: RecordedRequest) => Reply | null = () => null) {
  const entries = new Map<string, Stored>();
  const server = await startServer((req) => {
    if (req.url === "/api/v1/me") {
      return json(200, { user: { id: "u-1" }, workspace: { id: WS, name: "Acme" }, role: "workspace_user", serverTime: h.ctx.now().toISOString() });
    }
    const refused = refuse(req);
    if (refused !== null) return refused;
    const id = req.url.split("/").pop()!;
    const body = JSON.parse(req.body) as SegmentPut["body"];
    const known = entries.get(id);
    const stored: Stored =
      known === undefined || applies()
        ? { description: body.description, taskId: body.taskId, final: body.final }
        : { ...known, final: body.final };
    entries.set(id, stored);
    return json(known === undefined ? 201 : 200, {
      id,
      origin: "agent_session",
      description: stored.description,
      taskId: stored.taskId,
      agentFinalized: stored.final,
      agentDetached: false,
    });
  });
  servers.push(server);
  h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_rename_key_0001", timeoutMs: 3000, now: () => h.ctx.now().getTime() });
  return { server, entries };
}

function setup() {
  const h = stageHarness({ now: T0 });
  harnesses.push(h);
  const transcript = join(h.dir, "transcripts", "s-1.jsonl");
  writeTranscript(transcript, [{ id: "msg_1", at: at(10), output: 100 }]);
  const ev = (type: string, s: number, mapping: NormalizedMapping = MAPPING) =>
    h.journal(type, at(s), 1000 + s, { mapping: journalMapping(mapping), transcriptPath: transcript, promptId: "p-1" });
  /** Flusher passes at `s` (each stage in order), until the send stage has nothing due at once. */
  const pass = async (s: number, times = 3) => {
    h.setNow(at(s));
    for (let i = 0; i < times; i++) for (const name of STAGE_NAMES) await PIPELINE[name](h.ctx);
  };
  return { h, transcript, ev, pass };
}

function puts(requests: RecordedRequest[]): SegmentPut[] {
  return requests
    .filter((r) => r.method === "PUT" && r.url.startsWith("/api/v1/agent-segments/"))
    .map((r) => ({ id: r.url.split("/").pop()!, body: JSON.parse(r.body) as SegmentPut["body"] }));
}

const mappingOf = (h: StageHarness, versionId: number) => JSON.parse(h.store.getMapping(versionId)!.normalizedJson) as NormalizedMapping;

describe("which changes are renamed in place", () => {
  it("a change of task and/or description only, nothing else", () => {
    expect(contextOnlyChange(MAPPING, RENAMED)).toBe(true);
    expect(contextOnlyChange(MAPPING, { ...MAPPING, taskId: TASK })).toBe(true);
    expect(contextOnlyChange(MAPPING, { ...MAPPING, description: "Other" })).toBe(true);
    expect(contextOnlyChange(MAPPING, MAPPING)).toBe(false);
    expect(contextOnlyChange(MAPPING, { ...RENAMED, tagIds: [TAG] })).toBe(false);
    expect(contextOnlyChange(MAPPING, { ...RENAMED, projectId: OTHER_PROJECT })).toBe(false);
    expect(contextOnlyChange(MAPPING, { ...RENAMED, workspaceId: "9b9b9b9b-0000-4000-8000-000000000099" })).toBe(false);
    // Tags too once the instance is known to apply renames; a project never.
    expect(contextOnlyChange(MAPPING, { ...MAPPING, tagIds: [TAG] }, true)).toBe(true);
    expect(contextOnlyChange(MAPPING, { ...RENAMED, projectId: OTHER_PROJECT }, true)).toBe(false);
    expect(contextOnlyChange(MAPPING, MAPPING, true)).toBe(false);
  });

  it("tried in place while the capability is unknown or supported; once unsupported, again only REPROBE_MS later", () => {
    const { h } = setup();
    const now = new Date(T0);
    expect(tryInPlace(h.store, now)).toBe(true);
    h.ctx.guarded(() => writeRenameSupport(h.store, "supported", now));
    expect(tryInPlace(h.store, now)).toBe(true);
    h.ctx.guarded(() => writeRenameSupport(h.store, "unsupported", now));
    expect(tryInPlace(h.store, new Date(now.getTime() + REPROBE_MS - 1))).toBe(false);
    expect(tryInPlace(h.store, new Date(now.getTime() + REPROBE_MS))).toBe(true);
    expect(JSON.parse(h.store.getMeta(RENAME_SUPPORT_KEY)!)).toEqual({ state: "unsupported", at: T0 });
  });
});

describe("a Tickr that applies the change", () => {
  it("one segment, one entry: the next revisions carry the new task and description; supported is recorded", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await tickr(h, () => true);
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 30);
    await pass(31);
    ev("PostToolUse", 60, RENAMED);
    ev("Stop", 90, RENAMED);
    await pass(91);

    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg).toMatchObject({ final: false, startedAt: at(0), stoppedAt: at(90) });
    expect(mappingOf(h, seg.mappingVersionId)).toEqual(RENAMED);
    expect(readPendingRename(h.store, seg.id)).toBeNull();
    expect(readRenameSupport(h.store)).toEqual({ state: "supported", at: at(91) });

    const sent = puts(server.requests);
    expect(new Set(sent.map((p) => p.id))).toEqual(new Set([seg.id]));
    expect(sent.map((p) => p.body.revision)).toEqual([...sent.keys()].map((i) => i + 1));
    expect(sent[0]!.body).toMatchObject({ description: MAPPING.description, taskId: null, stoppedAt: at(30) });
    // The probe: the change, stopped at the change, without usage; then the segment goes on.
    expect(sent[1]!.body).toMatchObject({ description: RENAMED.description, taskId: TASK, stoppedAt: at(60), final: false });
    expect(sent[1]!.body.usage).toBeUndefined();
    expect(sent.at(-1)!.body).toMatchObject({ description: RENAMED.description, taskId: TASK, stoppedAt: at(90) });
    expect(entries.get(seg.id)).toMatchObject({ description: RENAMED.description, taskId: TASK });

    // The segment ends as usual, still one entry.
    ev("SessionEnd", 120, RENAMED);
    await pass(121);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
    expect(puts(server.requests).at(-1)!.body).toMatchObject({ final: true, description: RENAMED.description, stoppedAt: at(90) });
  });

  it("a task-only change keeps the description and renames the entry's task", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await tickr(h, () => true);
    const taskOnly: NormalizedMapping = { ...MAPPING, taskId: TASK };
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, taskOnly);
    await pass(61);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    expect(entries.get(segments[0]!.id)).toEqual({ description: MAPPING.description, taskId: TASK, final: false });
    expect(puts(server.requests).at(-1)!.body).toMatchObject({ description: MAPPING.description, taskId: TASK });
    expect(readRenameSupport(h.store)?.state).toBe("supported");
  });

  it("a segment never committed yet takes the new mapping without asking Tickr anything", async () => {
    const { h, ev, pass } = setup();
    const { server } = await tickr(h, () => false);
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 60, RENAMED);
    await pass(61);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    expect(readPendingRename(h.store, segments[0]!.id)).toBeNull();
    expect(puts(server.requests).every((p) => p.body.description === RENAMED.description)).toBe(true);
    // A creation says nothing about renames.
    expect(readRenameSupport(h.store)).toBeNull();
  });
});

describe("a Tickr that keeps the old task and description", () => {
  it("unsupported is recorded and the segment is split at the change as before, time and tokens included", async () => {
    const { h, transcript, ev, pass } = setup();
    const { server, entries } = await tickr(h, () => false);
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 30);
    await pass(31);
    appendTranscript(transcript, [{ id: "msg_2", at: at(70), output: 200 }]);
    ev("PostToolUse", 60, RENAMED);
    ev("PostToolUse", 80, RENAMED);
    ev("Stop", 90, RENAMED);
    await pass(91);

    expect(readRenameSupport(h.store)).toEqual({ state: "unsupported", at: at(91) });
    const [old, next] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    // The old segment as the split would have left it: its mapping, final at the change.
    expect(old).toMatchObject({ final: true, finalReason: "mapping", startedAt: at(0), stoppedAt: at(60), lastActivityAt: at(30) });
    expect(mappingOf(h, old!.mappingVersionId)).toEqual(MAPPING);
    // The new one from the change on, no gap, no overlap.
    expect(next).toMatchObject({ final: false, startedAt: at(60), stoppedAt: at(90), lastActivityAt: at(90) });
    expect(mappingOf(h, next!.mappingVersionId)).toEqual(RENAMED);
    expect(readPendingRename(h.store, old!.id)).toBeNull();

    // Tokens: by time, as the split attributes them.
    const rows = ledgerRowsFor(h.store, "s-1");
    expect(rows.find((r) => r.messageId === "msg_1")).toMatchObject({ recipientKind: "segment", recipientId: old!.id });
    expect(rows.find((r) => r.messageId === "msg_2")).toMatchObject({ recipientKind: "segment", recipientId: next!.id });

    // On the wire: the probe the server ignored is superseded by the old segment's final revision.
    const sent = puts(server.requests);
    const ofOld = sent.filter((p) => p.id === old!.id).map((p) => p.body);
    const ofNext = sent.filter((p) => p.id === next!.id).map((p) => p.body);
    expect(ofOld.map((b) => b.revision)).toEqual([...ofOld.keys()].map((i) => i + 1));
    expect(ofOld.filter((b) => b.description === RENAMED.description)).toHaveLength(1);
    expect(ofOld.at(-1)).toMatchObject({ final: true, description: MAPPING.description, taskId: null, stoppedAt: at(60) });
    // The probe never moved the entry past the change, nor its tokens.
    expect(ofOld.every((b) => Date.parse(b.stoppedAt) <= Date.parse(at(60)))).toBe(true);
    expect(ofNext.length).toBeGreaterThan(0);
    expect(ofNext.every((b) => b.description === RENAMED.description && b.taskId === TASK && b.startedAt === at(60))).toBe(true);
    expect(entries.get(old!.id)).toMatchObject({ description: MAPPING.description, final: true });

    // The next context change splits directly: no attempt in place.
    const third: NormalizedMapping = { ...RENAMED, description: "Release notes" };
    ev("UserPromptSubmit", 120, third);
    await pass(121);
    const all = h.store.segmentsForSession("s-1");
    expect(all).toHaveLength(3);
    expect(all[1]).toMatchObject({ final: true, finalReason: "mapping", stoppedAt: at(120) });
    expect(puts(server.requests).filter((p) => p.id === next!.id).every((p) => p.body.description === RENAMED.description)).toBe(true);
    expect(mappingOf(h, all[2]!.mappingVersionId)).toEqual(third);
  });

  it("tried in place again on the first change at least 24 h after unsupported was learnt", async () => {
    const { h, ev, pass } = setup();
    let applies = false;
    const { server } = await tickr(h, () => applies);
    h.ctx.guarded(() => writeRenameSupport(h.store, "unsupported", new Date(Date.parse(T0) - REPROBE_MS + 100_000)));
    ev("UserPromptSubmit", 0);
    await pass(1);
    // Within the 24 h: split directly.
    ev("PostToolUse", 60, RENAMED);
    await pass(61);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(puts(server.requests).filter((p) => p.id === h.store.segmentsForSession("s-1")[0]!.id).every((p) => p.body.description === MAPPING.description)).toBe(true);

    // 24 h after it was learnt, and Tickr was upgraded meanwhile: in place, and supported.
    applies = true;
    const back: NormalizedMapping = { ...MAPPING, description: "Back to the backlog" };
    ev("PostToolUse", 120, back);
    await pass(121);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(mappingOf(h, segments[1]!.mappingVersionId)).toEqual(back);
    expect(readRenameSupport(h.store)).toEqual({ state: "supported", at: at(121) });
  });

  it("a refused rename (422 on the task) is given up: the segment goes on with the accepted mapping, never left stuck", async () => {
    const { h, ev, pass } = setup();
    const { server } = await tickr(
      h,
      () => true,
      (req) => (req.method === "PUT" && req.body.includes(TASK) ? problem(422, "validation", "Validation failed", { errors: [{ field: "taskId", code: "task_not_found" }] }) : null),
    );
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, RENAMED);
    ev("Stop", 90, RENAMED);
    await pass(91);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg).toMatchObject({ final: false, stoppedAt: at(90) });
    expect(mappingOf(h, seg.mappingVersionId)).toEqual(MAPPING);
    expect(h.store.isTerminal("segment", seg.id)).toBe(false);
    // The refused probe wrote nothing: the next revision carries the accepted mapping and the end.
    expect(puts(server.requests).at(-1)!.body).toMatchObject({ description: MAPPING.description, taskId: null, stoppedAt: at(90) });
    expect(puts(server.requests).filter((p) => p.body.taskId === TASK)).toHaveLength(1);
    expect(h.store.outboxFor("segment", seg.id)).toEqual([]);
    // Nothing learnt about the capability; one notice with the refusal's code.
    expect(readRenameSupport(h.store)).toBeNull();
    expect(h.store.getMeta(PENDING_RENAME_PREFIX + seg.id)).toBeNull();
    expect(h.store.listNotices().map((n) => n.kind)).toEqual(["rename_refused:task_not_found"]);
  });
});

describe("crash safety and retention", () => {
  it("an answer lost before it is applied: the probe is sent again with the same bytes and resolved then", async () => {
    const { h, ev, pass } = setup();
    let lose = true;
    const { server } = await tickr(
      h,
      () => false,
      (req) => (lose && req.method === "PUT" && req.body.includes(TASK) ? { status: 503 } : null),
    );
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, RENAMED);
    await pass(61, 1);
    const [seg] = h.store.segmentsForSession("s-1");
    expect(readPendingRename(h.store, seg!.id)).not.toBeNull();
    // Held: nothing else of the segment is committed while the probe waits for its answer.
    ev("PostToolUse", 70, RENAMED);
    await pass(71, 1);
    expect(h.store.outboxFor("segment", seg!.id).map((r) => r.revision)).toEqual([2]);
    lose = false;
    await pass(400);
    const probes = puts(server.requests).filter((p) => p.body.revision === 2);
    expect(probes.length).toBeGreaterThan(1);
    expect(new Set(probes.map((p) => JSON.stringify(p.body))).size).toBe(1);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(readRenameSupport(h.store)?.state).toBe("unsupported");
  });

  it("a repair while the reads are partial drops the usage set taken during the probe; the next complete read splits it by time", async () => {
    const { h, transcript, ev, pass } = setup();
    let lose = true;
    const { server } = await tickr(
      h,
      () => false,
      (req) => (lose && req.method === "PUT" && req.body.includes(TASK) ? { status: 503 } : null),
    );
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 30);
    await pass(31);
    // (1) The probe waits for its answer; a complete read snapshots the tokens after the change
    // with the segment (msg_2 at 70 s, after the change at 60 s).
    appendTranscript(transcript, [{ id: "msg_2", at: at(70), output: 200 }]);
    ev("PostToolUse", 60, RENAMED);
    ev("PostToolUse", 80, RENAMED);
    await pass(81, 1);
    const [seg] = h.store.segmentsForSession("s-1");
    expect(readPendingRename(h.store, seg!.id)).not.toBeNull();
    const outputOf = (id: string) => (usageForRevision(h.store, { kind: "segment", id })?.usage ?? []).reduce((n, r) => n + r.outputTokens, 0);
    expect(outputOf(seg!.id)).toBe(300);

    // (2) The answer comes while the transcript's last line is cut mid-write: repair, partial reads.
    const cut = { id: "msg_3", at: at(85), output: 50 };
    appendPartial(transcript, cut);
    ev("Stop", 90, RENAMED);
    lose = false;
    const before = server.requests.length;
    await pass(400);
    const [old, next] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(old!.id).toBe(seg!.id);
    expect(h.store.getTranscriptOffset(transcript)).toMatchObject({ status: "partial" });
    // (3) Neither carries usage until a complete read rebuilds both sets.
    expect(usageForRevision(h.store, { kind: "segment", id: old!.id })).toBeUndefined();
    expect(usageForRevision(h.store, { kind: "segment", id: next!.id })).toBeUndefined();
    const afterRepair = puts(server.requests.slice(before));
    const oldAfter = afterRepair.filter((p) => p.id === old!.id && p.body.description === MAPPING.description);
    expect(oldAfter.length).toBeGreaterThan(0);
    expect(oldAfter.every((p) => p.body.usage === undefined)).toBe(true);
    expect(oldAfter.at(-1)!.body).toMatchObject({ final: true, usageQuality: "incomplete" });
    expect(afterRepair.filter((p) => p.id === next!.id).every((p) => p.body.usage === undefined)).toBe(true);

    // The line is completed: the next complete read carries each segment's tokens by time.
    appendFileSync(transcript, line(cut).slice(40));
    const beforeComplete = server.requests.length;
    await pass(500);
    expect(outputOf(old!.id)).toBe(100);
    expect(outputOf(next!.id)).toBe(250);
    const lastOf = (id: string) => puts(server.requests.slice(beforeComplete)).filter((p) => p.id === id).at(-1)!.body;
    const sum = (usage: unknown) => (usage as UsageRow[]).reduce((n, r) => n + r.outputTokens, 0);
    expect(lastOf(old!.id)).toMatchObject({ final: true, usageQuality: "complete" });
    expect(sum(lastOf(old!.id).usage)).toBe(100);
    expect(sum(lastOf(next!.id).usage)).toBe(250);
  });

  it("retention removes the pending rename of a segment that is gone", () => {
    const { h, ev } = setup();
    ev("UserPromptSubmit", 0);
    h.ctx.guarded(() => {
      h.store.setMeta(`${PENDING_RENAME_PREFIX}gone`, JSON.stringify({ fromMappingVersionId: 999, at: T0, lastActivityAt: T0, observedAt: T0, baseRevision: 1 }));
      h.store.setMeta(`${ADOPTED_TAGS_PREFIX}gone`, JSON.stringify({ from: [TAG], to: [] }));
      h.store.setMeta(`${REFUSED_RENAME_PREFIX}gone-session`, JSON.stringify({ from: 1, to: 2 }));
      h.store.deleteRetired("2026-11-04T00:00:00.000Z");
    });
    expect(h.store.getMeta(`${PENDING_RENAME_PREFIX}gone`)).toBeNull();
    expect(h.store.getMeta(`${ADOPTED_TAGS_PREFIX}gone`)).toBeNull();
    expect(h.store.getMeta(`${REFUSED_RENAME_PREFIX}gone-session`)).toBeNull();
  });
});

describe("other mapping changes still split", () => {
  it.each([
    ["tags", { ...RENAMED, tagIds: [TAG] }],
    ["project", { ...MAPPING, projectId: OTHER_PROJECT }],
  ])("a change of %s", async (_name, other) => {
    const { h, ev, pass } = setup();
    await tickr(h, () => true);
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, other as NormalizedMapping);
    await pass(61);
    const [old, next] = h.store.segmentsForSession("s-1");
    expect(old).toMatchObject({ final: true, finalReason: "mapping", stoppedAt: at(60) });
    expect(next).toMatchObject({ startedAt: at(60) });
    expect(readRenameSupport(h.store)).toBeNull();
    expect(PROJECT).not.toBe(OTHER_PROJECT);
  });
});
