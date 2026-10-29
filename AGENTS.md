# Repository Guidelines

## Project Overview

`omp-cairn-blackboard` is an omp (oh-my-pi) plugin, v0.4.0, MIT, with **zero dependencies**. It gives parallel `task` subagents a shared, persistent **fact–intent graph** (a "blackboard") to coordinate through, in place of messaging each other. The idea comes from Cairn: *state is the single source of truth, decisions are distributed to workers*. None of Cairn's code is used.

The package ships these pieces:
- A 17-tool extension: `src/index.ts`
- Three workflow skills: `skills/cairn-search/SKILL.md`, `skills/dispatcher-check/SKILL.md`, `skills/update-version/SKILL.md`
- A read-only live viewer: `src/viewer.ts`, started with `/fact-board`. It has a list view and an SVG Graph tab laid out by `src/graph.ts`
- An opt-in `redact-output` feature: `src/redact-output.ts`
- A daily new-version notice on `session_start`: `src/update-check.ts` (reads `package.json` on GitHub `main`, suggests the upgrade command for the install kind, never updates)
- A marketplace catalog: `.omp-plugin/marketplace.json` (keep its `version` equal to `package.json`)
- An always-applied rule for the agent: `rules/cairn-mindset.md` (when and how to use the board). It is the only LLM guidance outside skills and tool descriptions; never write guidance into a user's `AGENTS.md`

## Architecture & Data Flow

```
omp tool call ─► src/index.ts  (adapter: zod params, snake_case → camelCase, run() error mapping)
                   │ boardFor(project) → one Board per file path, kept on globalThis (omp loads each session/subagent as its own module instance)
                   ▼
               src/board.ts    (ALL domain rules; sole SQLite writer; synchronous)
                   │ bun:sqlite, WAL
                   ▼
   <agent dir>/fact-board.db   (+ fact-boards/<project>.db per project)
                   ▲ read-only connection
               src/viewer.ts   (Bun.serve on 127.0.0.1, polls /api/board every 2 s)
                   └─ src/graph.ts  buildGraph(snapshot): pure, deterministic layout (origin left → goal right)

src/redact.ts ── shared regex rules ──► board.ts (redact before store)
                                   └──► redact-output.ts (tool_result hook, bash/eval only)
```

- **Graph:** `origin ─► Intent ─► Fact ─► Intent ─► … ─► goal`. An intent must cite source facts (`from`). Concluding it creates exactly one fact (`to_fact_id`). Completion is a concluded intent whose `to_fact_id = "goal"`. Edges live in `intent_sources` and `intents.to_fact_id`. A fact claimed directly may cite the facts it builds on (`fact_claim.from`, stored in `fact_sources`, validated like intent sources); that gives sequential work a connected chain without intents. `fact_sources` is created by `SCHEMA` when a writer opens a board, so `snapshotFrom` must keep tolerating boards that lack it.
- **The coordination rules are enforced in `board.ts`, not in prompts:**
  - **Reason lease:** only one holder at a time. Only the holder can call `intent_create`, capped by `FACT_BOARD_MAX_INTENTS` per pass (default 2).
  - **Intent lease:** `intent_claim` returns a `lease_token`. Heartbeat, conclude and release are compare-and-swap on that token: `UPDATE … WHERE id=? AND status='claimed' AND lease_token=?`.
  - **Stale leases:** `expireStale()` only drops a stale Reason lease. A claimed intent whose lease lapses stays `claimed` so its owner can still conclude slow work; a new worker reclaims it in `claimIntent` via compare-and-swap on the prior holder (`heartbeat_at === null` also counts as reclaimable).
  - **Atomicity:** every mutation runs through `write()`, i.e. `db.transaction(fn).immediate()`. If `concludeIntent` fails, the transaction rolls back its fact insert too.
- **Read paths never select `lease_token`.** Views strip it (`view()`), and `snapshotFrom` lists columns explicitly.

## Key Directories

