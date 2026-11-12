import { expect, test } from "bun:test";
import { appendFileSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectDbPath } from "../src/board";
import { aggregateSessionUsage, startViewer } from "../src/viewer";

// The page's script lives in a template string, so nothing else parses it. A stray brace there silently kills
// the whole viewer while the API tests stay green. Parse the served script here, and pin the wiring we rely on.
test("the served viewer page has a script that parses and wires the completed toggle", async () => {
  const base = join(mkdtempSync(join(tmpdir(), "viewer-page-")), "fact-board.db");
  const board = new Board(projectDbPath(base, "page-check"));
  board.init({ origin: "o", goal: "g" });
  const viewer = startViewer({ basePath: base, port: 0 });
  try {
    const html = await (await fetch(viewer.url)).text();
    const script = html.slice(html.indexOf("<script>") + "<script>".length, html.lastIndexOf("</script>"));
    expect(() => new Function(script)).not.toThrow();
    expect(html).toContain('id="showDone"');
    expect(html).toContain('getElementById("showDone").addEventListener("change"');
  } finally {
    viewer.stop();
    board.close();
  }
});
test("aggregateSessionUsage increments incrementally on append and serves via /api/telemetry", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "viewer-telem-"));
  const base = join(tempDir, "fact-board.db");
  // session directory setup
  const sessionsDir = join(tempDir, "sessions", "sess-1");
  mkdirSync(sessionsDir, { recursive: true });
  const sessionFile = join(sessionsDir, "session.jsonl");

  const line1 = JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { input: 100, output: 50, cacheRead: 500, cost: { total: 0.05 } } },
  }) + "\n";
  writeFileSync(sessionFile, line1);

  // verify first line usage
  const u1 = aggregateSessionUsage(base, null);
  expect(u1.input).toBe(100);
  expect(u1.output).toBe(50);
  expect(u1.cacheRead).toBe(500);
  expect(u1.cost).toBeCloseTo(0.05, 4);

  // Append line
  const line2 = JSON.stringify({
    type: "message",
    message: { role: "assistant", usage: { input: 200, output: 30, cacheRead: 1000, cost: { total: 0.10 } } },
  }) + "\n";
  appendFileSync(sessionFile, line2);

  const u2 = aggregateSessionUsage(base, null);
  expect(u2.input).toBe(300);
  expect(u2.output).toBe(80);
  expect(u2.cacheRead).toBe(1500);
  expect(u2.cost).toBeCloseTo(0.15, 4);

  // Verify /api/telemetry endpoint response
  const viewer = startViewer({ basePath: base, port: 0 });
  try {
    const res = await (await fetch(`${viewer.url}/api/telemetry`)).json();
    expect(res.usage.input).toBe(300);
    expect(res.usage.output).toBe(80);
  } finally {
    viewer.stop();
  }
});
test("aggregateSessionUsage isolates projects correctly across multiple sessions", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "viewer-telem-multi-"));
  const base = join(tempDir, "fact-board.db");
  const sessionsDir = join(tempDir, "sessions", "sess-proj");
  mkdirSync(sessionsDir, { recursive: true });

  const fileA = join(sessionsDir, "a.jsonl");
  writeFileSync(fileA, JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", arguments: { project: "project-alpha" } }], usage: { input: 123, output: 45, cacheRead: 678, cost: 0.01 } }
  }) + "\n");

  const fileB = join(sessionsDir, "b.jsonl");
  writeFileSync(fileB, JSON.stringify({
    type: "message",
    message: { role: "assistant", content: [{ type: "toolCall", arguments: { project: "project-beta" } }], usage: { input: 456, output: 78, cacheRead: 910, cost: 0.02 } }
  }) + "\n");

  const uA = aggregateSessionUsage(base, "project-alpha");
  expect(uA.input).toBe(123);
  const uB = aggregateSessionUsage(base, "project-beta");
  expect(uB.input).toBe(456);
  const uNone = aggregateSessionUsage(base, "project-none");
  expect(uNone.input).toBe(0);
});

test("viewer /api/board includes anchors in snapshot and fact/intent views", async () => {
  const tempDir = mkdtempSync(join(tmpdir(), "viewer-anchors-"));
  const base = join(tempDir, "fact-board.db");
  const board = new Board(projectDbPath(base, "anchors-api"));
  board.init({ origin: "o", goal: "g" });
  const { reason_token } = board.reasonClaim("controller");
  board.createIntent({ description: "task a", from: ["origin"], reasonToken: reason_token, anchors: ["src/index.ts"] });
  board.claimFact({ text: "fact a", claimedBy: "controller", from: ["origin"], anchors: ["src/index.ts", "docs/api.md"] });

  const viewer = startViewer({ basePath: base, port: 0 });
  try {
    const res = await (await fetch(`${viewer.url}/api/board?project=anchors-api`)).json();
    expect(res.facts[0].anchors).toEqual(["docs/api.md", "src/index.ts"]);
    expect(res.intents[0].anchors).toEqual(["src/index.ts"]);
    expect(res.anchors[res.facts[0].id]).toEqual(["docs/api.md", "src/index.ts"]);
  } finally {
    viewer.stop();
    board.close();
  }
});
