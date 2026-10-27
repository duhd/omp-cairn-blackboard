import { afterAll, describe, expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Board, BoardError, listBoards, listProjects, parseIdList, projectDbPath, readSnapshot } from "../src/board";
import type { BoardOptions, Snapshot } from "../src/board";
import redactOutput from "../src/redact-output";
import { redactText } from "../src/redact";
import { startViewer } from "../src/viewer";

const dirs: string[] = [];
const boards: Board[] = [];

function tempDir(prefix = "blackboard-"): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

function newBoard(options: BoardOptions = {}, path = join(tempDir(), "board.db")): Board {
  const board = new Board(path, options);
  boards.push(board);
  return board;
}

afterAll(() => {
  for (const board of boards) board.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

/** A started board whose Reason lease is held by "controller". */
function started(options: BoardOptions = {}) {
  const board = newBoard(options);
  board.init({ origin: "service X returns 500 under load", goal: "root cause identified" });
  const { reason_token } = board.reasonClaim("controller");
  return { board, reason_token };
}

function expectRule(fn: () => unknown, message: string): void {
  expect(fn).toThrow(BoardError);
  expect(fn).toThrow(message);
}

describe("graph", () => {
  test("concluding an intent creates exactly one fact linked by an edge", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "check the DB pool", from: ["origin"], reasonToken: reason_token });
    expect(intent.from).toEqual(["origin"]);
    const { lease_token } = board.claimIntent(intent.id, "w1");
    const { fact, intent: done } = board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact: "pool size is 5", evidence: "config.yml" });
    expect(done.status).toBe("concluded");
    expect(done.to_fact_id).toBe(fact.id);
    expect(fact.claimed_by).toBe("w1");
    const exported = JSON.parse(board.export());
    expect(exported.facts.find((f: { id: string }) => f.id === fact.id).produced_by).toEqual([intent.id]);
  });

  test("intents must cite existing, undisputed facts and never the goal", () => {
    const { board, reason_token } = started({ maxIntentsPerReason: 10 });
    const fact = board.claimFact({ text: "seed finding" });
    expectRule(() => board.createIntent({ description: "x", from: [], reasonToken: reason_token }), "at least one source");
    expectRule(() => board.createIntent({ description: "x", from: ["f_missing"], reasonToken: reason_token }), "unknown source fact");
    expectRule(() => board.createIntent({ description: "x", from: ["goal"], reasonToken: reason_token }), "cannot be used as a source");
    board.disputeFact(fact.id, "wrong");
    expectRule(() => board.createIntent({ description: "x", from: [fact.id], reasonToken: reason_token }), "is disputed");
  });

  test("an uninitialized board refuses intents", () => {
    const board = newBoard();
    expectRule(() => board.reasonClaim("controller"), "not initialized");
  });

  test("init is idempotent for the same origin and goal, and refuses a different one", () => {
    const board = newBoard();
    const first = board.init({ origin: "o", goal: "g" });
    expect(board.init({ origin: "o", goal: "g" })).toEqual(first);
    expectRule(() => board.init({ origin: "o", goal: "other" }), "already initialized");
  });
});

describe("Reason lease", () => {
  test("only one worker reasons at a time", () => {
    const { board } = started();
    expectRule(() => board.reasonClaim("other"), "held by controller");
  });

  test("declaring intents needs the current reason token", () => {
    const { board } = started();
    expectRule(() => board.createIntent({ description: "x", from: ["origin"], reasonToken: "wrong" }), "needs the Reason lease");
  });

  test("a Reason pass may declare at most the configured number of intents", () => {
    const { board, reason_token } = started({ maxIntentsPerReason: 2 });
    board.createIntent({ description: "a", from: ["origin"], reasonToken: reason_token });
    board.createIntent({ description: "b", from: ["origin"], reasonToken: reason_token });
    expectRule(() => board.createIntent({ description: "c", from: ["origin"], reasonToken: reason_token }), "cap 2");
    board.reasonRelease(reason_token);
    const next = board.reasonClaim("controller");
    expect(board.createIntent({ description: "c", from: ["origin"], reasonToken: next.reason_token }).description).toBe("c");
  });

  test("a stale Reason lease expires and can be taken over", () => {
    let now = 1_000;
    const board = newBoard({ leaseMs: 100, now: () => now });
    board.init({ origin: "o", goal: "g" });
    const stale = board.reasonClaim("controller");
    now += 101;
    expect(board.reasonClaim("other").worker).toBe("other");
    expectRule(() => board.createIntent({ description: "x", from: ["origin"], reasonToken: stale.reason_token }), "needs the Reason lease");
  });
});

