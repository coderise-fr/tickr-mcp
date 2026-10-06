export const TRUNCATION_MARK = "…[truncated]";

// C0 + C1 control characters and the Unicode line/paragraph separators.
const CONTROL_ALL = /[\u0000-\u001F\u007F-\u009F\u2028\u2029]/g;
// Same, but keeps the line feed (U+000A) so multi-line descriptions stay readable.
const CONTROL_KEEP_NEWLINE = /[\u0000-\u0009\u000B-\u001F\u007F-\u009F\u2028\u2029]/g;
// Invisible formatting characters: zero-width characters, direction marks (including the Arabic
// letter mark), embeddings, overrides and isolates, invisible operators, the Mongolian vowel
// separator, and the zero-width no-break space (BOM).
// They are removed, so the agent reads the same text a person sees.
const INVISIBLE_FORMATTING = /[\u061C\u180E\u200B-\u200F\u202A-\u202E\u2060-\u2064\u2066-\u2069\uFEFF]/g;

function clean(value: string, max: number, pattern: RegExp): string {
  const cleaned = value.replace(INVISIBLE_FORMATTING, "").replace(pattern, " ");
  return cleaned.length <= max ? cleaned : cleaned.slice(0, max) + TRUNCATION_MARK;
}

export const cleanName = (v: string): string => clean(v, 200, CONTROL_ALL);
export const cleanNullableName = (v: string | null): string | null => (v === null ? null : cleanName(v));
export const cleanDescription = (v: string): string => clean(v, 1000, CONTROL_KEEP_NEWLINE);
export const cleanDetail = (v: string): string => clean(v, 300, CONTROL_ALL);

export const REDACTED = "[redacted]";

/**
 * Replaces every occurrence of a secret (the configured API key) in a string, or in every string
 * of a JSON value (arrays and plain objects, values only). An empty secret changes nothing.
 */
export function redact<T>(value: T, secret: string): T {
  if (!secret) return value;
  const walk = (v: unknown): unknown => {
    if (typeof v === "string") return v.split(secret).join(REDACTED);
    if (Array.isArray(v)) return v.map(walk);
    if (typeof v === "object" && v !== null) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, walk(x)]));
    return v;
  };
  return walk(value) as T;
}
