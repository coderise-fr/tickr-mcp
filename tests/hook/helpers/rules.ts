// Checks of the permission rules that the README recommends. A rule of the form
// `Bash(node ... tickr-hook.cjs <command> *)` that has a `*` anywhere in front of the script name
// would also match a `tickr-hook.cjs` of a cloned repository, which would then run without approval.

const SCRIPT = "tickr-hook.cjs";
const RULE_START = "Bash(";

/**
 * The rules of `text` (quoted in JSON or written inline) that carry a wildcard in front of the
 * script name. A rule runs from its `Bash(` to the first script name after it; a `Bash(` that is
 * followed by another `Bash(` before any script name is a rule without a script and is not
 * judged, nor is one whose command is not `node` (for example `Bash(git status:*)`). There is no
 * limit on the length of a rule.
 */
export function wildcardBeforeScript(text: string): string[] {
  const starts: number[] = [];
  for (let at = text.indexOf(RULE_START); at >= 0; at = text.indexOf(RULE_START, at + RULE_START.length)) starts.push(at);

  const unsafe: string[] = [];
  starts.forEach((start, index) => {
    // Only a rule that can run the script is judged: a `node` command, or one that starts with a
    // wildcard. `Bash(git diff:*)` and the like are other rules.
    const command = text.slice(start + RULE_START.length).trimStart();
    if (!command.startsWith("node") && !command.startsWith("*")) return;
    const script = text.indexOf(SCRIPT, start);
    if (script < 0) return;
    const next = starts[index + 1];
    if (next !== undefined && next < script) return;
    const beforeScript = text.slice(start, script);
    if (beforeScript.includes("*")) unsafe.push(text.slice(start, script + SCRIPT.length));
  });
  return unsafe;
}