describe("intent lease (compare-and-swap)", () => {
  test("a worker whose lease was reclaimed cannot conclude, and its fact is not written", () => {
    let now = 1_000;
    const board = newBoard({ leaseMs: 100, now: () => now });
    board.init({ origin: "o", goal: "g" });
    const { reason_token } = board.reasonClaim("controller");
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const first = board.claimIntent(intent.id, "w1");
    now += 101; // w1 goes quiet; the lease expires
    const second = board.claimIntent(intent.id, "w2");
    expect(second.intent.claimed_by).toBe("w2");
    expectRule(() => board.concludeIntent({ id: intent.id, leaseToken: first.lease_token, fact: "stale result" }), "no longer valid");
    expect(board.queryFacts({ q: "stale result" })).toHaveLength(0);
    const { fact } = board.concludeIntent({ id: intent.id, leaseToken: second.lease_token, fact: "fresh result" });
    expect(fact.claimed_by).toBe("w2");
  });

  test("an expired lease that nobody reclaimed may still conclude", () => {
    let now = 1_000;
    const board = newBoard({ leaseMs: 100, now: () => now });
    board.init({ origin: "o", goal: "g" });
    const { reason_token } = board.reasonClaim("controller");
    const intent = board.createIntent({ description: "slow work", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    now += 500;
    expect(board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact: "late but valid" }).intent.status).toBe("concluded");
  });

  test("heartbeat keeps a lease alive past the timeout and fails once it is lost", () => {
    let now = 1_000;
    const board = newBoard({ leaseMs: 100, now: () => now });
    board.init({ origin: "o", goal: "g" });
    const { reason_token } = board.reasonClaim("controller");
    const intent = board.createIntent({ description: "long work", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    now += 80;
    board.heartbeatIntent(intent.id, lease_token);
    now += 80; // 160ms after the claim, 80ms after the heartbeat
    expectRule(() => board.claimIntent(intent.id, "w2"), "already claimed by w1");
    now += 101;
    board.claimIntent(intent.id, "w2");
    expectRule(() => board.heartbeatIntent(intent.id, lease_token), "held by w2");
  });

  test("the owner re-claiming gets its token back; others are refused", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const first = board.claimIntent(intent.id, "w1");
    expect(board.claimIntent(intent.id, "w1").lease_token).toBe(first.lease_token);
    expectRule(() => board.claimIntent(intent.id, "w2"), "already claimed by w1");
  });

  test("claiming hands the worker its source facts and the latest hints", () => {
    const { board, reason_token } = started();
    board.writeHint("focus on the connection pool");
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const claimed = board.claimIntent(intent.id, "w1");
    expect(claimed.sources.map(s => s.text)).toEqual(["service X returns 500 under load"]);
    expect(claimed.hints.map(h => h.content)).toEqual(["focus on the connection pool"]);
  });

  test("release reopens the intent and invalidates the old token", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    const released = board.releaseIntent(intent.id, lease_token);
    expect(released.status).toBe("open");
    expect(released.claimed_by).toBeNull();
    expectRule(() => board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact: "x" }), "no longer valid");
  });

  test.each([
    ["conclude an open intent", (b: Board, id: string) => b.concludeIntent({ id, leaseToken: "t", fact: "x" })],
    ["release an open intent", (b: Board, id: string) => b.releaseIntent(id, "t")],
    ["heartbeat an open intent", (b: Board, id: string) => b.heartbeatIntent(id, "t")],
  ])("rejects: %s", (_name, act) => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    expectRule(() => act(board, intent.id), "no longer valid");
  });

  test("lease rejections carry a machine-readable code and lease expiry", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    board.claimIntent(intent.id, "w1");
    try {
      board.claimIntent(intent.id, "w2");
      throw new Error("expected a rejection");
    } catch (err) {
      expect(err).toBeInstanceOf(BoardError);
      const be = err as BoardError;
      expect(be.code).toBe("intent_claimed");
      expect(be.details?.held_by).toBe("w1");
      expect(typeof be.details?.lease_expires_at).toBe("number");
    }
  });

  test("claimed intents expose lease expiry in exports", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    board.claimIntent(intent.id, "w1");
    const exported = JSON.parse(board.export());
    const found = exported.intents.find((x: { id: string }) => x.id === intent.id);
    expect(typeof found.lease_expires_at).toBe("number");
  });

  test("a concluded intent cannot be claimed again", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact: "done" });
    expectRule(() => board.claimIntent(intent.id, "w2"), "invalid transition concluded -> claimed");
  });

  test("lease tokens never appear in any read path", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    expect(board.export()).not.toContain(lease_token);
    expect(board.export("timeline")).not.toContain(lease_token);
    expect(JSON.stringify(readSnapshot(board.path))).not.toContain(lease_token);
  });
});

