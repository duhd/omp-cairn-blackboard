# Changelog

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
