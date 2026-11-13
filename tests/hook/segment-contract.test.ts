// The segment route's rename contract (PUT /api/v1/agent-segments/{id}) against a local fake
// Tickr that follows it: on a later accepted revision, description, taskId and tagIds are applied
// (taskId absent keeps, null clears; tag ids that no longer exist are dropped), projectId is
// immutable (422 immutable, nothing written), the 200 shows the entry as stored; a replay of a
// revision number is accepted only with the very same bytes (409 agent_revision_conflict
// otherwise). The same fake in "old" mode keeps the entry's mapping as it was created (a Tickr
// that does not apply renames), the capability detector of flusher/rename.ts.
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createAgentApi } from "../../hook-src/flusher/api.js";
import { readPendingRename, readRenameSupport, writeRenameSupport } from "../../hook-src/flusher/rename.js";
import { STOPPED_LOCKED } from "../../hook-src/flusher/sender.js";
import { PIPELINE, STAGE_NAMES } from "../../hook-src/flusher/stages.js";
import type { NormalizedMapping } from "../../hook-src/mapping.js";
import { noticeMessage } from "../../hook-src/notices.js";
import { json, problem, type RecordedRequest, type Reply, startServer } from "../helpers/httpServer.js";
import { cleanTempDirs, OTHER_PROJECT, WS } from "./helpers/env.js";
import { journalMapping, MAPPING, type StageHarness, stageHarness } from "./helpers/stage.js";
import { writeTranscript } from "./helpers/transcript.js";

const T0 = "2026-11-09T10:00:00.000Z";
const TASK = "2a9c6e3f-7d4b-4e0a-9c3d-5f7b9d1e3f04";
const TASK_2 = "3b0d7f4a-8e5c-4f1b-8d4e-6a8c0e2f4a05";
const TAG = "5c1e8a2b-9f3d-4e6a-8b0c-7d2f4a6c8e06";
const TAG_2 = "6d2f9b3c-0a4e-4f7b-9c1d-8e3a5b7d9f07";
const TAG_3 = "7e3a0c4d-1b5f-4a8c-8d2e-9f4b6c8e0a08";
const at = (s: number) => new Date(Date.parse(T0) + s * 1000).toISOString();

const harnesses: StageHarness[] = [];
const servers: { close(): Promise<void> }[] = [];
afterEach(async () => {
  for (const h of harnesses.splice(0)) h.close();
  await Promise.all(servers.splice(0).map((s) => s.close()));
  cleanTempDirs();
});

interface Body {
  revision: number;
  agentSessionId: string;
  startedAt: string;
  stoppedAt: string;
  projectId?: string | null;
  taskId?: string | null;
  tagIds?: string[] | null;
  description?: string | null;
  working: boolean;
  final: boolean;
  usage?: unknown;
}

interface Entry {
  projectId: string | null;
  taskId: string | null;
  tagIds: string[];
  description: string;
  stoppedAt: string;
  revision: number;
  /** The raw bytes of the stored revision (a replay must match them). */
  raw: string;
  finalized: boolean;
}

interface FakeOptions {
  /** Apply description / taskId / tagIds on a later revision (the new contract), else keep them (an old Tickr). */
  applies: boolean;
  /** Answers a segment PUT before the contract does, when it returns a reply. */
  intercept?: (req: RecordedRequest, body: Body, entry: Entry | undefined) => Reply | null;
}

