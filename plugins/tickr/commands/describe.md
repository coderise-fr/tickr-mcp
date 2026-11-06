---
description: Set a short description of the work of this Claude Code session for Tickr, keeping its task.
argument-hint: "[description of at most 10 words]"
allowed-tools: Bash(node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" context-info:*)
---

# Tickr description of this session

Set the short description this Claude Code session is recorded under in Tickr, from now on; the task stays as it is. It is a label of the overall work that the user confirms, not conversation content. The `set-context` command below is NOT pre-authorised: Claude Code asks the user to allow it, and that is intended.

## What the plugin records for this session

!`node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" context-info "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" .`

The JSON line above comes from the plugin's read-only `context-info` command (a note Claude Code may add after it, such as the shell directory, is not part of it). It reads the same `.tickr.json` as the plugin's hooks (the nearest one from the current directory upwards) and checks that it is linked on this machine. It is one JSON object: `project_id`, `task_id` and `description` are what this session is recorded under now, and `session_context` tells whether they come from a task or description chosen for this session. Do not read `.tickr.json` yourself.

## Steps

1. **Linked?** If the JSON line above is `{"linked":false}`, or there is no JSON line with `"linked":true`, tell the user that this directory is not linked to a Tickr project on this machine and to run `/tickr:link` first, and do nothing else.

2. **Propose a description.** Use "$ARGUMENTS" when given, otherwise describe the overall work of this session so far: plain text of at most 10 words and 100 characters (numbers do not count as words), without `"`, `` ` ``, `$` or `\`, for example `Implementation of the mobile app UI` or `Fix tickets 1 2 3 4 5 6 7 110 210`. Never quote prompts, answers, code, file or branch names or paths in it. When the given text breaks these rules, propose a shorter one.

3. **Confirm.** In manual mode (the default), ask the user to confirm or edit the description, and wait for the answer. In automatic mode (the Tickr session context note given at the start of the session says `Mode: automatic`), do not ask in chat: go on with step 4.

4. **Apply.** Run `node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" set-context "${CLAUDE_PLUGIN_DATA}" "${CLAUDE_SESSION_ID}" "<project_id>" --description "<description>"` with the `project_id` printed above (no `--task`: the task is kept). If the user declines the command, nothing is changed; say so.

5. **Tell the user** the command's output line. `/tickr:task` also chooses the task; `/tickr:task clear` goes back to the task and description of `.tickr.json`.
