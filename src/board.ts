/**
 * The blackboard: a fact–intent graph in one SQLite file shared by every session and subagent.
 *
 *   origin ──► Intent ──► Fact ──► Intent ──► Fact ──► … ──► goal
 *
 * - Fact    a confirmed finding. Produced by concluding an Intent (or claimed directly while bootstrapping).
 * - Intent  a declared step into the unknown. It must cite the facts it grows from (`from`), and concluding
 *           it yields exactly one fact (`to`). Edges are stored, so the path from origin to goal is auditable.
 * - Hint    human steering, delivered to workers when they claim an intent and in every export.
 *
 * Coordination rules (all enforced here, not left to prompts):
 * - Only the holder of the Reason lease may declare intents, at most `maxIntents` per pass.
 * - Claiming an intent grants a lease token. Heartbeat/conclude/release are compare-and-swap on that token, so a
 *   worker whose lease was reclaimed can never overwrite its successor. Stale leases expire and the intent reopens.
 *
 * Deterministic and model-free. Credential-shaped values are redacted before they are stored.
 */
import { Database } from "bun:sqlite";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { redactText } from "./redact";

/** A rule violation (not a bug). Tools report these as `{ error }`. */
export class BoardError extends Error {
  /** Machine-distinguishable rejection class (e.g. "lease_lost", "intent_claimed", "reason_held"). */
  readonly code?: string;
  /** Structured context (e.g. { held_by, lease_expires_at, status }). */
  readonly details?: Record<string, unknown>;

  constructor(message: string, options: { code?: string; details?: Record<string, unknown> } = {}) {
    super(message);
    this.name = "BoardError";
    this.code = options.code;
    this.details = options.details;
  }
}

export const ORIGIN = "origin";
export const GOAL = "goal";

export type FactStatus = "claimed" | "disputed";
export type IntentStatus = "open" | "claimed" | "concluded";
export type BoardStatus = "active" | "completed";

export interface FactRow {
  id: string;
  text: string;
  status: FactStatus;
  claimed_by: string;
  evidence: string | null;
  created_at: number;
}

/** A fact plus the intents that produced it (empty for facts claimed directly). */
export type FactView = FactRow & { produced_by: string[] };

interface IntentRow {
  id: string;
  description: string;
  status: IntentStatus;
  created_by: string | null;
  claimed_by: string | null;
  lease_token: string | null;
  heartbeat_at: number | null;
  to_fact_id: string | null;
  created_at: number;
  updated_at: number;
}

/** An intent as exposed to callers: never includes the lease token. */
export type IntentView = Omit<IntentRow, "lease_token"> & { from: string[]; lease_expires_at: number | null };

export interface HintRow {
  id: string;
  content: string;
  created_at: number;
}

export interface BoardInfo {
  initialized: boolean;
  status: BoardStatus;
  origin: string | null;
  goal: string | null;
  completed_intent: string | null;
  created_at: number | null;
  reason: { worker: string; heartbeat_at: number; created: number } | null;
}

export interface Snapshot {
  board: BoardInfo;
  facts: FactView[];
  intents: IntentView[];
  hints: HintRow[];
}

export interface ReasonLease {
  reason_token: string;
  worker: string;
  created: number;
  max_intents: number;
  lease_expires_at: number;
}

