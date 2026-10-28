import { expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, projectDbPath } from "../src/board";
import { startViewer } from "../src/viewer";

// The banner only shows what the served payload carries. Read it back over HTTP so a field dropped between the
// reader and the payload fails here, not in front of a user.
test("the served payload carries floating and unknown facts and the edge count", async () => {
  const base = join(mkdtempSync(join(tmpdir(), "viewer-health-")), "fact-board.db");
  const board = new Board(projectDbPath(base, "health"));
  board.init({ origin: "o", goal: "g" });
  const rooted = board.claimFact({ text: "rooted", claimedBy: "controller", from: ["origin"] });
  const dangling = board.claimFact({ text: "dangling" });
  const viewer = startViewer({ basePath: base, port: 0 });
  try {
    const data = await (await fetch(`${viewer.url}/api/board?project=health`)).json();
    expect(data.floatingFacts).toContain(dangling.id);
    expect(data.floatingFacts).not.toContain(rooted.id);
    expect(data.unknownFacts).toContain(dangling.id);
    expect(data.edges).toBeGreaterThan(0);
  } finally {
    viewer.stop();
    board.close();
  }
});
