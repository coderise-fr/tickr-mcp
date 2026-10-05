// REST shapes of the Tickr public API /api/v1, verbatim (camelCase bodies,
// snake_case enum values and pagination block). Spec §5.1–5.2.

export type RoleCode = "owner" | "admin" | "project_lead" | "analyst" | "workspace_user";

export interface MeDto {
  user: { id: string; displayName: string; email: string; timezone: string };
  workspace: { id: string; name: string; timezone: string };
  role: RoleCode;
  keyRole: RoleCode;
  serverTime: string;
}

export interface EntryDto {
  id: string;
  userId: string;
  projectId: string | null;
  projectName: string | null;
  projectColor: string | null;
  clientId: string | null;
  clientName: string | null;
  taskId: string | null;
  description: string;
  startedAt: string;
  stoppedAt: string | null;
  durationSeconds: number | null;
  tagIds: string[];
  createdAt: string;
  updatedAt: string;
  isBillable: boolean;
}

export interface ProjectDto {
  id: string;
  name: string;
  isArchived: boolean;
  clientId: string | null;
  clientName: string | null;
}

export interface TaskDto {
  id: string;
  projectId: string;
  name: string;
  isArchived: boolean;
}

export interface TagDto {
  id: string;
  name: string;
}

export interface PagedDto<T> {
  data: T[];
  page: { next_cursor: string | null; has_more: boolean };
}

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
