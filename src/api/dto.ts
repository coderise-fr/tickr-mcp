import { z } from "zod";

// Runtime schemas of the Tickr answers the client hands to the tools. They are loose on
// purpose: they check only the fields the projections read, and let any extra field through
// (the projections are allow-lists and never copy it). An answer that does not match is
// reported as unreadable instead of failing later inside a projection.
// Values passed to the agent without cleaning (ids, datetimes, the entry cursor) are held to
// their exact format, so an answer cannot carry free text in them.

const nullableString = z.string().nullable();

/** Tickr ids are UUIDs. */
export const apiId = z.guid();
/** Tickr datetimes always carry an offset ("Z" or "+00:00"), with up to 7 fractional digits. */
export const apiDateTime = z.iso.datetime({ offset: true });
/** The opaque cursor of GET /api/v1/entries: base64 text of bounded length. */
export const apiCursor = z.string().regex(/^[A-Za-z0-9_\-+/=]{1,1024}$/);

export const entryDtoSchema = z.looseObject({
  id: apiId,
  projectId: apiId.nullable(),
  projectName: nullableString,
  clientName: nullableString,
  taskId: apiId.nullable(),
  // Tickr sends "" for an entry without description; null is tolerated and projected as "".
  description: nullableString,
  startedAt: apiDateTime,
  stoppedAt: apiDateTime.nullable(),
  durationSeconds: z.number().int().nonnegative().nullable(),
  tagIds: z.array(apiId),
  isBillable: z.boolean(),
});

export const pagedEntriesDtoSchema = z.looseObject({
  data: z.array(entryDtoSchema),
  page: z.looseObject({ next_cursor: apiCursor.nullable(), has_more: z.boolean() }),
});

export const projectDtoSchema = z.looseObject({
  id: apiId,
  name: z.string(),
  isArchived: z.boolean(),
  clientName: nullableString,
});

export const taskDtoSchema = z.looseObject({
  id: apiId,
  projectId: apiId,
  name: z.string(),
  isArchived: z.boolean(),
});

export const tagDtoSchema = z.looseObject({ id: apiId, name: z.string() });

export const meDtoSchema = z.looseObject({
  user: z.looseObject({ id: apiId, displayName: z.string(), email: z.string(), timezone: z.string() }),
  workspace: z.looseObject({ id: apiId, name: z.string(), timezone: z.string() }),
  role: z.string(),
  // Checked by the key-role gate, which must answer a missing, null or unknown value with its own
  // message. Optional here: in zod 4 a z.unknown() key is otherwise required, and a missing keyRole
  // would be reported as an unreadable answer instead of a contract error.
  keyRole: z.unknown().optional(),
  serverTime: apiDateTime,
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
