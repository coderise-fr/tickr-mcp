import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { PLUGIN_VERSION } from "../../hook-src/version.js";

function readJson<T>(relative: string): T {
  return JSON.parse(readFileSync(new URL(`../../${relative}`, import.meta.url), "utf8")) as T;
}

interface PluginManifest {
  name: string;
  version: string;
  userConfig: Record<string, { type: string; sensitive?: boolean; required?: boolean; default?: unknown }>;
}

interface McpConfig {
  mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
}

interface HookCommand {
  type: string;
  command: string;
  args: string[];
  timeout: number;
}

interface HooksFile {
  hooks: Record<string, { matcher?: string; hooks: HookCommand[] }[]>;
}

interface Marketplace {
  name: string;
  plugins: { name: string; source: string }[];
}

const plugin = readJson<PluginManifest>("plugins/tickr/.claude-plugin/plugin.json");
const pkg = readJson<{ version: string; files: string[] }>("package.json");

describe("plugin manifests", () => {
  it("plugin.json version equals PLUGIN_VERSION", () => {
    expect(plugin.name).toBe("tickr");
    expect(plugin.version).toBe(PLUGIN_VERSION);
  });

  it(".mcp.json pins @coderise-fr/tickr-mcp@<package.json version>", () => {
    const mcp = readJson<McpConfig>("plugins/tickr/.mcp.json");
    expect(Object.keys(mcp.mcpServers)).toEqual(["tickr"]);
    const server = mcp.mcpServers.tickr!;
    expect(server.command).toBe("npx");
    expect(server.args).toEqual(["-y", `@coderise-fr/tickr-mcp@${pkg.version}`]);
    expect(server.env).toEqual({
      TICKR_API_KEY: "${user_config.api_key}",
      TICKR_BASE_URL: "${user_config.base_url}",
    });
  });

  it('every hook is exec form: command "node", args ["--no-warnings", "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs", <its event name>]', () => {
    const file = readJson<HooksFile>("plugins/tickr/hooks/hooks.json");
    expect(Object.keys(file.hooks).sort()).toEqual(
      ["PostToolUse", "SessionEnd", "SessionStart", "Stop", "SubagentStart", "SubagentStop", "UserPromptSubmit"].sort(),
    );
    for (const [event, groups] of Object.entries(file.hooks)) {
      expect(groups).toHaveLength(1);
      expect(groups[0]!.matcher).toBeUndefined();
      expect(groups[0]!.hooks).toEqual([
        {
          type: "command",
          command: "node",
          args: ["--no-warnings", "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs", event],
          timeout: 5,
        },
      ]);
    }
  });

  it('marketplace lists exactly plugin "tickr" with source "./plugins/tickr"', () => {
    const market = readJson<Marketplace>(".claude-plugin/marketplace.json");
    expect(market.name).toBe("tickr-mcp");
    expect(market.plugins.map((p) => [p.name, p.source])).toEqual([["tickr", "./plugins/tickr"]]);
  });

  it("userConfig keys are exactly api_key, base_url, idle_minutes, auto_context and api_key is sensitive", () => {
    expect(Object.keys(plugin.userConfig).sort()).toEqual(["api_key", "auto_context", "base_url", "idle_minutes"]);
    expect(plugin.userConfig.auto_context).toMatchObject({ type: "boolean", default: false });
    expect(plugin.userConfig.auto_context!.sensitive).not.toBe(true);
    expect(plugin.userConfig.api_key).toMatchObject({ type: "string", sensitive: true, required: true });
    expect(plugin.userConfig.base_url).toMatchObject({ type: "string", default: "https://tickr.coderise.cloud" });
    expect(plugin.userConfig.idle_minutes).toMatchObject({ type: "number", default: 15, min: 5, max: 120 });
    expect(plugin.userConfig.base_url!.sensitive).not.toBe(true);
  });

  it("the npm package files allow-list contains no plugin path", () => {
    const pluginPaths = /^(\.\/)?(plugins|hook-src|\.claude-plugin|scripts|tests)(\/|$)/;
    expect(pkg.files.filter((f) => pluginPaths.test(f))).toEqual([]);
    expect(pkg.files).not.toContain(".");
    expect(pkg.files.some((f) => f.includes("*"))).toBe(false);
  });
});
