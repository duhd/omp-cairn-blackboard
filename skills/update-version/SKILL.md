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

1. `package.json` — bump `version` (semver: patch for fixes, minor for behavior, major for breaking contracts).
2. Run the suite — `bun test` must be green.
3. If a public contract changed (tool params, skill names, nudge/lease behavior), update `README.md` and `AGENTS.md` so the docs match the code.
4. Commit with a conventional message and push to `origin/main` (`duhd/omp-cairn-blackboard`).

## Guardrails

- Only use the verified zod subset in `src/index.ts` (see `AGENTS.md`): `z.object/string/number` plus `.optional/.describe/.int/.positive/.max`. `z.preprocess` is not in the host shim and breaks extension load.
- Never return `lease_token`/`reason_token` outside the claiming tool's own result.
- Keep fact provenance: pass `claimed_by`, cite `from`.
- Keep the skill layout `skills/<name>/SKILL.md` (one level, non-recursive) and always set `name` + `description` frontmatter — the `omp-plugins` provider drops skills without a `description`.
