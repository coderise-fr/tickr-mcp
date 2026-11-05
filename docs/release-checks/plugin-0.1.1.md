# Release checks — plugin `tickr` 0.1.1

Security patch of plugin 0.1.0. See the [0.1.0 record](plugin-0.1.0.md) for the full checklist.

Date: 2026-11-05.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 443 tests, on Node 22.17 (Windows), three runs in a row. CI runs them on Ubuntu, Windows and macOS with Node 22, 24 and 26. |
| Bundle equals its source | pass | Two builds are byte-identical. |
| A `.tickr.json` that was never linked on the machine tracks nothing | pass | Automated tests, and a real Claude Code 2.1.296 session in a repository with an unlinked `.tickr.json`: no entry was created. |
| `accept` links the checkout and tracking starts | pass | Same real session after `accept`: one entry, closed, quality `complete`. |
| A changed or moved `.tickr.json` must be linked again | pass | Automated tests. |
| Revoking a link stops the sessions already recorded | pass | Automated tests against a local test server: after the link file is removed, or once a hook finds `.tickr.json` changed, the session's segments and delegated entries go terminal (`unlinked`), nothing more is sent and its transcript is no longer read; one notice; linking again tracks the session again. Not run in a real Claude Code session. |
| Store schema v3 migrates a v2 store | pass | Automated test: rows kept; events journalled before v3 carry no link and are not judged. |
| Concurrent `accept` keep every link | pass | Automated test: 8 `accept` processes of the built bundle at once, all linked. |
| `/tickr:link` links a kept `.tickr.json` | pass | Pinned by an automated test of the command text: the keep path skips the rewrite and reaches the exclude step and `accept`. Not run interactively. |
| `.tickr.json` over 64 KB or not a regular file is refused | pass | Automated tests. |
| `/tickr:status` runs with only the status command pre-authorised | pass | Real session: the output is shown without a permission prompt. |
| `/tickr:link` pre-authorises no file access nor `node` command | pass | Pinned by an automated test. The interactive flow (prompts for the file write and for `accept`) was not run end to end. |
| Install from a local marketplace on macOS, Linux | not run | |
