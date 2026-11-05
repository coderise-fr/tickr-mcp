---
description: Show what the Tickr plugin has recorded and sent, and anything that needs your attention.
allowed-tools: Bash(node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" status:*)
---

# Tickr plugin status

!`node --no-warnings "${CLAUDE_PLUGIN_ROOT}/hooks/dist/tickr-hook.cjs" status "${CLAUDE_PLUGIN_DATA}"`

Show the status above to the user as it is, then explain briefly what needs their attention, if anything:

- `paused: the API key was refused`: set a valid key in the Tickr plugin option `api_key`.
- `paused: the API key cannot record time`: the key belongs to a read-only role; use a key of a member who can record time.
- `paused: this Tickr does not accept agent sessions yet`: nothing to do; the plugin asks again every hour.
- `paused: this computer's clock is ahead of Tickr`: correct the system clock; sending resumes on its own.
- `intake paused`: the local queue is full, usually because Tickr could not be reached for a long time; it resumes once the queue is sent.
- `previous key or URL`: data recorded under former plugin options; it is kept for reference and never sent under the current ones.
- Terminal items were refused by Tickr for good (for example `not_project_member`: run `/tickr:link` to pick a project you belong to; `workspace_mismatch`: `.tickr.json` names another workspace than the key's).

Do not run anything else.