/** A fake Tickr that follows the segment route's contract (see the file comment). */
async function fakeTickr(h: StageHarness, o: FakeOptions) {
  const entries = new Map<string, Entry>();
  const tags = new Set([TAG, TAG_2, TAG_3]);
  const tasks = new Set([TASK, TASK_2]);
  const answer = (id: string, e: Entry, status = 200) =>
    json(status, {
      id,
      origin: "agent_session",
      projectId: e.projectId,
      description: e.description,
      taskId: e.taskId,
      taskName: e.taskId === null ? null : "Some task",
      tagIds: e.tagIds,
      agentFinalized: e.finalized,
      agentDetached: false,
    });
  const field = (status: number, name: string, code: string) =>
    problem(status, "validation", "Validation failed", { errors: [{ field: name, code, message: "refused" }] });
  const server = await startServer((req) => {
    if (req.url === "/api/v1/me") {
      return json(200, { user: { id: "u-1" }, workspace: { id: WS, name: "Acme" }, role: "workspace_user", serverTime: h.ctx.now().toISOString() });
    }
    const id = req.url.split("/").pop()!;
    const body = JSON.parse(req.body) as Body;
    const known = entries.get(id);
    const intercepted = o.intercept?.(req, body, known);
    if (intercepted) return intercepted;
    if (known === undefined) {
      if ((body.tagIds ?? []).some((t) => !tags.has(t))) return field(422, "tagIds", "invalid_tag");
      const created: Entry = {
        projectId: body.projectId ?? null,
        taskId: body.taskId ?? null,
        tagIds: [...(body.tagIds ?? [])],
        description: body.description ?? "",
        stoppedAt: body.stoppedAt,
        revision: body.revision,
        raw: req.body,
        finalized: body.final,
      };
      entries.set(id, created);
      return answer(id, created, 201);
    }
    if (body.revision < known.revision) return answer(id, known);
    if (body.revision === known.revision) return req.body === known.raw ? answer(id, known) : problem(409, "conflict", "agent_revision_conflict");
    if (known.finalized && body.stoppedAt !== known.stoppedAt) return problem(409, "conflict", "segment_finalized");
    // Nothing of a refused revision is written.
    if ((body.projectId ?? null) !== known.projectId) return field(422, "projectId", "immutable");
    const next: Entry = { ...known };
    if (o.applies) {
      if (typeof body.description === "string") {
        if (body.description.length > 2000) return field(422, "description", "too_long");
        next.description = body.description;
      }
      if ("taskId" in body && body.taskId !== known.taskId) {
        if (body.taskId !== null && !tasks.has(body.taskId!)) return field(422, "taskId", "invalid");
        next.taskId = body.taskId ?? null;
      }
      if (Array.isArray(body.tagIds)) next.tagIds = body.tagIds.filter((t) => tags.has(t));
    }
    if (!known.finalized) {
      next.stoppedAt = body.stoppedAt;
      next.finalized = body.final;
    }
    next.revision = body.revision;
    next.raw = req.body;
    entries.set(id, next);
    return answer(id, next);
  });
  servers.push(server);
  h.ctx.api = createAgentApi({ baseUrl: server.baseUrl, apiKey: "tkr_test_contract_key_0001", timeoutMs: 3000, now: () => h.ctx.now().getTime() });
  return { server, entries, tags, tasks };
}

function setup() {
  const h = stageHarness({ now: T0 });
  harnesses.push(h);
  const transcript = join(h.dir, "transcripts", "s-1.jsonl");
  writeTranscript(transcript, [{ id: "msg_1", at: at(10), output: 100 }]);
  const ev = (type: string, s: number, mapping: NormalizedMapping = MAPPING) =>
    h.journal(type, at(s), 1000 + s, { mapping: journalMapping(mapping), transcriptPath: transcript, promptId: "p-1" });
  const pass = async (s: number, times = 3) => {
    h.setNow(at(s));
    for (let i = 0; i < times; i++) for (const name of STAGE_NAMES) await PIPELINE[name](h.ctx);
  };
  return { h, ev, pass };
}

interface Put {
  id: string;
  raw: string;
  body: Body;
}

function puts(requests: RecordedRequest[]): Put[] {
  return requests
    .filter((r) => r.method === "PUT" && r.url.startsWith("/api/v1/agent-segments/"))
    .map((r) => ({ id: r.url.split("/").pop()!, raw: r.body, body: JSON.parse(r.body) as Body }));
}

const mappingOf = (h: StageHarness, versionId: number) => JSON.parse(h.store.getMapping(versionId)!.normalizedJson) as NormalizedMapping;