| Path | Purpose |
|---|---|
| `src/` | Plugin source, executed directly as TypeScript (no build) |
| `test/` | `board.test.ts` covers the board, redaction and viewer. `graph.test.ts` covers the layout. `claimer.ts` and `reader.ts` are **child-process fixtures, not tests**, so do not rename them to `*.test.ts` |
| `skills/cairn-search/` | Agent-facing loop. It is shipped through `files` in `package.json` and found by omp's `skills/` directory convention. There is no `omp.skills` field, so keep the path |

## Development Commands

```bash
bun test                                   # full suite (~5 s, 3 files)
bun test -t "lease"                        # filter by test name
bun src/viewer.ts                          # standalone viewer (FACT_BOARD_PORT, FACT_BOARD_DB)
omp plugin link ./omp-cairn-blackboard     # dev install (junction on Windows)
omp plugin features omp-cairn-blackboard --enable=redact-output
```
- There is no build step, linter, formatter or typecheck script. Do not add a `bun install` step either: nothing needs installing.
- `omp plugin enable <pkg> <feature>` does **not** enable a feature. It treats the feature as a plugin name. Use `features --enable=`.
- Extensions load only at process start. **Quit omp fully** to pick up source changes; `/new` does not reload them.

## Code Conventions & Common Patterns

- **Error handling:** rule violations throw `BoardError(message, { code?, details? })`. `run()` in `index.ts` turns them into `{ error, code?, ...details }`, and any other error rethrows. Codes in use: `reason_held`, `intent_claimed`, `invalid_transition`, `lease_lost`, `not_found`. Many rules (not initialized, cap, bad source…) still have no code, so callers must handle both shapes. When you add a rule, give it a `code`.
- **Typing:** no `any`. Use `unknown` plus type guards (see `isTextChunk`). Static lookups are `Record<string, true>`, not `Set`.
- **Tool params:** wire params are snake_case (`claimed_by`, `reason_token`, `lease_token`) and TS method args are camelCase. `from` is a **string** (comma-separated or a JSON-array string) parsed by `parseIdList`; passing a real array fails validation.
- **Zod subset known to load on the host:** `z.object/string/number`, `.optional/.describe/.int/.positive/.max`. `.array()`/`.min()` were removed because they are unverified against the omptype shim. Re-verify before adding new zod methods.
- **Host import is type-only:** `import type { ExtensionAPI } from "@oh-my-pi/pi-coding-agent"`. Never make it a value import, and never add the package to `dependencies`.
- **Dedup:** fact id is `f_<sha1(redacted text)>`, so identical findings collapse into one row.
- **Schema changes:** add columns to `INTENT_COLUMNS`. `migrate()` upgrades in place with `ALTER TABLE ADD COLUMN` and tolerates the "duplicate column" race.
- **Redaction (`src/redact.ts`):**
  - Best-effort regex, ordered with PEM first.
  - The token rule matches `*token` keys in **any casing**, including camelCase and PascalCase JSON keys (`accessToken`, `IdToken`), because auth endpoints return them as real credentials.
  - The only exclusions are the board's own capability handles: `reason_token`, `lease_token`, `reasonToken`, `leaseToken`. They must round-trip verbatim. A camelCase identifier outside that list in `bash`/`eval` output is redacted, which is intentional.
  - `redact-output` rewrites only `bash`/`eval` results. Redacting `read`/`grep` output would corrupt code the agent edits.

## Important Files

| File | Why it matters |
|---|---|
| `src/board.ts` | Schema, migration, path/project resolution, every invariant. Its header comment is the canonical rule list, so keep it in sync |
| `src/index.ts` | 17 `registerTool` calls (`board_list` is the discovery tool: a session that continues earlier work cannot read a board it cannot find), the `/fact-board` command (start also upgrades an existing default board), and a `session_shutdown` handler that, for the main agent only, stops the viewer and closes the board connections. Viewer handle and boards live on `globalThis` so any module instance can stop what another started |
| `src/viewer.ts` | `startViewer` checks method, loopback and `Host`. The page renders board text with `textContent` / SVG text nodes only and must never use `innerHTML` |
| `src/graph.ts` | `buildGraph(snapshot, now)` returns nodes, edges and size for the Graph tab. Cycles are handled as back edges, so keep it pure |
| `src/session-boards.ts` | Pure helpers behind the `tool_call` / `session.compacting` hooks in `index.ts`: `recordToolUse` notes which projects and worker names a session used, `compactionContext` turns that into the lines a compaction summary carries (board names plus a "reload with `board_export`, re-claim with the same worker name" step). Only names matching `PROJECT_NAME` / the worker pattern are kept, since they land in the summary; state lives on `globalThis` and is dropped on `session_shutdown` |
| `src/dispatch.ts` | Pure `dispatchAdvice(checkpoint, counts, project)`: Cairn's `_reason_trigger` (facts/hints grew, last open intent concluded → Reason) plus "unclaimed open intents → Explore subagents". `dispatchFor` in `index.ts` reads boards from disk at most every 30 s per main session and must never throw (omp blocks a tool call whose `tool_call` handler throws) |
| `package.json` | `omp.extensions`, `omp.features["redact-output"]` (`default: false`), `files` (excludes `test/`) |