describe("completion", () => {
  test("complete links the goal to its supporting facts, freezes the board, and reopen undoes it", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    const { fact } = board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact: "pool exhausted under load" });
    const done = board.complete({ from: [fact.id], description: "pool exhaustion causes the 500s", worker: "controller" });
    expect(done.to_fact_id).toBe("goal");
    expect(done.from).toEqual([fact.id]);
    expect(board.info().status).toBe("completed");
    expectRule(() => board.claimFact({ text: "late" }), "board is completed");
    expectRule(() => board.reasonClaim("controller"), "board is completed");

    const { fact: why } = board.reopen("the 500s persist with a larger pool");
    expect(board.info().status).toBe("active");
    const exported = JSON.parse(board.export());
    expect(exported.intents.find((i: { id: string }) => i.id === done.id).to_fact_id).toBe(why.id);
    expect(board.reasonClaim("controller").worker).toBe("controller");
  });

  test("the timeline export tells the path from origin to goal", () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    const { fact } = board.concludeIntent({ id: intent.id, leaseToken: lease_token, fact: "pool exhausted" });
    board.complete({ from: [fact.id], description: "done", worker: "controller" });
    const timeline = board.export("timeline");
    for (const marker of ["BOARD INITIALIZED", "INTENT DECLARED", "INTENT CONCLUDED", "BOARD COMPLETED"]) {
      expect(timeline).toContain(marker);
    }
    expect(timeline.indexOf("INTENT DECLARED")).toBeLessThan(timeline.indexOf("BOARD COMPLETED"));
  });
});

