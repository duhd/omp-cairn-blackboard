import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board } from "../src/board";
import type { BoardOptions, Snapshot } from "../src/board";
import { buildGraph } from "../src/graph";
import type { Graph } from "../src/graph";

const dirs: string[] = [];
const boards: Board[] = [];

function newBoard(options: BoardOptions = {}): Board {
  const dir = mkdtempSync(join(tmpdir(), "graph-"));
  dirs.push(dir);
  const board = new Board(join(dir, "board.db"), options);
  boards.push(board);
  return board;
}

afterAll(() => {
  for (const board of boards) board.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function snapshotOf(board: Board): Snapshot {
  return JSON.parse(board.export()) as Snapshot;
}

function node(graph: Graph, id: string) {
  const found = graph.nodes.find(n => n.id === id);
  if (!found) throw new Error(`missing node ${id}`);
  return found;
}

/** One full Reason → Explore round: declare an intent from `from`, claim it and conclude it with `fact`. */
function explore(board: Board, from: string[], fact: string) {
  const { reason_token } = board.reasonClaim("controller");
  const intent = board.createIntent({ description: `look into ${fact}`, from, reasonToken: reason_token });
  board.reasonRelease(reason_token);
  const { lease_token } = board.claimIntent(intent.id, "w1");
  return board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact, evidence: "test observation" });
}

describe("graph layout", () => {
  test("each intent sits between the facts it grows from and the fact it produced; the goal is rightmost", () => {
    const board = newBoard();
    board.init({ origin: "service X returns 500", goal: "root cause found" });
    const first = explore(board, ["origin"], "pool size is 5");
    const second = explore(board, [first.fact.id], "pool exhausts at 50 rps");
    const graph = buildGraph(snapshotOf(board), Date.now());

    expect(node(graph, "origin").layer).toBe(0);
    expect(node(graph, first.intent.id).layer).toBe(1);
    expect(node(graph, first.fact.id).layer).toBe(2);
    expect(node(graph, second.intent.id).layer).toBe(3);
    expect(node(graph, second.fact.id).layer).toBe(4);
    expect(node(graph, "goal").layer).toBe(5);
    expect(node(graph, "goal").status).toBe("goal");
    expect(graph.edges).toContainEqual({ from: "origin", to: first.intent.id });
    expect(graph.edges).toContainEqual({ from: first.intent.id, to: first.fact.id });
    expect(graph.edges).toContainEqual({ from: first.fact.id, to: second.intent.id });
  });

  test("completing the board links the goal to its completion intent and marks it reached", () => {
    const board = newBoard();
    board.init({ origin: "o", goal: "g" });
    const { fact } = explore(board, ["origin"], "root cause is pool exhaustion");
    const completion = board.complete({ from: [fact.id], description: "pool exhaustion", worker: "controller" }).intent;
    const graph = buildGraph(snapshotOf(board), Date.now());

    expect(node(graph, "goal").status).toBe("reached");
    expect(graph.edges).toContainEqual({ from: fact.id, to: completion.id });
    expect(graph.edges).toContainEqual({ from: completion.id, to: "goal" });
    expect(node(graph, "goal").layer).toBeGreaterThan(node(graph, completion.id).layer);
  });

  test("an intent that dedupes onto a fact it grew from does not loop or drop nodes", () => {
    const board = newBoard();
    board.init({ origin: "o", goal: "g" });
    const first = explore(board, ["origin"], "same finding");
    const loop = explore(board, [first.fact.id], "same finding");
    expect(loop.fact.id).toBe(first.fact.id);

    const graph = buildGraph(snapshotOf(board), Date.now());
    const expected = ["origin", "goal", first.intent.id, first.fact.id, loop.intent.id].sort();
    expect(graph.nodes.map(n => n.id).sort()).toEqual(expected);
    expect(node(graph, loop.intent.id).layer).toBeGreaterThan(node(graph, first.fact.id).layer);
  });

  test("a claimed intent is flagged stale only after its lease runs out", () => {
    const board = newBoard({ leaseMs: 100, now: () => 1_000 });
    board.init({ origin: "o", goal: "g" });
    const { reason_token } = board.reasonClaim("controller");
    const intent = board.createIntent({ description: "slow work", from: ["origin"], reasonToken: reason_token });
    board.claimIntent(intent.id, "w1");
    const snapshot = snapshotOf(board);

    expect(node(buildGraph(snapshot, 1_050), intent.id).stale).toBe(false);
    expect(node(buildGraph(snapshot, 1_200), intent.id).stale).toBe(true);
  });

  test("nodes never overlap and stay inside the drawing", () => {
    const board = newBoard();
    board.init({ origin: "o", goal: "g" });
    for (const text of ["bootstrap A", "bootstrap B", "bootstrap C"]) board.claimFact({ text });
    for (const pass of [1, 2]) {
      const { reason_token } = board.reasonClaim("controller");
      board.createIntent({ description: `pass ${pass} a`, from: ["origin"], reasonToken: reason_token });
      board.createIntent({ description: `pass ${pass} b`, from: ["origin"], reasonToken: reason_token });
      board.reasonRelease(reason_token);
    }
    const graph = buildGraph(snapshotOf(board), Date.now());

    for (const n of graph.nodes) {
      expect(n.x + graph.nodeWidth).toBeLessThanOrEqual(graph.width);
      expect(n.y + graph.nodeHeight).toBeLessThanOrEqual(graph.height);
    }
    for (const a of graph.nodes) {
      for (const b of graph.nodes) {
        if (a === b || a.layer !== b.layer) continue;
        expect(Math.abs(a.y - b.y)).toBeGreaterThanOrEqual(graph.nodeHeight);
      }
    }
  });

  test("an empty board draws nothing", () => {
    expect(buildGraph(snapshotOf(newBoard()), Date.now()).nodes).toEqual([]);
  });

  test("directly claimed facts are linked to their sources, so sequential work draws a chain", () => {
    const board = newBoard();
    board.init({ origin: "o", goal: "g" });
    const a = board.claimFact({ text: "stash saved", from: ["origin"] });
    const b = board.claimFact({ text: "merge resolved", from: [a.id] });
    const graph = buildGraph(snapshotOf(board), Date.now());
    expect(graph.edges).toContainEqual({ from: "origin", to: a.id });
    expect(graph.edges).toContainEqual({ from: a.id, to: b.id });
    expect(node(graph, a.id).layer).toBeLessThan(node(graph, b.id).layer);
    expect(node(graph, "goal").layer).toBeGreaterThan(node(graph, b.id).layer);
  });
});
