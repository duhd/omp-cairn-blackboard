import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectDbPath } from "../src/board";

// These exercise the coordination rules the plugin added after watching real sessions: the Reason lease carries the
// graph, releasing after completion is a no-op, and a new board warns when it splits an existing task.
const base = () => join(mkdtempSync(join(tmpdir(), "rules-")), "fact-board.db");

test("reason_claim hands back the graph, so a Reason pass does not need a separate board_export", () => {
  const board = new Board(projectDbPath(base(), "p"));
  board.init({ origin: "o", goal: "g" });
  board.claimFact({ text: "one", claimedBy: "controller", from: ["origin"] });
  const lease = board.reasonClaim("controller");
  expect(lease.board.facts).toBe(1);
  expect(lease.board.edges).toBeGreaterThan(0);
  expect(lease.board.open).toEqual([]);
  expect(lease.board.claimed).toEqual([]);
  expect(lease.board.floating).toBe(0);
  board.close();
});

test("the lease summary counts open and claimed intents and unknown provenance", () => {
  const board = new Board(projectDbPath(base(), "p"));
  board.init({ origin: "o", goal: "g" });
  board.claimFact({ text: "nameless" }); // no claimed_by, no from
  const lease = board.reasonClaim("controller");
  const a = board.createIntent({ description: "open one", from: ["origin"], reasonToken: lease.reason_token });
  const b = board.createIntent({ description: "claimed one", from: ["origin"], reasonToken: lease.reason_token });
  board.claimIntent(b.id, "worker-b");
  const second = board.reasonClaim("controller");
  expect(second.board.open).toEqual([a.id]);
  expect(second.board.claimed).toEqual([{ id: b.id, worker: "worker-b" }]);
  expect(second.board.unknown).toBe(1);
  expect(second.board.floating).toBe(1);
  board.close();
});

test("releasing the Reason lease after board_complete succeeds with a note instead of failing", () => {
  const board = new Board(projectDbPath(base(), "p"));
  board.init({ origin: "o", goal: "g" });
  const { reason_token } = board.reasonClaim("controller");
  board.claimFact({ text: "done", claimedBy: "controller", from: ["origin"] });
  board.complete({ from: ["origin"], description: "done", worker: "controller" });
  const released = board.reasonRelease(reason_token);
  expect(released.released).toBe(false);
  expect(released.note).toContain("already released");
  board.close();
});

test("releasing with a stale token while another worker holds the lease still fails", () => {
  const board = new Board(projectDbPath(base(), "p"));
  board.init({ origin: "o", goal: "g" });
  const { reason_token } = board.reasonClaim("controller");
  expect(() => board.reasonRelease(`${reason_token}-stale`)).toThrow("not held with that token");
  board.close();
});
