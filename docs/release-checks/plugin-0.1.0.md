# Release checks — plugin `tickr` 0.1.0

Not released yet. This record is filled in as the checks are done; the plugin
is published only once every row is `pass` and the Tickr it targets accepts
agent sessions in production.

| Check | Result | Notes |
| --- | --- | --- |
| Lint, typecheck, unit and protocol tests | pass | 355 tests. |
| Hook tests (`npm run test:hook`) | pass | 402 tests, on Node 22.17 (Windows). CI runs them on Ubuntu, Windows and macOS with Node 22, 24 and 26. |
| Bundle equals its source | pass | Two builds are byte-identical; CI rebuilds and diffs `plugins/tickr/hooks/dist`. |
| Runtime without `node:sqlite` (Node 22.12.0, 20.x) | pass | CI: exit 0, one message, no store created. |
| `claude plugin validate --strict` (plugin and marketplace) | pass | Claude Code 2.1.296. |
| OpenAPI contract with the two plugin routes | pass | 12 routes, against a test instance with agent provenance. Production does not have the two routes yet: they are skipped there. |
| Hooks and flusher end to end on a test instance | pass | The built bundle fed with the five hook events of a session and a transcript with two assistant messages: the segment is created, then closed at the end of the session with quality `complete` and the tokens of both messages (1,500 input, 500 output, 200 cache creation, 100 cache read). The Tickr-Agent version of the entry is `unknown`: it is known only after the first transcript read, later than the creation request. |
| Real Claude Code session with the plugin installed | not run | Needs the plugin installed from the marketplace, a linked repository and a key. |
| Delegated `start_timer` through the plugin's MCP server | not run | Covered by unit tests with a synthetic `tool_response`; the real shape is to be re-captured. |
| Install from a local marketplace on Windows, macOS, Linux | not run | |
| Parallel sessions in one repository | not run | Covered by unit and process tests. |
| `/tickr:status` output reviewed for privacy | pass | Covered by an automated test: no key, instance hash, path or description. |
| Re-captured `initialize` and `tool_response` fixtures with the current Claude Code | not run | `initialize` of 2.1.296 is captured for the MCP server; the `tool_response` fixture is synthetic. |