describe("facts", () => {
  test("identical findings dedupe to one row", () => {
    const board = newBoard();
    const a = board.claimFact({ text: "build script is scripts/build.sh", claimedBy: "A" });
    const b = board.claimFact({ text: "build script is scripts/build.sh", claimedBy: "B" });
    expect(b.id).toBe(a.id);
    expect(b.claimed_by).toBe("A");
    expect(board.queryFacts()).toHaveLength(1);
  });

  test("credentials are redacted before storage and do not defeat dedup", () => {
    const board = newBoard();
    const a = board.claimFact({ text: "creds: password=hunter2secret", evidence: "token=abcdef1234567890" });
    const b = board.claimFact({ text: "creds: password=anotherSecret99" });
    expect(b.id).toBe(a.id);
    expect(a.text).toBe("creds: password=[REDACTED]");
    expect(a.evidence).toBe("token=[REDACTED]");
  });

  test("dispute keeps the row and appends the redacted reason", () => {
    const board = newBoard();
    const fact = board.claimFact({ text: "service X is open", evidence: "curl 200" });
    const disputed = board.disputeFact(fact.id, "false positive, api_key=abcdefgh12345678");
    expect(disputed.status).toBe("disputed");
    expect(disputed.evidence).toBe("curl 200 [disputed: false positive, api_key=[REDACTED]]");
    expectRule(() => board.disputeFact("f_missing"), "fact not found");
  });

  test("a directly claimed fact records the facts it builds on, and a repeat claim adds new sources", () => {
    const board = newBoard();
    board.init({ origin: "o", goal: "g" });
    const sourcesOf = (id: string) => (JSON.parse(board.export()) as Snapshot).facts.find(f => f.id === id)?.from;
    const first = board.claimFact({ text: "branch created", from: ["origin"] });
    const second = board.claimFact({ text: "conflicts resolved", from: [first.id] });
    expect(sourcesOf(second.id)).toEqual([first.id]);
    const repeat = board.claimFact({ text: "conflicts resolved", claimedBy: "other", from: ["origin"] });
    expect([repeat.id, repeat.claimed_by]).toEqual([second.id, "unknown"]);
    expect(sourcesOf(second.id)).toEqual([first.id, "origin"]);
    expect(board.export("timeline")).toContain(`from: ${first.id}, origin`);
  });

  test("fact sources follow the same rules as intent sources", () => {
    const board = newBoard();
    board.init({ origin: "o", goal: "g" });
    const wrong = board.claimFact({ text: "wrong finding" });
    board.disputeFact(wrong.id);
    expectRule(() => board.claimFact({ text: "a", from: ["f_missing"] }), "unknown source fact");
    expectRule(() => board.claimFact({ text: "b", from: [wrong.id] }), "disputed");
    expectRule(() => board.claimFact({ text: "c", from: ["goal"] }), "cannot be used as a source");
    // A fact that already exists cannot cite itself when it is claimed again.
    const existing = board.claimFact({ text: "d" });
    expectRule(() => board.claimFact({ text: "d", from: [existing.id] }), "its own source");
    // None of the rejected claims left a row behind.
    expect(board.queryFacts().map(f => f.text)).toEqual(["d", "wrong finding"]);
  });

  test("a board written before fact sources existed is still readable, with no sources", () => {
    const path = join(tempDir("blackboard-nofs-"), "board.db");
    const board = newBoard({}, path);
    board.init({ origin: "o", goal: "g" });
    board.claimFact({ text: "kept", from: ["origin"] });
    const raw = new Database(path);
    raw.exec("DROP TABLE fact_sources");
    raw.close();
    const snapshot = readSnapshot(path);
    if ("missing" in snapshot || "legacy" in snapshot) throw new Error("board should be readable");
    expect(snapshot.facts.map(f => [f.text, f.from])).toEqual([["kept", []]]);
  });

  test("query pages and treats LIKE wildcards literally", () => {
    const board = newBoard();
    board.claimFact({ text: "rate limit is 100% of quota" });
    board.claimFact({ text: "rate limit is 1000 of quota" });
    expect(board.queryFacts({ q: "100%" }).map(f => f.text)).toEqual(["rate limit is 100% of quota"]);
    const all = board.queryFacts();
    expect(board.queryFacts({ limit: 1, offset: 1 }).map(f => f.id)).toEqual([all[1].id]);
  });
});

