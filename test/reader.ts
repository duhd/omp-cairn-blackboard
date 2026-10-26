// Child process for the concurrency test: behaves like the viewer (open read-only, query, close, repeat).
import { Database } from "bun:sqlite";
import { existsSync } from "node:fs";

const [dbPath, stopFile] = process.argv.slice(2);
let reads = 0;
let errors = 0;
while (!existsSync(stopFile)) {
  try {
    const db = new Database(dbPath, { readonly: true });
    db.exec("PRAGMA busy_timeout = 2000");
    db.query("SELECT * FROM facts ORDER BY created_at DESC LIMIT 500").all();
    db.close();
    reads++;
  } catch {
    errors++;
  }
}
console.log(JSON.stringify({ reads, errors }));
