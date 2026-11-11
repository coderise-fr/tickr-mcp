# Release checks — plugin `tickr` 0.4.3

Fixes to the flusher's edge cases on top of [0.4.2](plugin-0.4.2.md): revisions invalidated
outside the ledger window, tags Tickr holds as a subset, a refused mapping after an idle gap,
and sessions locked by `409 entry_locked`. See the [0.1.0 record](plugin-0.1.0.md) for the full
checklist.

Date: 2026-11-11. To be released as tag `plugin-v0.4.3`.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests, typecheck and lint clean. |
| Hook tests (`npm run test:hook`) | pass | 584 tests, on Node 22.17 (Windows), one run. CI runs them on Ubuntu, Windows and macOS; that run is not recorded here. |
| Bundle equals its source | pass | Rebuilt with `npm run build:hook` after the version bump. |
| `409 agent_revision_conflict` then `409 entry_locked` on another segment | pass (fake server only) | The conflicted segment is known as held by Tickr: it is not cancelled by the lock and its replacement revision is sent. |
| Rename answered after the session was locked | pass (fake server only) | With a Tickr that keeps the old values, and with `422 immutable`: the segment the repair splits off is cancelled (terminal, never sent); the entry Tickr holds still receives its final revision. The lock is simulated by setting the session state between the probe's commit and its answer. |
| `409 entry_locked` cancels the session's unsent segments | pass (fake server only) | Including those already queued; segments Tickr holds keep their updates. |
| Invalidated commit selected again outside the ledger window | pass | Pinned by a store test. |
| `409 segment_id_unavailable` | not addressed | Terminal by design (PD-12). Seen on the last revision of already-created segments of a real instance; its cause on Tickr's side is unconfirmed, so nothing changes here. |
| Real Claude Code session against a Tickr | not run | No key was used for this check. |
