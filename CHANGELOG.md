# Changelog

## 0.9.0 — 2026-11-12

### Added

- **Visibility Ladder provider**: when a Visibility Ladder extension collapses a large tool result to a short or hidden level, and a fact on a board this process has used quotes a line (40 characters or longer) of that result in its evidence, the result collapses to a one-line pointer at that fact instead: `→ fact <id> (board <project>): <text>`. Disputed facts are skipped and the newest match wins. The plugin registers one provider per process under `Symbol.for("omp.visibility-ladder.providers")` and does nothing unless such an extension is loaded. Matching is in `src/ladder-provider.ts`.

## 0.8.1 — 2026-11-12

### Added

- **Token Usage Telemetry on Viewer UI**: Displays live aggregated token metrics (`Input`, `Output`, `Cache Read`, `Cost`) in a topbar badge on `/fact-board`.
- **Incremental Byte-Offset Cache**: Telemetry is served via dedicated `/api/telemetry` endpoint with 120s path caching and incremental byte-offset parsing, eliminating full file re-reads.
- **Manual Telemetry Refresh**: Dedicated refresh button on the viewer topbar; auto-refresh interval disabled to keep viewer lightweight.
- **Project Discrimination**: Matches token telemetry per board project across multi-session environments.
- **Auto-update Command**: Added `/fact-board-update` command for checking and automatically updating git checkout installations.

### Changed

- **Cairn Mindset & Governance**: Enforced user confirmation in chat before calling `board_complete`, and mandated intent/environment fidelity for verification facts.
- **Board Auditor Watchdog**: Added checks flagging premature board completion and environment mismatches.

Extensions load only at process start: quit omp fully to pick up this change.

## 0.8.0 — 2026-11-10

### Added

- **Board Picker with Columns**: the viewer's native board select is replaced by a combobox whose list has a **Board** and a **Completed** column. Boards are grouped Active and Completed; each completed board shows how long ago it finished (`3d ago`, `1w ago`, `1mo ago`, `1y ago`) in right-aligned tabular numerals, with the exact date as its tooltip, newest completion first. It works from the keyboard (Enter, Space or the arrow keys open it; ↑/↓, Home, End, type-ahead, Enter and Esc), follows the ARIA combobox and listbox pattern, keeps its highlight when the list is rebuilt while open, and uses 44 px rows on narrow screens. The page keeps its existing tokens and adds one overlay shadow token.
- **Text Limits**: free text longer than 16 000 characters (`MAX_TEXT`) and worker or author labels longer than 200 (`MAX_NAME`) are refused with the error code `too_long` instead of stored, so one agent cannot make every export and viewer poll heavy. A fact's evidence, including the reasons `fact_dispute` appends, may total at most twice the text limit.
- **Viewer Security Headers**: the page is served under a Content-Security-Policy that allows only its own inline script (by a sha256 computed from the page), no other origin and no framing, plus `X-Content-Type-Options: nosniff` and `Referrer-Policy: no-referrer`; `/api/board` sends the same two headers.
- **Wider Credential Redaction**: new rules for the `user:password@` part of a connection string (an empty user as in `redis://:pw@host`, and a raw `@` in the password, included), `Authorization:` values with any scheme, `Cookie:` and `Set-Cookie:` header values, JWTs, and Google (`AIza`), GitLab (`glpat-`) and npm (`npm_`) tokens. Every rule is length-bounded, and tests assert linear time on pathological input.

### Changed

- Project names may not be Windows device names (`con`, `prn`, `aux`, `nul`, `com1` to `com9`, `lpt1` to `lpt9`, with or without an extension). A board file already stored under such a name is no longer listed.
- The viewer page cannot be embedded in a frame (`frame-ancestors 'none'`).
- `completed_at` is derived from the completion intent only, and only while the board is completed. `board_complete` no longer writes a `completed_at` row to `meta`, and rows left behind by 0.7.0 to 0.7.2 are ignored.

### Fixed

- A board reopened and completed again by an older version kept the time of its first completion, and a reopened (active) board still reported one. The time now follows the current completion intent.
- `fact_dispute` could grow one fact's evidence without limit by appending on every call.
- The 4096-character cap on `Cookie` redaction left the tail of a longer header visible, and an `Authorization` scheme of eight or more characters (`Negotiate`) was redacted instead of the credential after it.

Extensions load only at process start: quit omp fully to pick up this change.

## 0.7.2 — 2026-11-10

### Fixed

- The dispatcher's board-write check in `src/index.ts` kept its own copy of the write-tool list and omitted `intent_heartbeat`, so a heartbeat was treated as ordinary work and `cairn-dispatch` advice fired right after a board write. It now reuses the single `WRITE_TOOLS` set from `src/session-boards.ts`, and a test pins the set so the two cannot drift.

