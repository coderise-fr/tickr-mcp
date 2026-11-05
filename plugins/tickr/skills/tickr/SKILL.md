---
name: tickr
description: How the Tickr plugin records Claude Code sessions as Tickr time entries, what it sends and never sends, and the rules for touching Tickr entries. Use when the user asks about Tickr time tracking of Claude Code sessions, links a repository to Tickr, or asks you to change a Tickr time entry.
---

# Tickr time tracking for Claude Code

## What is tracked

In a repository linked with `/tickr:link` (a local `.tickr.json` holding a workspace id, a project id and optionally a task id, tag ids and a description), the plugin's hooks journal session activity on this machine: prompts submitted, tools used, turns ending, sessions starting and ending. They never use the network.

A background process turns that activity into **agent session segments** and sends them to Tickr, where they appear as time entries marked as recorded by an agent:

- a segment starts with activity and ends after `idle_minutes` without any (15 by default), at UTC midnight, before 23 hours, when `.tickr.json` changes, or when the session ends;
- while Claude is working, the open segment is shown as live in Tickr;
- the token usage of the session is attached to its segments when known.

`/tickr:status` shows what was sent, paused instances and anything Tickr refused. A session in a repository without `.tickr.json` is not tracked.

## Privacy

Only allow-listed fields leave the machine: segment times, the ids from `.tickr.json`, the description it names, the session id, a working flag, and token counts per model. Prompt and response text, tool inputs and outputs, the working directory, file and branch names, the API key and any fingerprint of it are never sent, logged or shown. Never put such content into `.tickr.json` or into a Tickr entry yourself.

## Rules for Tickr entries

- **Never edit an entry whose origin is `agent_session` with `update_entry`.** Such entries are maintained by the plugin; a human edit detaches the entry from its session for good, and the plugin then stops updating it. If the user wants it changed, tell them it will no longer follow the session and let them decide.
- Time you start or create yourself with `start_timer` or `create_entry` is recorded as written by an agent; the plugin attaches the session's token usage to it.
- `.tickr.json` is personal to each checkout: it is never committed. Each developer links their own checkout with `/tickr:link`.
