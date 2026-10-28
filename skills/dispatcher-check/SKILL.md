---
name: dispatcher-check
description: "Diagnose whether the omp-cairn-blackboard dispatcher is firing: the cairn-dispatch messages that advise the main session to staff open intents or run a Reason pass."
when_to_use: "Use when cairn-dispatch messages stop appearing, open intents are not announced, or the Reason prompt seems blocked after a worker's lease lapses."
category: workflow
keywords: [dispatcher, dispatch, fact-board, blackboard, cairn, diagnose, lease]
license: MIT
---

# Dispatcher Check

The dispatcher (`src/dispatch.ts`) reads each active board a session has used and, on a main-session tool call, sends `cairn-dispatch` messages: "open intents nobody has claimed" or "the graph changed … Run a Reason pass". It is wired in `src/index.ts` (`pi.on("tool_call")`), throttled by `DISPATCH_LOOK_MS = 30_000`, and runs only for the main session.

## Quick check

1. **Plugin loaded** — `board_list` returns boards; if the 17 `board_*` tools are missing, the extension did not load.
2. **Trigger a Reason prompt** — `board_init` a scratch board with a unique `project`, then wait past the 30 s throttle (one more tool call) so the dispatcher's first look records its baseline. That first look issues **no advice** — it only seeds the checkpoint. Then `fact_claim` one fact and wait past the throttle again: the second look reports "the graph changed (facts 0->1). Run a Reason pass…". A fact claimed before that first look is never reported as a change.
3. **Lease projection** — `intent_create` then `intent_claim`, let the lease lapse (`FACT_BOARD_LEASE_SECONDS`, default 900), then confirm the dispatcher treats the expired claim as reclaimable: it shows up as an unclaimed intent and no longer blocks the Reason prompt (see `projectLeases` in `src/dispatch.ts`).

## If no message fires

- Dispatcher only runs for the **main session**, never subagents.
- It is **throttled to one look per 30 s** — wait one more tool call.
- The board must be **active** and one the session has used (pass the same `project` on every call).
- The plugin must be **enabled** — `omp plugin list`.
- A board that cannot be read, or a message that cannot be sent, is skipped silently: advice is optional and never blocks a tool call.
