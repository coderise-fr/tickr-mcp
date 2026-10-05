// REST shapes of the Tickr public API /api/v1, verbatim (camelCase bodies,
// snake_case enum values and pagination block).

export const ROLE_CODES = ["owner", "admin", "project_lead", "analyst", "workspace_user"] as const;
export type RoleCode = (typeof ROLE_CODES)[number];

// Answers are validated at runtime by the schemas in dto.ts; their types are derived from them.
export type { EntryDto, MeDto, PagedDto, ProjectDto, TagDto, TaskDto } from "./dto.js";

export interface StartTimerBody {
  projectId?: string;
  taskId?: string;
  description?: string;
  tagIds?: string[];
  startedAt?: string;
  isBillable?: boolean;
}

export interface StopTimerBody {
  stoppedAt?: string;
}

export interface CreateEntryBody {
  projectId?: string;
  taskId?: string;
  description?: string;
  startedAt: string;
  stoppedAt: string;
  tagIds?: string[];
  isBillable?: boolean;
}

export interface UpdateEntryBody {
  projectId?: string;
  clearProject?: boolean;
  taskId?: string;
  clearTask?: boolean;
  description?: string;
  startedAt?: string;
  stoppedAt?: string;
  tagIds?: string[];
  isBillable?: boolean;
}

// Query parameter names exactly as declared by GET /api/v1/entries.
export interface ListEntriesQuery {
  from?: string;
  to?: string;
  project_id?: string;
  task_id?: string;
  tag_id?: string;
  cursor?: string;
  limit?: number;
}
