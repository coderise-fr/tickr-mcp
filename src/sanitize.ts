export const TRUNCATION_MARK = "…[truncated]";

// C0 + C1 control characters and the Unicode line/paragraph separators.
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// Same, but keeps "\n" (U+000A) so multi-line descriptions stay readable.
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;

function clean(value: string, max: number, pattern: RegExp): string {
  const cleaned = value.replace(pattern, " ");
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + TRUNCATION_MARK;
}

export const cleanName = (v: string): string => clean(v, 200, CONTROL_ALL);
export const cleanNullableName = (v: string | null): string | null => (v === null ? null : cleanName(v));
export const cleanDescription = (v: string): string => clean(v, 1000, CONTROL_KEEP_NEWLINE);
export const cleanDetail = (v: string): string => clean(v, 300, CONTROL_ALL);