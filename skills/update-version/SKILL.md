---
name: update-version
description: "Bump the omp-cairn-blackboard plugin version: package.json, test suite, docs, and the commit/push."
when_to_use: "Use before releasing omp-cairn-blackboard after a code change, or when asked to update the plugin version."
category: workflow
keywords: [version, release, bump, package.json, changelog]
license: MIT
---

# Update Version

## Steps

1. `package.json` — bump `version` (semver: patch for fixes, minor for behavior, major for breaking contracts). Set the same `version` in `.omp-plugin/marketplace.json`: `omp plugin upgrade` of all plugins only reinstalls when the catalog version is newer.
2. `CHANGELOG.md` — add `## X.Y.Z — YYYY-MM-DD` at the top with `### Added` / `### Changed` / `### Fixed` entries for this release. There is no `Unreleased` section.
3. Run the suite — `bun test` must be green.
4. If a public contract changed (tool params, skill names, nudge/lease behavior, `board_export` output), update `README.md` and `AGENTS.md` so the docs match the code.
5. Commit with a conventional message and push to `origin/main` (`duhd/omp-cairn-blackboard`). If push returns 403 (`Permission to duhd/omp-cairn-blackboard.git denied to duhd-vnpay`), the active gh account is wrong: run `gh auth switch --user duhd && gh auth setup-git && git push origin main`, then `gh auth switch --user duhd-vnpay` to restore. The push is the release: installed copies see the new `main` version in their next daily update check.
6. Tag it and publish release notes: `git tag vX.Y.Z && git push origin vX.Y.Z`, then write that version's CHANGELOG section to a temp file and run `gh release create vX.Y.Z --title vX.Y.Z --notes-file <file>`. Never pass the notes inline with `--notes "…"`: the CHANGELOG contains backticks, which the shell would execute. Users do not need the release to update; it records what shipped.

## Guardrails

- Only use the verified zod subset in `src/index.ts` (see `AGENTS.md`): `z.object/string/number` plus `.optional/.describe/.int/.positive/.max`. `z.preprocess` is not in the host shim and breaks extension load.
- Never return `lease_token`/`reason_token` outside the claiming tool's own result.
- Keep fact provenance: pass `claimed_by`, cite `from`.
- Keep the skill layout `skills/<name>/SKILL.md` (one level, non-recursive) and always set `name` + `description` frontmatter — the `omp-plugins` provider drops skills without a `description`.
