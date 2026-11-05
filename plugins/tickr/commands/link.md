---
description: Link this repository to a Tickr project, so that Claude Code sessions here are tracked as Tickr time.
argument-hint: "[project name]"
allowed-tools: mcp__plugin_tickr_tickr__get_context, mcp__plugin_tickr_tickr__list_projects, mcp__plugin_tickr_tickr__list_tasks, mcp__plugin_tickr_tickr__list_tags, Read, Write, Edit, Bash(git rev-parse:*)
---

# Link this repository to Tickr

Create (or replace) the `.tickr.json` file that tells the Tickr plugin which workspace, project, task and tags the Claude Code sessions of this checkout are recorded under. Ask the user at each choice; never guess a project.

## Steps

1. **Find the repository root.** Run `git rev-parse --show-toplevel`. If it fails, this directory is not a git work tree: use the current working directory as the root and skip step 7.

2. **Look for an existing link.** If `<root>/.tickr.json` exists, read it, tell the user which project it names (look the name up with `mcp__plugin_tickr_tickr__list_projects`) and ask whether to replace it. Stop if they want to keep it.

3. **Find the workspace.** Call `mcp__plugin_tickr_tickr__get_context`. Keep `workspace.id`; tell the user the workspace name. If the tool fails, explain that the Tickr plugin options (`api_key`, `base_url`) must be set first, and stop.

4. **Choose the project.** Call `mcp__plugin_tickr_tickr__list_projects` (with `name_contains` set to "$ARGUMENTS" when the user gave a name; follow `next_cursor` while `has_more` is true). Show the matching projects by name and client, and ask the user to pick one. Keep its `id`.

5. **Optional details.** Ask whether the sessions should go to a task of that project (`mcp__plugin_tickr_tickr__list_tasks` with its `project_id`), carry tags (`mcp__plugin_tickr_tickr__list_tags`), and use a description other than the default `Claude Code session` (at most 2000 characters). Each is optional: skip what the user does not want.

6. **Write `<root>/.tickr.json`** with exactly these snake_case keys, leaving out the optional ones the user skipped:

   ```json
   {
     "workspace_id": "<workspace id>",
     "project_id": "<project id>",
     "task_id": "<task id>",
     "tag_ids": ["<tag id>"],
     "description": "Claude Code session"
   }
   ```

   Only ids go in this file: never a name, a path or anything else.

7. **Keep the file out of git, locally.** `.tickr.json` is personal to this checkout and is never committed:
   - Run `git rev-parse --git-path info/exclude` from the root to get the path of this checkout's exclude file (it also resolves worktrees and submodules, where `.git` is a file). A relative answer is relative to the root.
   - Read that file (it may not exist yet). If no line of it is exactly `.tickr.json` or `/.tickr.json`, append the line `/.tickr.json` (create the file and its directory when missing). Change nothing else in it.
   - Do not edit `.gitignore` (it is shared with the other developers), and do not stage, commit or push anything.

8. **Tell the user** which workspace, project, task and tags this checkout is now linked to; that `.tickr.json` stays on this machine (excluded through `.git/info/exclude`, never committed); that **each developer links their own checkout** with `/tickr:link`; and that tracking starts with the next Claude Code session started in this repository. `/tickr:status` shows what was sent.
