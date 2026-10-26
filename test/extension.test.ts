import { Database } from "bun:sqlite";
import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

type Notify = (message: string) => void;
type CommandHandler = (args: string, ctx: { ui: { notify: Notify } }) => Promise<void>;

const dir = mkdtempSync(join(tmpdir(), "extension-"));
const savedEnv = { port: process.env.FACT_BOARD_PORT, db: process.env.FACT_BOARD_DB };
afterAll(() => {
  // The extension keeps its board connections process-wide; Windows will not delete a file that is still open.
  const state: { boards?: Map<string, { close(): void }> } | undefined = Reflect.get(globalThis, Symbol.for("omp-cairn-blackboard.state"));
  for (const board of state?.boards?.values() ?? []) board.close();
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

test("/fact-board start upgrades an existing 0.1 board so the read-only viewer can show it", async () => {
  process.env.FACT_BOARD_PORT = "0";
  process.env.FACT_BOARD_DB = join(dir, "legacy-board.db");
  const legacy = new Database(process.env.FACT_BOARD_DB, { create: true });
  legacy.exec(`CREATE TABLE facts (id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'claimed',
    claimed_by TEXT, evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE intents (id TEXT PRIMARY KEY, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
    claimed_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
    CREATE TABLE hints (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL);
    INSERT INTO facts VALUES ('f_old', 'kept across the upgrade', 'claimed', NULL, NULL, 1, 1);`);
  legacy.close();
  const notes: string[] = [];
  const ctx = { ui: { notify: (message: string) => void notes.push(message) } };
  const instance = await loadInstance("legacy");

  await instance.command("start", ctx);
  const url = notes[0].replace("fact board viewer: ", "");
  const data = await (await fetch(`${url}/api/board`)).json();
  await instance.command("stop", ctx);
  expect(data.note).toBeUndefined();
  expect(data.facts.map((f: { text: string }) => f.text)).toEqual(["kept across the upgrade"]);
});
