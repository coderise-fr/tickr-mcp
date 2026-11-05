# Release checks — plugin `tickr` 0.1.0

Released as tag `plugin-v0.1.0` on 2026-11-05. The rows marked `not run` below
were not done before the release.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 411 tests, on Node 22.17 (Windows). CI runs them on Ubuntu, Windows and macOS with Node 22, 24 and 26. |
| Bundle equals its source | pass | Two builds are byte-identical; CI rebuilds and diffs `plugins/tickr/hooks/dist`. |
| Runtime without `node:sqlite` (Node 22.12.0, 20.x) | pass | CI: exit 0, one message, no store created. |
| `claude plugin validate --strict` (plugin and marketplace) | pass | Claude Code 2.1.296. |
| OpenAPI contract with the two plugin routes | pass | 12 routes, against a test instance with agent provenance. Production does not have the two routes yet: they are skipped there. |
| Hooks and flusher end to end on a test instance | pass | The built bundle fed with the five hook events of a session and a transcript with two assistant messages: the segment is created, then closed at the end of the session with quality `complete` and the tokens of both messages (1,500 input, 500 output, 200 cache creation, 100 cache read). That run predates the wait for the agent version, and its entry kept the Tickr-Agent version `unknown`. Since then the creation request of a segment waits up to 2 minutes after the segment starts for the Claude Code version that the flusher reads from the transcript, then goes with `unknown`. The hook tests check this with fake clocks: the creation is held, then sent with `claude-code/<version>` once a transcript read names the version, or with `unknown` when the 2 minutes are up. A real hook process against a local server, with a transcript that names the version, gets `claude-code/<version>` on its creation request. The end-to-end run on the test instance has not been repeated. |
| Real Claude Code session with the plugin installed | pass | Claude Code 2.1.296, plugin installed from a local marketplace, a linked repository, a headless session (shell command, `get_context`, `start_timer`, `stop_timer`): one entry closed at the end of the session, quality `complete`, `Tickr-Agent` version `2.1.296`, tokens of the session recorded. Not run on macOS or Linux, nor through the public marketplace. |
| Delegated `start_timer` through the plugin's MCP server | pass | In the same real session the entry created by `start_timer` is linked to the session (quality `complete`, no tokens: they belong to the session entry). The real `tool_response` is the tool's JSON text itself, which the plugin now reads. |
| Install from a local marketplace on Windows, macOS, Linux | not run | |
| Parallel sessions in one repository | not run | Covered by unit and process tests. |
| `/tickr:status` output reviewed for privacy | pass | Covered by an automated test: no key, instance hash, path or description. |
| Re-captured `initialize` and `tool_response` fixtures with the current Claude Code | pass | `initialize` of 2.1.296 for the MCP server; the real `tool_response` shape is pinned by a test. |
