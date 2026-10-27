import { expect, test } from "bun:test";
import { type GraphCounts, dispatchAdvice } from "../src/dispatch";

const counts = (c: Partial<GraphCounts>): GraphCounts => ({ facts: 0, hints: 0, live: 0, claimed: 0, unclaimed: [], ...c });

test("the first look records counts without asking for Reason", () => {
  const { advice, next } = dispatchAdvice(undefined, counts({ facts: 3, live: 1 }), "p");
  expect(advice).toBeUndefined();
  expect(dispatchAdvice(next, counts({ facts: 3, live: 1 }), "p").advice).toBeUndefined();
});

test("a session resuming a board with open intents is told to staff them, once", () => {
  const { advice, next } = dispatchAdvice(undefined, counts({ facts: 3, live: 1, unclaimed: ["i-1"] }), "p");
  expect(advice).toContain("intent_claim");
  expect(dispatchAdvice(next, counts({ facts: 3, live: 1, unclaimed: ["i-1"] }), "p").advice).toBeUndefined();
});

test("the Reason advice does not ask for reason_release after board_complete", () => {
  const cp = dispatchAdvice(undefined, counts({ facts: 1 }), "p").next;
  expect(dispatchAdvice(cp, counts({ facts: 2 }), "p").advice).toContain("releases the Reason lease itself");
});

test("a new unclaimed intent asks for an Explore subagent, once", () => {
  const first = dispatchAdvice(undefined, counts({}), "p").next;
  const { advice, next } = dispatchAdvice(first, counts({ live: 1, unclaimed: ["intent-abcdef12-x"] }), "p");
  expect(advice).toContain("intent-a");
  expect(advice).toContain("intent_claim");
  expect(advice).toContain('project "p"');
  expect(dispatchAdvice(next, counts({ live: 1, unclaimed: ["intent-abcdef12-x"] }), "p").advice).toBeUndefined();
});

test("a new fact or hint asks for a Reason pass", () => {
  const cp = dispatchAdvice(undefined, counts({ facts: 2 }), "p").next;
  expect(dispatchAdvice(cp, counts({ facts: 3 }), "p").advice).toContain("Reason pass");
  expect(dispatchAdvice(cp, counts({ facts: 2, hints: 1 }), "p").advice).toContain("hints 0->1");
});

test("the last open intent concluding asks for a Reason pass", () => {
  const cp = dispatchAdvice(undefined, counts({ live: 1 }), "p").next;
  expect(dispatchAdvice(cp, counts({ live: 0 }), "p").advice).toContain("open intents 1->0");
});

test("an unchanged graph gives no advice, and advice is not repeated", () => {
  const cp = dispatchAdvice(undefined, counts({ facts: 1 }), "p").next;
  expect(dispatchAdvice(cp, counts({ facts: 1 }), "p").advice).toBeUndefined();
  const after = dispatchAdvice(cp, counts({ facts: 2 }), "p").next;
  expect(dispatchAdvice(after, counts({ facts: 2 }), "p").advice).toBeUndefined();
});

test("no Reason prompt while a worker still holds an intent; it fires once they all finish", () => {
  const cp = dispatchAdvice(undefined, counts({ live: 2, claimed: 2 }), "p").next;
  const mid = dispatchAdvice(cp, counts({ facts: 1, live: 1, claimed: 1 }), "p");
  expect(mid.advice).toBeUndefined();
  const done = dispatchAdvice(mid.next, counts({ facts: 2, live: 0, claimed: 0 }), "p");
  expect(done.advice).toContain("facts 0->2");
  expect(done.advice).toContain("open intents 2->0");
});

test("an intent released back to open is announced again", () => {
  let cp = dispatchAdvice(undefined, counts({ live: 1, unclaimed: ["i-1"] }), "p").next;
  cp = dispatchAdvice(cp, counts({ live: 1, claimed: 1 }), "p").next;
  expect(dispatchAdvice(cp, counts({ live: 1, unclaimed: ["i-1"] }), "p").advice).toContain("intent_claim");
});
