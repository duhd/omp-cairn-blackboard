import { expect, test } from "bun:test";
import { NUDGE_AFTER_CALLS, NUDGE_COOLDOWN_MS, nudgeOnCall, type NudgeState } from "../src/session-boards";

const MIN = 60_000;

function calls(state: NudgeState, session: string, tool: string, n: number, now: number): string[] {
  const out: string[] = [];
  for (let i = 0; i < n; i++) {
    const msg = nudgeOnCall(state, session, tool, now);
    if (msg) out.push(msg);
  }
  return out;
}

test("a session that makes many calls without recording anything is nudged exactly once", () => {
  const state: NudgeState = new Map();
  const nudges = calls(state, "s", "read", NUDGE_AFTER_CALLS, 0);
  expect(nudges).toHaveLength(1);
  expect(nudges[0]).toContain("board_init");
  expect(nudges[0]).toContain("fact_claim");
});

test("a recorded write since the last nudge prevents the next nudge, even after the cooldown", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, 0)).toHaveLength(1);
  nudgeOnCall(state, "s", "fact_claim", 1 * MIN);
  // Enough calls, and past the cooldown: only the missing write would keep it silent.
  const later = calls(state, "s", "read", NUDGE_AFTER_CALLS, NUDGE_COOLDOWN_MS + 1 * MIN);
  expect(later).toHaveLength(0);
});

test("without a write, a second nudge waits for the cooldown", () => {
  const state: NudgeState = new Map();
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, 0)).toHaveLength(1);
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, 1 * MIN)).toHaveLength(0);
  expect(calls(state, "s", "read", NUDGE_AFTER_CALLS, NUDGE_COOLDOWN_MS)).toHaveLength(1);
});

test("sessions are counted separately", () => {
  const state: NudgeState = new Map();
  calls(state, "a", "read", NUDGE_AFTER_CALLS - 1, 0);
  expect(calls(state, "b", "read", 1, 0)).toHaveLength(0);
  expect(calls(state, "a", "read", 1, 0)).toHaveLength(1);
});
