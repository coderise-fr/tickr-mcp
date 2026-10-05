import { z } from "zod";
import type { EntryDto, MeDto, ProjectDto, TagDto, TaskDto } from "../api/types.js";
import { cleanDescription, cleanName, cleanNullableName } from "../sanitize.js";

// Allow-listed result shapes (spec §6.2). Strict: any extra field is a bug.
export const entrySchema = z.strictObject({
  id: z.string(),
  description: z.string(),
  project_id: z.string().nullable(),
  project_name: z.string().nullable(),
  client_name: z.string().nullable(),
  task_id: z.string().nullable(),
  tag_ids: z.array(z.string()),
  started_at: z.string(),
  stopped_at: z.string().nullable(),
  duration_seconds: z.number().int().nonnegative(),
  duration: z.string(),
  billable: z.boolean(),
  running: z.boolean(),
});
export const projectSchema = z.strictObject({
  id: z.string(), name: z.string(), client_name: z.string().nullable(), archived: z.boolean(),
});
export const taskSchema = z.strictObject({
  id: z.string(), project_id: z.string(), name: z.string(), archived: z.boolean(),
});
export const tagSchema = z.strictObject({ id: z.string(), name: z.string() });
export const contextSchema = z.strictObject({
  user: z.strictObject({ id: z.string(), display_name: z.string(), email: z.string(), timezone: z.string() }),
  workspace: z.strictObject({ id: z.string(), name: z.string(), timezone: z.string() }),
  role: z.string(),
  server_time: z.string(),
});

export type Entry = z.infer<typeof entrySchema>;
export type Project = z.infer<typeof projectSchema>;
export type Task = z.infer<typeof taskSchema>;
export type Tag = z.infer<typeof tagSchema>;
export type Context = z.infer<typeof contextSchema>;

export function formatDuration(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  return h > 0 ? `${h}h ${String(m).padStart(2, "0")}m` : `${m}m`;
}

export function toEntry(dto: EntryDto, now: Date): Entry {
  const running = dto.stoppedAt === null;
  const end = running ? now.getTime() : Date.parse(dto.stoppedAt as string);
  const computed = Math.floor((end - Date.parse(dto.startedAt)) / 1000);
  const seconds = Math.max(0, running ? computed : dto.durationSeconds ?? computed);
  return {
    id: dto.id,
    description: dto.description === null ? "" : cleanDescription(dto.description),
    project_id: dto.projectId,
    project_name: cleanNullableName(dto.projectName),
    client_name: cleanNullableName(dto.clientName),
    task_id: dto.taskId,
    tag_ids: [...dto.tagIds],
    started_at: dto.startedAt,
    stopped_at: dto.stoppedAt,
    duration_seconds: seconds,
    duration: formatDuration(seconds),
    billable: dto.isBillable,
    running,
  };
}

export const toProject = (dto: ProjectDto): Project => ({
  id: dto.id, name: cleanName(dto.name), client_name: cleanNullableName(dto.clientName), archived: dto.isArchived,
});

export const toTask = (dto: TaskDto): Task => ({
  id: dto.id, project_id: dto.projectId, name: cleanName(dto.name), archived: dto.isArchived,
});

export const toTag = (dto: TagDto): Tag => ({ id: dto.id, name: cleanName(dto.name) });

export const toContext = (me: MeDto): Context => ({
  user: {
    id: me.user.id,
    display_name: cleanName(me.user.displayName),
    email: cleanName(me.user.email),
    timezone: cleanName(me.user.timezone),
  },
  workspace: { id: me.workspace.id, name: cleanName(me.workspace.name), timezone: cleanName(me.workspace.timezone) },
  role: me.role,
  server_time: me.serverTime,
});