## Runtime/Tooling Preferences

- **The code is Bun-only:** `bun:sqlite`, `Bun.serve`, `import.meta.main`, `Bun.spawn`, `bun:test`. It does not run under Node.
- Config comes from environment variables:
  - `FACT_BOARD_DB`: board file path
  - `FACT_BOARD_PORT`: viewer port, default 8799
  - `FACT_BOARD_LEASE_SECONDS`
  - `FACT_BOARD_MAX_INTENTS`
  - `FACT_BOARD_UPDATE_CHECK`: `0` disables the daily version check (`src/update-check.ts`), the plugin's only network call
  - `PI_CODING_AGENT_DIR`
- Lease and cap values are read when a `Board` is constructed, and boards are cached per path. Changing env mid-process does not affect boards that are already open.
- The process holds DB files open while omp runs. Project board files cannot be deleted until the process exits.
- **Agents calling the tools:** omp mounts them under `xd://`, not in the normal tool list. Read `xd://<tool>` for the schema, then `write` a JSON args object to it. Restate this in every subagent's task text.

## Testing & QA

- Tests use real SQLite files in `mkdtempSync` dirs (closed and removed in `afterAll`), a real HTTP viewer on port 0, and real multi-process contention. There are **no mocks**. Time is controlled by injecting `now` through `BoardOptions`.
- Helpers in `test/board.test.ts`:
  - `newBoard(options, path)`
  - `started()`: an initialized board with the Reason lease held by `"controller"`
  - `expectRule(fn, message)`: asserts a `BoardError` with that message
- Spawn-based tests (WAL lock, claim race) need a `30_000` ms timeout; spawning Bun is slow on Windows.
- **Credential-shaped fixtures are built at runtime**, e.g. ``` `${"AKIA"}${"B".repeat(16)}` ```. Never commit literal secrets. The host's secret obfuscator also masks such literals in tool output, so what you read may differ from what is on disk.
- **Coverage gap:** tool registration and `run()` mapping have no unit tests; `test/extension.test.ts` covers the `/fact-board` command and shutdown through a stub `pi` loaded as separate module instances. Prove the real tool path with a restarted omp session plus a pair of `task` subagents.

## Security Invariants (do not regress)

- **The board is not a safe place for credentials.** Redaction is best-effort regex only (`src/redact.ts`), applied before storage, and it will miss arbitrary secrets. Findings are stored as plain text in a file shared by every project that uses the same agent dir.
- **The viewer stays read-only and local:** read-only DB connection, bound to `127.0.0.1`, GET/HEAD only, strict `Host` check, and lease tokens never selected. Board text comes from agents, so it is rendered with `textContent` only.
- **Never log or return `lease_token`/`reason_token` anywhere except the claiming tool's own result.**

## Known Doc/Code Gaps (fix in code or docs, don't rely on the docs)

- `board_complete` and `board_reopen` do not require the Reason lease. `fact_dispute` and `hint_write` skip `assertActive()`/`requireInit()`.
- `board_export` is not a pure read: it runs `expireStale()` in a write transaction (which now only clears a stale Reason lease — it no longer reopens intent leases). The viewer uses `readSnapshot` instead.
- `concludeIntent` accepts an expired lease that no one has reclaimed. "no longer valid" means the lease was superseded or released, not that it timed out.