/** Every request carries description and taskId explicitly (a value or null), never absent. */
function expectExplicitMapping(sent: Put[]): void {
  for (const p of sent) {
    expect(Object.keys(p.body)).toEqual(expect.arrayContaining(["projectId", "taskId", "tagIds", "description"]));
    expect(p.body.description === null || p.body.description === undefined).toBe(false);
  }
}

/** No revision of a segment ever carries another projectId than its creation's. */
function expectProjectNeverChanges(sent: Put[]): void {
  const created = new Map<string, string | null | undefined>();
  for (const p of sent) {
    if (!created.has(p.id)) created.set(p.id, p.body.projectId);
    expect(p.body.projectId).toBe(created.get(p.id));
  }
}

describe("a Tickr that applies the change", () => {
  it.each([
    ["the description only", { ...MAPPING, description: "Mobile app UI" }],
    ["the task only", { ...MAPPING, taskId: TASK }],
  ] as const)("%s: one segment, one entry renamed, supported recorded", async (_name, renamed) => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: true });
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, renamed);
    ev("Stop", 90, renamed);
    await pass(91);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    expect(entries.get(segments[0]!.id)).toMatchObject({ description: renamed.description, taskId: renamed.taskId, stoppedAt: at(90) });
    expect(readRenameSupport(h.store)?.state).toBe("supported");
    expectExplicitMapping(puts(server.requests));
  });

  it("a task cleared: the revision carries taskId null explicitly and the entry's task is cleared", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: true });
    const withTask: NormalizedMapping = { ...MAPPING, taskId: TASK };
    ev("UserPromptSubmit", 0, withTask);
    await pass(1);
    ev("PostToolUse", 60, MAPPING);
    await pass(61);
    const [seg] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
    expect(entries.get(seg!.id)).toMatchObject({ taskId: null });
    const probe = puts(server.requests).find((p) => p.body.revision === 2)!;
    expect(probe.raw).toContain('"taskId":null');
    expect(readRenameSupport(h.store)?.state).toBe("supported");
  });

  it("once supported, a change of tags is renamed in place too: replaced, then emptied", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: true });
    h.ctx.guarded(() => writeRenameSupport(h.store, "supported", new Date(T0)));
    const tagged: NormalizedMapping = { ...MAPPING, tagIds: [TAG] };
    ev("UserPromptSubmit", 0, tagged);
    await pass(1);
    const replaced: NormalizedMapping = { ...MAPPING, tagIds: [TAG_2, TAG_3].sort() };
    ev("PostToolUse", 60, replaced);
    await pass(61);
    const [seg] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
    expect(entries.get(seg!.id)!.tagIds.sort()).toEqual([TAG_2, TAG_3].sort());
    ev("PostToolUse", 120, MAPPING);
    await pass(121);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
    expect(entries.get(seg!.id)!.tagIds).toEqual([]);
    expect(puts(server.requests).at(-1)!.raw).toContain('"tagIds":[]');
    expect(readRenameSupport(h.store)?.state).toBe("supported");
  });

  it("while the capability is unknown, a change of tags still splits", async () => {
    const { h, ev, pass } = setup();
    await fakeTickr(h, { applies: true });
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, { ...MAPPING, tagIds: [TAG] });
    await pass(61);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
  });

  it("a tag deleted on Tickr (the answer lacks it): the rename counts as applied and the segment adopts Tickr's tags", async () => {
    const { h, ev, pass } = setup();
    const { server, entries, tags } = await fakeTickr(h, { applies: true });
    const tagged: NormalizedMapping = { ...MAPPING, tagIds: [TAG, TAG_2].sort() };
    ev("UserPromptSubmit", 0, tagged);
    await pass(1);
    tags.delete(TAG_2);
    const renamed: NormalizedMapping = { ...tagged, description: "Mobile app UI" };
    ev("PostToolUse", 60, renamed);
    await pass(61);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    expect(readRenameSupport(h.store)?.state).toBe("supported");
    expect(entries.get(segments[0]!.id)).toMatchObject({ description: "Mobile app UI", tagIds: [TAG] });
    // The next revisions carry the tags Tickr holds; the segment's mapping is unchanged.
    ev("PostToolUse", 200, renamed);
    await pass(201);
    const last = puts(server.requests).at(-1)!;
    expect(last.body.tagIds).toEqual([TAG]);
    expect(Date.parse(last.body.stoppedAt)).toBe(Date.parse(at(200)));
    expect(mappingOf(h, h.store.segmentsForSession("s-1")[0]!.mappingVersionId)).toEqual(renamed);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
  });

  it.each([
    ["with a new description", "Mobile app UI"],
    ["alone", MAPPING.description],
  ])("on a supported Tickr, [A] → [A, B] with B deleted %s: applied, the tags Tickr holds are adopted, no split", async (_name, description) => {
    const { h, ev, pass } = setup();
    const { server, entries, tags } = await fakeTickr(h, { applies: true });
    h.ctx.guarded(() => writeRenameSupport(h.store, "supported", new Date(T0)));
    const base: NormalizedMapping = { ...MAPPING, tagIds: [TAG] };
    ev("UserPromptSubmit", 0, base);
    await pass(1);
    tags.delete(TAG_2);
    const changed: NormalizedMapping = { ...base, tagIds: [TAG, TAG_2].sort(), description };
    ev("PostToolUse", 60, changed);
    await pass(61);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    expect(readRenameSupport(h.store)?.state).toBe("supported");
    expect(entries.get(segments[0]!.id)).toMatchObject({ description, tagIds: [TAG] });
    // Nothing was split off: the next revision carries the tags Tickr holds, never the deleted one.
    ev("PostToolUse", 200, changed);
    await pass(201);
    expect(puts(server.requests).at(-1)!.body.tagIds).toEqual([TAG]);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
  });

  it("a refused rename, then an idle gap: the resumed segment opens with the accepted mapping, the refused one is not sent again", async () => {
    const { h, ev, pass } = setup();
    const BAD_TASK = "4c1e8a5b-9f6d-4a2c-8e5f-7b9d1f3a5b06";
    const bad: NormalizedMapping = { ...MAPPING, taskId: BAD_TASK, description: "Refused task" };
    const refuseBad = (req: RecordedRequest) =>
      req.method === "PUT" && req.body.includes(BAD_TASK)
        ? problem(422, "validation", "Validation failed", { errors: [{ field: "taskId", code: "invalid", message: "refused" }] })
        : null;
    const { server } = await fakeTickr(h, { applies: true, intercept: refuseBad });
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, bad);
    await pass(61);
    expect(h.store.listNotices().map((n) => n.kind)).toEqual(["rename_refused:invalid"]);

    // An hour of idleness, then the same context: a new segment, with the accepted mapping.
    ev("PostToolUse", 3700, bad);
    await pass(3701);
    ev("PostToolUse", 3760, bad);
    await pass(3761);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(segments[0]).toMatchObject({ final: true, finalReason: "idle" });
    expect(mappingOf(h, segments[1]!.mappingVersionId)).toEqual(MAPPING);
    expect(puts(server.requests).filter((p) => p.body.taskId === BAD_TASK)).toHaveLength(1);
    expect(h.store.listTerminal()).toEqual([]);
    expect(puts(server.requests).some((p) => p.id === segments[1]!.id)).toBe(true);
  });

  it("a refused rename A→B, then B accepted from another mapping: the refusal no longer applies, an idle gap resumes with B", async () => {
    const { h, ev, pass } = setup();
    let refuse = true;
    const B: NormalizedMapping = { ...MAPPING, taskId: TASK_2, description: "Task B" };
    const C: NormalizedMapping = { ...MAPPING, taskId: TASK, description: "Task C" };
    await fakeTickr(h, {
      applies: true,
      intercept: (req) =>
        refuse && req.method === "PUT" && req.body.includes(TASK_2)
          ? problem(422, "validation", "Validation failed", { errors: [{ field: "taskId", code: "invalid", message: "refused" }] })
          : null,
    });
    ev("UserPromptSubmit", 0);
    await pass(1);
    ev("PostToolUse", 60, B);
    await pass(61); // A→B refused: the segment keeps A
    expect(h.store.listNotices().map((n) => n.kind)).toEqual(["rename_refused:invalid"]);

    refuse = false; // B becomes valid (the task was fixed on Tickr)
    ev("PostToolUse", 120, C);
    await pass(121); // A→C accepted
    ev("PostToolUse", 180, B);
    await pass(181); // C→B accepted
    const [seg] = h.store.segmentsForSession("s-1");
    expect(mappingOf(h, seg!.mappingVersionId)).toEqual(B);

    // An idle gap, then the same context: the new segment opens with B, not with the stale A.
    ev("PostToolUse", 3800, B);
    await pass(3801);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(mappingOf(h, segments[1]!.mappingVersionId)).toEqual(B);
  });

  it("a change of project is never sent on the segment: split, the old one final with its project and end, a new segment for the new project", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: true });
    h.ctx.guarded(() => writeRenameSupport(h.store, "supported", new Date(T0)));
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 30);
    await pass(31);
    const moved: NormalizedMapping = { ...MAPPING, projectId: OTHER_PROJECT, description: "Elsewhere" };
    ev("PostToolUse", 60, moved);
    ev("Stop", 90, moved);
    await pass(91);
    const [old, next] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(old).toMatchObject({ final: true, finalReason: "mapping", stoppedAt: at(60) });
    expect(entries.get(old!.id)).toMatchObject({ projectId: MAPPING.projectId, description: MAPPING.description, finalized: true, stoppedAt: at(60) });
    expect(entries.get(next!.id)).toMatchObject({ projectId: OTHER_PROJECT, description: "Elsewhere" });
    const sent = puts(server.requests);
    expectProjectNeverChanges(sent);
    expect(sent.filter((p) => p.id === old!.id).at(-1)!.body).toMatchObject({ final: true, projectId: MAPPING.projectId });
    expect(sent.filter((p) => p.id === old!.id).at(-1)!.body.usage).toBeDefined();
    expect(h.store.listTerminal()).toEqual([]);
  });
});