export interface ClaimedIntent {
  intent: IntentView;
  lease_token: string;
  lease_expires_at: number;
  /** The facts this intent grows from, so the worker starts with its context. */
  sources: FactRow[];
  hints: HintRow[];
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS facts (
  id TEXT PRIMARY KEY,
  text TEXT NOT NULL UNIQUE,
  status TEXT NOT NULL DEFAULT 'claimed',
  claimed_by TEXT NOT NULL,
  evidence TEXT,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS intents (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_by TEXT,
  claimed_by TEXT,
  lease_token TEXT,
  heartbeat_at INTEGER,
  to_fact_id TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS intent_sources (
  intent_id TEXT NOT NULL,
  fact_id TEXT NOT NULL,
  PRIMARY KEY (intent_id, fact_id)
);
CREATE TABLE IF NOT EXISTS hints (
  id TEXT PRIMARY KEY,
  content TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS meta (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);
`;

/** Columns added after 0.1; older boards are upgraded in place. */
const INTENT_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ["created_by", "TEXT"],
  ["lease_token", "TEXT"],
  ["heartbeat_at", "INTEGER"],
  ["to_fact_id", "TEXT"],
];

const PROJECT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;

function defaultDbPath(): string {
  const override = process.env.FACT_BOARD_DB;
  if (override) return override;
  const agentDir = process.env.PI_CODING_AGENT_DIR ?? join(homedir(), ".omp", "agent");
  return join(agentDir, "fact-board.db");
}

/** The board file for a project. No project means the default board; each project has its own file. */
export function projectDbPath(basePath: string, project?: string): string {
  if (!project) return basePath;
  if (!PROJECT_NAME.test(project)) {
    throw new BoardError(`invalid project name "${project}": use letters, digits, '.', '_' or '-' (max 64)`);
  }
  return join(dirname(basePath), "fact-boards", `${project}.db`);
}

export function resolveDbPath(project?: string): string {
  return projectDbPath(defaultDbPath(), project);
}

export function listProjects(basePath: string): string[] {
  const dir = join(dirname(basePath), "fact-boards");
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter(file => file.endsWith(".db"))
    .map(file => file.slice(0, -3))
    .filter(name => PROJECT_NAME.test(name))
    .sort();
}

function factIdOf(text: string): string {
  return `f_${createHash("sha1").update(text).digest("hex")}`;
}

/** Parses a `from` list as sent by a tool: comma-separated ids, or a JSON array string. Fact ids never contain commas. */
export function parseIdList(raw: string): string[] {
  const text = raw.trim();
  if (text.startsWith("[")) {
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed)) return parsed.map(item => String(item)).filter(s => s.length > 0);
    } catch {
      // not JSON; fall through to comma split
    }
  }
  return text
    .split(",")
    .map(item => item.trim().replace(/^["']|["']$/g, ""))
    .filter(s => s.length > 0);
}

function envNumber(name: string, fallback: number): number {
  const value = Number(process.env[name]);
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

export interface BoardOptions {
  /** How long a claimed intent / the Reason lease may go without a heartbeat before it can be reclaimed. */
  leaseMs?: number;
  /** Cap on intents one Reason pass may declare. */
  maxIntentsPerReason?: number;
  now?: () => number;
}

export class Board {
  readonly path: string;
  private readonly db: Database;
  private readonly leaseMs: number;
  private readonly maxIntents: number;
  private readonly now: () => number;

  constructor(path: string, options: BoardOptions = {}) {
    this.path = path;
    this.leaseMs = options.leaseMs ?? envNumber("FACT_BOARD_LEASE_SECONDS", 900) * 1000;
    this.maxIntents = options.maxIntentsPerReason ?? envNumber("FACT_BOARD_MAX_INTENTS", 2);
    this.now = options.now ?? Date.now;
    mkdirSync(dirname(path), { recursive: true });
    this.db = new Database(path, { create: true });
    // busy_timeout first so the journal-mode switch itself waits instead of failing.
    // WAL lets the read-only viewer and any number of writers proceed without "database is locked".
    this.db.exec("PRAGMA busy_timeout = 5000; PRAGMA journal_mode = WAL;");
    this.db.exec(SCHEMA);
    this.migrate();
  }

  private migrate(): void {
    const existing = new Set(this.db.query<{ name: string }, []>("PRAGMA table_info(intents)").all().map(c => c.name));
    for (const [name, type] of INTENT_COLUMNS) {
      if (existing.has(name)) continue;
      try {
        this.db.exec(`ALTER TABLE intents ADD COLUMN ${name} ${type}`);
      } catch (err) {
        // Another process migrated first.
        if (!(err instanceof Error) || !/duplicate column/i.test(err.message)) throw err;
      }
    }
  }

  /** Runs fn in a write transaction that takes the lock up front, so racing workers serialize instead of deadlocking. */
  private write<T>(fn: () => T): T {
    return this.db.transaction(fn).immediate();
  }

  // ── board state ────────────────────────────────────────────────────────────

  private getMeta(key: string): string | null {
    return this.db.query<{ value: string }, [string]>("SELECT value FROM meta WHERE key = ?").get(key)?.value ?? null;
  }

  private setMeta(key: string, value: string): void {
    this.db
      .query("INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, value);
  }

  private clearReason(): void {
    this.db.exec("DELETE FROM meta WHERE key IN ('reason_worker','reason_token','reason_created','reason_heartbeat_at')");
  }

  info(): BoardInfo {
    return infoFrom(this.db);
  }

  private assertActive(): void {
    if (this.getMeta("status") === "completed") {
      throw new BoardError("board is completed; call board_reopen with the reason it is not actually done");
    }
  }

  private requireInit(): void {
    if (!this.getMeta("origin") || !this.getMeta("goal")) {
      throw new BoardError("board is not initialized: call board_init({ origin, goal }) first");
    }
  }

  /** Declares the origin (what is known) and goal (the success condition). Idempotent for identical values. */
  init(input: { origin: string; goal: string }): BoardInfo {
    const origin = redactText(input.origin);
    const goal = redactText(input.goal);
    return this.write(() => {
      const current = this.info();
      if (current.initialized) {
        if (current.origin === origin && current.goal === goal) return current;
        throw new BoardError("board is already initialized with a different origin/goal; use another project");
      }
      this.setMeta("origin", origin);
      this.setMeta("goal", goal);
      this.setMeta("status", "active");
      this.setMeta("created_at", String(this.now()));
      return this.info();
    });
  }

  /** Reopens intents whose lease went stale and drops a stale Reason lease. */
  private expireStale(): void {
    const cutoff = this.now() - this.leaseMs;
    this.db
      .query(
        `UPDATE intents SET status = 'open', claimed_by = NULL, lease_token = NULL, heartbeat_at = NULL, updated_at = ?
         WHERE status = 'claimed' AND (heartbeat_at IS NULL OR heartbeat_at < ?)`,
      )
      .run(this.now(), cutoff);
    if (this.getMeta("reason_token") && !(Number(this.getMeta("reason_heartbeat_at")) >= cutoff)) this.clearReason();
  }

  // ── facts ──────────────────────────────────────────────────────────────────

  /** Claims a finding directly (bootstrapping). Explorers should conclude an intent instead, which records provenance. */
  claimFact(input: { text: string; claimedBy?: string; evidence?: string }): FactRow {
    this.assertActive();
    const text = redactText(input.text);
    // The id is derived from the stored text, so identical findings dedupe to one row.
    const id = factIdOf(text);
    this.db
      .query(
        `INSERT OR IGNORE INTO facts (id, text, status, claimed_by, evidence, created_at)
         VALUES (?, ?, 'claimed', ?, ?, ?)`,
      )
      .run(id, text, input.claimedBy ?? "unknown", input.evidence ? redactText(input.evidence) : null, this.now());
    return this.requireFact(id);
  }

  getFact(id: string): FactRow | null {
    return this.db.query<FactRow, [string]>("SELECT * FROM facts WHERE id = ?").get(id);
  }

  private requireFact(id: string): FactRow {
    const row = this.getFact(id);
    if (!row) throw new BoardError(`fact not found: ${id}`);
    return row;
  }

  queryFacts(filter: { q?: string; status?: string; limit?: number; offset?: number } = {}): FactRow[] {
    const like = filter.q ? `%${filter.q.replace(/[\\%_]/g, "\\$&")}%` : null;
    const limit = Math.min(Math.max(filter.limit ?? 50, 1), 500);
    return this.db
      .query<FactRow, [string | null, string | null, string | null, string | null, number, number]>(
        `SELECT * FROM facts
         WHERE (? IS NULL OR text LIKE ? ESCAPE '\\')
           AND (? IS NULL OR status = ?)
         ORDER BY created_at DESC LIMIT ? OFFSET ?`,
      )
      .all(like, like, filter.status ?? null, filter.status ?? null, limit, Math.max(filter.offset ?? 0, 0));
  }

  /** Marks a fact disputed and appends the reason to its evidence. Never deletes. */
  disputeFact(id: string, reason?: string): FactRow {
    this.requireFact(id);
    const suffix = reason ? ` [disputed: ${redactText(reason)}]` : "";
    this.db
      .query("UPDATE facts SET status = 'disputed', evidence = COALESCE(evidence, '') || ? WHERE id = ?")
      .run(suffix, id);
    return this.requireFact(id);
  }

  // ── Reason lease (who may declare intents) ─────────────────────────────────

  private reasonLease(): ReasonLease {
    return {
      reason_token: this.getMeta("reason_token") ?? "",
      worker: this.getMeta("reason_worker") ?? "",
      created: Number(this.getMeta("reason_created") ?? 0),
      max_intents: this.maxIntents,
      lease_expires_at: Number(this.getMeta("reason_heartbeat_at") ?? 0) + this.leaseMs,
    };
  }

  /** Only one worker holds the Reason lease at a time; it alone may declare intents (capped per pass). */
  reasonClaim(worker: string): ReasonLease {
    return this.write(() => {
      this.expireStale();
      this.assertActive();
      this.requireInit();
      const holder = this.getMeta("reason_worker");
      if (holder && holder !== worker) {
        throw new BoardError(`the Reason lease is held by ${holder}; wait for it to be released or to expire`, {
          code: "reason_held",
          details: { held_by: holder },
        });
      }
      if (!holder) {
        this.setMeta("reason_worker", worker);
        this.setMeta("reason_token", crypto.randomUUID());
        this.setMeta("reason_created", "0");
      }
      this.setMeta("reason_heartbeat_at", String(this.now()));
      return this.reasonLease();
    });
  }

  reasonRelease(reasonToken: string): { released: true } {
    return this.write(() => {
      this.expireStale();
      if (!reasonToken || this.getMeta("reason_token") !== reasonToken) {
        throw new BoardError("the Reason lease is not held with that token (it may have expired)");
      }
      this.clearReason();
      return { released: true };
    });
  }

  // ── intents ────────────────────────────────────────────────────────────────

  private getIntent(id: string): IntentRow | null {
    return this.db.query<IntentRow, [string]>("SELECT * FROM intents WHERE id = ?").get(id);
  }

  private requireIntent(id: string): IntentRow {
    const row = this.getIntent(id);
    if (!row) throw new BoardError(`intent not found: ${id}`);
    return row;
  }

  private sourcesOf(intentId: string): string[] {
    return this.db
      .query<{ fact_id: string }, [string]>("SELECT fact_id FROM intent_sources WHERE intent_id = ? ORDER BY rowid")
      .all(intentId)
      .map(r => r.fact_id);
  }

  private view(row: IntentRow): IntentView {
    const { lease_token: _token, ...rest } = row;
    return { ...rest, from: this.sourcesOf(row.id), lease_expires_at: this.expiresAt(row) };
  }

  private expiresAt(row: IntentRow): number | null {
    return row.status === "claimed" && row.heartbeat_at ? row.heartbeat_at + this.leaseMs : null;
  }

  /** The cited sources must exist and be undisputed; "origin" is always valid, "goal" never is. */
  private validateSources(from: readonly string[]): string[] {
    const ids = [...new Set(from)];
    if (ids.length === 0) {
      throw new BoardError(`"from" needs at least one source fact id (use "${ORIGIN}" for the starting point)`);
    }
    if (ids.includes(GOAL)) throw new BoardError(`"${GOAL}" cannot be used as a source`);
    for (const id of ids) {
      if (id === ORIGIN) continue;
      const fact = this.getFact(id);
      if (!fact) throw new BoardError(`unknown source fact: ${id}`);
      if (fact.status === "disputed") throw new BoardError(`source fact ${id} is disputed; cite a standing fact`);
    }
    return ids;
  }

  private insertSources(intentId: string, ids: readonly string[]): void {
    const insert = this.db.query("INSERT INTO intent_sources (intent_id, fact_id) VALUES (?, ?)");
    for (const factId of ids) insert.run(intentId, factId);
  }

  /** Declares a step into the unknown, growing from existing facts. Requires the Reason lease; capped per pass. */
  createIntent(input: { description: string; from: readonly string[]; reasonToken: string }): IntentView {
    return this.write(() => {
      this.expireStale();
      this.assertActive();
      this.requireInit();
      const token = this.getMeta("reason_token");
      if (!token || token !== input.reasonToken) {
        throw new BoardError(
          "declaring intents needs the Reason lease: call reason_claim and pass its reason_token (it may have expired)",
        );
      }
      const created = Number(this.getMeta("reason_created") ?? 0);
      if (created >= this.maxIntents) {
        throw new BoardError(
          `this Reason pass already declared ${created} intents (cap ${this.maxIntents}); release it with reason_release`,
        );
      }
      const sources = this.validateSources(input.from);
      const id = crypto.randomUUID();
      const now = this.now();
      this.db
        .query(
          `INSERT INTO intents (id, description, status, created_by, claimed_by, lease_token, heartbeat_at, to_fact_id, created_at, updated_at)
           VALUES (?, ?, 'open', ?, NULL, NULL, NULL, NULL, ?, ?)`,
        )
        .run(id, redactText(input.description), this.getMeta("reason_worker"), now, now);
      this.insertSources(id, sources);
      this.setMeta("reason_created", String(created + 1));
      this.setMeta("reason_heartbeat_at", String(now));
      return this.view(this.requireIntent(id));
    });
  }

  private sourceFacts(ids: readonly string[]): FactRow[] {
    const info = this.info();
    return ids.flatMap(id => {
      if (id === ORIGIN) {
        return [{ id: ORIGIN, text: info.origin ?? "", status: "claimed" as const, claimed_by: "board", evidence: null, created_at: info.created_at ?? 0 }];
      }
      const fact = this.getFact(id);
      return fact ? [fact] : [];
    });
  }

  private claimResult(row: IntentRow): ClaimedIntent {
    return {
      intent: this.view(row),
      lease_token: row.lease_token ?? "",
      lease_expires_at: (row.heartbeat_at ?? 0) + this.leaseMs,
      sources: this.sourceFacts(this.sourcesOf(row.id)),
      hints: this.queryHints(10),
    };
  }

  /** open -> claimed. Returns a lease token that heartbeat/conclude/release must present. */
  claimIntent(id: string, worker: string): ClaimedIntent {
    return this.write(() => {
      this.expireStale();
      this.assertActive();
      const row = this.requireIntent(id);
      if (row.status === "claimed") {
        if (row.claimed_by !== worker) {
          throw new BoardError(`intent ${id} is already claimed by ${row.claimed_by}`, {
            code: "intent_claimed",
            details: { held_by: row.claimed_by, lease_expires_at: this.expiresAt(row) },
          });
        }
        // The owner asking again is a heartbeat, and gets its token back.
        this.db.query("UPDATE intents SET heartbeat_at = ? WHERE id = ?").run(this.now(), id);
        return this.claimResult(this.requireIntent(id));
      }
      if (row.status !== "open") {
        throw new BoardError(`invalid transition ${row.status} -> claimed: intent ${id} is ${row.status}`, {
          code: "invalid_transition",
          details: { status: row.status },
        });
      }
      const now = this.now();
      // Compare-and-swap on status: correct even without the surrounding transaction, and the loser of a race
      // never receives the winner's lease token.
      const { changes } = this.db
        .query(
          `UPDATE intents SET status = 'claimed', claimed_by = ?, lease_token = ?, heartbeat_at = ?, updated_at = ?
           WHERE id = ? AND status = 'open'`,
        )
        .run(worker, crypto.randomUUID(), now, now, id);
      if (changes === 0) {
        const holder = this.getIntent(id)?.claimed_by;
        throw new BoardError(`intent ${id} was claimed concurrently${holder ? ` by ${holder}` : ""}`);
      }
      return this.claimResult(this.requireIntent(id));
    });
  }

  private leaseError(id: string): BoardError {
    const row = this.getIntent(id);
    if (!row) return new BoardError(`intent not found: ${id}`, { code: "not_found" });
    const holder = row.claimed_by ? `, held by ${row.claimed_by}` : "";
    return new BoardError(
      `lease for intent ${id} is no longer valid (intent is ${row.status}${holder}); claim it again before continuing`,
      {
        code: "lease_lost",
        details: { status: row.status, held_by: row.claimed_by ?? null, lease_expires_at: this.expiresAt(row) },
      },
    );
  }

  /** Extends the lease. Fails if the lease was lost to another worker or the intent is no longer claimed. */
  heartbeatIntent(id: string, leaseToken: string): { intent: IntentView; lease_expires_at: number } {
    return this.write(() => {
      const now = this.now();
      const { changes } = this.db
        .query("UPDATE intents SET heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'claimed' AND lease_token = ?")
        .run(now, now, id, leaseToken);
      if (changes === 0) throw this.leaseError(id);
      return { intent: this.view(this.requireIntent(id)), lease_expires_at: now + this.leaseMs };
    });
  }

  /**
   * claimed -> concluded, producing exactly one fact linked to the intent. Atomic, and compare-and-swap on the
   * lease token: if the lease was reclaimed the fact is not created and the caller gets an error.
   * An expired lease that nobody reclaimed still concludes — work is only refused when actually superseded.
   */
  concludeIntent(input: { id: string; leaseToken: string; fact: string; evidence?: string }): { fact: FactRow; intent: IntentView } {
    return this.write(() => {
      this.assertActive();
      const row = this.requireIntent(input.id);
      const text = redactText(input.fact);
      const factId = factIdOf(text);
      this.db
        .query(
          `INSERT OR IGNORE INTO facts (id, text, status, claimed_by, evidence, created_at)
           VALUES (?, ?, 'claimed', ?, ?, ?)`,
        )
        .run(factId, text, row.claimed_by ?? "unknown", input.evidence ? redactText(input.evidence) : null, this.now());
      const { changes } = this.db
        .query(
          `UPDATE intents SET status = 'concluded', to_fact_id = ?, lease_token = NULL, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND lease_token = ?`,
        )
        .run(factId, this.now(), input.id, input.leaseToken);
      // Throwing rolls the whole transaction back, including the fact insert above.
      if (changes === 0) throw this.leaseError(input.id);
      return { fact: this.requireFact(factId), intent: this.view(this.requireIntent(input.id)) };
    });
  }

  /** claimed -> open, clearing the owner, so another worker can retry. */
  releaseIntent(id: string, leaseToken: string): IntentView {
    return this.write(() => {
      const { changes } = this.db
        .query(
          `UPDATE intents SET status = 'open', claimed_by = NULL, lease_token = NULL, heartbeat_at = NULL, updated_at = ?
           WHERE id = ? AND status = 'claimed' AND lease_token = ?`,
        )
        .run(this.now(), id, leaseToken);
      if (changes === 0) throw this.leaseError(id);
      return this.view(this.requireIntent(id));
    });
  }

  // ── completion ─────────────────────────────────────────────────────────────

  /** Reaches the goal: a completion intent grows from the supporting facts and produces "goal". */
  complete(input: { from: readonly string[]; description: string; worker: string }): IntentView {
    return this.write(() => {
      this.expireStale();
      this.assertActive();
      this.requireInit();
      const sources = this.validateSources(input.from);
      const id = crypto.randomUUID();
      const now = this.now();
      this.db
        .query(
          `INSERT INTO intents (id, description, status, created_by, claimed_by, lease_token, heartbeat_at, to_fact_id, created_at, updated_at)
           VALUES (?, ?, 'concluded', ?, ?, NULL, NULL, ?, ?, ?)`,
        )
        .run(id, redactText(input.description), input.worker, input.worker, GOAL, now, now);
      this.insertSources(id, sources);
      this.setMeta("status", "completed");
      this.setMeta("completed_intent", id);
      this.clearReason();
      return this.view(this.requireIntent(id));
    });
  }

  /** Undoes a completion: the completion intent now produces a fact recording why the board was not done. */
  reopen(reason: string): { fact: FactRow; intent: IntentView } {
    return this.write(() => {
      const completed = this.getMeta("completed_intent");
      if (this.getMeta("status") !== "completed" || !completed) throw new BoardError("board is not completed");
      const text = redactText(reason);
      const factId = factIdOf(text);
      this.db
        .query(
          `INSERT OR IGNORE INTO facts (id, text, status, claimed_by, evidence, created_at)
           VALUES (?, ?, 'claimed', 'reopen', NULL, ?)`,
        )
        .run(factId, text, this.now());
      this.db.query("UPDATE intents SET to_fact_id = ?, updated_at = ? WHERE id = ?").run(factId, this.now(), completed);
      this.setMeta("status", "active");
      this.db.exec("DELETE FROM meta WHERE key = 'completed_intent'");
      return { fact: this.requireFact(factId), intent: this.view(this.requireIntent(completed)) };
    });
  }

  // ── hints ──────────────────────────────────────────────────────────────────

  writeHint(content: string): HintRow {
    const id = crypto.randomUUID();
    this.db
      .query("INSERT INTO hints (id, content, created_at) VALUES (?, ?, ?)")
      .run(id, redactText(content), this.now());
    const row = this.db.query<HintRow, [string]>("SELECT * FROM hints WHERE id = ?").get(id);
    if (!row) throw new BoardError(`hint ${id} missing after insert`);
    return row;
  }

  queryHints(limit = 20): HintRow[] {
    return this.db.query<HintRow, [number]>("SELECT * FROM hints ORDER BY created_at DESC LIMIT ?").all(limit);
  }

  // ── whole-graph reads ──────────────────────────────────────────────────────

  /** The full graph, for the Reason pass. `json` is structured; `timeline` reads like a log. Never includes lease tokens. */
  export(format: string = "json"): string {
    if (format !== "json" && format !== "timeline") {
      throw new BoardError(`unsupported export format "${format}": use "json" or "timeline"`);
    }
    this.write(() => this.expireStale());
    const snapshot = snapshotFrom(this.db, 1_000_000, this.leaseMs);
    return format === "timeline" ? timelineOf(snapshot) : JSON.stringify(chronological(snapshot), null, 2);
  }

  close(): void {
    this.db.close();
  }
}

// ── snapshots (used by export and by the read-only viewer) ───────────────────

function infoFrom(db: Database): BoardInfo {
  const meta = new Map(db.query<{ key: string; value: string }, []>("SELECT key, value FROM meta").all().map(r => [r.key, r.value]));
  const reasonWorker = meta.get("reason_worker");
  return {
    initialized: meta.has("origin") && meta.has("goal"),
    status: meta.get("status") === "completed" ? "completed" : "active",
    origin: meta.get("origin") ?? null,
    goal: meta.get("goal") ?? null,
    completed_intent: meta.get("completed_intent") ?? null,
    created_at: meta.has("created_at") ? Number(meta.get("created_at")) : null,
    reason: reasonWorker
      ? { worker: reasonWorker, heartbeat_at: Number(meta.get("reason_heartbeat_at") ?? 0), created: Number(meta.get("reason_created") ?? 0) }
      : null,
  };
}

/** Newest first. Lease tokens are not selected, so they cannot leak through any read path. */
export function snapshotFrom(db: Database, limit: number, leaseMs = envNumber("FACT_BOARD_LEASE_SECONDS", 900) * 1000): Snapshot {
  const sources = new Map<string, string[]>();
  for (const r of db.query<{ intent_id: string; fact_id: string }, []>("SELECT intent_id, fact_id FROM intent_sources ORDER BY rowid").all()) {
    sources.set(r.intent_id, [...(sources.get(r.intent_id) ?? []), r.fact_id]);
  }
  const intents = db
    .query<Omit<IntentRow, "lease_token">, [number]>(
      `SELECT id, description, status, created_by, claimed_by, heartbeat_at, to_fact_id, created_at, updated_at
       FROM intents ORDER BY created_at DESC LIMIT ?`,
    )
    .all(limit)
    .map(row => ({ ...row, from: sources.get(row.id) ?? [], lease_expires_at: row.status === "claimed" && row.heartbeat_at ? row.heartbeat_at + leaseMs : null }));
  const producers = new Map<string, string[]>();
  for (const intent of intents) {
    if (intent.to_fact_id) producers.set(intent.to_fact_id, [...(producers.get(intent.to_fact_id) ?? []), intent.id]);
  }
  const facts = db
    .query<FactRow, [number]>("SELECT * FROM facts ORDER BY created_at DESC LIMIT ?")
    .all(limit)
    .map(row => ({ ...row, produced_by: producers.get(row.id) ?? [] }));
  const hints = db.query<HintRow, [number]>("SELECT * FROM hints ORDER BY created_at DESC LIMIT ?").all(limit);
  return { board: infoFrom(db), facts, intents, hints };
}

/** Read-only snapshot straight from the file; never writes, so it is safe while omp is running or closed. */
export function readSnapshot(dbPath: string, limit = 500): Snapshot | { missing: true } {
  if (!existsSync(dbPath)) return { missing: true };
  const db = new Database(dbPath, { readonly: true });
  try {
    db.exec("PRAGMA busy_timeout = 2000");
    return snapshotFrom(db, limit, envNumber("FACT_BOARD_LEASE_SECONDS", 900) * 1000);
  } finally {
    db.close();
  }
}

function chronological(snapshot: Snapshot): Snapshot {
  return {
    board: snapshot.board,
    facts: [...snapshot.facts].reverse(),
    intents: [...snapshot.intents].reverse(),
    hints: [...snapshot.hints].reverse(),
  };
}

function timelineOf(snapshot: Snapshot): string {
  const { board } = snapshot;
  const factText = new Map(snapshot.facts.map(f => [f.id, f.text]));
  const events: Array<{ at: number; text: string }> = [];
  if (board.created_at !== null) {
    events.push({ at: board.created_at, text: `BOARD INITIALIZED\n  origin: ${board.origin}\n  goal: ${board.goal}` });
  }
  for (const fact of snapshot.facts) {
    if (fact.produced_by.length === 0) events.push({ at: fact.created_at, text: `FACT CLAIMED ${fact.id} by ${fact.claimed_by}\n  ${fact.text}` });
  }
  for (const hint of snapshot.hints) events.push({ at: hint.created_at, text: `HINT\n  ${hint.content}` });
  for (const intent of snapshot.intents) {
    const from = intent.from.join(", ");
    events.push({ at: intent.created_at, text: `INTENT DECLARED ${intent.id} by ${intent.created_by}\n  from: ${from}\n  ${intent.description}` });
    if (intent.status !== "concluded") continue;
    const text =
      intent.to_fact_id === GOAL
        ? `BOARD COMPLETED by ${intent.claimed_by}\n  via: ${intent.id} from ${from}`
        : `INTENT CONCLUDED ${intent.id} by ${intent.claimed_by}\n  produced: ${intent.to_fact_id}\n  ${factText.get(intent.to_fact_id ?? "") ?? ""}`;
    events.push({ at: intent.updated_at, text });
  }
  events.sort((a, b) => a.at - b.at);
  return events.map(e => `[${new Date(e.at).toISOString()}] ${e.text}`).join("\n\n");
}
