import { expect, test } from "bun:test";
import { factFor } from "../src/ladder-provider";

const quoted = "src/auth/session.ts:42: if (expiresAt < now) return refresh(token);";
const block = ["header", "}", quoted, "ok"].join("\n");
const fact = (id: string, evidence: string | null, status = "claimed") => ({ id, text: `fact ${id}`, evidence, status });

test("a fact whose evidence quotes a long line of the block becomes its summary", () => {
  expect(factFor(block, [fact("f_aaaaaaaaaaaaaaaa", `grep output: ${quoted}`)], "auth")).toBe("→ fact f_aaaaaaaaaa (board auth): fact f_aaaaaaaaaaaaaaaa");
});

test("short lines never link a fact, so `}` or `ok` in evidence does not collapse unrelated output", () => {
  expect(factFor(block, [fact("f_short", "} ok header")], "")).toBeUndefined();
});

test("disputed facts are skipped and the newest matching fact wins", () => {
  const facts = [fact("f_new_disputed", quoted, "disputed"), fact("f_newer", quoted), fact("f_older", quoted)];
  expect(factFor(block, facts, "")).toBe("→ fact f_newer (board default): fact f_newer");
});

test("long fact text is cut so a pointer stays one short line", () => {
  const long = { id: "f_long", text: "x".repeat(1000), evidence: quoted, status: "claimed" };
  expect(factFor(block, [long], "p")?.length).toBeLessThan(360);
});
