# Changelog

## Unreleased

- A completed entry (with `stoppedAt`) whose `durationSeconds` is null is reported
  as unreadable instead of being given a duration computed from its timestamps.

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
