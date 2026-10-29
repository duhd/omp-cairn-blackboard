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
import { listBoards, listProjects, projectDbPath, readSnapshot, resolveDbPath } from "./board";
import { buildGraph } from "./graph";

export interface ViewerHandle {
  url: string;
  stop(): void;
}

const SNAPSHOT_LIMIT = 500;

function boardPayload(basePath: string, project: string | null) {
  // A board that cannot be read must not take the whole viewer down (it polls every 2 s); an unknown status is
  // "active" so an uninitialized or unlisted board is never hidden by mistake.
  let status: Record<string, string> = {};
  try {
    status = Object.fromEntries(listBoards(basePath).map(b => [b.project, b.status]));
  } catch {
    status = {};
  }
  const projects = listProjects(basePath).map(name => ({ name, status: status[name] ?? "active" }));
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
    const snapshot = { board: read.board, facts: read.facts.slice(0, SNAPSHOT_LIMIT), intents: read.intents.slice(0, SNAPSHOT_LIMIT), hints: read.hints.slice(0, SNAPSHOT_LIMIT), floatingFacts: read.floatingFacts, unknownFacts: read.unknownFacts, edges: read.edges };
    return { ...base, dbPath: path, ...snapshot, truncated, hintsTruncated, limit: SNAPSHOT_LIMIT, graph: buildGraph(snapshot, now) };
  } catch (err) {
    return { ...base, note: `read failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

const PAGE = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Fact board</title>
<link rel="icon" href="data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'%3E%3Crect width='32' height='32' rx='8' fill='%232f5bea'/%3E%3Cg fill='%23ffffff'%3E%3Crect x='9' y='21' width='14' height='4' rx='2'/%3E%3Crect x='11' y='15' width='10' height='4' rx='2'/%3E%3Crect x='13' y='9' width='6' height='4' rx='2'/%3E%3C/g%3E%3C/svg%3E">
<style>
:root{
  color-scheme:light dark;
  --font-sans:ui-sans-serif,-apple-system,"Segoe UI Variable Text","Segoe UI","Helvetica Neue",Arial,sans-serif;
  --font-mono:ui-monospace,"Cascadia Mono","SF Mono",Consolas,monospace;
  --bg:oklch(0.982 0.004 265);
  --surface:oklch(0.997 0.002 265);
  --surface-2:oklch(0.956 0.006 265);
  --fg:oklch(0.24 0.02 265);
  --muted:oklch(0.45 0.016 265);
  --faint:oklch(0.53 0.014 265);
  --border:oklch(0.90 0.008 265);
  --border-2:oklch(0.82 0.012 265);
  --accent:oklch(0.50 0.17 268);
  --accent-soft:oklch(0.945 0.03 268);
  --ok:oklch(0.50 0.13 152);
  --warn:oklch(0.49 0.12 68);
  --bad:oklch(0.51 0.19 25);
  --focus:oklch(0.58 0.17 268);
  --r:10px;
  --r-sm:7px;
  --r-pill:999px;
  --dur:150ms;
  --ease:cubic-bezier(0.25,1,0.5,1);
}
@media(prefers-color-scheme:dark){
  :root{
    --bg:oklch(0.185 0.012 265);
    --surface:oklch(0.225 0.014 265);
    --surface-2:oklch(0.268 0.016 265);
    --fg:oklch(0.93 0.007 265);
    --muted:oklch(0.78 0.013 265);
    --faint:oklch(0.68 0.013 265);
    --border:oklch(0.30 0.014 265);
    --border-2:oklch(0.38 0.016 265);
    --accent:oklch(0.74 0.14 268);
    --accent-soft:oklch(0.32 0.05 268);
    --ok:oklch(0.76 0.14 155);
    --warn:oklch(0.81 0.13 75);
    --bad:oklch(0.73 0.16 25);
    --focus:oklch(0.80 0.13 268);
  }
}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.55 var(--font-sans);-webkit-font-smoothing:antialiased}
[hidden]{display:none!important}
button{font:inherit;color:inherit}
:focus-visible{outline:2px solid var(--focus);outline-offset:2px}
.topbar{position:sticky;top:0;z-index:20;display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:10px 24px;background:var(--bg);border-bottom:1px solid var(--border)}
.brand{display:inline-flex;align-items:center;gap:8px;font-size:14px;font-weight:600;letter-spacing:-0.01em;white-space:nowrap}
.brand svg{width:18px;height:18px;color:var(--accent);flex:none}
.conn{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--border);border-radius:var(--r-pill);font-size:11px;color:var(--muted);white-space:nowrap;font-variant-numeric:tabular-nums}
.dot{width:6px;height:6px;border-radius:50%;background:var(--ok);flex:none}
.dot.off{background:var(--bad)}
.dot.paused{background:var(--faint)}
.spacer{flex:1 1 auto}
.field{display:inline-flex;align-items:center;gap:6px;min-width:0}
.label{font-size:10px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:var(--muted);white-space:nowrap}
.control{height:30px;padding:0 10px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface);color:var(--fg);font-size:12px;cursor:pointer;transition:background var(--dur) var(--ease),border-color var(--dur) var(--ease),color var(--dur) var(--ease)}
button.control:hover{background:var(--surface-2);border-color:var(--border-2)}
button.control:active{transform:translateY(1px)}
button.control[aria-pressed=true]{background:var(--accent-soft);border-color:var(--accent)}
select.control{cursor:pointer;max-width:220px}
.check{display:inline-flex;align-items:center;gap:6px;font-size:12px;color:var(--muted);cursor:pointer;white-space:nowrap}
.check input{width:14px;height:14px;margin:0;accent-color:var(--accent)}
.search{position:relative;display:flex;align-items:center;flex:1 1 200px;max-width:340px;min-width:170px}
.search svg{position:absolute;left:9px;width:14px;height:14px;color:var(--faint);pointer-events:none}
.search input{width:100%;height:30px;padding:0 34px 0 30px;border:1px solid var(--border-2);border-radius:var(--r-sm);background:var(--surface);color:var(--fg);font-size:12px}
.search input::placeholder{color:var(--faint)}
.search kbd{position:absolute;right:8px;padding:0 4px;border:1px solid var(--border);border-radius:4px;font:10px/16px var(--font-mono);color:var(--faint);pointer-events:none}
.subnav{display:flex;align-items:center;gap:16px;flex-wrap:wrap;padding:12px 24px;border-bottom:1px solid var(--border)}
.seg{display:inline-flex;gap:2px;padding:2px;border:1px solid var(--border);border-radius:9px;background:var(--surface-2)}
.seg button{height:26px;padding:0 14px;border:0;border-radius:6px;background:transparent;color:var(--muted);font-size:12px;font-weight:500;cursor:pointer;transition:background var(--dur) var(--ease),color var(--dur) var(--ease)}
.seg button:hover{color:var(--fg)}
.seg button.on{background:var(--surface);color:var(--fg)}
.meta{margin-left:auto;font:11px/1.4 var(--font-mono);color:var(--faint);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:min(52vw,640px)}
main{padding:24px 24px 64px;max-width:1440px;margin:0 auto}
.overview{padding:16px 20px;border:1px solid var(--border);border-radius:var(--r);background:var(--surface)}
.overview-head{display:flex;align-items:center;gap:12px;flex-wrap:wrap;min-height:22px}
.overview-project{font-size:14px;font-weight:600;letter-spacing:-0.01em}
.overview-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:24px;margin-top:16px}
.ov-text{margin:4px 0 0;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;text-wrap:pretty}
.flags{display:grid;gap:6px;margin-top:16px;padding-top:12px;border-top:1px solid var(--border)}
.flag{display:flex;gap:8px;align-items:baseline;font-size:12px;color:var(--muted);min-width:0;flex-wrap:wrap}
.flag b{font-weight:600;color:var(--fg);white-space:nowrap}
.flag .v{min-width:0;overflow-wrap:anywhere}
.flag.warn b{color:var(--warn)}
.pill{display:inline-flex;align-items:center;gap:6px;height:20px;padding:0 8px;border:1px solid var(--border);border-radius:var(--r-pill);background:var(--surface-2);font-size:11px;line-height:1;color:var(--muted);white-space:nowrap}
.pill i{width:6px;height:6px;border-radius:50%;background:var(--faint);flex:none}
.pill.claimed i,.pill.active i{background:var(--ok)}
.pill.disputed i,.pill.stale i{background:var(--bad)}
.pill.open i{background:var(--accent)}
.pill.concluded i,.pill.hint i,.pill.completed i{background:var(--faint)}
.pill.goal i{background:var(--warn)}
.workspace{display:grid;grid-template-columns:minmax(0,1fr) 380px;gap:24px;margin-top:24px;align-items:start}
.pane{border:1px solid var(--border);border-radius:var(--r);background:var(--surface);overflow:hidden;min-width:0}
.rail{display:grid;gap:24px;min-width:0}
.pane-head{display:flex;align-items:center;gap:8px;padding:12px 16px;border-bottom:1px solid var(--border);min-height:48px}
.pane-head h2{margin:0;font-size:13px;font-weight:600;letter-spacing:-0.005em}
.count{font:11px/1 var(--font-mono);color:var(--faint);font-variant-numeric:tabular-nums}
.filters{display:flex;align-items:center;gap:6px;flex-wrap:wrap;padding:10px 16px;border-bottom:1px solid var(--border)}
.wchip{display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 8px;border:1px solid var(--border);border-radius:var(--r-pill);background:var(--surface);color:var(--muted);font-size:11px;cursor:pointer;transition:border-color var(--dur) var(--ease),color var(--dur) var(--ease),background var(--dur) var(--ease)}
.wchip:hover{border-color:var(--border-2);color:var(--fg)}
.wchip[aria-pressed=true]{border-color:var(--accent);background:var(--accent-soft);color:var(--fg)}
.wchip i{width:6px;height:6px;border-radius:50%;flex:none}
.wchip .n{font:10px/1 var(--font-mono);color:var(--faint)}
.item{padding:12px 16px;border-top:1px solid var(--border);transition:background var(--dur) var(--ease)}
.item:first-child{border-top:0}
.item:hover{background:var(--surface-2)}
.item.hl{background:var(--surface-2);box-shadow:inset 0 0 0 2px var(--focus)}
.item.new{animation:flash 1.8s var(--ease)}
@keyframes flash{0%{background:var(--accent-soft)}100%{background:var(--surface)}}
.item-meta{display:flex;align-items:center;gap:8px;flex-wrap:wrap;font-size:11px;color:var(--muted)}
.item-meta .time{margin-left:auto;color:var(--faint);font-variant-numeric:tabular-nums;white-space:nowrap}
.who{display:inline-flex;align-items:center;gap:5px;min-width:0;max-width:220px;color:var(--muted)}
.who i{width:6px;height:6px;border-radius:50%;flex:none}
.who span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.body{margin:6px 0 0;font-size:14px;line-height:1.55;white-space:pre-wrap;word-break:break-word;text-wrap:pretty}
.item.disputed{background:color-mix(in oklch,var(--bad) 4%,var(--surface))}
.item.disputed .body{color:var(--muted)}
.note{margin:6px 0 0;font-size:11px;color:var(--warn)}
.evidence{margin:8px 0 0;padding:8px 10px;border:1px solid var(--border);border-radius:var(--r-sm);background:var(--surface-2)}
.evidence .label{display:block;margin-bottom:2px}
.evidence p{margin:0;font-size:12px;line-height:1.5;color:var(--muted);white-space:pre-wrap;word-break:break-word}
.edges{display:flex;align-items:center;gap:4px;flex-wrap:wrap;margin-top:8px;font-size:11px;color:var(--faint)}
.ref{display:inline-flex;align-items:center;height:20px;padding:0 6px;border:1px solid var(--border);border-radius:5px;background:var(--surface);color:var(--muted);font:11px/1 var(--font-mono);cursor:pointer;transition:color var(--dur) var(--ease),background var(--dur) var(--ease),border-color var(--dur) var(--ease)}
.ref:hover{color:var(--fg);background:var(--surface-2);border-color:var(--border-2)}
.ref.idbtn{background:transparent;border-color:transparent}
.ref.idbtn:hover{border-color:var(--border);background:var(--surface-2)}
.group + .group{border-top:1px solid var(--border)}
.group-head{display:flex;align-items:center;gap:8px;padding:10px 16px;background:var(--surface-2);font-size:11px;font-weight:600;color:var(--muted)}
.group-head .count{margin-left:auto}
.empty{padding:24px 16px;color:var(--faint);font-size:12px;text-align:center}
.gbar{display:flex;align-items:center;gap:16px;flex-wrap:wrap;margin:24px 0 12px}
.legend{display:flex;align-items:center;gap:12px;flex-wrap:wrap;font-size:11px;color:var(--muted)}
.legend span{display:inline-flex;align-items:center;gap:5px}
.legend i{display:inline-block;width:14px;height:9px;border:1.5px solid var(--border-2);border-radius:2px}
.legend .lo{border-color:var(--fg)}
.legend .li{border-color:var(--accent);border-radius:4px}
.legend .lc{border-color:var(--ok);border-radius:4px}
.legend .ld{border-color:var(--faint);border-radius:4px}
.legend .lf{border-color:var(--ok)}
.legend .lx{border-color:var(--bad);border-style:dashed}
.legend .lg{border-color:var(--warn)}
#graph{display:block;width:100%;height:calc(100vh - 520px);min-height:360px;background:var(--surface);border:1px solid var(--border);border-radius:var(--r);cursor:grab;touch-action:none;user-select:none}
#graph.dragging{cursor:grabbing}
#arrow path{fill:var(--border-2)}
.edge{fill:none;stroke:var(--border-2);stroke-width:1.5}
.edge.back{stroke-dasharray:5 4}
.edge.hl{stroke:var(--accent);stroke-width:2.5}
.edge.dim{opacity:.1}
.gnode{cursor:pointer}
.gnode rect{fill:var(--surface);stroke:var(--border-2);stroke-width:1.5}
.gnode text{fill:var(--fg);font:12px var(--font-sans)}
.gnode text.k{fill:var(--faint);font-family:var(--font-mono);font-size:10px;letter-spacing:.06em}
.gnode text.l{font-size:12px}
.gnode text.o{fill:var(--muted);font-size:11px}
.gnode.origin rect{stroke:var(--fg)}
.gnode.goal rect{stroke:var(--warn);stroke-dasharray:6 4}
.gnode.reached rect{stroke:var(--warn);stroke-width:2;stroke-dasharray:none}
.gnode.fact rect{stroke:var(--ok)}
.gnode.fact.disputed rect{stroke:var(--bad);stroke-dasharray:4 3}
.gnode.intent.open rect{stroke:var(--accent)}
.gnode.intent.claimed rect{stroke:var(--ok);fill:color-mix(in oklch,var(--ok) 8%,var(--surface))}
.gnode.intent.concluded rect{stroke:var(--faint)}
.gnode.stale rect,.gnode.intent.claimed.stale rect{stroke:var(--bad);stroke-dasharray:3 3}
.gnode.hl rect{stroke-width:3}
.gnode.dim{opacity:.15}
@media(max-width:1040px){.workspace{grid-template-columns:minmax(0,1fr)}}
@media(max-width:760px){
  .topbar{position:static;padding:10px 16px;gap:8px 12px}
  .field .label{display:none}
  select.control{max-width:none}
  .subnav{padding:10px 16px}
  main{padding:16px 16px 48px}
  .overview{padding:14px 16px}
  .overview-grid{grid-template-columns:minmax(0,1fr);gap:16px}
  .search{max-width:none;flex-basis:100%;order:10}
  .search input,.control,select.control{font-size:16px;height:38px}
  .wchip{height:28px}
}
@media(prefers-reduced-motion:reduce){
  *{animation-duration:.01ms!important;animation-iteration-count:1!important;transition-duration:.01ms!important}
}
</style></head><body>
<header class="topbar">
  <span class="brand">
    <svg viewBox="0 0 24 24" aria-hidden="true"><g fill="currentColor"><rect x="4" y="16" width="16" height="4" rx="2"/><rect x="6.5" y="10.5" width="11" height="4" rx="2"/><rect x="9" y="5" width="6" height="4" rx="2"/></g></svg>
    Fact board
  </span>
  <span class="conn" aria-live="polite"><i id="dot" class="dot"></i><span id="connText">live</span></span>
  <span class="spacer"></span>
  <label class="field"><span class="label">Board</span><select id="project" class="control" aria-label="Board"></select></label>
  <label class="check"><input id="showDone" type="checkbox"><span>Show completed</span></label>
  <label class="search">
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M16.5 16.5 21 21"/></svg>
    <input id="q" type="search" placeholder="Filter facts, intents, hints" aria-label="Filter facts, intents and hints" autocomplete="off" spellcheck="false">
    <kbd>/</kbd>
  </label>
  <button id="pause" class="control" type="button" aria-pressed="false">Pause</button>
</header>
<nav class="subnav" aria-label="Views">
  <div class="seg" role="tablist" aria-label="Board view">
    <button id="tabList" type="button" role="tab" aria-selected="true" aria-controls="listView">List</button>
    <button id="tabGraph" type="button" role="tab" aria-selected="false" aria-controls="graphView">Graph</button>
  </div>
  <span class="meta" id="meta"></span>
</nav>
<main>
  <section class="overview" id="overview" aria-label="Board summary"></section>
  <div class="workspace" id="listView">
    <section class="pane" aria-labelledby="hfHead">
      <div class="pane-head"><h2 id="hfHead">Facts</h2><span class="count" id="hf"></span></div>
      <div class="filters" id="workers" hidden></div>
      <div id="facts"></div>
    </section>
    <aside class="rail">
      <section class="pane" aria-labelledby="hiHead">
        <div class="pane-head"><h2 id="hiHead">Intents</h2><span class="count" id="hi"></span></div>
        <div id="intents"></div>
      </section>
      <section class="pane" aria-labelledby="hhHead">
        <div class="pane-head"><h2 id="hhHead">Hints</h2><span class="count" id="hh"></span></div>
        <div id="hints"></div>
      </section>
    </aside>
  </div>
  <div id="graphView" hidden>
    <div class="gbar">
      <button id="fit" class="control" type="button">Fit</button>
      <span class="legend">
        <span><i class="lo"></i>origin</span><span><i class="li"></i>intent open</span><span><i class="lc"></i>claimed</span>
        <span><i class="ld"></i>concluded</span><span><i class="lf"></i>fact</span><span><i class="lx"></i>disputed or lease expired</span>
        <span><i class="lg"></i>goal</span>
      </span>
      <span class="meta" id="gmeta"></span>
    </div>
    <svg id="graph" role="img" aria-label="Fact and intent graph"></svg>
  </div>
</main>
<script>
var params = new URLSearchParams(location.search);
var state = { paused: false, filter: "", first: true, data: null, seen: {}, project: params.get("project") || "", view: params.get("view") === "graph" ? "graph" : "list", showDone: false };
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
function colorFor(name) { var h = 2166136261; for (var i = 0; i < name.length; i++) { h ^= name.charCodeAt(i); h = Math.imul(h, 16777619) >>> 0; } return "hsl(" + (h % 360) + " 50% 45%)"; }
function ago(ts, now) { var s = Math.max(0, Math.round((now - ts) / 1000)); if (s < 60) return s + "s ago"; if (s < 3600) return Math.floor(s / 60) + "m ago"; if (s < 86400) return Math.floor(s / 3600) + "h ago"; return Math.floor(s / 86400) + "d ago"; }
function matches(o) { if (!state.filter) return true; return JSON.stringify(o).toLowerCase().indexOf(state.filter) !== -1; }
function owner(o) { return o.claimed_by || o.created_by || null; }
function short(id) { return id === "origin" || id === "goal" ? id : id.slice(0, 10); }
function stamp(ts) {
  var d = new Date(ts);
  var t = el("time", "time", ago(ts, Date.now()));
  t.dateTime = d.toISOString();
  t.title = d.toLocaleString();
  return t;
}
function pill(text, status) {
  var p = el("span", "pill " + status);
  p.appendChild(el("i"));
  p.appendChild(document.createTextNode(text));
  return p;
}
function who(name) {
  var w = el("span", "who");
  var d = el("i");
  d.style.background = colorFor(name);
  w.appendChild(d);
  w.appendChild(el("span", "", name));
  w.title = name;
  return w;
}
function refBtn(id, cls) {
  var b = el("button", "ref" + (cls ? " " + cls : ""), short(id));
  b.type = "button";
  b.title = id;
  b.onclick = function () { jump(id); };
  return b;
}
function edges(label, ids) {
  var e = el("div", "edges");
  e.appendChild(el("span", "", label));
  ids.forEach(function (id) { e.appendChild(refBtn(id)); });
  return e;
}
function jump(id) {
  var target = document.querySelector('#listView [data-id="' + CSS.escape(id) + '"]');
  if (!target) return false;
  target.scrollIntoView({ block: "center", behavior: "smooth" });
  target.classList.add("hl");
  setTimeout(function () { target.classList.remove("hl"); }, 1600);
  return true;
}
function markNew(node, sig) {
  if (!state.first && !state.seen[sig]) node.className += " new";
  state.seen[sig] = 1;
}
function itemHead(status, by, id, ts, now) {
  var r = el("div", "item-meta");
  r.appendChild(pill(status, status));
  if (by) r.appendChild(who(by));
  r.appendChild(stamp(ts, now));
  r.appendChild(refBtn(id, "idbtn"));
  return r;
}
function factItem(f, now) {
  var c = el("article", "item fact " + f.status);
  c.dataset.id = f.id;
  markNew(c, f.id + ":" + (f.created_at || 0) + ":" + f.status);
  c.appendChild(itemHead(f.status, f.claimed_by, f.id, f.created_at, now));
  c.appendChild(el("p", "body", f.text));
  if (f.evidence) {
    var ev = el("div", "evidence");
    ev.appendChild(el("span", "label", "Evidence"));
    ev.appendChild(el("p", "", f.evidence));
    c.appendChild(ev);
  }
  if (f.produced_by.length) c.appendChild(edges("produced by", f.produced_by));
  if (f.from && f.from.length) c.appendChild(edges("from", f.from));
  return c;
}
function intentItem(i, now) {
  var stale = i.status === "claimed" && i.lease_expires_at && i.lease_expires_at < now;
  var status = i.to_fact_id === "goal" ? "goal" : i.status;
  var c = el("article", "item intent " + status + (stale ? " stale" : ""));
  c.dataset.id = i.id;
  markNew(c, i.id + ":" + (i.updated_at || 0) + ":" + status + (stale ? ":stale" : ""));
  c.appendChild(itemHead(status, owner(i), i.id, i.updated_at, now));
  c.appendChild(el("p", "body", i.description));
  if (stale) c.appendChild(el("p", "note", "Lease expired. It reopens on the next board write."));
  if (i.from && i.from.length) c.appendChild(edges("from", i.from));
  if (i.to_fact_id) c.appendChild(edges("to", [i.to_fact_id]));
  return c;
}
function hintItem(h, now) {
  var c = el("article", "item hint");
  c.dataset.id = h.id;
  markNew(c, h.id + ":" + (h.created_at || 0) + ":hint");
  c.appendChild(itemHead("hint", null, h.id, h.created_at, now));
  c.appendChild(el("p", "body", h.content));
  return c;
}
function fill(id, items, emptyText) {
  var box = document.getElementById(id);
  box.replaceChildren();
  if (!items.length) box.appendChild(el("div", "empty", emptyText));
  else items.forEach(function (c) { box.appendChild(c); });
}
function flag(label, value, kind) {
  var f = el("div", "flag" + (kind ? " " + kind : ""));
  f.appendChild(el("b", "", label));
  f.appendChild(el("span", "v", value));
  return f;
}
function block(label, text) {
  var d = el("div", "ov");
  d.appendChild(el("span", "label", label));
  d.appendChild(el("p", "ov-text", text ? text : "Not set"));
  return d;
}

function renderOverview(d) {
  var box = document.getElementById("overview");
  box.replaceChildren();
  box.className = "overview";
  var info = d.board;
  if (!info || !info.initialized) {
    box.appendChild(el("div", "empty", d.note || "This board has no origin or goal yet. board_init sets both."));
    return;
  }
  var head = el("div", "overview-head");
  head.appendChild(pill(info.status, info.status));
  head.appendChild(el("span", "overview-project", state.project || "default board"));
  if (info.created_at) head.appendChild(el("span", "meta", "created " + ago(info.created_at, d.now)));
  box.appendChild(head);
  var grid = el("div", "overview-grid");
  grid.appendChild(block("Origin", info.origin));
  grid.appendChild(block("Goal", info.goal));
  box.appendChild(grid);
  var flags = el("div", "flags");
  if (info.reason) flags.appendChild(flag("Reason lease", info.reason.worker + " · heartbeat " + ago(info.reason.heartbeat_at, d.now)));
  if (info.completed_intent) {
    var row = el("div", "flag");
    row.appendChild(el("b", "", "Completed via"));
    row.appendChild(refBtn(info.completed_intent));
    flags.appendChild(row);
  }
  if (d.floatingFacts && d.floatingFacts.length) flags.appendChild(flag("Floating facts", d.floatingFacts.length + " cite no source and come from no intent", "warn"));
  if (d.unknownFacts && d.unknownFacts.length) flags.appendChild(flag("Unknown provenance", d.unknownFacts.length + " recorded with no worker name", "warn"));
  if (flags.children.length) box.appendChild(flags);
}

function renderWorkers(counts) {
  var names = Object.keys(counts).sort();
  var wb = document.getElementById("workers");
  wb.replaceChildren();
  wb.hidden = !names.length;
  names.forEach(function (n) {
    var b = el("button", "wchip");
    b.type = "button";
    b.setAttribute("aria-pressed", String(state.filter === n.toLowerCase()));
    var i = el("i");
    i.style.background = colorFor(n);
    b.appendChild(i);
    b.appendChild(document.createTextNode(n));
    b.appendChild(el("span", "n", String(counts[n])));
    b.onclick = function () { toggleWorker(n); };
    wb.appendChild(b);
  });
}
function toggleWorker(name) {
  var q = document.getElementById("q");
  if (state.filter === name.toLowerCase()) { state.filter = ""; q.value = ""; }
  else { state.filter = name.toLowerCase(); q.value = name; }
  render();
}

function renderList(d) {
  var now = d.now;
  var factsAll = d.facts || [], intentsAll = d.intents || [], hintsAll = d.hints || [];
  var facts = factsAll.filter(matches), intents = intentsAll.filter(matches), hints = hintsAll.filter(matches);
  var counts = {};
  factsAll.concat(intentsAll).forEach(function (o) { var n = owner(o); if (n) counts[n] = (counts[n] || 0) + 1; });
  renderWorkers(counts);
  function tally(list, all) { return list.length + (list.length !== all.length ? " / " + all.length : ""); }
  document.getElementById("hf").textContent = tally(facts, factsAll);
  document.getElementById("hi").textContent = tally(intents, intentsAll);
  document.getElementById("hh").textContent = tally(hints, hintsAll);
  fill("facts", facts.map(function (f) { return factItem(f, now); }), "No facts yet.");
  var groups = document.getElementById("intents");
  groups.replaceChildren();
  ["open", "claimed", "concluded"].forEach(function (st) {
    var list = intents.filter(function (i) { return i.status === st; });
    var g = el("div", "group");
    var gh = el("div", "group-head");
    gh.appendChild(el("span", "", st.charAt(0).toUpperCase() + st.slice(1)));
    gh.appendChild(el("span", "count", String(list.length)));
    g.appendChild(gh);
    if (!list.length) g.appendChild(el("div", "empty", "None"));
    else list.forEach(function (i) { g.appendChild(intentItem(i, now)); });
    groups.appendChild(g);
  });
  fill("hints", hints.map(function (h) { return hintItem(h, now); }), "No hints yet.");
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
    + graph.nodes.length + " nodes · " + graph.edges.length + " edges · scroll to zoom, drag to pan, click a node to open its card";
  meta.title = meta.textContent;
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
      : (n.kind + " · " + n.status + (n.stale ? " · LEASE EXPIRED" : "")).toUpperCase();
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
  renderOverview(d);
  if (state.view === "graph") renderGraph(d); else renderList(d);
  var partial = d.truncated || (state.view === "list" && d.hintsTruncated);
  var meta = document.getElementById("meta");
  meta.textContent = (partial ? "partial view (newest " + d.limit + ") · " : "") + (d.dbPath || "") + " · updated " + new Date(d.now).toLocaleTimeString();
  meta.title = d.dbPath || "";
}
function renderProjects(d) {
  var sel = document.getElementById("project");
  // Completed boards are hidden by default: they are history, not work in progress. The selected one always stays,
  // so a URL pointing at a completed board still works with the toggle off.
  var names = [""].concat((d.projects || []).filter(function (p) { return state.showDone || p.status !== "completed" || p.name === state.project; }).map(function (p) { return p.name; }));
  var key = names.join("|") + "#" + state.showDone;
  if (sel.dataset.names === key && sel.value === state.project) return;
  sel.replaceChildren();
  names.forEach(function (n) { var o = el("option", "", n || "(default)"); o.value = n; sel.appendChild(o); });
  sel.value = state.project; sel.dataset.names = key;
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
  document.getElementById("tabList").setAttribute("aria-selected", String(name === "list"));
  document.getElementById("tabGraph").setAttribute("aria-selected", String(name === "graph"));
  if (name === "list") state.first = true;
  syncUrl();
  render();
}
function setConn(mode) {
  document.getElementById("dot").className = "dot" + (mode === "offline" ? " off" : mode === "paused" ? " paused" : "");
  document.getElementById("connText").textContent = mode;
}
function poll() {
  if (state.paused) return;
  var url = "/api/board" + (state.project ? "?project=" + encodeURIComponent(state.project) : "");
  fetch(url, { cache: "no-store" }).then(function (r) { return r.json(); }).then(function (d) { state.data = d; setConn("live"); render(); })
    .catch(function () { setConn("offline"); });
}
document.getElementById("project").addEventListener("change", function (e) {
  state.project = e.target.value; state.first = true; state.seen = {}; gs.sig = ""; gs.moved = false;
  syncUrl(); poll();
});
document.getElementById("tabList").onclick = function () { showTab("list"); };
document.getElementById("tabGraph").onclick = function () { showTab("graph"); };
document.getElementById("fit").onclick = function () { fit(); };
document.getElementById("q").addEventListener("input", function (e) { state.filter = e.target.value.trim().toLowerCase(); render(); });
document.getElementById("showDone").addEventListener("change", function (e) { state.showDone = e.target.checked; render(); });
document.getElementById("pause").onclick = function () {
  state.paused = !state.paused;
  this.textContent = state.paused ? "Resume" : "Pause";
  this.setAttribute("aria-pressed", String(state.paused));
  setConn(state.paused ? "paused" : "live");
  if (!state.paused) poll();
};
document.addEventListener("keydown", function (ev) {
  var tag = (ev.target.tagName || "").toLowerCase();
  var typing = tag === "input" || tag === "select" || tag === "textarea";
  if (ev.key === "/" && !typing) { ev.preventDefault(); document.getElementById("q").focus(); }
  if (ev.key === "Escape" && tag === "input") {
    var q = document.getElementById("q");
    q.value = ""; state.filter = ""; q.blur(); render();
  }
});
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
