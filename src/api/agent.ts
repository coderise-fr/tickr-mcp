// Identity sent with every write so Tickr can show who created an entry. The grammars are the
// ones Tickr validates; a value outside them would make the write fail, so each part is cleaned
// and falls back on its own.
export const ORIGIN_HEADER = "Tickr-Origin";
export const AGENT_HEADER = "Tickr-Agent";
export const AGENT_ORIGIN = "agent";

export const AGENT_NAME = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const AGENT_VERSION = /^[A-Za-z0-9][A-Za-z0-9.+_-]{0,31}$/;

export const FALLBACK_NAME = "mcp-client";
export const FALLBACK_VERSION = "unknown";

export interface ClientIdentity {
  name?: unknown;
  version?: unknown;
}

function clean(raw: unknown, unwanted: RegExp, leading: RegExp, max: number): string | undefined {
  if (typeof raw !== "string") return undefined;
  const text = raw.replace(unwanted, "-").replace(/-{2,}/g, "-").replace(leading, "").slice(0, max);
  return text === "" ? undefined : text;
}

export function sanitizeAgentName(raw: unknown): string | undefined {
  const text = clean(typeof raw === "string" ? raw.toLowerCase() : raw, /[^a-z0-9._-]/g, /^[^a-z0-9]+/, 64);
  return text !== undefined && AGENT_NAME.test(text) ? text : undefined;
}

export function sanitizeAgentVersion(raw: unknown): string | undefined {
  const text = clean(raw, /[^A-Za-z0-9.+_-]/g, /^[^A-Za-z0-9]+/, 32);
  return text !== undefined && AGENT_VERSION.test(text) ? text : undefined;
}

export function agentHeaderValue(info: ClientIdentity | undefined): string {
  const name = sanitizeAgentName(info?.name) ?? FALLBACK_NAME;
  const version = sanitizeAgentVersion(info?.version) ?? FALLBACK_VERSION;
  return `${name}/${version}`;
}
