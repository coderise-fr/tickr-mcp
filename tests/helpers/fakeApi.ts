import { vi, type Mock } from "vitest";
import type { TickrApi } from "../../src/api/client.js";
import { entryFixture, meFixture, projectFixture, tagFixture, taskFixture } from "./fixtures.js";

export type FakeApi = { [K in keyof TickrApi]: Mock<TickrApi[K]> };

export function fakeApi(): FakeApi {
  return {
    me: vi.fn<TickrApi["me"]>().mockResolvedValue(meFixture()),
    listActiveTimers: vi.fn<TickrApi["listActiveTimers"]>().mockResolvedValue([]),
    startTimer: vi.fn<TickrApi["startTimer"]>().mockResolvedValue(entryFixture({ stoppedAt: null, durationSeconds: null })),
    stopTimer: vi.fn<TickrApi["stopTimer"]>().mockResolvedValue(entryFixture()),
    listEntries: vi.fn<TickrApi["listEntries"]>().mockResolvedValue({ data: [entryFixture()], page: { next_cursor: null, has_more: false } }),
    createEntry: vi.fn<TickrApi["createEntry"]>().mockResolvedValue(entryFixture()),
    updateEntry: vi.fn<TickrApi["updateEntry"]>().mockResolvedValue(entryFixture()),
    listProjects: vi.fn<TickrApi["listProjects"]>().mockResolvedValue([projectFixture()]),
    listTasks: vi.fn<TickrApi["listTasks"]>().mockResolvedValue([taskFixture()]),
    listTags: vi.fn<TickrApi["listTags"]>().mockResolvedValue([tagFixture()]),
  };
}
