/**
 * Read-only live view of the fact boards: a list of facts, intents and hints, and a graph of how they connect.
 *
 * Inside omp:   /fact-board            (starts it in-process)
 * Standalone:   bun src/viewer.ts      (FACT_BOARD_PORT, FACT_BOARD_DB)
 *
 * Boards are opened read-only, the server binds loopback only, serves GET/HEAD only and checks the Host header.
 * Lease tokens are never selected. Board text comes from agents, so both the HTML list and the SVG graph render
 * it with textContent only, and the page loads nothing from the network.
 */
import { listProjects, projectDbPath, readSnapshot, resolveDbPath } from "./board";
import { buildGraph } from "./graph";

export interface ViewerHandle {
  url: string;
  stop(): void;
}

const SNAPSHOT_LIMIT = 500;

function boardPayload(basePath: string, project: string | null) {
  const projects = listProjects(basePath);
  const now = Date.now();
  const base = { project, projects, now };
  try {
    const path = projectDbPath(basePath, project ?? undefined);
    // One row past the limit is read only to tell "exactly at the limit" apart from "older rows exist".
    const read = readSnapshot(path, SNAPSHOT_LIMIT + 1);
    if ("missing" in read) return { ...base, dbPath: path, note: "board not created yet" };
    if ("legacy" in read) {
      return { ...base, dbPath: path, note: "this board uses the 0.1 format; it is upgraded the first time a board tool (e.g. board_init) opens it" };
    }
    // Older nodes, and edges into them, are absent from list and graph when this is set.
    const truncated = read.facts.length > SNAPSHOT_LIMIT || read.intents.length > SNAPSHOT_LIMIT;
    // The graph does not draw hints, so their overflow is reported separately, for the list only.
    const hintsTruncated = read.hints.length > SNAPSHOT_LIMIT;
    const snapshot = { board: read.board, facts: read.facts.slice(0, SNAPSHOT_LIMIT), intents: read.intents.slice(0, SNAPSHOT_LIMIT), hints: read.hints.slice(0, SNAPSHOT_LIMIT) };
    return { ...base, dbPath: path, ...snapshot, truncated, hintsTruncated, limit: SNAPSHOT_LIMIT, graph: buildGraph(snapshot, now) };
  } catch (err) {
    return { ...base, note: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fact board</title>
<style>
:root{--bg:#f6f7f9;--card:#fff;--fg:#1c2330;--mut:#667085;--bd:#e3e6eb;--ok:#1a7f4b;--bad:#b42318;--acc:#2f5bea;--gold:#a15c07}
@media(prefers-color-scheme:dark){:root{--bg:#10141b;--card:#171d27;--fg:#e6e9ef;--mut:#8b94a5;--bd:#273041;--ok:#4cc38a;--bad:#f27a6e;--acc:#7b9bff;--gold:#f0b35e}}
*{box-sizing:border-box}body{margin:0;font:14px/1.45 system-ui,Segoe UI,sans-serif;background:var(--bg);color:var(--fg)}
[hidden]{display:none!important}
header{position:sticky;top:0;z-index:2;background:var(--bg);border-bottom:1px solid var(--bd);padding:10px 16px;display:flex;gap:12px;align-items:center;flex-wrap:wrap}
h1{font-size:16px;margin:0}.dot{width:9px;height:9px;border-radius:50%;background:var(--ok)}.dot.off{background:var(--bad)}.dot.paused{background:var(--mut)}
input[type=search],select{padding:6px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg)}
input[type=search]{flex:1;min-width:160px}
button{padding:6px 10px;border:1px solid var(--bd);border-radius:6px;background:var(--card);color:var(--fg);cursor:pointer}
.tabs{display:inline-flex;border:1px solid var(--bd);border-radius:6px;overflow:hidden}
.tabs button{border:0;border-radius:0}.tabs button.on{background:var(--acc);color:#fff}
.meta{color:var(--mut);font-size:12px}main{padding:14px 16px;max-width:1400px;margin:0 auto}
.banner{background:var(--card);border:1px solid var(--bd);border-radius:8px;padding:10px 12px;margin-bottom:12px;display:grid;gap:4px}
.banner.done{border-color:var(--ok)}.banner .k{color:var(--mut);font-size:12px;text-transform:uppercase;letter-spacing:.05em;margin-right:6px}
.workers{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.chip{display:inline-flex;gap:6px;align-items:center;padding:2px 8px;border-radius:999px;border:1px solid var(--bd);background:var(--card);font-size:12px;cursor:pointer}
.chip i{width:8px;height:8px;border-radius:50%;display:inline-block}
section{margin-bottom:22px}h2{font-size:13px;text-transform:uppercase;letter-spacing:.06em;color:var(--mut);margin:0 0 8px}
.cols{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px}@media(max-width:800px){.cols{grid-template-columns:1fr}}
.card{background:var(--card);border:1px solid var(--bd);border-left:3px solid var(--bd);border-radius:6px;padding:8px 10px;margin-bottom:8px}
.card.disputed{border-left-color:var(--bad)}.card.disputed .txt{text-decoration:line-through;opacity:.7}
.card.claimed{border-left-color:var(--ok)}.card.open{border-left-color:var(--acc)}.card.concluded{border-left-color:var(--mut)}.card.goal{border-left-color:var(--gold)}
.card.stale{outline:1px dashed var(--bad)}
.card.new{animation:flash 2.2s ease-out}@keyframes flash{from{background:color-mix(in srgb,var(--acc) 28%,var(--card))}}
.card.hl{outline:2px solid var(--acc)}
.row{display:flex;gap:8px;align-items:center;flex-wrap:wrap;font-size:12px;color:var(--mut)}
.badge{padding:0 6px;border-radius:4px;border:1px solid var(--bd);font-size:11px}
.edges{font-size:12px;color:var(--mut);margin-top:4px;display:flex;gap:4px;flex-wrap:wrap;align-items:center}
.ref{font-family:ui-monospace,Consolas,monospace;font-size:11px;padding:0 4px;border-radius:4px;border:1px solid var(--bd);cursor:pointer}
.txt{white-space:pre-wrap;word-break:break-word;margin:4px 0 0}.ev{white-space:pre-wrap;word-break:break-word;color:var(--mut);font-size:12px;margin-top:4px}
.empty{color:var(--mut);font-style:italic;padding:6px 2px}
.gbar{display:flex;gap:12px;align-items:center;flex-wrap:wrap;margin-bottom:8px}
.legend{display:flex;gap:12px;flex-wrap:wrap;font-size:12px;color:var(--mut)}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{display:inline-block;width:16px;height:11px;border:2px solid var(--mut);border-radius:3px}
.legend .lo{border-color:var(--fg)}.legend .li{border-color:var(--acc);border-radius:6px}.legend .lc{border-color:var(--ok);border-radius:6px}
.legend .ld{border-color:var(--mut);border-radius:6px}.legend .lf{border-color:var(--ok)}.legend .lx{border-color:var(--bad);border-style:dashed}
.legend .lg{border-color:var(--gold)}
#graph{display:block;width:100%;height:calc(100vh - 260px);min-height:420px;background:var(--card);border:1px solid var(--bd);border-radius:8px;cursor:grab;touch-action:none;user-select:none}
#graph.dragging{cursor:grabbing}
#arrow path{fill:var(--mut)}
.edge{fill:none;stroke:var(--mut);stroke-width:1.5;opacity:.6}
.edge.back{stroke-dasharray:5 4}
.edge.hl{stroke:var(--acc);opacity:1;stroke-width:2.5}
.edge.dim{opacity:.08}
.gnode{cursor:pointer}
.gnode rect{fill:var(--card);stroke:var(--mut);stroke-width:2}
.gnode text{fill:var(--fg);font-size:12px;font-family:system-ui,Segoe UI,sans-serif}
.gnode text.k{fill:var(--mut);font-size:10px;letter-spacing:.04em}
.gnode text.o{fill:var(--mut);font-size:10.5px}
.gnode.origin rect{stroke:var(--fg);stroke-width:2.5}
.gnode.goal rect{stroke:var(--gold);stroke-dasharray:6 4}
.gnode.reached rect{stroke:var(--gold);stroke-width:3;stroke-dasharray:none}
.gnode.fact rect{stroke:var(--ok)}
.gnode.fact.disputed rect{stroke:var(--bad);stroke-dasharray:4 3}
.gnode.fact.disputed text.l{text-decoration:line-through}
.gnode.intent.open rect{stroke:var(--acc)}
.gnode.intent.claimed rect{stroke:var(--ok);fill:color-mix(in srgb,var(--ok) 10%,var(--card))}
.gnode.intent.concluded rect{stroke:var(--mut)}
.gnode.stale rect,.gnode.intent.claimed.stale rect{stroke:var(--bad);stroke-dasharray:3 3}
.gnode.hl rect{stroke-width:4}
.gnode.dim{opacity:.18}
</style></head><body>
<header>
  <h1>Fact board</h1><span id="dot" class="dot"></span>
  <select id="project" aria-label="Board"></select>
  <div class="tabs" role="tablist"><button id="tabList" role="tab">List</button><button id="tabGraph" role="tab">Graph</button></div>
  <input id="q" type="search" placeholder="Filter by text, worker, id, status…" aria-label="Filter">
  <button id="pause">Pause</button>
  <span class="meta" id="meta"></span>
</header>
<main>
  <div id="banner" class="banner"></div>
  <div id="listView">
    <div id="workers" class="workers"></div>
    <section><h2 id="hf">Facts</h2><div id="facts"></div></section>
    <section><h2 id="hi">Intents</h2><div class="cols" id="intents"></div></section>
    <section><h2 id="hh">Hints</h2><div id="hints"></div></section>
  </div>
  <div id="graphView" hidden>
    <div class="gbar">
      <button id="fit">Fit</button>
      <span class="legend">
        <span><i class="lo"></i>origin</span><span><i class="li"></i>intent open</span><span><i class="lc"></i>claimed</span>
        <span><i class="ld"></i>concluded</span><span><i class="lf"></i>fact</span><span><i class="lx"></i>disputed / lease expired</span>
        <span><i class="lg"></i>goal</span>
      </span>
      <span class="meta" id="gmeta"></span>
    </div>
    <svg id="graph" role="img" aria-label="Fact and intent graph"></svg>
  </div>
</main>
<script>
var params = new URLSearchParams(location.search);
var state = { paused: false, filter: "", first: true, data: null, seen: {}, project: params.get("project") || "", view: params.get("view") === "graph" ? "graph" : "list" };
var SVGNS = "http://www.w3.org/2000/svg";
var gs = { sig: "", view: null, bounds: null, moved: false, nw: 220, nh: 58 };
var graphEl = document.getElementById("graph");

function el(tag, cls, text) { var e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
function svg(tag, attrs, text) {
  var e = document.createElementNS(SVGNS, tag);
  if (attrs) Object.keys(attrs).forEach(function (k) { e.setAttribute(k, String(attrs[k])); });
  if (text != null) e.textContent = text;
  return e;
}
function clip(s, n) { s = String(s == null ? "" : s); return s.length > n ? s.slice(0, n - 1) + "…" : s; }
function colorFor(name) { var h = 2166136261; for (var i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return "hsl(" + (h % 360) + " 62% 48%)"; }
function ago(ts, now) { var s = Math.max(0, Math.round((now - ts) / 1000)); if (s < 60) return s + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
function matches(o) { if (!state.filter) return true; return JSON.stringify(o).toLowerCase().indexOf(state.filter) !== -1; }
function owner(o) { return o.claimed_by || o.created_by || null; }
function short(id) { return id === "origin" || id === "goal" ? id : id.slice(0, 10); }
function who(name) { var w = el("span", "chip"); var d = el("i"); d.style.background = colorFor(name); w.appendChild(d); w.appendChild(document.createTextNode(name)); return w; }
function ref(id) { var r = el("span", "ref", short(id)); r.title = id; r.onclick = function () { jump(id); }; return r; }
function edgeChips(label, ids) { var e = el("div", "edges"); e.appendChild(document.createTextNode(label)); ids.forEach(function (id) { e.appendChild(ref(id)); }); return e; }
function jump(id) {
  var target = document.getElementById("listView").querySelector('[data-id="' + CSS.escape(id) + '"]');
  if (!target) return false;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add("hl"); setTimeout(function () { target.classList.remove("hl"); }, 1600);
  return true;
}
function card(o, status, body, ts, now, by) {
  var c = el("div", "card " + status); c.dataset.id = o.id;
  var key = o.id + ":" + (o.updated_at || o.created_at) + ":" + status;
  if (!state.first && !state.seen[key]) c.className += " new";
  state.seen[key] = 1;
  var r = el("div", "row"); r.appendChild(el("span", "badge", status));
  if (by) r.appendChild(who(by));
  r.appendChild(el("span", "", short(o.id))); r.appendChild(el("span", "", ago(ts, now)));
  c.appendChild(r); c.appendChild(el("div", "txt", body));
  return c;
}
function fill(id, items, emptyText) { var box = document.getElementById(id); box.replaceChildren(); if (!items.length) box.appendChild(el("div", "empty", emptyText)); else items.forEach(function (c) { box.appendChild(c); }); }
function line(k, v) { var d = el("div"); d.appendChild(el("span", "k", k)); d.appendChild(document.createTextNode(v)); return d; }

function renderBanner(d) {
  var b = document.getElementById("banner"); b.replaceChildren(); b.className = "banner";
  var info = d.board;
  if (!info || !info.initialized) { b.appendChild(el("div", "empty", d.note || "Board not initialized (board_init sets the origin and goal).")); return; }
  if (info.status === "completed") b.className = "banner done";
  b.appendChild(line("status", info.status));
  b.appendChild(line("origin", info.origin));
  b.appendChild(line("goal", info.goal));
  if (info.reason) b.appendChild(line("reason lease", info.reason.worker + " · declared " + info.reason.created + " · heartbeat " + ago(info.reason.heartbeat_at, d.now)));
  if (info.completed_intent) b.appendChild(edgeChips("completed via ", [info.completed_intent]));
}

function renderList(d) {
  var now = d.now;
  var factsAll = d.facts || [], intentsAll = d.intents || [], hintsAll = d.hints || [];
  var facts = factsAll.filter(matches), intents = intentsAll.filter(matches), hints = hintsAll.filter(matches);
  var counts = {};
  factsAll.concat(intentsAll).forEach(function (o) { var n = owner(o); if (n) counts[n] = (counts[n] || 0) + 1; });
  var wb = document.getElementById("workers"); wb.replaceChildren();
  Object.keys(counts).sort().forEach(function (n) { var c = who(n); c.appendChild(document.createTextNode(" " + counts[n])); c.onclick = function () { document.getElementById("q").value = n; state.filter = n.toLowerCase(); render(); }; wb.appendChild(c); });
  document.getElementById("hf").textContent = "Facts (" + facts.length + (facts.length !== factsAll.length ? "/" + factsAll.length : "") + ")";
  document.getElementById("hi").textContent = "Intents (" + intents.length + ")";
  document.getElementById("hh").textContent = "Hints (" + hints.length + ")";
  fill("facts", facts.map(function (f) {
    var c = card(f, f.status, f.text, f.created_at, now, f.claimed_by);
    if (f.evidence) c.appendChild(el("div", "ev", f.evidence));
    if (f.produced_by.length) c.appendChild(edgeChips("produced by ", f.produced_by));
    return c;
  }), "No facts yet.");
  var cols = document.getElementById("intents"); cols.replaceChildren();
  ["open", "claimed", "concluded"].forEach(function (st) {
    var list = intents.filter(function (i) { return i.status === st; });
    var col = el("div"); col.appendChild(el("h2", "", st + " (" + list.length + ")"));
    if (!list.length) col.appendChild(el("div", "empty", "none"));
    list.forEach(function (i) {
      var c = card(i, i.to_fact_id === "goal" ? "goal" : i.status, i.description, i.updated_at, now, owner(i));
      if (i.status === "claimed" && i.lease_expires_at && i.lease_expires_at < now) { c.className += " stale"; c.appendChild(el("div", "ev", "lease expired — reopens on the next board write")); }
      c.appendChild(edgeChips("from ", i.from));
      if (i.to_fact_id) c.appendChild(edgeChips("→ ", [i.to_fact_id]));
      col.appendChild(c);
    });
    cols.appendChild(col);
  });
  fill("hints", hints.map(function (h) { return card(h, "hint", h.content, h.created_at, now, null); }), "No hints yet.");
  state.first = false;
}

function renderGraph(d) {
  var graph = d.graph, meta = document.getElementById("gmeta");
  if (!graph || !graph.nodes.length) { graphEl.replaceChildren(); gs.sig = ""; gs.bounds = null; meta.textContent = d.note || "Nothing to draw yet."; return; }
  gs.nw = graph.nodeWidth; gs.nh = graph.nodeHeight;
  var sig = JSON.stringify([graph.nodes.map(function (n) { return [n.id, n.status, n.stale, n.owner, n.x, n.y]; }), graph.edges]);
  if (sig !== gs.sig) { drawGraph(graph); gs.sig = sig; }
  applyFilter(graph);
  meta.textContent = (d.truncated ? "PARTIAL: only the newest " + d.limit + " facts and " + d.limit + " intents; older nodes and their edges are hidden · " : "")
    + graph.nodes.length + " nodes · " + graph.edges.length + " edges · scroll to zoom, drag to pan, click a fact or intent to open its card";
}

function drawGraph(graph) {
  var nw = gs.nw, nh = gs.nh, pos = {};
  graph.nodes.forEach(function (n) { pos[n.id] = n; });
  graphEl.replaceChildren();
  var defs = svg("defs");
  var marker = svg("marker", { id: "arrow", viewBox: "0 0 10 10", refX: 9, refY: 5, markerWidth: 7, markerHeight: 7, orient: "auto-start-reverse" });
  marker.appendChild(svg("path", { d: "M0,0 L10,5 L0,10 z" }));
  defs.appendChild(marker); graphEl.appendChild(defs);
  var edgeLayer = svg("g"), nodeLayer = svg("g");
  graph.edges.forEach(function (e) {
    var a = pos[e.from], b = pos[e.to];
    if (!a || !b) return;
    var x1 = a.x + nw, y1 = a.y + nh / 2, x2 = b.x, y2 = b.y + nh / 2, back = b.x <= a.x;
    var d = back
      ? "M" + x1 + "," + y1 + " C" + (x1 + 70) + "," + (y1 + nh * 1.6) + " " + (x2 - 70) + "," + (y2 + nh * 1.6) + " " + x2 + "," + y2
      : "M" + x1 + "," + y1 + " C" + (x1 + 45) + "," + y1 + " " + (x2 - 45) + "," + y2 + " " + x2 + "," + y2;
    edgeLayer.appendChild(svg("path", { d: d, "class": "edge" + (back ? " back" : ""), "data-from": e.from, "data-to": e.to, "marker-end": "url(#arrow)" }));
  });
  graph.nodes.forEach(function (n) {
    var grp = svg("g", { "class": "gnode " + n.kind + " " + n.status + (n.stale ? " stale" : ""), transform: "translate(" + n.x + "," + n.y + ")", "data-id": n.id });
    grp.appendChild(svg("title", null, n.label));
    grp.appendChild(svg("rect", { width: nw, height: nh, rx: n.kind === "intent" ? 14 : n.kind === "fact" ? 4 : 22 }));
    var kind = n.kind === "origin" ? "ORIGIN" : n.kind === "goal" ? (n.status === "reached" ? "GOAL · REACHED" : "GOAL")
      : (n.kind + " · " + n.status + (n.stale ? " · lease expired" : "")).toUpperCase();
    grp.appendChild(svg("text", { x: 12, y: 17, "class": "k" }, kind));
    grp.appendChild(svg("text", { x: 12, y: 35, "class": "l" }, clip(n.label, 30)));
    if (n.owner) grp.appendChild(svg("text", { x: 12, y: 50, "class": "o" }, clip(n.owner, 32)));
    grp.addEventListener("mouseenter", function () { highlight(n.id, true); });
    grp.addEventListener("mouseleave", function () { highlight(n.id, false); });
    nodeLayer.appendChild(grp);
  });
  graphEl.appendChild(edgeLayer); graphEl.appendChild(nodeLayer);
  gs.bounds = { x: 0, y: 0, w: graph.width, h: graph.height };
  if (!gs.moved || !gs.view) fit(); else applyViewBox(gs.view);
}

function highlight(id, on) {
  graphEl.querySelectorAll(".edge").forEach(function (e) {
    if (e.getAttribute("data-from") === id || e.getAttribute("data-to") === id) e.classList.toggle("hl", on);
  });
  var node = graphEl.querySelector('.gnode[data-id="' + CSS.escape(id) + '"]');
  if (node) node.classList.toggle("hl", on);
}

function applyFilter(graph) {
  var keep = {};
  graph.nodes.forEach(function (n) {
    keep[n.id] = !state.filter || (n.label + " " + (n.owner || "") + " " + n.status + " " + n.kind + " " + n.id).toLowerCase().indexOf(state.filter) !== -1;
  });
  graphEl.querySelectorAll(".gnode").forEach(function (g) { g.classList.toggle("dim", !keep[g.getAttribute("data-id")]); });
  graphEl.querySelectorAll(".edge").forEach(function (e) { e.classList.toggle("dim", !(keep[e.getAttribute("data-from")] || keep[e.getAttribute("data-to")])); });
}

function applyViewBox(v) { gs.view = v; graphEl.setAttribute("viewBox", v.x + " " + v.y + " " + v.w + " " + v.h); }
function fit() { var b = gs.bounds; if (!b) return; gs.moved = false; applyViewBox({ x: b.x, y: b.y, w: Math.max(b.w, 1), h: Math.max(b.h, 1) }); }
function toGraph(cx, cy) {
  var m = graphEl.getScreenCTM(); if (!m) return { x: 0, y: 0 };
  var p = graphEl.createSVGPoint(); p.x = cx; p.y = cy;
  return p.matrixTransform(m.inverse());
}
function openNode(id) {
  var nodes = state.data && state.data.graph ? state.data.graph.nodes : [];
  var n = nodes.filter(function (x) { return x.id === id; })[0];
  if (!n || (n.kind !== "fact" && n.kind !== "intent")) return;
  showTab("list");
  // The filter is shared by both tabs; a dimmed node's card is filtered out of the list, so clear it.
  if (!jump(id)) { state.filter = ""; document.getElementById("q").value = ""; render(); jump(id); }
}

graphEl.addEventListener("wheel", function (ev) {
  if (!gs.view || !gs.bounds) return;
  ev.preventDefault();
  var pt = toGraph(ev.clientX, ev.clientY), v = gs.view, k = ev.deltaY < 0 ? 0.87 : 1.15;
  var w = Math.min(Math.max(v.w * k, 120), Math.max(gs.bounds.w, 400) * 6), h = v.h * (w / v.w);
  applyViewBox({ x: pt.x - (pt.x - v.x) * (w / v.w), y: pt.y - (pt.y - v.y) * (h / v.h), w: w, h: h });
  gs.moved = true;
}, { passive: false });

var drag = null;
graphEl.addEventListener("pointerdown", function (ev) {
  if (!gs.view) return;
  var m = graphEl.getScreenCTM();
  drag = { sx: ev.clientX, sy: ev.clientY, view: gs.view, scale: m ? 1 / m.a : 1, moved: false, node: ev.target.closest ? ev.target.closest(".gnode") : null };
  graphEl.setPointerCapture(ev.pointerId);
});
graphEl.addEventListener("pointermove", function (ev) {
  if (!drag) return;
  if (!drag.moved && Math.abs(ev.clientX - drag.sx) + Math.abs(ev.clientY - drag.sy) < 5) return;
  drag.moved = true; graphEl.classList.add("dragging");
  applyViewBox({ x: drag.view.x - (ev.clientX - drag.sx) * drag.scale, y: drag.view.y - (ev.clientY - drag.sy) * drag.scale, w: drag.view.w, h: drag.view.h });
  gs.moved = true;
});
graphEl.addEventListener("pointerup", function () {
  if (!drag) return;
  var d = drag; drag = null; graphEl.classList.remove("dragging");
  if (!d.moved && d.node) openNode(d.node.getAttribute("data-id"));
});
graphEl.addEventListener("pointercancel", function () { drag = null; graphEl.classList.remove("dragging"); });

function render() {
  var d = state.data; if (!d) return;
  renderProjects(d);
  renderBanner(d);
  if (state.view === "graph") renderGraph(d); else renderList(d);
  var partial = d.truncated || (state.view === "list" && d.hintsTruncated);
  document.getElementById("meta").textContent = (partial ? "partial view (newest " + d.limit + ") · " : "") + (d.dbPath || "") + " · updated " + new Date(d.now).toLocaleTimeString();
}
function renderProjects(d) {
  var sel = document.getElementById("project");
  var names = [""].concat(d.projects || []);
  if (sel.dataset.names === names.join("|") && sel.value === state.project) return;
  sel.replaceChildren();
  names.forEach(function (n) { var o = el("option", "", n || "(default)"); o.value = n; sel.appendChild(o); });
  sel.value = state.project; sel.dataset.names = names.join("|");
}
function syncUrl() {
  var p = new URLSearchParams();
  if (state.project) p.set("project", state.project);
  if (state.view === "graph") p.set("view", "graph");
  var qs = p.toString();
  history.replaceState(null, "", qs ? "?" + qs : location.pathname);
}
function showTab(name) {
  state.view = name;
  document.getElementById("listView").hidden = name !== "list";
  document.getElementById("graphView").hidden = name !== "graph";
  document.getElementById("tabList").className = name === "list" ? "on" : "";
  document.getElementById("tabGraph").className = name === "graph" ? "on" : "";
  if (name === "list") state.first = true;
  syncUrl();
  render();
}
function poll() {
  if (state.paused) return;
  var url = "/api/board" + (state.project ? "?project=" + encodeURIComponent(state.project) : "");
  fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) { state.data = d; document.getElementById("dot").className = "dot"; render(); })
    .catch(function () { document.getElementById("dot").className = "dot off"; });
}
document.getElementById("project").addEventListener("change", function (e) {
  state.project = e.target.value; state.first = true; state.seen = {}; gs.sig = ""; gs.moved = false;
  syncUrl(); poll();
});
document.getElementById("tabList").onclick = function () { showTab("list"); };
document.getElementById("tabGraph").onclick = function () { showTab("graph"); };
document.getElementById("fit").onclick = function () { fit(); };
document.getElementById("q").addEventListener("input", function (e) { state.filter = e.target.value.trim().toLowerCase(); render(); });
document.getElementById("pause").onclick = function () { state.paused = !state.paused; this.textContent = state.paused ? "Resume" : "Pause"; document.getElementById("dot").className = state.paused ? "dot paused" : "dot"; if (!state.paused) poll(); };
showTab(state.view);
poll(); setInterval(poll, 2000);
</script></body></html>`;

export function startViewer(options: { basePath: string; port?: number }): ViewerHandle {
  let boundPort = 0;
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: options.port ?? 8799,
    fetch(req) {
      if (req.method !== "GET" && req.method !== "HEAD") return new Response("read-only", { status: 405 });
      const host = req.headers.get("host") ?? "";
      if (host !== `127.0.0.1:${boundPort}` && host !== `localhost:${boundPort}`) {
        return new Response("forbidden host", { status: 403 });
      }
      const url = new URL(req.url);
      if (url.pathname === "/api/board") {
        const payload = boardPayload(options.basePath, url.searchParams.get("project"));
        return Response.json(payload, { headers: { "cache-control": "no-store" } });
      }
      if (url.pathname === "/") return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
      return new Response("not found", { status: 404 });
    },
  });
  boundPort = server.port ?? 0;
  return { url: `http://127.0.0.1:${boundPort}`, stop: () => server.stop(true) };
}

if (import.meta.main) {
  const handle = startViewer({ basePath: resolveDbPath(), port: Number(process.env.FACT_BOARD_PORT ?? 8799) });
  console.log(`fact board viewer: ${handle.url}  (boards: ${resolveDbPath()})`);
}