## 0.7.1 — 2026-11-07

### Fixed

- Hints written in the same millisecond came back oldest-first, because the hint queries sorted on `created_at` alone. `intent_claim` returns only the newest 10 hints, so when a burst of hints shared a timestamp a worker could miss the latest steering. `queryHints` and the viewer/export snapshot now break ties on `rowid`, newest first.
- The `board_init` overlap warning said "active board(s)" although it also lists boards completed in the last 7 days. It now says "active or recently completed", and each `overlapping` entry carries its `status`.

## 0.7.0 — 2026-11-04

### Added

- **Board Completion Time**: `board_complete` records `completed_at` in `meta`; `BoardInfo.completed_at`, `BoardSummary.completed_at` and `board_list` (ISO) expose it, and `board_reopen` clears it. Boards completed before this version derive the timestamp from their completion intent, so existing boards need no migration.
- **Completion Time in the Viewer Picker**: the project picker groups active and completed boards, labels each finished board with its completion age (`3d ago`, `2w ago`, `1mo ago`), orders finished boards newest completion first, and shows the same age beside *Completed via* in the board summary. The default board goes through the same pipeline, so a completed default board carries its time and honours **Show completed**.

### Changed

- `listBoards` orders completed boards by completion time (falling back to last activity) instead of last activity alone; active boards keep their previous order.
- The picker rebuilds only when its visible labels change and never while it has focus, so an open dropdown is not replaced mid-selection.

## 0.6.1 — 2026-11-02

### Added

- **Safe Prefix Resolution**: `getFact`, `getIntent`, `claimIntent`, `heartbeatIntent`, `concludeIntent`, `releaseIntent`, and `validateSources` accept unambiguous short IDs (length >= 8). Matches are resolved using `substr(id, 1, len) = prefix` rather than SQLite `LIKE` to avoid wildcard collision on `f_<sha1>` underscores. Multiple matches throw `ambiguous_id`.
- **Token-Efficient Summary Export**: `board_export({ format: "summary" })` returns a compact JSON summary containing board status, intent/fact/hint counts, active (`open`/`claimed`) intents, standing hints, and the 10 most recent facts with truncated evidence.
- **Project Overlap Suggestions**: `board_init` returns `suggested_project` in the warning payload when an active board shares a name family, giving agents a direct project name to continue on.
- **Structured Completion Errors & Attributed Reopen**: `claimFact` on a completed board throws `BoardError` with `code: "board_completed"`, `completed_intent`, and `suggested_reason`. `reopen(reason, worker)` accepts caller identity and attributes the reopen fact accordingly.
- **Sensitive Material Redaction**: Added regex rules in `src/redact.ts` for 32-64 hex nodekeys/privkeys, Ethereum/Geth V3 keystore JSON (`ciphertext`/`mac`), and short `passfile`/`passphrase` assignments.

### Fixed

- **Fact Provenance Loss**: Controller identity is preserved across `clearReason()` and `reason_release` as `controller_worker` in `meta`, eliminating the regression where post-release facts defaulted to `unknown`. Subagents claiming intents can no longer overwrite controller attribution.
- **Write-Tool Hook Normalization**: Calls to `write xd://<tool>` are normalized to the target board tool name and parsed JSON content before passing to `recordToolUse` and `nudgeOnCall`, ensuring compaction summaries retain project tracking and in-session reminders reset properly on board writes.
- **Dispatcher Write-Tool Race Alarms**: Suppressed `dispatchFor` in the `tool_call` hook when the in-flight tool is an active board write (`intent_*`, `fact_*`, `board_*`), preventing false-alarm dispatch messages caused by pre-execution database reads.
- **Parameter Aliases**: Added ergonomic aliases across tools: `hint_write` accepts `text`/`hint`/`message`; `board_reopen` accepts `why`/`explanation`; `intent_create` defaults `from` to `"origin"` if omitted; `intent_conclude` accepts `result`/`text`.
## 0.6.0 — 2026-10-30
### Added

- `intent_claim` returns `hint_count`, the board's total hint count, next to the newest 10 hints. A worker whose `hint_count` exceeds `hints.length` knows it saw only the newest slice and can read the rest (`hint_query`, or the exported board) before deciding.
- The dispatcher's Reason advice now carries the absolute totals (`Board now: N fact(s), M hint(s), K live intent(s)`) alongside the delta that fired it, still counts only and never board text.

### Changed

- `cairn-search` and README tell the controller to brief a worker by path: export the board once to `local://board-<project>.md`, pass that path plus the intent id, and never paste the graph into the task text. When a subagent must return structured data instead of writing to the board, declare `outputSchema` rather than asking for JSON in prose.
- The shipped Board auditor advisor flags an intent only when it repeats a concluded direction or cites no source (`from` empty, or only `origin` while the board has related facts); a short description alone is not a finding.

