# Release checks — plugin `tickr` 0.4.0

Renaming a session's entry in place when the task or the description changes, when your Tickr applies the change; otherwise the entry is split at the change as before. See the [0.1.0 record](plugin-0.1.0.md) for the full checklist.

Date: 2026-11-09. Released as tag `plugin-v0.4.0`.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 549 tests, on Node 22.17 (Windows), three runs in a row. CI also runs them on Ubuntu and macOS; that run is not recorded here. |
| Bundle equals its source | pass | Two builds are byte-identical. |
| `claude plugin validate --strict` | pass | Claude Code 2.1.318, marketplace and plugin directory. |
| A Tickr that applies the change: one segment, one entry | pass (fake server only) | Pipeline tests with a local fake Tickr that stores the entry and applies a later revision's task and description: one segment, revisions 1, 2, 3… on the same id, the next revisions carry the new task and description, `rename_support` is `supported`. Also for a task-only change. No real Tickr applies such a change yet, so this path ran against the fake server only. |
| A Tickr that keeps the old values: split at the change | pass (fake server only) | Pipeline tests with a fake Tickr that answers with the entry's old task and description, as the real test instance does: `rename_support` is `unsupported`; the old segment is final at the change with its own mapping, and its final revision (old task and description) supersedes the one Tickr ignored; a new segment starts at the change with the new mapping, without gap or overlap; a message after the change is attributed to the new segment. The next change splits directly. Not run end to end against the real test instance (no key used for this check). |
| Re-probe a day later | pass | Pipeline test with a fake clock: within 24 h of `unsupported` a change splits directly; after it, the change is tried in place again and `supported` is recorded when Tickr applies it. |
| A change Tickr refuses (422 on the task) | pass (fake server only) | The old segment is split and finalised as above, never terminal; the new segment is refused as before; nothing is learnt. |
| Project or tags change | pass | Still split, nothing tried in place. |
| Crash safety | pass | The existing crash tests pass. A probe whose answer is lost is sent again with the same bytes, and nothing else of the segment is committed meanwhile. |
| Privacy | pass | The privacy test passes: only the task, the description and ids reach Tickr; the answer's task and description are read, never stored. |
| Built bundle with a local fake Tickr | pass (fake server only) | The built hook bundle run as Claude Code runs it (hooks, `accept`, `set-context`, the detached flusher), once against a fake Tickr that keeps the old values (one probe, then the old entry's final revision with the old description, and a new entry from the change) and once against one that applies them (one entry, renamed). |
| Real Claude Code session against a real Tickr | not run | No real key was used for this check. |
