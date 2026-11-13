/**
 * Lays the fact–intent graph out for drawing: origin on the left, the goal on the right, and every intent
 * between the facts it grows from and the fact it produced.
 *
 * Pure and deterministic, so the viewer only draws boxes and curves. Cycles can occur (an intent may
 * conclude with the text of a fact it grew from, which dedupes onto that fact); the closing edge is then
 * treated as a back edge for layering instead of looping.
 */
import { GOAL, ORIGIN } from "./board";
import type { Snapshot } from "./board";

export type GraphNodeKind = "origin" | "goal" | "fact" | "intent";

export interface GraphNode {
  id: string;
  kind: GraphNodeKind;
  /** origin | goal | reached | claimed | disputed | open | concluded */
  status: string;
  label: string;
  owner: string | null;
  /** A claimed intent whose lease has run out; it reopens on the next board write. */
  stale: boolean;
  /** Column, counted from the origin. */
  layer: number;
  x: number;
  y: number;
}

export interface GraphEdge {
  from: string;
  to: string;
}

export interface Graph {
  nodes: GraphNode[];
  edges: GraphEdge[];
  nodeWidth: number;
  nodeHeight: number;
  width: number;
  height: number;
  /** Node ids from the origin to the goal along the main route; empty until the goal has a route back to the origin. */
  mainPath: string[];
}

const NODE_WIDTH = 260;
const NODE_HEIGHT = 58;
const LAYER_V_GAP = 54;
const SIBLING_H_GAP = 32;
const PADDING = 32;
type NodeInfo = Omit<GraphNode, "layer" | "x" | "y">;

export function buildGraph(snapshot: Snapshot, now: number): Graph {
  const { board } = snapshot;
  // Insertion order (origin, facts, intents, goal; oldest first) is the tie-break order within a column.
  const info = new Map<string, NodeInfo>();
  if (board.initialized) {
    info.set(ORIGIN, { id: ORIGIN, kind: "origin", status: "origin", label: board.origin ?? "", owner: null, stale: false });
  }
  for (const fact of [...snapshot.facts].sort((a, b) => a.created_at - b.created_at)) {
    info.set(fact.id, { id: fact.id, kind: "fact", status: fact.status, label: fact.text, owner: fact.claimed_by, stale: false });
  }
  const intents = [...snapshot.intents].sort((a, b) => a.created_at - b.created_at);
  for (const intent of intents) {
    const stale = intent.status === "claimed" && intent.lease_expires_at !== null && intent.lease_expires_at < now;
    info.set(intent.id, {
      id: intent.id,
      kind: "intent",
      status: intent.status,
      label: intent.description,
      owner: intent.claimed_by ?? intent.created_by,
      stale,
    });
  }
  if (board.initialized) {
    const status = board.status === "completed" ? "reached" : "goal";
    info.set(GOAL, { id: GOAL, kind: "goal", status, label: board.goal ?? "", owner: null, stale: false });
  }

  const edges: GraphEdge[] = [];
  // Facts claimed directly cite the facts they build on; without intents these are the only edges in sequential work.
  for (const fact of snapshot.facts) {
    for (const source of fact.from) if (info.has(source) && source !== fact.id) edges.push({ from: source, to: fact.id });
  }
  for (const intent of intents) {
    for (const source of intent.from) if (info.has(source)) edges.push({ from: source, to: intent.id });
    if (intent.to_fact_id && info.has(intent.to_fact_id)) edges.push({ from: intent.id, to: intent.to_fact_id });
  }

  const ids = [...info.keys()];
  if (ids.length === 0) {
    return { nodes: [], edges, mainPath: [], nodeWidth: NODE_WIDTH, nodeHeight: NODE_HEIGHT, width: 0, height: 0 };
  }

  const preds = new Map<string, string[]>(ids.map(id => [id, []]));
  const succs = new Map<string, string[]>(ids.map(id => [id, []]));
  for (const edge of edges) {
    preds.get(edge.to)?.push(edge.from);
    succs.get(edge.from)?.push(edge.to);
  }
  const layer = longestPathLayers(ids, preds, succs);
  // The goal is the destination: always the rightmost column, reached or not.
  if (layer.has(GOAL)) {
    const others = ids.filter(id => id !== GOAL).map(id => layer.get(id) ?? 0);
    layer.set(GOAL, Math.max(layer.get(GOAL) ?? 0, others.length > 0 ? Math.max(...others) + 1 : 0));
  }
  const mainPath = mainPathOf(ids, preds, succs, layer);

  const byLayer = new Map<number, string[]>();
  for (const id of ids) {
    const l = layer.get(id) ?? 0;
    const column = byLayer.get(l);
    if (column) column.push(id);
    else byLayer.set(l, [id]);
  }
  const columns = [...byLayer.keys()].sort((a, b) => a - b).map(l => byLayer.get(l) ?? []);
  const columnOf = new Map<string, number>();
  columns.forEach((column, c) => column.forEach(id => columnOf.set(id, c)));
  orderByBarycenter(columns, columnOf, preds);

  const numLayers = columns.length;
  const maxNodesInLayer = Math.max(1, ...columns.map(col => col.length));
  const layerStepY = NODE_HEIGHT + LAYER_V_GAP;
  const nodeStepX = NODE_WIDTH + SIBLING_H_GAP;

  const totalWidth = PADDING * 2 + maxNodesInLayer * nodeStepX - SIBLING_H_GAP;
  const totalHeight = PADDING * 2 + numLayers * layerStepY - LAYER_V_GAP;

  const nodes: GraphNode[] = [];

  // Top-down: layer = Y level (rank), siblings within layer = X positions centered horizontally
  columns.forEach((column, l) => {
    const layerCount = column.length;
    const layerWidth = layerCount * nodeStepX - SIBLING_H_GAP;
    // Center this layer's nodes horizontally across the total graph width
    const startX = Math.max(PADDING, (totalWidth - layerWidth) / 2);
    const y = PADDING + l * layerStepY;

    column.forEach((id, i) => {
      const base = info.get(id);
      if (base) {
        nodes.push({
          ...base,
          layer: l,
          x: startX + i * nodeStepX,
          y,
        });
      }
    });
  });

  return {
    nodes,
    edges,
    mainPath,
    nodeWidth: NODE_WIDTH,
    nodeHeight: NODE_HEIGHT,
    width: Math.max(totalWidth, 500),
    height: Math.max(totalHeight, 300),
  };
}

