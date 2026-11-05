import { describe, expect, it } from "vitest";
import {
  applyEvent,
  closedByServer,
  DRIFT_DIAGNOSTIC,
  idleDueInMs,
  newSessionState,
  onWake,
  type SegmentChange,
  type SegmenterConfig,
  type SegmentEvent,
  type SessionState,
} from "../../hook-src/flusher/segmenter.js";

const MIN = 60_000;

/** Fake clocks: a wall time (ISO) and an uptime (seconds) per event. */
function ev(type: string, localTime: string, uptimeS: number, mappingVersionId: number | null = 1): SegmentEvent {
  return { type, localTime, uptimeS, mappingVersionId };
}

function config(idleMinutes = 15): SegmenterConfig {
  let n = 0;
  return { idleMs: idleMinutes * MIN, newId: () => `seg-${++n}` };
}

/** Runs events through the reducer; returns the final state and every change in order. */
function run(events: SegmentEvent[], cfg = config(), from: SessionState = newSessionState("s-1")) {
  let state = from;
  const changes: SegmentChange[] = [];
  for (const e of events) {
    const out = applyEvent(state, e, cfg);
    state = out.state;
    changes.push(...out.changes);
  }
  return { state, changes };
}

const finals = (changes: SegmentChange[]) => changes.filter((c) => c.kind === "finalize");
const opens = (changes: SegmentChange[]) => changes.flatMap((c) => (c.kind === "open" ? [c.seg] : []));

/** Wall time `minutes` after 2026-11-05T10:00:00Z, with an uptime that agrees. */
const T0 = Date.parse("2026-11-05T10:00:00.000Z");
const at = (minutes: number) => new Date(T0 + minutes * MIN).toISOString();
const up = (minutes: number) => 5000 + minutes * 60;

