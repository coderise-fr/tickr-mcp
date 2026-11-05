import { describe, expect, it } from "vitest";
import { readPluginConfig } from "../../hook-src/config.js";

const KEY = "tkr_test_config_key_0001";

function env(extra: Record<string, string | undefined> = {}) {
  return { CLAUDE_PLUGIN_DATA: "/data/tickr", CLAUDE_PLUGIN_OPTION_API_KEY: KEY, ...extra };
}

describe("readPluginConfig", () => {
  it("reads the plugin options with their defaults", () => {
    expect(readPluginConfig(env())).toEqual({
      apiKey: KEY,
      baseUrl: "https://tickr.coderise.cloud",
      idleMinutes: 15,
      dataDir: "/data/tickr",
    });
  });

  it("validates the URL with the server's rules and normalises it", () => {
    expect(readPluginConfig(env({ CLAUDE_PLUGIN_OPTION_BASE_URL: "https://tickr.example.test/" }))).toMatchObject({
      baseUrl: "https://tickr.example.test",
    });
    expect(readPluginConfig(env({ CLAUDE_PLUGIN_OPTION_BASE_URL: "http://localhost:8091" }))).toMatchObject({
      baseUrl: "http://localhost:8091",
    });
    const problem = readPluginConfig(env({ CLAUDE_PLUGIN_OPTION_BASE_URL: "http://tickr.example.test" }));
    expect(problem).toEqual({ problem: expect.stringContaining("base_url") });
  });

  it("reports a missing or malformed key without echoing it", () => {
    expect(readPluginConfig(env({ CLAUDE_PLUGIN_OPTION_API_KEY: undefined }))).toEqual({
      problem: expect.stringContaining("api_key"),
    });
    const bad = "tkr_test_with space";
    const problem = readPluginConfig(env({ CLAUDE_PLUGIN_OPTION_API_KEY: bad }));
    expect(problem).toEqual({ problem: expect.stringContaining("api_key") });
    expect(JSON.stringify(problem)).not.toContain(bad);
    expect(JSON.stringify(problem)).not.toContain("TICKR_");
  });

  it("needs CLAUDE_PLUGIN_DATA", () => {
    expect(readPluginConfig(env({ CLAUDE_PLUGIN_DATA: undefined }))).toEqual({ problem: expect.any(String) });
    expect(readPluginConfig(env({ CLAUDE_PLUGIN_DATA: "  " }))).toEqual({ problem: expect.any(String) });
  });

  it.each([
    ["5", 5],
    ["120", 120],
    ["30", 30],
    ["15.0", 15],
    ["4", 15],
    ["121", 15],
    ["7.5", 15],
    ["", 15],
    ["abc", 15],
    [undefined, 15],
  ])("idle_minutes %s ⇒ %d", (raw, expected) => {
    expect(readPluginConfig(env({ CLAUDE_PLUGIN_OPTION_IDLE_MINUTES: raw }))).toMatchObject({ idleMinutes: expected });
  });
});