## 0.5.1 — 2026-10-29

### Added

- `docs/advisors/board-auditor.yml`: an optional advisor entry that audits a board instead of the code — a `board_complete` with no fact chain to the goal, floating facts, unknown provenance, intents that cover the same direction, and evidence that is reasoning rather than an observed command or output. It is read-only (`read`/`grep`/`glob`; it queries the board with `read <db>?q=SELECT …`), `scope: main`, and treats board text as data, so board content cannot steer the reviewer. Installing the plugin never adds it: `WATCHDOG.yml` discovery reads the agent and project directories, not the plugin cache. README §Advisors documents the merge step (keep the item's two-space indentation; a level mismatch drops the whole roster, not just the new entry), how to confirm the entry built (`/advisor status`, plus the startup warning omp prints for a malformed roster), and the cadence (`agent-end`, every third run — a roster entry ignores the global `advisor.reviewInterval`).

## 0.5.0 — 2026-10-29

### Changed

- `intent_conclude` now requires `evidence`. An empty or missing evidence is refused before anything is written, so a conclusion without the command, file or output that proves it no longer lands on the board. The parameter is required in the tool schema and enforced in `Board.concludeIntent`; existing boards need no migration because the column already exists.
- `rules/cairn-mindset.md` now states three review findings: every fact carries evidence, a Reason pass ends with `board_complete` or `reason_release` instead of leaving the lease to expire, and `board_complete` is preceded by turning remaining work into intents or a handoff hint and reading the returned `unfinished` list. The `cairn-search` skill and README say the same.
- Extensions load only at process start: quit omp fully, update the catalog and upgrade, then restart. A marketplace install runs `omp plugin marketplace update omp-cairn-blackboard` then `omp plugin upgrade omp-cairn-blackboard@omp-cairn-blackboard`; a `github:` install runs `omp plugin upgrade omp-cairn-blackboard`.

## 0.4.1 — 2026-10-29

### Changed

- `/fact-board` viewer redesigned: OKLCH tokens with light and dark themes, a sticky topbar with the live/paused/offline state, a board summary, worker chips that filter the list, an intents rail grouped by status, and a restyled graph that fits the viewport. It still loads nothing from the network, renders board text with `textContent` only, and keeps the same URLs, `project`/`view` parameters and 2 s refresh.
- The `hint_write` description now names its purpose: record user steering before acting, so workers that claim an intent receive it.

### Fixed

- Mid-run user steering was never recorded as a hint. The always-applied `rules/cairn-mindset.md` never mentioned `hint_write`, so a session that kept working after the user changed scope, approved a step or forbade one left `hints` empty, and every `intent_claim` handed workers `hints: []`. The rule now requires writing a short hint before acting on such a change, and `cairn-search` says the same for the controller.

Extensions load only at process start: quit omp fully, update the catalog and upgrade, then restart. A marketplace install runs `omp plugin marketplace update omp-cairn-blackboard` then `omp plugin upgrade omp-cairn-blackboard@omp-cairn-blackboard`; a `github:` install runs `omp plugin upgrade omp-cairn-blackboard`.

## 0.4.0 — 2026-10-29

### Added

- New-version notice: once a day, a main session compares the installed version with `package.json` on `main` and, if `main` is newer, suggests the update command for the install method (marketplace, `github:`, or linked git checkout). It never updates by itself, stays silent when offline, and is off with `FACT_BOARD_UPDATE_CHECK=0`.
- Marketplace catalog `.omp-plugin/marketplace.json`: install with `omp plugin marketplace add duhd/omp-cairn-blackboard` and `omp plugin install omp-cairn-blackboard@omp-cairn-blackboard`.
- Rule `rules/cairn-mindset.md` (always applied): tells the agent when and how to use the board. It loads and unloads with the plugin and updates with it, so a hand-copied "Cairn Mindset" block in a user-level `AGENTS.md` is no longer needed; remove it to avoid two copies.

### Changed

- `cairn-search` reports a met goal and waits for the user to confirm before `board_complete` (unless the user asked it to close the board itself), releasing the Reason lease in the meantime.

### Fixed

- `board_export` timeline now marks disputed facts with `DISPUTED: <reason>` on their `FACT CLAIMED` / `INTENT CONCLUDED` entry. Previously a disputed fact read like a standing one. The schema has no dispute timestamp, so the mark is attached to the fact's entry instead of becoming its own event.
- `board_export` timeline no longer shows a reopened board's completion intent as `INTENT CONCLUDED` producing the reopen reason. It now shows `BOARD COMPLETED` at the completion time and `BOARD REOPENED (undoes <intent>)` at the reopen time. Existing boards read correctly without a migration.

Extensions load only at process start: quit omp fully to pick up this change.
