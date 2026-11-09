# Release checks — plugin `tickr` 0.3.0

Asking to link a session that is not linked, option `ask_to_link`; the docs say that a task or description change starts a new entry. See the [0.1.0 record](plugin-0.1.0.md) for the full checklist.

Date: 2026-11-09. Not released yet.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Dev dependency audit | pass | `npm audit`: no advisory. |
| Hook tests (`npm run test:hook`) | pass | 535 tests, on Node 22.17 (Windows), three runs in a row. CI also runs them on Ubuntu and macOS; that run is not recorded here. |
| Bundle equals its source | pass | Two builds are byte-identical. |
| `claude plugin validate --strict` | pass | Claude Code 2.1.318. |
| SessionStart note for the model in a checkout without `.tickr.json`, and in one whose `.tickr.json` is not linked on this machine | pass | Automated tests: the user message and the note in one JSON object; the note states the case and the rule (the first time the user gives work, ask once before starting it, with no tool call; not for questions nor when the user said to skip Tickr; yes: run the `tickr:link` skill, then the work; no: the work, and never ask again; never write `.tickr.json`); no path, id, hash or key. Not at resume or compact, not at any other event. |
| Option `ask_to_link` | pass | Automated tests: default true; `false` or `0` keep only the message; the manifest declares it as a boolean, default true. |
| Linked checkout unchanged | pass | Automated tests: the session context note, with `auto_context` on or off, whatever `ask_to_link` is. |
| The skill the note names exists | pass | Automated test: `tickr:link` is `plugins/tickr/commands/link.md` of the plugin named `tickr`, without `disable-model-invocation`. |
| Privacy | pass | The privacy test now also starts a session in a checkout with a `.tickr.json` that is not linked: no output shown to the user or the model carries a path, a hash or the key. |
| Real session, no `.tickr.json`, work request: the question comes first | pass | Claude Code 2.1.318, `claude -p "Add a subtract function to calc.py." --output-format stream-json --verbose` in a temporary git repository, run twice. The hook output carried the message and the note. Both times the first assistant turn had no tool call and its whole text was "Do you want to link this session to a Tickr activity before I add the `subtract` function to `calc.py`?"; no tool was called in the run, `calc.py` was byte-identical afterwards and no `.tickr.json` was written. |
| Real session, answer "no" | pass | The same session resumed with `claude -p --resume <id> "No."` (edits allowed): the model read and edited `calc.py` (the work was done) without asking again. |
| Real session, answer "yes" | partly | The same kind of session resumed with "Yes.": the first tool call was the Skill tool with `tickr:link`. In headless mode the command produced no output and nothing was linked (no `.tickr.json`); the model then tried the edit, refused by the headless permission mode. The full link flow needs an interactive session. |
| Real session, `.tickr.json` not linked, work request | pass | Same setup with a `.tickr.json` holding test ids: the note named the not-confirmed case; the first turn had no tool call and was "Do you want to link this session to a Tickr activity before I rename `add` to `plus` in `calc.py`?"; `.tickr.json` and `calc.py` were byte-identical afterwards. |
| Real session, a plain question | pass | "What does the add function in calc.py return?": answered (after reading the file) without the link question. One run; the model's choice may vary. |
| Real session, the request says to skip Tickr | pass | "Without Tickr tracking, add a multiply function to calc.py.": no question, the work was done. One run. |
| Real session, `ask_to_link` false | pass | The hook output carried only the message (no note); the model did the work (`calc.py` edited) without asking to link. |
| Install from the public marketplace, macOS, Linux | not run | The real check used a local copy of the marketplace under another name, installed at local scope in a temporary repository (where an installed `tickr@tickr-mcp` was disabled at local scope), with the options given as `CLAUDE_PLUGIN_OPTION_*` environment variables and a test key. The Claude Code configuration files were byte-identical to their backups afterwards. |
| "Yes" then `/tickr:link` in an interactive session | not run | Needs an interactive session and a real Tickr. |