describe("redact-output scope", () => {
  test("redacts bash/eval output but leaves source reads untouched", async () => {
    let handle: ((event: { toolName: string; content: Array<{ type: string; text: string }> }) => unknown) | undefined;
    redactOutput({ on: (_event: string, h: unknown) => (handle = h as never) } as never);
    const secret = [{ type: "text", text: "password=hunter2secret" }];
    expect(JSON.stringify(await handle!({ toolName: "bash", content: secret }))).toContain("[REDACTED]");
    expect(JSON.stringify(await handle!({ toolName: "eval", content: secret }))).toContain("[REDACTED]");
    expect(await handle!({ toolName: "read", content: secret })).toBeUndefined();
    expect(await handle!({ toolName: "grep", content: secret })).toBeUndefined();
  });
});

describe("parseIdList", () => {
  test.each([
    ["origin", ["origin"]],
    ["origin,f_abc123", ["origin", "f_abc123"]],
    [" origin , f_abc123 ", ["origin", "f_abc123"]],
    ['["origin","f_abc123"]', ["origin", "f_abc123"]],
    ['"origin"', ["origin"]],
    ["", []],
    ["origin,", ["origin"]],
  ])("parses %p", (input, expected) => {
    expect(parseIdList(input)).toEqual(expected);
  });
});

describe("projects", () => {
  test("each project is its own board file next to the default board", () => {
    const dir = tempDir();
    const base = join(dir, "fact-board.db");
    const alpha = projectDbPath(base, "alpha");
    expect(alpha).toBe(join(dir, "fact-boards", "alpha.db"));
    const a = newBoard({}, alpha);
    const b = newBoard({}, projectDbPath(base, "beta"));
    a.claimFact({ text: "only in alpha" });
    expect(b.queryFacts()).toHaveLength(0);
    expect(listProjects(base)).toEqual(["alpha", "beta"]);
  });

  test("no project means the default board", () => {
    expect(projectDbPath("/tmp/fact-board.db", undefined)).toBe("/tmp/fact-board.db");
    expect(projectDbPath("/tmp/fact-board.db", "")).toBe("/tmp/fact-board.db");
  });

  test.each(["../escape", "a/b", "a\\b", ".hidden", "x".repeat(65)])("rejects unsafe project name %p", name => {
    expectRule(() => projectDbPath("/tmp/fact-board.db", name), "invalid project name");
  });
});