describe("an old Tickr (a 200 with the entry unchanged)", () => {
  it("is detected by the answer alone: unsupported recorded, the segment split at the change", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: false });
    ev("UserPromptSubmit", 0);
    await pass(1);
    const renamed: NormalizedMapping = { ...MAPPING, taskId: TASK, description: "Mobile app UI" };
    ev("PostToolUse", 60, renamed);
    ev("Stop", 90, renamed);
    await pass(91);
    const [old, next] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(readRenameSupport(h.store)?.state).toBe("unsupported");
    expect(entries.get(old!.id)).toMatchObject({ description: MAPPING.description, taskId: null, finalized: true });
    expect(entries.get(next!.id)).toMatchObject({ description: renamed.description, taskId: TASK });
    expectExplicitMapping(puts(server.requests));
    expectProjectNeverChanges(puts(server.requests));
  });
});

describe("refusals of a rename", () => {
  it("422 immutable on the probe (safety net): the split, nothing terminal, no loop", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, {
      applies: true,
      intercept: (_req, body, e) =>
        e !== undefined && body.taskId === TASK ? problem(422, "validation", "Validation failed", { errors: [{ field: "projectId", code: "immutable", message: "m" }] }) : null,
    });
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 30);
    await pass(31);
    const renamed: NormalizedMapping = { ...MAPPING, taskId: TASK };
    ev("PostToolUse", 60, renamed);
    ev("Stop", 90, renamed);
    await pass(91);
    await pass(400);
    const [old, next] = h.store.segmentsForSession("s-1");
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(h.store.listTerminal()).toEqual([]);
    // The refused revision wrote nothing: the old segment's final revision carries its end and usage again.
    const ofOld = puts(server.requests).filter((p) => p.id === old!.id);
    expect(ofOld.at(-1)!.body).toMatchObject({ final: true, taskId: null, stoppedAt: at(60) });
    expect(ofOld.at(-1)!.body.usage).toBeDefined();
    expect(entries.get(old!.id)).toMatchObject({ finalized: true, stoppedAt: at(60) });
    expect(entries.get(next!.id)).toMatchObject({ taskId: TASK });
    // Bounded: a handful of requests, no repeated split.
    expect(puts(server.requests).length).toBeLessThan(10);
    expect(readPendingRename(h.store, old!.id)).toBeNull();
  });

  it("422 immutable on a heartbeat (never caused by the plugin): closed locally, not terminal, the next activity opens a new segment", async () => {
    const { h, ev, pass } = setup();
    let refuse = false;
    const { server } = await fakeTickr(h, {
      applies: true,
      intercept: (_req, _body, e) => (refuse && e !== undefined ? problem(422, "validation", "Validation failed", { errors: [{ field: "projectId", code: "immutable", message: "m" }] }) : null),
    });
    ev("UserPromptSubmit", 0);
    await pass(1);
    refuse = true;
    ev("PostToolUse", 120);
    await pass(121);
    const [first] = h.store.segmentsForSession("s-1");
    expect(first).toMatchObject({ final: true, serverState: "immutable" });
    expect(h.store.listTerminal()).toEqual([]);
    const before = puts(server.requests).length;
    await pass(300);
    expect(puts(server.requests).length).toBe(before);
    ev("PostToolUse", 400);
    await pass(401);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(2);
    expect(puts(server.requests).at(-1)!.id).toBe(h.store.segmentsForSession("s-1")[1]!.id);
  });

  it("another 422 (too_long, invalid…) on the probe: the change is given up, the segment goes on with the accepted mapping, end and usage; one notice; never resent", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: true });
    ev("UserPromptSubmit", 0);
    ev("PostToolUse", 30);
    await pass(31);
    // A task that is not one of the project's: 422 invalid on taskId.
    const refused: NormalizedMapping = { ...MAPPING, taskId: "9f9f9f9f-0000-4000-8000-0000000000aa" };
    ev("PostToolUse", 60, refused);
    ev("PostToolUse", 90, refused);
    await pass(91);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    const seg = segments[0]!;
    expect(seg.final).toBe(false);
    expect(mappingOf(h, seg.mappingVersionId)).toEqual(MAPPING);
    expect(h.store.isTerminal("segment", seg.id)).toBe(false);
    expect(entries.get(seg.id)).toMatchObject({ taskId: null, stoppedAt: at(90) });
    const kinds = h.store.listNotices().map((n) => n.kind);
    expect(kinds).toEqual(["rename_refused:invalid"]);
    expect(noticeMessage(kinds[0]!)).toBe("Tickr refused the new task or description of this session (invalid); the previous ones are kept.");
    // More activity with the refused mapping: the refused payload is not sent again.
    const before = puts(server.requests).length;
    ev("PostToolUse", 150, refused);
    ev("Stop", 180, refused);
    await pass(181);
    const after = puts(server.requests).slice(before);
    expect(after.length).toBeGreaterThan(0);
    expect(after.every((p) => p.id === seg.id && p.body.taskId === null)).toBe(true);
    expect(puts(server.requests).filter((p) => p.body.taskId !== null)).toHaveLength(1);
    expect(entries.get(seg.id)).toMatchObject({ stoppedAt: at(180) });
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
  });

  it("409 entry_locked on the probe: one notice, no split, no new entries", async () => {
    const { h, ev, pass } = setup();
    let locked = false;
    const { server } = await fakeTickr(h, { applies: true, intercept: () => (locked ? problem(409, "conflict", "entry_locked") : null) });
    ev("UserPromptSubmit", 0);
    await pass(1);
    locked = true;
    const renamed: NormalizedMapping = { ...MAPPING, description: "Mobile app UI" };
    ev("PostToolUse", 60, renamed);
    await pass(61);
    ev("PostToolUse", 2000, renamed);
    ev("PostToolUse", 4000, renamed);
    await pass(4001);
    expect(h.store.segmentsForSession("s-1")).toHaveLength(1);
    expect(h.store.listTerminal().map((t) => t.code)).toEqual(["entry_locked"]);
    expect(h.store.getSession("s-1")!.state).toBe(STOPPED_LOCKED);
    expect(h.store.listNotices().map((n) => n.kind)).toEqual(["entry_locked"]);
    expect(noticeMessage("entry_locked")).toBe("Tickr says this period is already submitted; the session is not recorded further.");
    expect(puts(server.requests)).toHaveLength(2);
  });

  it.each<[string, FakeOptions]>([
    ["a Tickr that keeps the old values", { applies: false }],
    [
      "422 immutable",
      {
        applies: true,
        intercept: (_req, body, e) =>
          e !== undefined && body.taskId === TASK ? problem(422, "validation", "Validation failed", { errors: [{ field: "projectId", code: "immutable", message: "m" }] }) : null,
      },
    ],
  ])("%s on a probe answered after the session was locked: the repair opens no sendable segment, the held entry keeps its update", async (_name, fake) => {
    const { h, ev, pass } = setup();
    const { server } = await fakeTickr(h, fake);
    ev("UserPromptSubmit", 0);
    await pass(1);
    const held = h.store.segmentsForSession("s-1")[0]!;
    expect(held.createdOnServer).toBe(true);
    ev("PostToolUse", 60, { ...MAPPING, taskId: TASK });
    h.setNow(at(61));
    for (const name of ["workspace", "segmentation", "ledger", "revisions"] as const) await PIPELINE[name](h.ctx);
    expect(readPendingRename(h.store, held.id)).not.toBeNull(); // the probe is committed, not sent
    const before = puts(server.requests).length;
    // Another segment of the session was refused (entry_locked) while the probe was in flight.
    h.store.upsertSession({ ...h.store.getSession("s-1")!, state: STOPPED_LOCKED });
    await pass(62);
    await pass(400);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    const child = segments[1]!;
    expect(h.store.isTerminal("segment", child.id)).toBe(true);
    expect(child.final).toBe(true);
    expect(puts(server.requests).some((p) => p.id === child.id)).toBe(false);
    // The entry Tickr holds still gets its final revision, with the mapping it was created with.
    const ofHeld = puts(server.requests).slice(before).filter((p) => p.id === held.id);
    expect(ofHeld.length).toBeGreaterThan(0);
    expect(ofHeld.at(-1)!.body).toMatchObject({ final: true, taskId: null });
    expect(h.store.pendingOutboxCount()).toBe(0);
  });

  it("409 segment_finalized when the end of a segment Tickr finalised moves: closed, the next activity opens a new segment", async () => {
    const { h, ev, pass } = setup();
    const { server, entries } = await fakeTickr(h, { applies: true });
    ev("UserPromptSubmit", 0);
    await pass(1);
    // Tickr finalised the entry meanwhile (its lease expired): a rename keeping its end is applied,
    // a revision that moves its end is refused.
    const seg = h.store.segmentsForSession("s-1")[0]!;
    entries.set(seg.id, { ...entries.get(seg.id)!, finalized: true });
    const renamed: NormalizedMapping = { ...MAPPING, description: "Mobile app UI" };
    ev("PostToolUse", 60, renamed);
    await pass(61);
    expect(h.store.getSegment(seg.id)).toMatchObject({ final: true, serverState: "finalized" });
    expect(readPendingRename(h.store, seg.id)).toBeNull();
    ev("PostToolUse", 120, renamed);
    await pass(121);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(entries.get(segments[1]!.id)).toMatchObject({ description: "Mobile app UI" });
    expect(puts(server.requests).filter((p) => p.id === seg.id)).toHaveLength(2);
  });
});

