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
| SessionStart note for the model in a checkout without `.tickr.json`, and in one whose `.tickr.json` is not linked on this machine | pass | Automated tests: the user message and the note in one JSON object; the note states the case and the rule (ask once when the user gives work, not for questions; yes: run the `tickr:link` skill; no: do not ask again; never write `.tickr.json`); no path, id, hash or key. Not at resume or compact, not at any other event. |
| Option `ask_to_link` | pass | Automated tests: default true; `false` or `0` keep only the message; the manifest declares it as a boolean, default true. |
| Linked checkout unchanged | pass | Automated tests: the session context note, with `auto_context` on or off, whatever `ask_to_link` is. |
| The skill the note names exists | pass | Automated test: `tickr:link` is `plugins/tickr/commands/link.md` of the plugin named `tickr`, without `disable-model-invocation`. |
| Privacy | pass | The privacy test now also starts a session in a checkout with a `.tickr.json` that is not linked: no output shown to the user or the model carries a path, a hash or the key. |
| Real session, no `.tickr.json`, work request | pass | Claude Code 2.1.318, `claude -p "Add a subtract function to calc.py."` in a temporary git repository. The hook output carried the message and the note. The answer ended with "Do you want to link this session to a Tickr activity?". No `.tickr.json` was written (the edit of `calc.py` itself was refused by the headless permission mode). `-p` cannot answer, so the "yes" and "no" paths were not run for real. |
| Real session, `.tickr.json` not linked, work request | pass | Same setup with a `.tickr.json` holding test ids: the note named the not-confirmed case; the answer ended with the same question; the file was byte-identical afterwards. |
| Real session, a plain question | pass | "What does the add function in calc.py return?": answered without asking to link. One run only; the model's choice may vary. |
| Real session, `ask_to_link` false | pass | The hook output carried only the message; the model did the work without asking to link. |
| Model asks before or after starting the work | observed | In the three real work requests the model attempted the work first and asked at the end of its answer. The note does not say when to ask. |
| Install from the public marketplace, macOS, Linux | not run | The real check used a local copy of the marketplace under another name, installed at local scope in a temporary repository (where an installed `tickr@tickr-mcp` was disabled at local scope), with the options given as `CLAUDE_PLUGIN_OPTION_*` environment variables and a test key. The Claude Code configuration files were byte-identical to their backups afterwards. |
| "Yes" then `/tickr:link` in an interactive session | not run | Needs an interactive session and a real Tickr. |