describe("storage", () => {
  test("a 0.1 board (no graph columns) is migrated in place", () => {
    const path = join(tempDir("blackboard-legacy-"), "board.db");
    const legacy = new Database(path, { create: true });
    legacy.exec(`CREATE TABLE intents (id TEXT PRIMARY KEY, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      INSERT INTO intents VALUES ('old', 'kept', 'open', NULL, 1, 1);`);
    legacy.close();
    const board = newBoard({}, path);
    board.init({ origin: "o", goal: "g" });
    const claimed = board.claimIntent("old", "w1");
    expect(claimed.intent.description).toBe("kept");
    expect(board.concludeIntent({ id: "old", leaseToken: claimed.lease_token, fact: "migrated" }).intent.to_fact_id).toBeTruthy();
  });

  test("the viewer reports a not-yet-migrated 0.1 board instead of failing, and reads it once a writer upgrades it", async () => {
    const base = join(tempDir("blackboard-legacy-view-"), "fact-board.db");
    const legacy = new Database(base, { create: true });
    legacy.exec(`CREATE TABLE facts (id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'claimed',
      claimed_by TEXT, evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE intents (id TEXT PRIMARY KEY, description TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'open',
      claimed_by TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);
      CREATE TABLE hints (id TEXT PRIMARY KEY, content TEXT NOT NULL, created_at INTEGER NOT NULL);`);
    legacy.close();
    expect(readSnapshot(base)).toEqual({ legacy: true });
    const viewer = startViewer({ basePath: base, port: 0 });
    try {
      const before = await (await fetch(`${viewer.url}/api/board`)).json();
      expect(before.note).toContain("0.1 format");
      expect(before.graph).toBeUndefined();
      newBoard({}, base).init({ origin: "o", goal: "g" });
      const after = await (await fetch(`${viewer.url}/api/board`)).json();
      expect([after.note, after.board.goal]).toEqual([undefined, "g"]);
    } finally {
      viewer.stop();
    }
  });

  test("a viewer-style polling reader in another process never makes a write fail", async () => {
    const dir = tempDir("blackboard-lock-");
    const dbPath = join(dir, "board.db");
    const stopFile = join(dir, "stop");
    const board = newBoard({}, dbPath);
    const reader = Bun.spawn([process.execPath, join(import.meta.dir, "reader.ts"), dbPath, stopFile], { stdout: "pipe" });
    let failures = 0;
    for (let i = 0; i < 600; i++) {
      try {
        board.claimFact({ text: `finding ${i}` });
      } catch {
        failures++;
      }
    }
    writeFileSync(stopFile, "1");
    const stats: { reads: number; errors: number } = JSON.parse(await new Response(reader.stdout).text());
    expect(failures).toBe(0);
    expect(stats.reads).toBeGreaterThan(0);
  }, 30_000);

  test("two processes racing for one intent: exactly one wins", async () => {
    const { board, reason_token } = started();
    const intent = board.createIntent({ description: "contested", from: ["origin"], reasonToken: reason_token });
    const script = join(import.meta.dir, "claimer.ts");
    const runs = ["w1", "w2", "w3", "w4"].map(worker =>
      Bun.spawn([process.execPath, script, board.path, intent.id, worker], { stdout: "pipe" }),
    );
    const outcomes = await Promise.all(runs.map(async p => (await new Response(p.stdout).text()).trim()));
    expect(outcomes.filter(o => o === "won")).toHaveLength(1);
    expect(outcomes.filter(o => o === "lost")).toHaveLength(3);
  }, 30_000);

  test("the board stays readable after every writer has closed", () => {
    const path = join(tempDir("blackboard-closed-"), "board.db");
    const writer = new Board(path);
    writer.init({ origin: "o", goal: "g" });
    writer.claimFact({ text: "survives shutdown" });
    writer.close();
    const snapshot = readSnapshot(path);
    if ("missing" in snapshot || "legacy" in snapshot) throw new Error("board vanished");
    expect(snapshot.facts.map(f => f.text)).toEqual(["survives shutdown"]);
    expect(snapshot.board.goal).toBe("g");
  });
});

