import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectDbPath } from "../src/board";
import { startViewer } from "../src/viewer";

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
    expect(html).toContain('getElementById("project").addEventListener("change"');
  } finally {
    viewer.stop();
    board.close();
  }
});
