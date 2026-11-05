import { appendFileSync, copyFileSync, cpSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { DB_FILE, openStore, type Store } from "../../hook-src/store/db.js";
import {
  agentIdOfPath,
  commitRead,
  HEAD_BYTES,
  readSubagentMeta,
  readTranscript,
  subagentTranscripts,
} from "../../hook-src/transcript/reader.js";
import { cleanTempDirs, tempDir } from "./helpers/env.js";

afterEach(() => cleanTempDirs());

const FIXTURES = join(import.meta.dirname, "fixtures", "transcripts");
const AGENT = "a0000000000000001";

function store(dir: string): Store {
  return openStore(join(dir, DB_FILE), { role: "flusher", busyTimeoutMs: 5000 }) as Store;
}

/** Reads the file and saves its offset, as the ledger stage does. */
function readAndCommit(s: Store, path: string) {
  const read = readTranscript(s, path, { sessionId: "s-1", now: new Date("2026-11-05T12:00:00.000Z") });
  commitRead(s, read);
  return read;
}

function copy(name: string, dir: string): string {
  const path = join(dir, name.replaceAll("/", "_"));
  copyFileSync(join(FIXTURES, name), path);
  return path;
}

describe("readTranscript", () => {
  it("reads a whole transcript once: complete, the version, offset at the end", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = copy("session-main.jsonl", dir);
    const read = readAndCommit(s, path);
    expect(read.status).toBe("complete");
    expect(read.version).toBe("2.1.300");
    expect(read.rescanned).toBe(false);
    expect(read.messages.map((m) => m.messageId)).toEqual(["msg_0001", "msg_0002", "msg_0003"]);
    const size = readFileSync(path).length;
    expect(s.getTranscriptOffset(path)).toMatchObject({ offset: size, size, sessionId: "s-1", status: "complete", readAt: "2026-11-05T12:00:00.000Z" });

    const again = readAndCommit(s, path);
    expect(again).toMatchObject({ status: "complete", messages: [], launches: [], rescanned: false });
    s.close();
  });

  it("partial trailing line ⇒ partial, the offset stops before it, the line is read whole next time", () => {
    const dir = tempDir();
    const s = store(dir);
    const full = readFileSync(join(FIXTURES, "accumulating.jsonl"), "utf8");
    const lines = full.split("\n");
    const path = join(dir, "t.jsonl");
    const head = `${lines[0]}\n${lines[1]}\n`;
    writeFileSync(path, head + lines[2]!.slice(0, 50));

    const first = readAndCommit(s, path);
    expect(first.status).toBe("partial");
    expect(first.messages).toEqual([expect.objectContaining({ messageId: "msg_0201", output: 64 })]);
    expect(s.getTranscriptOffset(path)!.offset).toBe(Buffer.byteLength(head));

    appendFileSync(path, `${lines[2]!.slice(50)}\n`);
    const second = readAndCommit(s, path);
    expect(second.status).toBe("complete");
    expect(second.rescanned).toBe(false);
    expect(second.messages).toEqual([expect.objectContaining({ messageId: "msg_0201", output: 333 })]);
    s.close();
  });

  it("appended lines are read alone", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = copy("session-main.jsonl", dir);
    readAndCommit(s, path);
    appendFileSync(path, readFileSync(join(FIXTURES, "accumulating.jsonl")));
    const read = readAndCommit(s, path);
    expect(read.messages.map((m) => m.messageId)).toEqual(["msg_0201"]);
    s.close();
  });

  it("shrunk file ⇒ full rescan", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = copy("session-main.jsonl", dir);
    readAndCommit(s, path);
    const lines = readFileSync(path, "utf8").split("\n");
    writeFileSync(path, `${lines.slice(0, 5).join("\n")}\n`);
    const read = readAndCommit(s, path);
    expect(read.rescanned).toBe(true);
    expect(read.status).toBe("complete");
    expect(read.messages.map((m) => m.messageId)).toEqual(["msg_0001"]);
    expect(s.getTranscriptOffset(path)!.offset).toBe(readFileSync(path).length);
    s.close();
  });

  it("file replaced by another of a larger size (changed head) ⇒ full rescan", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = copy("accumulating.jsonl", dir);
    readAndCommit(s, path);
    const replaced = readFileSync(join(FIXTURES, "session-main.jsonl"));
    expect(replaced.length).toBeGreaterThan(readFileSync(path).length);
    writeFileSync(path, replaced);
    const read = readAndCommit(s, path);
    expect(read.rescanned).toBe(true);
    expect(read.messages.map((m) => m.messageId)).toEqual(["msg_0001", "msg_0002", "msg_0003"]);
    s.close();
  });

  it("a file that grows past HEAD_BYTES keeps its head hash (no false rescan)", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = join(dir, "t.jsonl");
    const line = readFileSync(join(FIXTURES, "accumulating.jsonl"), "utf8").split("\n")[0]!;
    writeFileSync(path, `${line}\n`);
    readAndCommit(s, path);
    let more = "";
    while (more.length < HEAD_BYTES * 2) more += `${line.replace("msg_0201", `msg_x${more.length}`)}\n`;
    appendFileSync(path, more);
    expect(readAndCommit(s, path).rescanned).toBe(false);
    appendFileSync(path, `${line.replace("msg_0201", "msg_last")}\n`);
    const last = readAndCommit(s, path);
    expect(last.rescanned).toBe(false);
    expect(last.messages.map((m) => m.messageId)).toEqual(["msg_last"]);
    s.close();
  });

  it("malformed lines ⇒ partial, the valid messages are kept and the offset moves on", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = copy("malformed.jsonl", dir);
    const read = readAndCommit(s, path);
    expect(read.status).toBe("partial");
    expect(read.malformed).toBe(2);
    expect(read.messages.map((m) => m.messageId)).toEqual(["msg_0301", "msg_0303"]);
    expect(s.getTranscriptOffset(path)!.offset).toBe(readFileSync(path).length);
    expect(readAndCommit(s, path).status).toBe("complete");
    s.close();
  });

  it("unknown shape ⇒ unavailable, nothing read, the offset does not move", () => {
    const dir = tempDir();
    const s = store(dir);
    for (const name of ["unknown-shape.jsonl", "unknown-usage.jsonl"]) {
      const path = copy(name, dir);
      const read = readAndCommit(s, path);
      expect(read).toMatchObject({ status: "unavailable", messages: [] });
      expect(s.getTranscriptOffset(path)).toMatchObject({ offset: 0, status: "unavailable" });
    }
    s.close();
  });

  it("missing file ⇒ unavailable; a read offset already saved is kept", () => {
    const dir = tempDir();
    const s = store(dir);
    expect(readAndCommit(s, join(dir, "none.jsonl")).status).toBe("unavailable");
    const path = copy("session-main.jsonl", dir);
    readAndCommit(s, path);
    const offset = s.getTranscriptOffset(path)!.offset;
    rmSync(path);
    expect(readAndCommit(s, path).status).toBe("unavailable");
    expect(s.getTranscriptOffset(path)).toMatchObject({ offset, status: "unavailable" });
    s.close();
  });

  it("an empty file is a complete read of nothing", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = join(dir, "empty.jsonl");
    writeFileSync(path, "");
    expect(readAndCommit(s, path)).toMatchObject({ status: "complete", messages: [] });
    s.close();
  });

  it("an uncommitted read does not move the offset", () => {
    const dir = tempDir();
    const s = store(dir);
    const path = copy("session-main.jsonl", dir);
    readTranscript(s, path);
    expect(s.getTranscriptOffset(path)).toBeNull();
    expect(readTranscript(s, path).messages).toHaveLength(3);
    s.close();
  });
});

describe("subagent transcripts", () => {
  it("lists <session>/subagents/agent-<id>.jsonl beside the main transcript and reads the launching tool_use id from .meta.json", () => {
    const dir = tempDir();
    cpSync(FIXTURES, dir, { recursive: true });
    const main = join(dir, "session-main.jsonl");
    const subs = subagentTranscripts(main);
    expect(subs).toEqual([{ agentId: AGENT, path: join(dir, "session-main", "subagents", `agent-${AGENT}.jsonl`) }]);
    expect(agentIdOfPath(subs[0]!.path)).toBe(AGENT);
    expect(agentIdOfPath(main)).toBeNull();
    expect(readSubagentMeta(subs[0]!.path)).toEqual({ toolUseId: "toolu_agent_0001" });
    expect(readSubagentMeta(main)).toBeNull();
    expect(subagentTranscripts(join(dir, "accumulating.jsonl"))).toEqual([]);

    const s = store(tempDir());
    const read = readAndCommit(s, subs[0]!.path);
    expect(read.status).toBe("complete");
    expect(read.messages.every((m) => m.sidechain && m.agentId === AGENT)).toBe(true);
    s.close();
  });
});