describe("applyEvent", () => {
  it("opens on UserPromptSubmit, extends on PostToolUse and Stop (working false), never opens on Stop", () => {
    const stopOnly = run([ev("Stop", at(0), up(0))]);
    expect(stopOnly.changes).toEqual([]);
    expect(stopOnly.state.open).toBeNull();

    const { state, changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(2), up(2)), ev("Stop", at(3), up(3))]);
    expect(opens(changes)).toEqual([{ id: "seg-1", mappingVersionId: 1, startedAt: at(0), lastActivityAt: at(0), working: true, observedAt: at(0) }]);
    expect(changes.at(-1)).toEqual({ kind: "extend", id: "seg-1", lastActivityAt: at(3), working: false, observedAt: at(3) });
    expect(state).toMatchObject({ open: { id: "seg-1", lastActivityAt: at(3), working: false }, lastEventTime: at(3), lastUptimeS: up(3) });
  });

  it("PostToolUse opens a segment when none is open (tool activity after an idle finalisation)", () => {
    const { changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(16), up(16))]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "idle" }]);
    expect(opens(changes).map((s) => [s.id, s.startedAt])).toEqual([
      ["seg-1", at(0)],
      ["seg-2", at(16)],
    ]);
  });

  it("idle split at 15 min, none at 14:59", () => {
    const split = run([ev("UserPromptSubmit", at(0), up(0)), ev("UserPromptSubmit", at(15), up(15))]);
    expect(finals(split.changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "idle" }]);
    expect(split.state.open).toMatchObject({ id: "seg-2", startedAt: at(15) });

    const almost = run([ev("UserPromptSubmit", at(0), up(0)), ev("UserPromptSubmit", at(14 + 59 / 60), up(14 + 59 / 60))]);
    expect(finals(almost.changes)).toEqual([]);
    expect(almost.state.open).toMatchObject({ id: "seg-1", lastActivityAt: at(14 + 59 / 60) });
  });

  it("honours another idle_minutes", () => {
    const cfg = config(30);
    expect(finals(run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(29), up(29))], cfg).changes)).toEqual([]);
    expect(finals(run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(30), up(30))], config(30)).changes)).toHaveLength(1);
  });

  it("turn crossing exactly UTC midnight ⇒ stoppedAt 00:00:00Z and next startedAt 00:00:00Z", () => {
    const { state, changes } = run([
      ev("UserPromptSubmit", "2026-11-05T23:55:00.000Z", 100),
      ev("PostToolUse", "2026-11-05T23:59:30.000Z", 370),
      ev("PostToolUse", "2026-11-06T00:02:00.000Z", 520),
      ev("Stop", "2026-11-06T00:04:00.000Z", 640),
    ]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: "2026-11-06T00:00:00.000Z", reason: "midnight" }]);
    expect(opens(changes)[1]).toEqual({
      id: "seg-2",
      mappingVersionId: 1,
      startedAt: "2026-11-06T00:00:00.000Z",
      lastActivityAt: "2026-11-06T00:02:00.000Z",
      working: true,
      observedAt: "2026-11-06T00:02:00.000Z",
    });
    expect(state.open).toMatchObject({ id: "seg-2", lastActivityAt: "2026-11-06T00:04:00.000Z", working: false });
  });

  it("activity exactly at midnight extends to midnight (half-open bound), the next event splits there", () => {
    const { changes } = run([
      ev("UserPromptSubmit", "2026-11-05T23:55:00.000Z", 100),
      ev("PostToolUse", "2026-11-06T00:00:00.000Z", 400),
      ev("PostToolUse", "2026-11-06T00:01:00.000Z", 460),
    ]);
    expect(changes[1]).toMatchObject({ kind: "extend", lastActivityAt: "2026-11-06T00:00:00.000Z" });
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: "2026-11-06T00:00:00.000Z", reason: "midnight" }]);
    expect(opens(changes)[1]!.startedAt).toBe("2026-11-06T00:00:00.000Z");
  });

  it("a Stop after midnight continues the turn in the next day's segment", () => {
    const { changes, state } = run([ev("UserPromptSubmit", "2026-11-05T23:58:00.000Z", 100), ev("Stop", "2026-11-06T00:03:00.000Z", 400)]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: "2026-11-06T00:00:00.000Z", reason: "midnight" }]);
    expect(state.open).toMatchObject({ id: "seg-2", startedAt: "2026-11-06T00:00:00.000Z", lastActivityAt: "2026-11-06T00:03:00.000Z", working: false });
  });

  it("23 h split", () => {
    // Started at 00:30Z: 23 h later (23:30Z) comes before the next midnight.
    const start = Date.parse("2026-11-05T00:30:00.000Z");
    const events: SegmentEvent[] = [];
    for (let m = 0; m <= 23 * 60 + 15; m += 10) events.push(ev(m === 0 ? "UserPromptSubmit" : "PostToolUse", new Date(start + m * MIN).toISOString(), 100 + m * 60));
    const { state, changes } = run(events);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: "2026-11-05T23:30:00.000Z", reason: "max_duration" }]);
    expect(state.open).toMatchObject({ id: "seg-2", startedAt: "2026-11-05T23:30:00.000Z" });
    const segOne = opens(changes)[0]!;
    expect(Date.parse("2026-11-05T23:30:00.000Z") - Date.parse(segOne.startedAt)).toBe(23 * 3_600_000);
  });

  it("mapping change splits at the event", () => {
    const { state, changes } = run([ev("UserPromptSubmit", at(0), up(0), 1), ev("PostToolUse", at(5), up(5), 2)]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(5), reason: "mapping" }]);
    expect(state.open).toMatchObject({ id: "seg-2", mappingVersionId: 2, startedAt: at(5) });
  });

  it("a Stop carrying another mapping version still ends the turn of the open segment", () => {
    const { state, changes } = run([ev("UserPromptSubmit", at(0), up(0), 1), ev("Stop", at(5), up(5), 2)]);
    expect(finals(changes)).toEqual([]);
    expect(state.open).toMatchObject({ id: "seg-1", mappingVersionId: 1, lastActivityAt: at(5), working: false });
  });

  it("20-minute build (deltas agree) ⇒ no split", () => {
    // idle_minutes 30 isolates the clock rule: the 20-minute gap is not idle.
    const { changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(20), up(20))], config(30));
    expect(finals(changes)).toEqual([]);
    expect(changes.at(-1)).toMatchObject({ kind: "extend", lastActivityAt: at(20) });
  });

  it("wall clock moved forward, uptime grows ⇒ split", () => {
    // 3 minutes of uptime, 13 minutes of wall time: under the idle threshold, but a proven jump.
    const { state, changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(13), up(3))]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "clock_jump", diagnostic: DRIFT_DIAGNOSTIC }]);
    expect(state.open).toMatchObject({ id: "seg-2", startedAt: at(13) });
  });

  it("small disagreements (≤ 2 min) are not a jump", () => {
    const { changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(5), up(3))]);
    expect(finals(changes)).toEqual([]);
  });

  it("backwards jump ⇒ finalised at last activity, non-contiguous next segment", () => {
    const { state, changes } = run([
      ev("UserPromptSubmit", at(0), up(0)),
      ev("PostToolUse", at(4), up(4)),
      // The wall clock went back 10 minutes while uptime moved on by one.
      ev("PostToolUse", at(-5), up(5)),
    ]);
    expect(finals(changes)).toEqual([
      { kind: "finalize", id: "seg-1", stoppedAt: at(4), reason: "clock_jump", diagnostic: "wall clock moved backwards" },
    ]);
    expect(state.open).toMatchObject({ id: "seg-2", startedAt: at(-5), lastActivityAt: at(-5) });
    expect(state.lastEventTime).toBe(at(-5));
    expect(state.lateEvents).toBe(0);
  });

  it("reboot (uptime decreases) ⇒ no jump concluded, idle rule applies", () => {
    const short = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(5), 30)]);
    expect(finals(short.changes)).toEqual([]);
    expect(short.state.open).toMatchObject({ id: "seg-1", lastActivityAt: at(5) });

    const long = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(40), 30)]);
    expect(finals(long.changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "idle" }]);
    expect(long.state.lastUptimeS).toBe(30);
  });

  it('reboot with a later uptime above the previous ⇒ split only, "clock drift or possible reboot"', () => {
    // Before: uptime 100 s. Rebooted, up for 3000 s when the next event arrives one hour later.
    const { changes } = run([ev("UserPromptSubmit", at(0), 100), ev("UserPromptSubmit", at(60), 3000)]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "clock_jump", diagnostic: DRIFT_DIAGNOSTIC }]);
    expect(opens(changes).map((s) => s.startedAt)).toEqual([at(0), at(60)]);
  });

  it("sleep where uptime keeps counting ⇒ idle split; where it stops ⇒ forward jump split", () => {
    const counting = run([ev("UserPromptSubmit", at(0), up(0)), ev("UserPromptSubmit", at(45), up(45))]);
    expect(finals(counting.changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "idle" }]);

    const stopped = run([ev("UserPromptSubmit", at(0), up(0)), ev("UserPromptSubmit", at(45), up(0) + 2)]);
    expect(finals(stopped.changes)).toEqual([
      { kind: "finalize", id: "seg-1", stoppedAt: at(0), reason: "clock_jump", diagnostic: DRIFT_DIAGNOSTIC },
    ]);
    expect(stopped.state.open).toMatchObject({ startedAt: at(45) });
  });

  it("SessionEnd ⇒ finalised, no extension", () => {
    const { state, changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("Stop", at(5), up(5)), ev("SessionEnd", at(7), up(7))]);
    expect(finals(changes)).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(5), reason: "session_end" }]);
    expect(state.open).toBeNull();
    expect(state.lastEventTime).toBe(at(7));
  });

  it("events that are not activity only move the clock cursor", () => {
    const { state, changes } = run([ev("UserPromptSubmit", at(0), up(0)), ev("SessionStart", at(3), up(3)), ev("SubagentStart", at(4), up(4))]);
    expect(changes).toHaveLength(1);
    expect(state.open).toMatchObject({ lastActivityAt: at(0) });
    expect(state.lastEventTime).toBe(at(4));
  });

  it("crash before the first Stop ⇒ finalised by idle on a later wake", () => {
    const cfg = config();
    const { state } = run([ev("UserPromptSubmit", at(0), up(0)), ev("PostToolUse", at(1), up(1))], cfg);
    expect(onWake(state, new Date(at(15.9)), cfg).changes).toEqual([]);
    expect(idleDueInMs(state, new Date(at(15.9)), cfg)).toBe(0.1 * MIN);
    const woken = onWake(state, new Date(at(16)), cfg);
    expect(woken.changes).toEqual([{ kind: "finalize", id: "seg-1", stoppedAt: at(1), reason: "idle" }]);
    expect(woken.state.open).toBeNull();
    expect(idleDueInMs(woken.state, new Date(at(16)), cfg)).toBeNull();
  });

  it("two sessions interleaved ⇒ independent segments", () => {
    const cfg = config();
    let a = newSessionState("s-a");
    let b = newSessionState("s-b");
    const step = (s: SessionState, e: SegmentEvent) => applyEvent(s, e, cfg).state;
    a = step(a, ev("UserPromptSubmit", at(0), up(0)));
    b = step(b, ev("UserPromptSubmit", at(1), up(1), 2));
    a = step(a, ev("PostToolUse", at(2), up(2)));
    b = step(b, ev("Stop", at(3), up(3), 2));
    a = step(a, ev("PostToolUse", at(4), up(4)));
    expect(a.open).toMatchObject({ id: "seg-1", mappingVersionId: 1, startedAt: at(0), lastActivityAt: at(4), working: true });
    expect(b.open).toMatchObject({ id: "seg-2", mappingVersionId: 2, startedAt: at(1), lastActivityAt: at(3), working: false });
  });

  it("late event outside the open segment ⇒ lateEvents + 1, nothing reopened", () => {
    const cfg = config();
    const { state } = run([ev("UserPromptSubmit", at(0), up(0)), ev("UserPromptSubmit", at(60), up(60)), ev("PostToolUse", at(62), up(62))], cfg);
    // A fallback file imported now: it happened at minute 30, before the cursor (wall and uptime).
    const late = applyEvent(state, ev("PostToolUse", at(30), up(30)), cfg);
    expect(late.changes).toEqual([]);
    expect(late.state.lateEvents).toBe(1);
    expect(late.state.open).toEqual(state.open);
    expect(late.state.lastEventTime).toBe(at(62));

    const noSegment = applyEvent({ ...state, open: null }, ev("UserPromptSubmit", at(30), up(30)), cfg);
    expect(noSegment).toEqual({ state: { ...state, open: null, lateEvents: 1 }, changes: [] });
  });

  it("late event inside the open segment extends it and is not counted", () => {
    const cfg = config();
    const { state } = run([ev("UserPromptSubmit", at(0), up(0)), ev("SessionStart", at(6), up(6))], cfg);
    const late = applyEvent(state, ev("PostToolUse", at(4), up(4)), cfg);
    expect(late.changes).toEqual([{ kind: "extend", id: "seg-1", lastActivityAt: at(4), working: true, observedAt: at(0) }]);
    expect(late.state.lateEvents).toBe(0);
    expect(late.state.lastEventTime).toBe(at(6));
  });

  it("the server closing the open segment makes the next activity open a new one", () => {
    const cfg = config();
    const { state } = run([ev("UserPromptSubmit", at(0), up(0))], cfg);
    expect(closedByServer(state, "other")).toBe(state);
    const closed = closedByServer(state, "seg-1");
    expect(closed.open).toBeNull();
    const next = applyEvent(closed, ev("PostToolUse", at(1), up(1)), cfg);
    expect(next.changes).toEqual([{ kind: "open", seg: expect.objectContaining({ id: "seg-2", startedAt: at(1) }) }]);
  });

  it("is deterministic: the same events and ids give the same segments, synthetic bounds included", () => {
    const events = [
      ev("UserPromptSubmit", "2026-11-05T23:50:00.000Z", 100),
      ev("PostToolUse", "2026-11-06T00:04:00.000Z", 940),
      ev("SessionEnd", "2026-11-06T00:05:00.000Z", 1000),
    ];
    expect(run(events)).toEqual(run(events));
    expect(finals(run(events).changes).map((c) => c.kind === "finalize" && c.stoppedAt)).toEqual([
      "2026-11-06T00:00:00.000Z",
      "2026-11-06T00:04:00.000Z",
    ]);
  });
});
