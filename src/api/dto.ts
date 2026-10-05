import { z } from "zod";

// Runtime schemas of the Tickr answers the client hands to the tools. They are loose on
// purpose: they check only the fields the projections read, and let any extra field through
// (the projections are allow-lists and never copy it). An answer that does not match is
// reported as unreadable instead of failing later inside a projection.

const nullableString = z.string().nullable();

export const entryDtoSchema = z.looseObject({
  id: z.string(),
  projectId: nullableString,
  projectName: nullableString,
  clientName: nullableString,
  taskId: nullableString,
  // Tickr sends "" for an entry without description; null is tolerated and projected as "".
  description: nullableString,
  startedAt: z.string(),
  stoppedAt: nullableString,
  durationSeconds: z.number().nullable(),
  tagIds: z.array(z.string()),
  isBillable: z.boolean(),
});

export const pagedEntriesDtoSchema = z.looseObject({
  data: z.array(entryDtoSchema),
  page: z.looseObject({ next_cursor: nullableString, has_more: z.boolean() }),
});

export const projectDtoSchema = z.looseObject({
  id: z.string(),
  name: z.string(),
  isArchived: z.boolean(),
  clientName: nullableString,
});

export const taskDtoSchema = z.looseObject({
  id: z.string(),
  projectId: z.string(),
  name: z.string(),
  isArchived: z.boolean(),
});

export const tagDtoSchema = z.looseObject({ id: z.string(), name: z.string() });

export const meDtoSchema = z.looseObject({
  user: z.looseObject({ id: z.string(), displayName: z.string(), email: z.string(), timezone: z.string() }),
  workspace: z.looseObject({ id: z.string(), name: z.string(), timezone: z.string() }),
  role: z.string(),
  // Checked by the key-role gate, which must answer a missing or unknown value with its own message.
  keyRole: z.unknown(),
  serverTime: z.string(),
});

export type EntryDto = z.infer<typeof entryDtoSchema>;
export type PagedDto<T> = { data: T[]; page: { next_cursor: string | null; has_more: boolean } };
export type ProjectDto = z.infer<typeof projectDtoSchema>;
export type TaskDto = z.infer<typeof taskDtoSchema>;
export type TagDto = z.infer<typeof tagDtoSchema>;
export type MeDto = z.infer<typeof meDtoSchema>;

// Compile-time check: the paged schema produces the generic type the client declares.
const pagedCheck: (v: z.infer<typeof pagedEntriesDtoSchema>) => PagedDto<EntryDto> = (v) => v;
void pagedCheck;