describe("redaction", () => {
  // Credential-shaped inputs are assembled at runtime so no credential-like literal sits in the repo.
  const awsKeyId = `${"AKIA"}${"B".repeat(16)}`;
  const githubToken = `${"ghp"}_${"a".repeat(36)}`;
  const dashes = "-----";
  const pem = [`${dashes}BEGIN RSA PRIVATE KEY${dashes}`, "MIIabc", `${dashes}END RSA PRIVATE KEY${dashes}`].join("\n");

  test.each([
    ["password assignment", "password=hunter2secret", "password=[REDACTED]"],
    ["json password", '{"password": "hunter2secret"}', '{"password": "[REDACTED]"}'],
    ["bare token", "token=abcdef1234567890", "token=[REDACTED]"],
    ["aws secret access key", `AWS_SECRET_ACCESS_KEY=${"Ab1".repeat(14)}`, "AWS_SECRET_ACCESS_KEY=[REDACTED]"],
    ["client_secret", "client_secret: s3cr3tvalue99", "client_secret: [REDACTED]"],
    ["bearer header", `Authorization: Bearer ${"a".repeat(24)}`, "Authorization: Bearer [REDACTED]"],
    ["aws access key id", `key id ${awsKeyId} here`, "key id [REDACTED] here"],
    ["github token", `pushed with ${githubToken}`, "pushed with [REDACTED]"],
    ["pem block", `before\n${pem}\nafter`, "before\n[REDACTED PRIVATE KEY]\nafter"],
    ["two pem blocks", `${pem}\nmid\n${pem}`, "[REDACTED PRIVATE KEY]\nmid\n[REDACTED PRIVATE KEY]"],
  ])("masks: %s", (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  test("the board's own camelCase handle names are never treated as credentials", () => {
    expect(redactText("leaseToken: string):")).toBe("leaseToken: string):");
    expect(redactText("reasonToken = someLongValue")).toBe("reasonToken = someLongValue");
    expect(redactText("reasonToken = params.reason_token")).toBe("reasonToken = params.reason_token");
  });

  test("reason_token and lease_token are capability handles, never credentials", () => {
    expect(redactText('{"reason_token": "11111111-2222-3333-4444-555555555555"}')).toContain(
      "11111111-2222-3333-4444-555555555555",
    );
    expect(redactText('{"lease_token": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"}')).toContain(
      "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    );
  });

  test.each([
    ["bare token", "token=abcdef1234567890", "token=[REDACTED]"],
    ["auth_token", "auth_token=abcdef1234567890", "auth_token=[REDACTED]"],
    ["refresh_token", "refresh_token: s3cr3tvalue99", "refresh_token: [REDACTED]"],
  ])("still masks credential-shaped tokens: %s", (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  test.each([
    ["camelCase field", "accessToken: someLongValue", "accessToken: [REDACTED]"],
    ["PascalCase JSON key", '{"AccessToken": "abcdefghijklmnop"}', '{"AccessToken": "[REDACTED]"}'],
    ["id token JSON key", '{"IdToken": "abcdefghijklmnop"}', '{"IdToken": "[REDACTED]"}'],
  ])("masks camelCase credential keys: %s", (_name, input, expected) => {
    expect(redactText(input)).toBe(expected);
  });

  test.each([
    ["max_tokens is not a credential", "max_tokens=40960000"],
    ["short values are left alone", "password=short"],
    ["prose mentioning Bearer", "the Bearer scheme is documented"],
    ["PWD environment paths", "pwd=/home/user/project/dir"],
  ])("leaves ordinary text alone: %s", (_name, input) => {
    expect(redactText(input)).toBe(input);
  });

  // Each shape used to be quadratic: every '-' in a long run (or every unterminated PEM header) started a
  // scan to the end of the input. Sizes are where the old rules took several seconds (40 KB of dashes:
  // 3.5 s; 320 KB of headers: ~3 s); a timeout cannot interrupt a synchronous regex, so the bound is asserted.
  test.each([
    ["a line of dashes", "-".repeat(40_000)],
    ["dash-separated words", "a-".repeat(20_000)],
    ["unterminated private key headers", `${dashes}BEGIN RSA PRIVATE KEY${dashes}\n`.repeat(10_000)],
  ])("redacts pathological input in linear time: %s", (_name, input) => {
    const started = performance.now();
    expect(redactText(`${input} password=hunter2secret`)).toBe(`${input} password=[REDACTED]`);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe("viewer", () => {
  test("serves boards read-only on loopback, per project, without lease tokens", async () => {
    const base = join(tempDir(), "fact-board.db");
    const board = newBoard({}, base);
    board.init({ origin: "o", goal: "g" });
    const { reason_token } = board.reasonClaim("controller");
    const intent = board.createIntent({ description: "probe", from: ["origin"], reasonToken: reason_token });
    const { lease_token } = board.claimIntent(intent.id, "w1");
    newBoard({}, projectDbPath(base, "alpha")).claimFact({ text: "alpha finding" });

    const viewer = startViewer({ basePath: base, port: 0 });
    try {
      const body = await (await fetch(`${viewer.url}/api/board`)).text();
      expect(body).not.toContain(lease_token);
      const data = JSON.parse(body);
      expect(data.board.goal).toBe("g");
      expect(data.intents[0].from).toEqual(["origin"]);
      expect(data.graph.edges).toContainEqual({ from: "origin", to: intent.id });
      expect(data.graph.nodes.find((n: { id: string }) => n.id === intent.id).status).toBe("claimed");
      expect(data.truncated).toBe(false);
      expect(data.projects).toEqual([{ name: "alpha", status: "legacy" }]);
      const alpha = await (await fetch(`${viewer.url}/api/board?project=alpha`)).json();
      expect(alpha.facts.map((f: { text: string }) => f.text)).toEqual(["alpha finding"]);
      expect((await (await fetch(`${viewer.url}/api/board?project=../x`)).json()).note).toContain("invalid project name");
      expect((await fetch(`${viewer.url}/api/board`, { method: "POST" })).status).toBe(405);
      expect((await fetch(`${viewer.url}/api/board`, { headers: { host: "evil.example:80" } })).status).toBe(403);
    } finally {
      viewer.stop();
    }
  });

  test("flags the payload as partial only when rows beyond the snapshot limit exist", async () => {
    const base = join(tempDir(), "fact-board.db");
    const board = newBoard({}, base);
    board.init({ origin: "o", goal: "g" });
    for (let i = 0; i < 500; i++) {
      board.claimFact({ text: `finding ${i}` });
      board.writeHint(`hint ${i}`);
    }
    const viewer = startViewer({ basePath: base, port: 0 });
    try {
      const atLimit = await (await fetch(`${viewer.url}/api/board`)).json();
      expect([atLimit.facts.length, atLimit.truncated, atLimit.hintsTruncated]).toEqual([500, false, false]);
      // Hint overflow alone does not hide anything the graph draws.
      board.writeHint("hint 500");
      const hintsOnly = await (await fetch(`${viewer.url}/api/board`)).json();
      expect([hintsOnly.hints.length, hintsOnly.truncated, hintsOnly.hintsTruncated]).toEqual([500, false, true]);
      board.claimFact({ text: "finding 500" });
      const above = await (await fetch(`${viewer.url}/api/board`)).json();
      expect([above.facts.length, above.truncated, above.limit]).toEqual([500, true, 500]);
    } finally {
      viewer.stop();
    }
  });
});

describe("listBoards", () => {
  test("lists active boards before finished ones, most recent first, and skips what cannot be continued", () => {
    const base = join(tempDir("blackboard-list-"), "fact-board.db");
    let clock = 1_000;
    const at = (path: string) => newBoard({ now: () => clock }, path);

    // Default board: never created, so it must not appear.
    const older = at(projectDbPath(base, "older"));
    older.init({ origin: "o1", goal: "g1" });
    older.claimFact({ text: "old finding" });
    clock = 5_000;
    const newer = at(projectDbPath(base, "newer"));
    newer.init({ origin: "o2", goal: "g2" });
    newer.claimFact({ text: "new finding" });
    clock = 9_000;
    const finished = at(projectDbPath(base, "finished"));
    finished.init({ origin: "o3", goal: "g3" });
    const fact = finished.claimFact({ text: "proof" });
    finished.complete({ from: [fact.id], description: "done", worker: "w" });
    // A file that was opened but never initialized has no goal to continue.
    at(projectDbPath(base, "blank"));
    // A 0.1 file is reported, not summarized.
    const legacyPath = projectDbPath(base, "legacy");
    const legacy = new Database(legacyPath, { create: true });
    legacy.exec("CREATE TABLE facts (id TEXT PRIMARY KEY, text TEXT NOT NULL, status TEXT NOT NULL DEFAULT 'claimed', claimed_by TEXT, evidence TEXT, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL);");
    legacy.close();

    const listed = listBoards(base);
    expect(listed.map(b => [b.project, b.status])).toEqual([
      ["newer", "active"],
      ["older", "active"],
      ["finished", "completed"],
      ["legacy", "legacy"],
    ]);
    const [first] = listed;
    expect([first.origin, first.goal, first.facts, first.last_activity]).toEqual(["o2", "g2", 1, 5_000]);
  });

  test("includes an initialized default board with an empty project name", () => {
    const base = join(tempDir("blackboard-list-"), "fact-board.db");
    newBoard({}, base).init({ origin: "o", goal: "g" });
    expect(listBoards(base).map(b => b.project)).toEqual([""]);
  });
});