/**
 * One route from the origin to the goal, found from the goal backwards. Each step takes the predecessor in the
 * deepest earlier column (ties: the oldest node) among nodes the origin can reach, so it is the longest chain.
 * Empty while the goal has no route back, for example before the board is completed.
 */
function mainPathOf(ids: string[], preds: Map<string, string[]>, succs: Map<string, string[]>, layer: Map<string, number>): string[] {
  const reach = new Set<string>([ORIGIN]);
  const queue = [ORIGIN];
  for (let next = queue.shift(); next !== undefined; next = queue.shift()) {
    for (const to of succs.get(next) ?? []) {
      if (reach.has(to)) continue;
      reach.add(to);
      queue.push(to);
    }
  }
  if (!reach.has(GOAL)) return [];
  const order = new Map(ids.map((id, i) => [id, i]));
  const path = [GOAL];
  for (let node = GOAL; node !== ORIGIN; ) {
    const at = layer.get(node) ?? 0;
    let best: string | undefined;
    for (const p of preds.get(node) ?? []) {
      const depth = layer.get(p) ?? 0;
      if (!reach.has(p) || depth >= at) continue;
      const bestDepth = best === undefined ? -1 : (layer.get(best) ?? 0);
      if (depth > bestDepth || (depth === bestDepth && (order.get(p) ?? 0) < (order.get(best ?? p) ?? 0))) best = p;
    }
    if (best === undefined) return [];
    path.push(best);
    node = best;
  }
  return path.reverse();
}

/**
 * Longest-path layering. When only cycles remain, the oldest unplaced node is placed anyway, so the
 * result always covers every node and the edges that close a cycle become back edges.
 */
function longestPathLayers(ids: string[], preds: Map<string, string[]>, succs: Map<string, string[]>): Map<string, number> {
  const layer = new Map<string, number>();
  const waiting = new Map(ids.map(id => [id, preds.get(id)?.length ?? 0]));
  const ready = ids.filter(id => waiting.get(id) === 0);
  while (layer.size < ids.length) {
    const id = ready.shift() ?? ids.find(candidate => !layer.has(candidate));
    if (id === undefined) break;
    if (layer.has(id)) continue;
    const placed = (preds.get(id) ?? []).filter(p => layer.has(p)).map(p => (layer.get(p) ?? 0) + 1);
    layer.set(id, Math.max(0, ...placed));
    for (const next of succs.get(id) ?? []) {
      const left = (waiting.get(next) ?? 0) - 1;
      waiting.set(next, left);
      if (left === 0 && !layer.has(next)) ready.push(next);
    }
  }
  return layer;
}

/**
 * Two downward sweeps placing each node near the average row of its predecessors, which keeps most
 * edges short and uncrossed without a full crossing-minimisation pass.
 */
function orderByBarycenter(columns: string[][], columnOf: Map<string, number>, preds: Map<string, string[]>): void {
  const row = new Map<string, number>();
  columns.forEach(column => column.forEach((id, i) => row.set(id, i)));
  for (let sweep = 0; sweep < 2; sweep++) {
    for (let c = 1; c < columns.length; c++) {
      const column = columns[c];
      const score = new Map<string, number>();
      column.forEach((id, i) => {
        const above = (preds.get(id) ?? []).filter(p => (columnOf.get(p) ?? c) < c);
        score.set(id, above.length > 0 ? above.reduce((sum, p) => sum + (row.get(p) ?? 0), 0) / above.length : i);
      });
      column.sort((a, b) => (score.get(a) ?? 0) - (score.get(b) ?? 0));
      column.forEach((id, i) => row.set(id, i));
    }
  }
}
