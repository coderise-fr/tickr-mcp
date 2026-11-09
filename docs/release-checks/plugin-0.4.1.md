# Release checks — plugin `tickr` 0.4.1

Patch release: the skill's question about linking a session is gated on the SessionStart
ask-to-link note. No hook code, option or tool changed; see the
[0.3.0 record](plugin-0.3.0.md) for the note and its option.

Date: 2026-11-09.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 551 tests, on Node 22.17 (Windows). CI runs them on Ubuntu, Windows and macOS with Node 22, 24 and 26. |
| Bundle equals its source | pass | Rebuilt for the new version constant; two builds are byte-identical. |
| The skill asks only after the note | pass | Pinned by an automated test of the skill text: an unlinked checkout alone, or `ask_to_link` off, never prompts; the model never suggests linking on its own. Not run in a real Claude Code session. |
