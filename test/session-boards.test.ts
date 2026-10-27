import { expect, test } from "bun:test";
import { MAX_NUDGES_PER_SESSION, NUDGE_AFTER_CALLS, NUDGE_COOLDOWN_MS, nudgeOnCall, type NudgeState } from "../src/session-boards";

const T0 = NUDGE_COOLDOWN_MS * 10;

function calls(state: NudgeState, session: string, tool: string, n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const msg = nudgeOnCall(state, session, tool, now);
    if (msg) out.push(msg);
  }
  return out;
}

test("a session that makes many calls without touching the board is nudged", () => {
  const state: NudgeState = new Map();
  const nudges = calls(state, "s", "read", NUDGE_AFTER_CALLS, T0);
  expect(nudges).toHaveLength(1);
  expect(nudges[0]).toContain("board_init");
  expect(nudges[0]).toContain("fact_claim");
});

test("touching the board resets the counter, so a session that records then wanders off is still nudged", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, T0)).toHaveLength(1);
  nudgeOnCall(state, "s", "fact_claim", T0 + 1);
  nudgeOnCall(state, "s", "board_export", T0 + 2);
  const later = calls(state, "s", "read", NUDGE_AFTER_CALLS, T0 + NUDGE_COOLDOWN_MS);
  expect(later).toHaveLength(1);
});

test("a board touch resets a half-accumulated counter, so it does not trip the nudge early", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS - 1, T0)).toHaveLength(0);
  // Without the reset, this very write would reach the threshold and fire a nudge.
  const writeNudge = nudgeOnCall(state, "s", "fact_claim", T0 + 1);
  expect(writeNudge).toBeUndefined();
  expect(calls(state, "s", "read", 6, T0 + 2)).toHaveLength(0);
});
test("after a write, the next full run of calls after the cooldown nudges again", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, T0)).toHaveLength(1);
  nudgeOnCall(state, "s", "fact_claim", T0 + 1);
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, T0 + NUDGE_COOLDOWN_MS)).toHaveLength(1);
});

test("reading only the board list also resets the counter", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS - 1, T0)).toHaveLength(0);
  expect(nudgeOnCall(state, "s", "board_list", T0 + 1)).toBeUndefined();
  expect(calls(state, "s", "read", 6, T0 + 2)).toHaveLength(0);
});
test("without touching the board, a second nudge waits for the cooldown", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, T0)).toHaveLength(1);
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, T0 + 1)).toHaveLength(0);
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, T0 + NUDGE_COOLDOWN_MS)).toHaveLength(1);
});

test("a session is never nudged more than MAX_NUDGES_PER_SESSION times", () => {
  const state: NudgeState = new Map();
  let total = 0;
  for (let round = 0; round < MAX_NUDGES_PER_SESSION + 1; round++) {
    total += calls(state, "s", "read", NUDGE_AFTER_CALLS, T0 + round * NUDGE_COOLDOWN_MS).length;
  }
  expect(total).toBe(MAX_NUDGES_PER_SESSION);
});

test("sessions are counted separately", () => {
  const state: NudgeState = new Map();
  calls(state, "a", "read", NUDGE_AFTER_CALLS - 1, T0);
  expect(calls(state, "b", "read", 1, T0)).toHaveLength(0);
  expect(calls(state, "a", "read", 1, T0)).toHaveLength(1);
});