describe("a terminal segment", () => {
  it("a change on a segment Tickr refused for good splits: a new segment carries the corrected task and is sent", async () => {
    const { h, ev, pass } = setup();
    const BAD = "9f9f9f9f-0000-4000-8000-0000000000bb";
    const { server, entries } = await fakeTickr(h, {
      applies: true,
      intercept: (_req, body) => (body.taskId === BAD ? problem(422, "validation", "Validation failed", { errors: [{ field: "taskId", code: "invalid", message: "m" }] }) : null),
    });
    h.ctx.guarded(() => writeRenameSupport(h.store, "supported", new Date(T0)));
    // The creation carries a task of another project: refused (422), the segment terminal and still open.
    ev("UserPromptSubmit", 0, { ...MAPPING, taskId: BAD });
    await pass(1);
    const [refused] = h.store.segmentsForSession("s-1");
    expect(h.store.isTerminal("segment", refused!.id)).toBe(true);
    expect(refused!.final).toBe(false);
    // The user corrects the task: not a rename of the terminal segment, a new one that is sent.
    const corrected: NormalizedMapping = { ...MAPPING, taskId: TASK };
    ev("PostToolUse", 60, corrected);
    ev("Stop", 90, corrected);
    await pass(91);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(2);
    expect(readPendingRename(h.store, refused!.id)).toBeNull();
    const next = segments[1]!;
    expect(h.store.isTerminal("segment", next.id)).toBe(false);
    expect(entries.get(next.id)).toMatchObject({ taskId: TASK, stoppedAt: at(90) });
    expect(puts(server.requests).filter((p) => p.id === refused!.id)).toHaveLength(1);
  });
});

