# Changelog

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
