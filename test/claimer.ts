// Child process for the race test: tries to claim one intent and reports whether it won.
import { Board, BoardError } from "../src/board";

const [dbPath, intentId, worker] = process.argv.slice(2);
const board = new Board(dbPath);
try {
  board.claimIntent(intentId, worker);
  console.log("won");
} catch (err) {
  if (!(err instanceof BoardError)) throw err;
  console.log("lost");
} finally {
  board.close();
}
