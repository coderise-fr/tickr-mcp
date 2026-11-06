# Release checks — plugin `tickr` 0.2.0

Session context: `/tickr:task`, `/tickr:describe`, option `auto_context`. See the [0.1.0 record](plugin-0.1.0.md) for the full checklist.

Date: 2026-11-06. Not released yet.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 501 tests, on Node 22.17 (Windows), three runs in a row. CI also runs them on Ubuntu and macOS with Node 22, 24 and 26; that run is not recorded here. |
| Bundle equals its source | pass | Two builds are byte-identical. |
| `claude plugin validate --strict` | pass | Claude Code 2.1.318. The extra plugin directory checks (README in the plugin folder, icon) are unchanged from 0.1.x. |
| The session context overrides task and description only for the same project; the link stays computed from `.tickr.json` | pass | Automated tests. |
| An invalid, oversized (over 4 KB) or non-regular context file is ignored | pass | Automated tests. A symbolic link is refused by the same regular-file check (`lstat`); not tested, since creating links on Windows needs extra rights. |
| Two sessions of one checkout have independent contexts | pass | Automated test. |
| A context change splits the segment and the next revisions carry the new task and description | pass | Automated test against a local test server, and a real Claude Code 2.1.318 session: the hooks after `set-context` were recorded with the new description and the session's segment was split at that moment. Nothing was accepted by Tickr in the real session (a test key, refused with 401). |
| `set-context` / `clear-context` validation and atomic write | pass | Automated tests: 11 words, 101 characters, control characters, a task that is not a UUID are refused; `none` sets no task; no temporary file is left behind. |
| Only the confirmed description reaches Tickr as free text | pass | Privacy test: a full session with a context set halfway; every other text value of every request body is an id, a time, a model or a fixed word. |
| SessionStart note for the model | pass | Automated tests (manual, automatic, current context, nothing in unlinked or untracked checkouts). Real session: the model quoted the note word for word. |
| Commands and skill load | pass | Real session: `/tickr:describe` proposed a description and asked for confirmation (manual mode); `/tickr:task` read `.tickr.json`, called `list_tasks` (refused with 401, test key) and stopped without changing anything. |
| `${CLAUDE_SESSION_ID}` in the commands is the session of the hooks | pass | Real session: the command line contained the session id reported by Claude Code, and the context file name was the hash of that id; the hooks of that session applied the context. |
| `set-context` is not pre-authorised | pass | Pinned by an automated test. Real `claude -p` session without a rule: the command was refused (permission denial). |
| Automatic mode with the permission rule runs `set-context` without a prompt | pass | Real `claude -p` session with `auto_context` true and `--allowedTools 'Bash(node --no-warnings *tickr-hook.cjs" set-context *)'`: no question in chat, no permission denial, file written. The rule with the full plugin path also matched. A command chained after it (`&& echo ... > file`) was still refused. |
| The `clear-context` rule | not run | Only shown not to be covered by the `set-context` rule (the command was refused). The rule `Bash(node --no-warnings *tickr-hook.cjs" clear-context *)` itself was not run. |
| "Always allow" at the interactive permission prompt | not run | Needs an interactive session; which rule Claude Code saves was not checked. |
| Retention removes context files older than 90 days | pass | Automated tests (`pruneContexts` and the flusher's bounds stage). |
| Install from the public marketplace, macOS, Linux | not run | The real check used a local copy of the marketplace under another name, so that an installed `tickr@tickr-mcp` was left untouched. |
