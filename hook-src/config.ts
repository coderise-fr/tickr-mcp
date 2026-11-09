// Plugin options, as Claude Code exports them to hooks (CLAUDE_PLUGIN_OPTION_<KEY>). The key and
// the URL follow exactly the MCP server's rules (src/config.ts); the key is never echoed.
import { ConfigError, loadConfig } from "../src/config.js";

export const DEFAULT_IDLE_MINUTES = 15;
export const MIN_IDLE_MINUTES = 5;
export const MAX_IDLE_MINUTES = 120;

export interface PluginConfig {
  apiKey: string;
  baseUrl: string;
  idleMinutes: number;
  dataDir: string;
  /** Option auto_context: Claude may change the session's task and description without asking first. */
  autoContext: boolean;
  /** Option ask_to_link: in a checkout that is not linked, Claude asks once whether to link the session. */
  askToLink: boolean;
}

function optionWording(message: string): string {
  return message
    .replace(/TICKR_API_KEY/g, "The Tickr plugin option api_key")
    .replace(/TICKR_BASE_URL/g, "The Tickr plugin option base_url")
    .replace(" and add it to this MCP server's env", " and set it in the plugin options");
}

function idleMinutes(raw: string | undefined): number {
  if (raw === undefined || raw.trim() === "") return DEFAULT_IDLE_MINUTES;
  const value = Number(raw);
  return Number.isInteger(value) && value >= MIN_IDLE_MINUTES && value <= MAX_IDLE_MINUTES ? value : DEFAULT_IDLE_MINUTES;
}

/** A boolean plugin option: "true" or "1", "false" or "0"; anything else (unset included) is the default. */
function flag(raw: string | undefined, byDefault = false): boolean {
  const v = raw?.trim().toLowerCase();
  if (v === "true" || v === "1") return true;
  if (v === "false" || v === "0") return false;
  return byDefault;
}

export function readPluginConfig(env: NodeJS.ProcessEnv): PluginConfig | { problem: string } {
  const dataDir = env.CLAUDE_PLUGIN_DATA?.trim();
  if (!dataDir) return { problem: "Claude Code did not provide a plugin data directory (CLAUDE_PLUGIN_DATA)." };

  let config;
  try {
    config = loadConfig({
      TICKR_API_KEY: env.CLAUDE_PLUGIN_OPTION_API_KEY,
      TICKR_BASE_URL: env.CLAUDE_PLUGIN_OPTION_BASE_URL,
    });
  } catch (error) {
    if (error instanceof ConfigError) return { problem: optionWording(error.message) };
    throw error;
  }
  return {
    apiKey: config.apiKey,
    baseUrl: config.baseUrl,
    idleMinutes: idleMinutes(env.CLAUDE_PLUGIN_OPTION_IDLE_MINUTES),
    dataDir,
    autoContext: flag(env.CLAUDE_PLUGIN_OPTION_AUTO_CONTEXT),
    askToLink: flag(env.CLAUDE_PLUGIN_OPTION_ASK_TO_LINK, true),
  };
}
