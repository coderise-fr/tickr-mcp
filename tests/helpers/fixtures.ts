import type { EntryDto, MeDto, ProjectDto, TagDto, TaskDto } from "../../src/api/types.js";

export const NOW = new Date("2026-10-02T10:00:00Z");

export const IDS = {
  entry: "0199a000-0000-7000-8000-000000000001",
  entry2: "0199a000-0000-7000-8000-000000000002",
  user: "0199a000-0000-7000-8000-0000000000a1",
  projectA: "0199a000-0000-7000-8000-0000000000b1",
  projectB: "0199a000-0000-7000-8000-0000000000b2",
  taskA: "0199a000-0000-7000-8000-0000000000c1",
  client: "0199a000-0000-7000-8000-0000000000d1",
  tag: "0199a000-0000-7000-8000-0000000000e1",
  workspace: "0199a000-0000-7000-8000-0000000000f1",
} as const;

type Extra = Record<string, unknown>;

export function entryFixture(over: Partial<EntryDto> = {}): EntryDto & Extra {
  return {
    id: IDS.entry, userId: IDS.user, projectId: IDS.projectA, projectName: "Acme website",
    projectColor: "#3366cc", clientId: IDS.client, clientName: "Acme", taskId: null,
    description: "Homepage", startedAt: "2026-10-02T08:00:00+00:00", stoppedAt: "2026-10-02T09:30:00+00:00",
    durationSeconds: 5400, tagIds: [IDS.tag], createdAt: "2026-10-02T08:00:00+00:00",
    updatedAt: "2026-10-02T09:30:00+00:00", isBillable: true,
    // Fields the MCP must never return:
    billableRateSnapshot: 120, billableCurrencySnapshot: "EUR",
    ...over,
  };
}

export function projectFixture(over: Partial<ProjectDto> = {}): ProjectDto & Extra {
  return {
    id: IDS.projectA, name: "Acme website", isArchived: false, clientId: IDS.client, clientName: "Acme",
    color: "#3366cc", visibility: "private", createdAt: "2026-01-01T00:00:00+00:00",
    updatedAt: "2026-01-01T00:00:00+00:00", defaultIsBillable: true,
    ...over,
  };
}

export function taskFixture(over: Partial<TaskDto> = {}): TaskDto & Extra {
  return {
    id: IDS.taskA, projectId: IDS.projectA, name: "Design", isArchived: false,
    createdAt: "2026-01-01T00:00:00+00:00", updatedAt: "2026-01-01T00:00:00+00:00",
    ...over,
  };
}

export function tagFixture(over: Partial<TagDto> = {}): TagDto & Extra {
  return {
    id: IDS.tag, name: "meeting", color: "#ff0000", usageCount: 412,
    lastUsedAt: "2026-10-01T17:00:00+00:00", createdAt: "2026-01-01T00:00:00+00:00",
    ...over,
  };
}

export function meFixture(over: Partial<MeDto> = {}): MeDto {
  return {
    user: { id: IDS.user, displayName: "Julien", email: "julien@example.com", timezone: "Europe/Paris" },
    workspace: { id: IDS.workspace, name: "Coderise", timezone: "Europe/Paris" },
    role: "workspace_user",
    keyRole: "workspace_user",
    serverTime: "2026-10-02T10:00:00+00:00",
    ...over,
  };
}
