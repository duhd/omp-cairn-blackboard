# omp-cairn-blackboard

A state-space-search **blackboard** for omp (oh-my-pi). It gives parallel subagents a shared, persistent, queryable graph to coordinate through, instead of each one re-deriving the same findings. The design is inspired by [Cairn](https://github.com/oritera/Cairn)'s idea that *state is the single source of truth* and *decisions are distributed to workers*; it is an independent implementation and contains no Cairn code.

![omp-cairn-blackboard overview](docs/infographic.svg)

| Piece | What it is |
|---|---|
| **Fact board** (extension) | Seventeen tools implementing a fact–intent graph: `board_init`, `board_list`, `board_export`, `board_complete`, `board_reopen`, `fact_claim`, `fact_query`, `fact_dispute`, `reason_claim`, `reason_release`, `intent_create`, `intent_claim`, `intent_heartbeat`, `intent_conclude`, `intent_release`, `hint_write`, `hint_query`. `board_list` is how a new session finds the board of unfinished work. |
| **`cairn-search`** (skill) | The loop: Init → Bootstrap → Reason → Explore → Converge, for problems whose path is unknown up front. |
| **`/fact-board`** (command) | A read-only live view of the graph, for watching long multi-subagent investigations. |
| **`redact-output`** (optional feature) | Rewrites credential-shaped values in command/execution output (`bash`, `eval`) before it reaches the transcript. File reads and searches are left untouched. Off by default. |

## The graph

The board is a directed graph from `origin` (what is known) to `goal` (the success condition):

```
origin ──► Intent ──► Fact ──► Intent ──► Fact ──► … ──► goal
```

- A **fact** is a confirmed finding. It is produced by concluding an intent (which records the edge), or claimed directly while bootstrapping.
- An **intent** is a step into the unknown. It cites the facts it grows from (`from`) and, when concluded, yields exactly one fact (`to`). Edges are stored, so the path from origin to goal is auditable.
- A **hint** is human steering, delivered to workers when they claim an intent and included in every export.

## Install

```bash
# from git
omp plugin install github:duhd/omp-cairn-blackboard

# with the optional output-redaction feature
omp plugin install "github:duhd/omp-cairn-blackboard[redact-output]"

# from a local checkout (development)
omp plugin link ./omp-cairn-blackboard
omp plugin features omp-cairn-blackboard --enable=redact-output   # opt into output redaction
```

Quit omp and start it again (`/new` does not load new extensions). The tools then exist for every session and subagent. Check with `omp plugin list`.

> omp mounts extension tools under `xd://` rather than in the normal tool list. Agents call them by writing a JSON args object to `xd://fact_claim` (read the same path for the schema). The `cairn-search` skill tells the agent this, and tells it to repeat it to subagents.

## Use

Ask the agent to investigate something open-ended with `cairn-search`, or drive the tools directly:

1. `board_init({ origin, goal })`.
2. **Bootstrap** — try to solve it directly; `board_complete` if solved.
3. **Reason** — `reason_claim`, then `board_export` (the whole graph). Propose up to two `intent_create`, then `reason_release`.
4. **Explore** — one `task` subagent per open intent: `intent_claim` → work → `intent_conclude` (or `intent_release`).
5. Repeat, then synthesize from `board_export`.

### Coordination rules (enforced in code, not just in prompts)

- `intent_create` needs the Reason lease (`reason_claim` → `reason_token`), and one pass may declare at most **2** intents.
- `intent_claim` returns a **lease token**. `intent_heartbeat`, `intent_conclude` and `intent_release` are compare-and-swap on that token: a worker whose lease was reclaimed can never overwrite its successor, and its rejected `intent_conclude` creates no fact. The token guards against races and stale writers among cooperating agents; it is not authentication (see [Trust model](#trust-model)).
- A claimed intent whose lease goes stale reopens automatically, so a dead subagent never wedges the board.
- Rejections are structured: tool errors carry a `code` (`intent_claimed`, `lease_lost`, `invalid_transition`, `reason_held`, …) plus `held_by` and `lease_expires_at` when a lease is involved, so a worker can tell a transient refusal from a permanent one.
- `fact_claim` is idempotent (same text → same id; a repeat claim keeps the first row and adds any new `from` ids). `from` lists the facts it builds on (`"origin"` for the first), which draws its edges in the graph; without it the fact floats unconnected. `fact_dispute` marks a fact wrong; disputed facts cannot be cited as sources.

### After a compaction

Compacting a session rewrites the conversation, and with it the project and worker names the agent was using. The extension notes (per session, in process memory) which projects each session wrote to and which worker names it claimed with, and on `session.compacting` hands the summarizer one short block: the project and worker names, and a required first step: `board_export` (timeline) for each board, then `intent_claim` again with the same worker name on any intent still held, which returns the lease token. Only names that match the project/worker name rules are included, never board text. Subagents are tracked under their own session ids, so a parent's summary lists only the boards the parent itself called. This is a nudge inside the summary, not a guarantee the next turn follows it.

### In-session reminder

The board records nothing by itself, and an agent deep in a task can forget to create, read or write to it. To catch that, the extension watches the main session's tool calls and, when it makes **24 non-board calls without touching the board**, injects one `cairn-nudge` message that says to create the board (or `board_export` the one it is on), record milestones with `fact_claim`, and declare an intent before a system-changing step. It then waits a **10-minute cooldown** and stops after **3 nudges per session**. Any board tool — including `board_export`, `fact_query` and `board_list` — resets the counter, so reading the board does not get you nagged. Subagents are never nudged. The thresholds are constants in `src/session-boards.ts` (`NUDGE_AFTER_CALLS`, `NUDGE_COOLDOWN_MS`, `MAX_NUDGES_PER_SESSION`); there is no environment variable to turn them off yet.

## Watching the board

`/fact-board` starts a read-only viewer in-process (default `http://127.0.0.1:8799`); `/fact-board stop` and `/fact-board status`. It refreshes every 2 s and has two tabs:

- **List**: the origin/goal banner, per-worker counts, facts, intents by status with their `from → to` edges, and hints. Stale leases are marked and new rows are highlighted.
- **Graph** (`?view=graph`): the board drawn left to right, from `origin` through intents and facts to `goal`. Border colors show status: intents are open, claimed or concluded; facts are claimed or disputed; an expired lease gets a red dashed border; a reached goal gets a solid gold border. Scroll to zoom, drag to pan, **Fit** to reset. Hover a node to highlight its edges, and click a fact or intent to open its card in List. The filter box dims nodes that don't match. A dashed edge that loops back means a finding deduplicated into an earlier fact. Zoom and pan are kept across refreshes. The layout is computed server-side (`src/graph.ts`).

Use the project picker to switch boards; the URL keeps `project` and `view`. Outside omp: `bun src/viewer.ts`.

The viewer reads the newest 500 facts, 500 intents and 500 hints. When older facts or intents exist, both tabs mark the view as **partial**: older nodes, and the edges into them, are not shown. When only hints overflow, just the List tab is marked, since the graph does not draw hints. Use `board_export` for the full graph.

The viewer opens the database read-only, binds to `127.0.0.1` only, answers only GET/HEAD, checks the `Host` header, and renders board text (HTML and SVG) with `textContent` only.

## Configuration

| Variable | Default | Meaning |
|---|---|---|
| `FACT_BOARD_DB` | `<agent dir>/fact-board.db` | Default board file. Point it at a per-project file to keep investigations apart. |
| `FACT_BOARD_PORT` | `8799` | Viewer port. |
| `FACT_BOARD_LEASE_SECONDS` | `900` | How long an intent/Reason lease may go without a heartbeat before it can be reclaimed. |
| `FACT_BOARD_MAX_INTENTS` | `2` | Cap on intents one Reason pass may declare. |
| `PI_CODING_AGENT_DIR` | `~/.omp/agent` | Used to locate the default board. |

Each tool also takes an optional `project` name: every project is its own board file (under `fact-boards/` next to the default), with its own origin, goal and graph.

## Security notes

### Trust model

**Single-tenant, local trust.** The board assumes every agent and person who can reach it is the same trusted user on the same machine.

- There is no per-worker authentication. A `worker` name is a label, not an identity: calling `intent_claim` again with the name that currently holds an intent returns that lease's token (that is how a worker whose context was compacted recovers it), and `claimed_by` is visible through `board_export` and the viewer. Anyone who can read the board can therefore take over, conclude or release another worker's intent.
- Anyone who can open the database file can read and change everything in it directly; the tools add no access control on top of the file's permissions.
- The viewer is read-only and binds to loopback only (with a `Host` header check), but it shows the whole board to any local process or user that can reach that port.
- Do not share one board between mutually untrusting agents, users or tenants, and do not expose the viewer or the database file over a network or a shared volume. Use a separate `project` (a separate database file) per trust boundary.

### Stored data

- The database is shared by every project that uses the same agent directory, and findings are stored in plain text. For sensitive work set `FACT_BOARD_DB` (or pass `project`) to keep data apart, and keep the file out of backups and sync.
- Facts, evidence, dispute reasons, intents and hints are passed through best-effort credential redaction **before** they are stored. It is regex-based: it catches common shapes (`password=…`, `*token` / `*Token` keys, `*_secret`, API keys, `Bearer …`, AWS key ids, common provider tokens, private-key blocks), not arbitrary secrets. Do not treat the board as a safe place for credentials.
- The `redact-output` feature applies the same rules to command/execution output (`bash`, `eval`) only. Reading or searching files (`read`, `grep`, `glob`, `find`) is not redacted, because rewriting source code corrupts what the agent sees; a file that contains a secret is therefore not masked by this feature. Output of a `bash` command that runs in the background (an async job, or one moved to the background while running) arrives as a job notification rather than a tool result, so it is not redacted either. It is off by default.

## Concurrency

The database runs in WAL mode with a busy timeout, so the viewer, many writers and several omp processes can use it at once. Without WAL, a polling reader made roughly a fifth of writes fail with `database is locked`; `bun test` covers that regression, and the tests are mutation-checked against the coordination rules above.

## Upgrading from 0.1

0.1 kept a flat set of facts/intents/hints. 0.2 adds graph edges, `origin`/`goal`, the Reason lease, lease tokens, and completion. Existing 0.1 boards are migrated in place when first opened; `intent_create` now requires `from` and a `reason_token`, and `intent_conclude` now produces the fact.

## Development

```bash
bun test          # graph, leases, dedup, redaction, migration, cross-process locking, race, viewer, projects
bun src/viewer.ts # run the viewer standalone
```

Layout: `src/board.ts` (graph + coordination), `src/index.ts` (extension: tools + `/fact-board`), `src/viewer.ts`, `src/graph.ts` (graph layout for the viewer), `src/redact.ts`, `src/redact-output.ts` (optional feature), `skills/cairn-search/SKILL.md`.

## Uninstall

```bash
omp plugin uninstall omp-cairn-blackboard
```

The database files are left in place; delete `fact-board.db` and `fact-boards/` (plus their `-wal` / `-shm` files) to remove the data.

## License

MIT.