describe("replays", () => {
  it("503 on the probe: the retry resends the very same bytes, an explicit taskId null included", async () => {
    const { h, ev, pass } = setup();
    let busy = 2;
    const { server, entries } = await fakeTickr(h, {
      applies: true,
      intercept: (_req, body) => (body.revision === 2 && busy-- > 0 ? problem(503, "service_unavailable", "workspace_busy", {}, { "retry-after": "1" }) : null),
    });
    ev("UserPromptSubmit", 0, { ...MAPPING, taskId: TASK });
    await pass(1);
    ev("PostToolUse", 60, MAPPING);
    await pass(61, 1);
    await pass(63, 1);
    await pass(65);
    const probes = puts(server.requests).filter((p) => p.body.revision === 2);
    expect(probes.length).toBe(3);
    expect(new Set(probes.map((p) => p.raw)).size).toBe(1);
    expect(probes[0]!.raw).toContain('"taskId":null');
    expect(entries.get(h.store.segmentsForSession("s-1")[0]!.id)).toMatchObject({ taskId: null });
  });

  it("409 agent_revision_conflict on the probe: the probe goes again under the next number, then resolves", async () => {
    const { h, ev, pass } = setup();
    let conflicts = 1;
    const { server, entries } = await fakeTickr(h, {
      applies: true,
      intercept: (_req, body) => (body.revision === 2 && conflicts-- > 0 ? problem(409, "conflict", "agent_revision_conflict") : null),
    });
    ev("UserPromptSubmit", 0);
    await pass(1);
    const renamed: NormalizedMapping = { ...MAPPING, description: "Mobile app UI" };
    ev("PostToolUse", 60, renamed);
    await pass(61);
    const sent = puts(server.requests);
    const two = sent.filter((p) => p.body.revision === 2);
    const three = sent.find((p) => p.body.revision === 3)!;
    expect(two).toHaveLength(1);
    expect({ ...three.body, revision: 2 }).toEqual(two[0]!.body);
    const segments = h.store.segmentsForSession("s-1");
    expect(segments).toHaveLength(1);
    expect(h.store.listTerminal()).toEqual([]);
    expect(entries.get(segments[0]!.id)).toMatchObject({ description: "Mobile app UI" });
    expect(readRenameSupport(h.store)?.state).toBe("supported");
  });
});
