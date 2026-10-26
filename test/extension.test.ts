import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Notify = (message: string) => void;
type CommandHandler = (args: string, ctx: { ui: { notify: Notify } }) => Promise<void>;

const dir = mkdtempSync(join(tmpdir(), "extension-"));
const savedEnv = { port: process.env.FACT_BOARD_PORT, db: process.env.FACT_BOARD_DB };
afterAll(() => {
  process.env.FACT_BOARD_PORT = savedEnv.port;
  process.env.FACT_BOARD_DB = savedEnv.db;
  if (savedEnv.port === undefined) delete process.env.FACT_BOARD_PORT;
  if (savedEnv.db === undefined) delete process.env.FACT_BOARD_DB;
  rmSync(dir, { recursive: true, force: true });
});

// Stands in for zod: tool parameter schemas are only built, never used, by these tests.
const schema: object = new Proxy(() => schema, { get: () => schema });

/**
 * Loads the extension the way omp does: a plain path plus a cache-busting query gives each load its own
 * module instance (Bun ignores the query on file: URLs), so the import is necessarily dynamic.
 */
async function loadInstance(tag: string): Promise<{ module: object; command: CommandHandler }> {
  const module = await import(`${join(import.meta.dir, "..", "src", "index.ts")}?instance=${tag}`);
  let command: CommandHandler | undefined;
  const pi = {
    zod: schema,
    registerTool() {},
    registerCommand(_name: string, options: { handler: CommandHandler }) {
      command = options.handler;
    },
    on() {},
  };
  module.default(pi as never);
  if (!command) throw new Error("extension did not register /fact-board");
  return { module, command };
}

test("a viewer started from one module instance can be stopped from another", async () => {
  process.env.FACT_BOARD_PORT = "0";
  process.env.FACT_BOARD_DB = join(dir, "fact-board.db");
  const notes: string[] = [];
  const ctx = { ui: { notify: (message: string) => void notes.push(message) } };
  const a = await loadInstance("a");
  const b = await loadInstance("b");
  expect(a.module).not.toBe(b.module);

  await a.command("start", ctx);
  const url = notes[0].replace("fact board viewer: ", "");
  expect((await fetch(`${url}/api/board`)).status).toBe(200);

  await b.command("status", ctx);
  expect(notes[1]).toBe(`fact board viewer: ${url}`);
  await b.command("stop", ctx);
  expect(notes[2]).toBe("fact board viewer stopped");
  await expect(fetch(`${url}/api/board`)).rejects.toThrow();
  await a.command("stop", ctx);
  expect(notes[3]).toBe("fact board viewer is not running in this omp process");
});
