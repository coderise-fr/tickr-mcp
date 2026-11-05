# Changelog

## Plugin `tickr` 0.1.0 — 2026-11-05

- New Claude Code plugin (marketplace `tickr-mcp`, tag `plugin-v0.1.0`): records
  Claude Code sessions as Tickr time with token usage, and bundles this MCP
  server (pinned to 0.2.0). Commands `/tickr:link` and `/tickr:status`. See the
  README, section "Claude Code plugin". It needs a Tickr version that accepts
  agent sessions. The plugin is not published to npm.

## 0.2.0 — 2026-11-05

- **Breaking (runtime):** Node 22 or later is required (Node 20 reached end of
  life). CI also runs on Node 24 and 26.
- Every write (start/stop timer, create/update entry) now tells Tickr that it
  comes from an agent, with the MCP client's name and version
  (`Tickr-Origin` and `Tickr-Agent` headers). Reads carry no such header. A Tickr
  without agent provenance ignores them.
- When Tickr answers that the workspace is busy with another change, the call
  is retried once after the wait it asks for (up to 5 seconds). If it is still
  busy, the agent is told that nothing was changed instead of being asked to
  check whether the write was applied.

## 0.1.2 — 2026-10-10

- A completed entry (with `stoppedAt`) whose `durationSeconds` is null is reported
  as unreadable instead of being given a duration computed from its timestamps.
- Development: `npm test` also works when the shell reports the working directory
  with a lower-case drive letter (Windows).

## 0.1.1 — 2026-10-09

- Answers from Tickr whose `durationSeconds` is not a non-negative integer are
  reported as unreadable. Previously a negative value was shown as 0 and a
  fractional value was passed through.
- The `list_entries` cursor is checked before calling Tickr (same format and
  1,024-character bound as the cursor Tickr returns); an invalid cursor gets a
  new "Invalid cursor" message.
- README: a shell-safe key placeholder in the client commands, guidance for the
  timer limit across workspaces, and both causes of the "list is too large" message.

## 0.1.0 — 2026-10-09

First release published by CI. Ten tools: get_context, list_active_timers,
start_timer, stop_timer, list_entries, create_entry, update_entry,
list_projects, list_tasks, list_tags. Requires a Tickr version providing
`GET /api/v1/me`.

## 0.0.1

Bootstrap release, published manually to register npm trusted publishing.
Not for use.
