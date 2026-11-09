# Changelog

## Plugin `tickr` 0.4.2 — 2026-11-09

- Follows the segment route's rename contract of a Tickr that applies the change, and
  still works with one that does not: which one is told by Tickr's answer alone, never
  by a version number.
- Every revision sends the task (or an explicit `null`) and the description; a retry
  resends the same bytes.
- When the answer shows the new task and description but not one of the tags (a tag
  deleted in Tickr), the rename counts as applied and the next revisions send the tags
  Tickr holds. Once your Tickr is known to apply renames, a change of tags is renamed in
  place too; a change of project always starts a new entry, the previous one keeping
  its project, end and tokens.
- A new task or description Tickr refuses (`422`, for instance a task of another
  project) is given up instead of being split: the session goes on with the previous
  ones, its time and tokens included, a message says so, and the refused change is not
  sent again in that session. A `422 immutable` on the project splits the entry
  instead, without marking anything as failed.
- `409 agent_revision_conflict` no longer gives up on the entry: the wanted state is
  sent under the next revision number (a number already sent is never sent with other
  bytes).
- `409 entry_locked` (the period is already submitted) stops recording that session,
  with one message, instead of opening new entries in the same period.
- Fix: a change of task or description on an entry Tickr had refused for good (for
  instance a task of another project at its creation) is no longer renamed in place,
  where it would never be sent: it starts a new entry, which is sent.
- Fix: when an entry was split at a change while the session's transcript was being
  written, and Tickr's answer came more than a day after the session's last activity,
  the tokens of both entries are now still rebuilt once the transcript is complete,
  without new activity in the session.
- Bundles MCP server 0.2.1 (unchanged).

## Plugin `tickr` 0.4.1 — 2026-11-09

- The skill asks to link a session only when the model received the SessionStart
  ask-to-link note: an unlinked checkout alone, or the option `ask_to_link` turned off,
  never prompts, and the model never suggests linking on its own.

## Plugin `tickr` 0.4.0 — 2026-11-09

- Changing the task or the description of a session (`/tickr:task`, `/tickr:describe`)
  now renames the current Tickr entry in place when your Tickr applies the change; a
  change of project or tags still starts a new entry.
- When your Tickr keeps the old task and description, the plugin notices it in the
  answer and splits the entry at the change as before (the previous one ends there,
  with its own task, description, time and tokens), then splits directly on later
  changes. It tries in place again a day later, so an upgraded Tickr is picked up
  without a plugin release. A change Tickr refuses is split the same way.
- The skill, `/tickr:task`, `/tickr:describe` and the README say so.
- Bundles MCP server 0.2.1 (unchanged).

## Plugin `tickr` 0.3.0 — 2026-11-09

- In a repository that is not linked (no `.tickr.json`, or one not yet linked on this
  machine), the SessionStart hook now also gives Claude a short note: the first time
  you give it work to do, Claude asks you once, before starting the work, whether to
  link the session to a Tickr activity; on yes it runs `/tickr:link` right away, then
  does the work; on no it does the work and does not ask again in that session.
  Questions are answered without the link question, and it does not ask when you
  already said to skip Tickr. It never writes `.tickr.json` itself outside `/tickr:link`. The note holds
  no path, id or key, and is not repeated when a session resumes or is compacted.
- New option `ask_to_link` (default true): set it to false to keep only the
  not-tracked message.
- The skill, `/tickr:task`, `/tickr:describe` and the README now say that changing the
  task or the description starts a new Tickr entry (the previous one ends there),
  since Tickr does not change the task or description of an entry that already
  exists; set them early, once the work is clear.
- Bundles MCP server 0.2.1 (unchanged).

## Plugin `tickr` 0.2.0 — 2026-11-06

- New `/tickr:task`: choose, for the current session only, a task among the
  existing tasks of the linked project (or no task) and a short description of the
  work; Claude proposes them and you confirm or edit them. `/tickr:task clear` goes
  back to `.tickr.json`. It never creates tasks or tags.
- New `/tickr:describe`: change only the description of the current session.
- Both commands read the project through the plugin's read-only `context-info`
  command, the only one they pre-authorise: it uses the same `.tickr.json` as the
  recording (the nearest one from the session's directory upwards) and its link on
  this machine; an unlinked checkout is sent to `/tickr:link`.
- Project and task ids are compared ignoring case, so a `.tickr.json` holding an
  upper-case id gets the session context too; the chosen task id is stored and sent
  in lower case.
- A description is plain text of at most 10 words (only words with a letter count)
  and 100 characters, without `"`, `` ` ``, `$` or `\`. A change starts a new Tickr
  entry with the new task and description.
- Claude proposes `/tickr:task` when the work moves to another task or purpose. New
  option `auto_context` (default false): Claude applies the change without asking in
  the chat. The README gives the permission rules that also let the command run
  without a prompt.
- The session context stays on this machine (one small file per session in the
  plugin data directory, removed after 90 days); only the chosen task id and the
  confirmed description are sent, as part of the session's entries. Nothing else
  about the session is sent.
- Bundles MCP server 0.2.1 (unchanged).

## 0.2.1 — 2026-11-05

- Security: zod 4.6.7 (an advisory on memory exhaustion while validating very large
  collections) and updated transitive dependencies; no runtime dependency has a known
  advisory left.

## Plugin `tickr` 0.1.1 — 2026-11-05

- Security: a `.tickr.json` that arrives with a clone or a pull is no longer trusted
  by itself. A checkout is tracked only after `/tickr:link` recorded, on this machine,
  that this directory and this file content were linked; a changed file or a moved
  checkout must be linked again. Sessions in an unlinked checkout are not tracked and
  say so once at the start.
- Security: revoking a link also stops the sessions already recorded under it: once
  `.tickr.json` changed or the link was removed, nothing more of the session is read
  or sent (store schema v3). Links are stored independently, so two links recorded
  at once are both kept. Keeping an existing `.tickr.json` in `/tickr:link` still
  links it on this machine.
- Security: `/tickr:link` no longer pre-authorises file reads and writes, and
  `/tickr:status` no longer pre-authorises arbitrary `node` commands; Claude Code asks
  before the link is written and recorded.
- A `.tickr.json` larger than 64 KB or that is not a regular file is refused.
- Bundles MCP server 0.2.1.
- **Existing users:** run `/tickr:link` once in each linked repository after updating.

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
