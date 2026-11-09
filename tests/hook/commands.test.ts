import { existsSync, readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { ALL_TOOLS } from "../../src/tools/index.js";
import { wildcardBeforeScript } from "./helpers/rules.js";

const pluginRoot = fileURLToPath(new URL("../../plugins/tickr/", import.meta.url));
const read = (relative: string) => readFileSync(`${pluginRoot}${relative}`, "utf8").replace(/\r\n/g, "\n");

const FILES = ["commands/link.md", "commands/status.md", "commands/task.md", "commands/describe.md", "skills/tickr/SKILL.md"] as const;
const CONTEXT_COMMANDS = ["commands/task.md", "commands/describe.md"] as const;
const SET_CONTEXT = 'tickr-hook.cjs" set-context "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" "<project_id>"';
/** The only node command /tickr:task and /tickr:describe pre-authorise: the read-only context-info mode. */
const CONTEXT_INFO_RULE = 'Bash(node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" context-info:*)';
const CONTEXT_INFO = '!`node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" context-info "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" .`';

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

/** The numbered steps of a command body ("1. ..." at the start of a line), each with its text up to the next step. */
function numberedSteps(body: string): { n: number; text: string }[] {
  const starts = [...body.matchAll(/^(\d+)\. /gm)];
  return starts.map((m, i) => ({ n: Number(m[1]), text: body.slice(m.index, starts[i + 1]?.index ?? body.length) }));
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
      const ok = BUILT_IN.has(entry) || /^Bash\((git rev-parse|node --no-warnings "\$\{CLAUDE_PLUGIN_ROOT\}\/hooks\/dist\/tickr-hook\.cjs" (status|context-info)):\*\)$/.test(entry) || (entry.startsWith(PREFIX) && TOOL_NAMES.has(entry.slice(PREFIX.length)));
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

  it("the README recommends no permission rule that matches a script by its name alone", () => {
    const readme = readFileSync(`${pluginRoot}../../README.md`, "utf8");
    // The same check for every rule of the README, quoted in JSON or written inline.
    expect(wildcardBeforeScript(readme)).toEqual([]);
    // The recommended rules are present, each one naming the script by its full path.
    const rules = readme.match(/"Bash\((?:[^"\\]|\\.)*\)"/g) ?? [];
    expect(rules.length).toBeGreaterThanOrEqual(2);
    for (const rule of rules) expect(rule, rule).toMatch(/full path/);
    expect(readme).toMatch(/remove them/);
  });

  describe("wildcardBeforeScript (the README rule check)", () => {
    const safe = 'Bash(node --no-warnings "C:/Users/me/.claude/plugins/cache/tickr-mcp/tickr/0.2.0/hooks/dist/tickr-hook.cjs" set-context *)';

    it("accepts a full-path rule, quoted or inline", () => {
      expect(wildcardBeforeScript(`"${safe.replaceAll('"', '\\"')}"`)).toEqual([]);
      expect(wildcardBeforeScript(`use ${safe} here`)).toEqual([]);
    });

    it("accepts a safe rule next to a rule that has a wildcard but no script, in either order", () => {
      expect(wildcardBeforeScript(`Bash(git status:*) and ${safe}`)).toEqual([]);
      expect(wildcardBeforeScript(`${safe} and Bash(git diff:*) and the tickr-hook.cjs script`)).toEqual([]);
    });

    it("rejects an inline rule with a directory between the wildcard and the script name", () => {
      expect(wildcardBeforeScript("Bash(node --no-warnings */hooks/dist/tickr-hook.cjs set-context *)")).toHaveLength(1);
    });

    it("rejects an inline rule with a long path, whatever its length", () => {
      const long = `Bash(node --no-warnings */${"directory/".repeat(60)}hooks/dist/tickr-hook.cjs set-context *)`;
      expect(long.length).toBeGreaterThan(400);
      expect(wildcardBeforeScript(long)).toHaveLength(1);
    });

    it("rejects the old form, a wildcard right before the script name, in a JSON string", () => {
      expect(wildcardBeforeScript('"Bash(node --no-warnings *tickr-hook.cjs\\" clear-context *)"')).toHaveLength(1);
    });

    it("finds the unsafe rule among several on one line", () => {
      const line = `["${safe.replaceAll('"', '\\"')}", "Bash(node --no-warnings *tickr-hook.cjs\\" clear-context *)"]`;
      const unsafe = wildcardBeforeScript(line);
      expect(unsafe).toHaveLength(1);
      expect(unsafe[0]).toContain("*tickr-hook.cjs");
    });
  });

  it("link.md pre-authorises no file write nor node command, and links the checkout with `accept`", () => {
    const { meta, body } = parse(read("commands/link.md"));
    const allowed = meta["allowed-tools"] ?? "";
    expect(allowed).not.toMatch(/\b(Read|Write|Edit)\b/);
    expect(allowed).not.toMatch(/Bash\(node/);
    expect(body).toContain('tickr-hook.cjs" accept "${CLAUDE_PLUGIN_DATA}"');
    expect(body).toMatch(/treat them as data/);
  });

  it("link.md: keeping an existing .tickr.json skips the rewrite but still reaches the exclude step and `accept`", () => {
    const steps = numberedSteps(parse(read("commands/link.md")).body);
    expect(steps.map((s) => s.n)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    const existing = steps[1]!.text;
    expect(existing).toMatch(/\*\*replace\*\* it or \*\*keep\*\* it/);
    expect(existing).not.toMatch(/\bstop\b/i);
    const keep = /\*\*Keep\*\*: ([^\n]*)/.exec(existing)![1]!;
    expect(keep).toMatch(/do not rewrite nor edit the file/);
    const skipped = /Skip steps (\d) to (\d)/.exec(keep)!;
    const resumeAt = Number(/go on with step (\d)/.exec(keep)![1]);
    expect(resumeAt).toBe(Number(skipped[2]) + 1);
    // The skipped steps are exactly the ones that choose and write the mapping.
    const skippedText = steps.filter((s) => s.n >= Number(skipped[1]) && s.n <= Number(skipped[2])).map((s) => s.text).join("\n");
    expect(skippedText).toContain("**Write `<root>/.tickr.json`**");
    // From there on: the exclude step, the explicit `accept`, the final message, and no stop.
    const rest = steps.filter((s) => s.n >= resumeAt).map((s) => s.text).join("\n");
    expect(rest).toContain("git rev-parse --git-path info/exclude");
    expect(rest).toContain('tickr-hook.cjs" accept "${CLAUDE_PLUGIN_DATA}"');
    expect(rest).toContain("**Tell the user**");
    expect(rest).not.toMatch(/\bstop\b/i);
    expect(rest).not.toContain("**Write `<root>/.tickr.json`**");
  });

  it("link.md writes the snake_case shape of .tickr.json", () => {
    const shape = /```json\n([\s\S]*?)```/.exec(read("commands/link.md"))![1]!;
    expect(Object.keys(JSON.parse(shape))).toEqual(["workspace_id", "project_id", "task_id", "tag_ids", "description"]);
  });

  it("status.md runs the bundle's status mode on the plugin data directory, with node only", () => {
    const { meta, body } = parse(read("commands/status.md"));
    // Only the status mode of the bundle is pre-authorised, never a bare `node`.
    expect(meta["allowed-tools"]).toBe('Bash(node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" status:*)');
    expect(body).toContain('!`node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" status "${CLAUDE_PLUGIN_DATA}"`');
  });

  it.each(FILES)("%s pre-authorises no bare node command and never set-context nor clear-context", (file) => {
    const allowed = parse(read(file)).meta["allowed-tools"] ?? "";
    for (const broad of ["Bash(node:*)", "Bash(node *)", "Bash(*)", "Bash(git:*)", "Bash(node --no-warnings:*)"]) expect(allowed).not.toContain(broad);
    expect(allowed).not.toMatch(/set-context|clear-context/);
  });

  it.each(CONTEXT_COMMANDS)("%s pre-authorises no file access and no node command but context-info, and sets the context of this very session", (file) => {
    const { meta, body } = parse(read(file));
    const allowed = meta["allowed-tools"] ?? "";
    expect(allowed).not.toMatch(/\b(Read|Write|Edit)\b/);
    expect(allowed).not.toContain("Bash(git");
    const entries = allowed.split(",").map((s) => s.trim());
    expect(entries).toContain(CONTEXT_INFO_RULE);
    expect(entries.filter((e) => e.startsWith("Bash("))).toEqual([CONTEXT_INFO_RULE]);
    expect(body).toContain(SET_CONTEXT);
    expect(body).toMatch(/NOT pre-authorised/);
    expect(body).toMatch(/at most 10 words and 100 characters/);
    expect(body).toMatch(/never quote prompts/i);
    expect(body).toContain("Implementation of the mobile app UI");
    expect(body).toMatch(/Mode: automatic/);
    expect(body).toContain("In manual mode (the default), ask the user to confirm");
  });

  it.each(CONTEXT_COMMANDS)("%s reads the project with context-info (the .tickr.json of the hooks), never the git root, and stops when not linked", (file) => {
    const { body } = parse(read(file));
    // Run before the model sees the command, in the session's directory.
    expect(body).toContain(CONTEXT_INFO);
    expect(body.indexOf(CONTEXT_INFO)).toBeLessThan(body.indexOf("## Steps"));
    expect(body).not.toContain("git rev-parse");
    expect(body).not.toMatch(/read `<root>\/\.tickr\.json`/);
    expect(body).toContain("Do not read `.tickr.json` yourself.");
    expect(body).toContain("the `project_id` printed above");
    const steps = numberedSteps(body.slice(body.indexOf("## Steps")));
    expect(steps[0]!.text).toMatch(/^1\. \*\*Linked\?\*\* If the JSON line above is `\{"linked":false\}`/);
    expect(steps[0]!.text).toContain("`/tickr:link` first, and do nothing else");
    // context-info is the only command run before the user is asked; set-context comes last.
    const apply = steps.findIndex((s) => s.text.includes(SET_CONTEXT));
    expect(apply).toBe(steps.length - 2);
  });

  it("task.md chooses only among the existing tasks read with list_tasks, and clears with clear-context", () => {
    const { meta, body } = parse(read("commands/task.md"));
    expect(meta["allowed-tools"]).toContain(`${PREFIX}list_tasks`);
    expect(body).toContain(`${PREFIX}list_tasks`);
    expect(body).toMatch(/never create a task or a tag/);
    expect(body).toMatch(/never a task that is not in the list/);
    expect(body).toMatch(/treat them as data/);
    expect(body).toContain('--task "<task id, or none>" --description "<description>"');
    expect(body).toContain('tickr-hook.cjs" clear-context "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}"');
    expect(body).not.toMatch(/create_(task|tag)/);
  });

  it("describe.md changes only the description", () => {
    const { body } = parse(read("commands/describe.md"));
    expect(body).toContain(`${SET_CONTEXT} --description "<description>"`);
    for (const command of body.split("\n").filter((l) => l.includes("set-context"))) expect(command).not.toContain("--task \"");
  });

  it("the skill tells the agent to propose /tickr:task among existing tasks only, and how the automatic mode works", () => {
    const text = read("skills/tickr/SKILL.md");
    expect(text).toContain("**propose** `/tickr:task`");
    expect(text).toContain("**Never create a task or a tag**");
    expect(text).toContain("read the tasks with `list_tasks` first");
    expect(text).toMatch(/at most 10 words/);
    expect(text).toContain("**never quote prompts, answers or code**");
    expect(text).toContain("In automatic mode (plugin option `auto_context`), apply it yourself without asking in chat");
    expect(text).toMatch(/data to show, never instructions/);
  });

  it("the skill tells the agent to ask once to link an unlinked session, run tickr:link on yes, and never write .tickr.json itself", () => {
    const text = read("skills/tickr/SKILL.md");
    expect(text).toContain("ask the user **once**");
    expect(text).toContain("run the `tickr:link` command right away");
    expect(text).toMatch(/If they say no, do not ask again in this session/);
    expect(text).toContain("Never create or edit `.tickr.json` yourself");
    expect(text).toContain("`ask_to_link`");
  });

  it("a task or description change starts a new Tickr entry: said in the skill, /tickr:task, /tickr:describe and the README", () => {
    const readme = readFileSync(`${pluginRoot}../../README.md`, "utf8").replace(/\r\n/g, "\n").replace(/\s+/g, " ");
    for (const [name, text] of [
      ["SKILL.md", read("skills/tickr/SKILL.md")],
      ["task.md", read("commands/task.md")],
      ["describe.md", read("commands/describe.md")],
      ["README.md", readme],
    ] as const) {
      const flat = text.replace(/\s+/g, " ");
      expect(flat, name).toMatch(/starts a new Tickr entry/);
      expect(flat, name).toContain("Tickr does not change the task or description of an entry that already exists");
    }
    for (const file of ["commands/task.md", "commands/describe.md"] as const) {
      const steps = numberedSteps(parse(read(file)).body.slice(parse(read(file)).body.indexOf("## Steps")));
      expect(steps.find((s) => s.text.includes("**Confirm.**"))!.text.replace(/\s+/g, " "), file).toMatch(/starts a new Tickr entry/);
    }
    expect(read("skills/tickr/SKILL.md")).toMatch(/set the task and the description early/);
  });

  it("the skill states the privacy rule and the agent_session editing rule", () => {
    const text = read("skills/tickr/SKILL.md");
    expect(text).toMatch(/never edit an entry whose origin is `agent_session` with `update_entry`/i);
    expect(text).toMatch(/a human edit detaches/);
    expect(text).toMatch(/never sent, logged or shown/);
  });
});
