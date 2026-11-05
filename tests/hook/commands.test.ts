import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../../src/tools/index.js";

const pluginRoot = fileURLToPath(new URL("../../plugins/tickr/", import.meta.url));
const read = (relative: string) => readFileSync(`${pluginRoot}${relative}`, "utf8").replace(/\r\n/g, "\n");

const FILES = ["commands/link.md", "commands/status.md", "skills/tickr/SKILL.md"] as const;

/** The frontmatter (simple `key: value` lines between the first two `---`) and the body. */
function parse(text: string): { meta: Record<string, string>; body: string } {
  const match = /^---\n([\s\S]*?)\n---\n([\s\S]*)$/.exec(text);
  if (!match) throw new Error("no frontmatter");
  const meta: Record<string, string> = {};
  for (const line of match[1]!.split("\n")) {
    const at = line.indexOf(":");
    if (at <= 0) throw new Error(`not a key: value line: ${line}`);
    meta[line.slice(0, at).trim()] = line.slice(at + 1).trim();
  }
  return { meta, body: match[2]! };
}

const mcp = JSON.parse(read(".mcp.json")) as { mcpServers: Record<string, unknown> };
const plugin = JSON.parse(read(".claude-plugin/plugin.json")) as { name: string };
const PREFIX = `mcp__plugin_${plugin.name}_${Object.keys(mcp.mcpServers)[0]}__`;
const TOOL_NAMES = new Set(ALL_TOOLS.map((t) => t.name));
const BUILT_IN = new Set(["Read", "Write", "Edit"]);

describe("commands and skill", () => {
  it.each(FILES)("%s has a valid frontmatter", (file) => {
    const { meta, body } = parse(read(file));
    expect(meta.description?.length ?? 0).toBeGreaterThan(20);
    expect(body.trim().length).toBeGreaterThan(100);
    const allowed = file.startsWith("skills/") ? ["name", "description"] : ["description", "argument-hint", "allowed-tools"];
    for (const key of Object.keys(meta)) expect(allowed).toContain(key);
    if (file.startsWith("skills/")) expect(meta.name).toBe("tickr");
  });

  it.each(FILES)("%s references only tools and paths that exist in the plugin", (file) => {
    const text = read(file);
    const { meta } = parse(text);
    for (const tool of text.match(/mcp__[A-Za-z0-9_]+/g) ?? []) {
      expect(tool.startsWith(PREFIX), tool).toBe(true);
      expect(TOOL_NAMES.has(tool.slice(PREFIX.length)), tool).toBe(true);
    }
    for (const entry of (meta["allowed-tools"] ?? "").split(",").map((s) => s.trim()).filter(Boolean)) {
      const ok = BUILT_IN.has(entry) || /^Bash\((node|git rev-parse):\*\)$/.test(entry) || (entry.startsWith(PREFIX) && TOOL_NAMES.has(entry.slice(PREFIX.length)));
      expect(ok, entry).toBe(true);
    }
    for (const path of text.match(/\$\{CLAUDE_PLUGIN_ROOT\}\/[^"`\s)]+/g) ?? []) {
      expect(existsSync(path.replace("${CLAUDE_PLUGIN_ROOT}/", pluginRoot)), path).toBe(true);
    }
    for (const command of text.match(/\/tickr:[a-z]+/g) ?? []) {
      expect(existsSync(`${pluginRoot}commands/${command.slice("/tickr:".length)}.md`), command).toBe(true);
    }
  });

  it("link.md never stages nor commits .tickr.json and keeps it out of git through info/exclude", () => {
    const text = read("commands/link.md");
    expect(text).not.toMatch(/git\s+add/);
    expect(text).not.toMatch(/git\s+commit/);
    expect(text).not.toMatch(/git\s+push/);
    expect(text).toContain("git rev-parse --git-path info/exclude");
    expect(text).toContain(".git/info/exclude");
    expect(text).toMatch(/Do not edit `\.gitignore`/);
    expect(text).toMatch(/each developer links their own checkout/i);
    expect(parse(text).meta["allowed-tools"]).not.toMatch(/Bash\(git:\*\)|Bash\(\*\)/);
  });

  it("link.md writes the snake_case shape of .tickr.json", () => {
    const shape = /```json\n([\s\S]*?)```/.exec(read("commands/link.md"))![1]!;
    expect(Object.keys(JSON.parse(shape))).toEqual(["workspace_id", "project_id", "task_id", "tag_ids", "description"]);
  });

  it("status.md runs the bundle's status mode on the plugin data directory, with node only", () => {
    const { meta, body } = parse(read("commands/status.md"));
    expect(meta["allowed-tools"]).toBe("Bash(node:*)");
    expect(body).toContain('!`node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" status "${CLAUDE_PLUGIN_DATA}"`');
  });

  it("the skill states the privacy rule and the agent_session editing rule", () => {
    const text = read("skills/tickr/SKILL.md");
    expect(text).toMatch(/never edit an entry whose origin is `agent_session` with `update_entry`/i);
    expect(text).toMatch(/a human edit detaches/);
    expect(text).toMatch(/never sent, logged or shown/);
  });
});
