# Changelog

## 0.1.1 — 2026-10-09

- Answers from Tickr with a negative or fractional `durationSeconds` are reported as
  unreadable instead of being turned into a duration of 0.
- The `list_entries` cursor is checked before calling Tickr (same format and
  1,024-character bound as the cursor Tickr returns).
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
