# Release checks — plugin `tickr` 0.4.2

Follows the segment route's rename contract of a Tickr that applies the change (description,
task and tags of a later revision applied to the same entry, project immutable), and keeps
working with a Tickr that does not: the plugin tells them apart from the answer alone, never
from a version number. See the [0.4.0 record](plugin-0.4.0.md) for the rename in place and
the [0.1.0 record](plugin-0.1.0.md) for the full checklist.

Date: 2026-11-09. Not released yet.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 572 tests, on Node 22.17 (Windows), three runs in a row. CI runs them on Ubuntu, Windows and macOS; that run is not recorded here. |
| Bundle equals its source | pass | Two builds are byte-identical. |
| Every revision names the task and the description | pass | Pinned by tests: `taskId` is a value or an explicit `null`, never absent; a probe answered `503 workspace_busy` is resent with the very same bytes, `"taskId":null` included. |
| A Tickr that applies the change | pass (fake server only) | A local fake Tickr that follows the contract: a change of the description only, of the task only, a task cleared with `null`: one segment, one entry renamed, `rename_support` is `supported`. Once supported, a change of tags is renamed in place (replaced, then emptied). |
| A tag deleted in Tickr | pass (fake server only) | The answer shows the new description but not the deleted tag: the rename counts as applied, `supported` is recorded, and the next revisions send the tags Tickr holds. |
| A Tickr that keeps the old values | pass (fake server only) | The same fake in its old mode (a `200` with the entry unchanged): `unsupported` is recorded and the entry is split at the change as before. The real local test instance behaves this way, but no key was used for this check, so it ran against the fake server only. |
| A change of project | pass (fake server only) | Always a split: the old segment's final revision keeps its project, end and usage; a new segment carries the new project. A test checks that no revision of a segment ever carries another `projectId` than its creation's. |
| `422 immutable` on the project | pass (fake server only) | On a probe: the split above, nothing terminal, a bounded number of requests. On a heartbeat (never caused by the plugin): the segment is closed locally, nothing terminal, the next activity opens a new segment. |
| Another `422` on a rename | pass (fake server only) | A task of another project (`invalid`): the change is given up, the segment goes on with the previous task, its end and usage, one message `rename_refused:<code>`; more activity with the refused task never sends it again. |
| `409 agent_revision_conflict` | pass (fake server only) | Nothing terminal; the wanted body is committed under the next number (a probe too) and applied; the number already sent is never sent with other bytes. |
| `409 entry_locked` | pass (fake server only) | One message; the session is no longer recorded; no split into another entry of the same period. |
| `409 segment_finalized` | pass (fake server only) | A rename whose end moves on a segment Tickr finalised: the segment is closed, the next activity opens a new one. |
| Crash safety and privacy | pass | The existing crash and privacy tests pass. The only thing kept from an answer is the list of tag ids Tickr holds for a segment, after a tag was deleted there. |
| Real Claude Code session against a Tickr that applies the change | not run | No such Tickr and no key were used for this check. |
