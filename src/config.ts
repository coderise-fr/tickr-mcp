export const DEFAULT_BASE_URL = "https://tickr.coderise.cloud";

export interface Config {
  apiKey: string;
  baseUrl: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigError";
  }
}

const LOCAL_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function loadConfig(env: Record<string, string | undefined>): Config {
  const apiKey = env.TICKR_API_KEY?.trim();
  if (!apiKey) {
    throw new ConfigError(
      "TICKR_API_KEY is not set. Create an API key in Tickr (Settings → API keys) and add it to this MCP server's env.",
    );
  }

  const raw = env.TICKR_BASE_URL?.trim() || DEFAULT_BASE_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new ConfigError("TICKR_BASE_URL is not a valid URL.");
  }
  if (url.username || url.password) throw new ConfigError("TICKR_BASE_URL must not contain credentials.");
  if (url.protocol === "http:") {
    if (!LOCAL_HOSTS.has(url.hostname)) {
      throw new ConfigError("TICKR_BASE_URL must use https (http is only allowed for localhost).");
    }
  } else if (url.protocol !== "https:") {
    throw new ConfigError("TICKR_BASE_URL must use https.");
  }
  if (url.search || url.hash) throw new ConfigError("TICKR_BASE_URL must not contain a query string or fragment.");

  return { apiKey, baseUrl: url.origin + url.pathname.replace(/\/+$/, "") };
}
