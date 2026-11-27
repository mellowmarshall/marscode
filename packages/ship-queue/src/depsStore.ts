// @effect-diagnostics nodeBuiltinImport:off - Durable SQLite store for dependency holds, audit log, idempotent decisions, and HMAC clearances.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import {
  DEP_REPO_NAME_RE,
  parseLegacyStateFile,
  type DepClearanceRecord,
  type DepRepoState,
  type RecordedReportDecision,
} from "./depsTypes.ts";

/** Detects SQLite primary-key / unique constraint violations across Node sqlite error shapes. */
export function isSqliteUniqueConstraintError(err: unknown): boolean {
  if (!err || typeof err !== "object") return false;
  const rec = err as {
    readonly code?: unknown;
    readonly errstr?: unknown;
    readonly message?: unknown;
  };
  const code = typeof rec.code === "string" ? rec.code : "";
  const errstr = typeof rec.errstr === "string" ? rec.errstr : "";
  const msg = typeof rec.message === "string" ? rec.message : "";
  return (
    code === "ERR_SQLITE_ERROR" &&
    (errstr.includes("CONSTRAINT") ||
      msg.includes("UNIQUE constraint") ||
      msg.includes("PRIMARY KEY"))
  );
}

/** Durable SQLite store for ship-queue dependency holds, audit log, and idempotent report decisions. */
export class SqliteDepsStore {
  readonly dbPath: string;
  private readonly queueRoot: string;
  private readonly db: NodeSqlite.DatabaseSync;

  constructor(queueRoot: string, dbPath?: string) {
    this.queueRoot = queueRoot;
    this.dbPath = dbPath ?? NodePath.join(queueRoot, "dependencies", "deps.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(this.dbPath), { recursive: true, mode: 0o700 });
    this.db = new NodeSqlite.DatabaseSync(this.dbPath);
    this.db.exec(`
      PRAGMA journal_mode = WAL;
      PRAGMA busy_timeout = 5000;
      PRAGMA synchronous = NORMAL;
      CREATE TABLE IF NOT EXISTS dep_repos (
        repo TEXT PRIMARY KEY,
        state_json TEXT NOT NULL,
        updated_at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dep_decisions (
        report_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        decision TEXT NOT NULL,
        attempt_id TEXT,
        decided_at REAL NOT NULL,
        actor TEXT NOT NULL,
        reason TEXT NOT NULL,
        message TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dep_audit (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        repo TEXT NOT NULL,
        action TEXT NOT NULL,
        target_id TEXT NOT NULL,
        reason TEXT NOT NULL,
        actor TEXT NOT NULL,
        at REAL NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dep_clearances (
        job_id TEXT PRIMARY KEY,
        repo TEXT NOT NULL,
        body_json TEXT NOT NULL,
        mac TEXT NOT NULL
      );
    `);
  }

  close(): void {
    this.db.close();
  }

  /** Runs `fn` inside a single SQLite `BEGIN IMMEDIATE` write transaction, rolling back on error. */
  runInImmediateTransaction<T>(fn: () => T): T {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const result = fn();
      this.db.exec("COMMIT");
      return result;
    } catch (err) {
      this.db.exec("ROLLBACK");
      throw err;
    }
  }

  /** Imports any legacy `dependencies/<repo>/state.json` files not yet present in SQLite. */
  importLegacyJsonIfNeeded(nowEpochSec: number): void {
    const depsDir = NodePath.join(this.queueRoot, "dependencies");
    if (!NodeFS.existsSync(depsDir)) return;
    let entries: ReadonlyArray<NodeFS.Dirent>;
    try {
      entries = NodeFS.readdirSync(depsDir, { withFileTypes: true });
    } catch {
      return;
    }
    const checkStmt = this.db.prepare("SELECT 1 FROM dep_repos WHERE repo = ?");
    for (const entry of entries) {
      if (!entry.isDirectory() || !DEP_REPO_NAME_RE.test(entry.name)) continue;
      if (checkStmt.get(entry.name)) continue;
      const statePath = NodePath.join(depsDir, entry.name, "state.json");
      if (!NodeFS.existsSync(statePath)) continue;
      const parsed = parseLegacyStateFile(entry.name, statePath);
      if (parsed) this.saveRepoState(parsed, nowEpochSec);
    }
  }

  getRepoState(repo: string): DepRepoState | null {
    const row = this.db.prepare("SELECT state_json FROM dep_repos WHERE repo = ?").get(repo) as
      | { readonly state_json?: string }
      | undefined;
    if (row?.state_json) {
      return JSON.parse(row.state_json) as DepRepoState;
    }
    const legacyPath = NodePath.join(this.queueRoot, "dependencies", repo, "state.json");
    if (NodeFS.existsSync(legacyPath)) {
      return parseLegacyStateFile(repo, legacyPath);
    }
    return null;
  }

  saveRepoState(state: DepRepoState, nowEpochSec: number): void {
    this.db
      .prepare(
        `INSERT INTO dep_repos (repo, state_json, updated_at)
         VALUES (?, ?, ?)
         ON CONFLICT(repo) DO UPDATE SET state_json = excluded.state_json, updated_at = excluded.updated_at`,
      )
      .run(state.repo, JSON.stringify(state), nowEpochSec);
  }

  listRepoStates(nowEpochSec: number): ReadonlyArray<DepRepoState> {
    this.importLegacyJsonIfNeeded(nowEpochSec);
    const rows = this.db
      .prepare("SELECT state_json FROM dep_repos ORDER BY repo ASC LIMIT 64")
      .all() as unknown as ReadonlyArray<{ readonly state_json: string }>;
    return rows.map((r) => JSON.parse(r.state_json) as DepRepoState);
  }

  getDecisionByReportId(reportId: string): RecordedReportDecision | null {
    const row = this.db
      .prepare(
        `SELECT report_id, repo, decision, attempt_id, decided_at, actor, reason, message
         FROM dep_decisions WHERE report_id = ?`,
      )
      .get(reportId) as
      | {
          readonly report_id: string;
          readonly repo: string;
          readonly decision: "approve" | "reject";
          readonly attempt_id: string | null;
          readonly decided_at: number;
          readonly actor: string;
          readonly reason: string;
          readonly message: string;
        }
      | undefined;
    if (!row) return null;
    return {
      reportId: row.report_id,
      repo: row.repo,
      decision: row.decision,
      attemptId: row.attempt_id,
      decidedAt: row.decided_at,
      actor: row.actor,
      reason: row.reason,
      message: row.message,
    };
  }

  /** Inserts an idempotent report decision row (call inside `runInImmediateTransaction`). */
  insertDecisionRow(decision: RecordedReportDecision): void {
    this.db
      .prepare(
        `INSERT INTO dep_decisions (report_id, repo, decision, attempt_id, decided_at, actor, reason, message)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        decision.reportId,
        decision.repo,
        decision.decision,
        decision.attemptId,
        decision.decidedAt,
        decision.actor,
        decision.reason,
        decision.message,
      );
  }

  appendAudit(input: {
    readonly repo: string;
    readonly action: string;
    readonly targetId: string;
    readonly reason: string;
    readonly actor: string;
    readonly nowEpochSec: number;
  }): void {
    this.db
      .prepare(
        `INSERT INTO dep_audit (repo, action, target_id, reason, actor, at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      )
      .run(input.repo, input.action, input.targetId, input.reason, input.actor, input.nowEpochSec);
  }

  listAudit(repo: string): ReadonlyArray<{
    readonly action: string;
    readonly targetId: string;
    readonly reason: string;
    readonly actor: string;
    readonly at: number;
  }> {
    return this.db
      .prepare(
        "SELECT action, target_id AS targetId, reason, actor, at FROM dep_audit WHERE repo = ? ORDER BY id ASC",
      )
      .all(repo) as unknown as ReadonlyArray<{
      readonly action: string;
      readonly targetId: string;
      readonly reason: string;
      readonly actor: string;
      readonly at: number;
    }>;
  }

  private clearanceKey(): Buffer {
    const keyPath = NodePath.join(this.queueRoot, "dependencies", "clearance.key");
    if (!NodeFS.existsSync(keyPath)) {
      NodeFS.mkdirSync(NodePath.dirname(keyPath), { recursive: true, mode: 0o700 });
      NodeFS.writeFileSync(keyPath, NodeCrypto.randomBytes(32), { mode: 0o600 });
    }
    return NodeFS.readFileSync(keyPath);
  }

  saveClearance(record: DepClearanceRecord): void {
    const bodyJson = JSON.stringify(record);
    const mac = NodeCrypto.createHmac("sha256", this.clearanceKey()).update(bodyJson).digest("hex");
    this.db
      .prepare(
        `INSERT INTO dep_clearances (job_id, repo, body_json, mac)
         VALUES (?, ?, ?, ?)
         ON CONFLICT(job_id) DO UPDATE SET repo = excluded.repo, body_json = excluded.body_json, mac = excluded.mac`,
      )
      .run(record.jobId, record.repo, bodyJson, mac);
  }

  getVerifiedClearance(jobId: string, repo: string, worktree: string): DepClearanceRecord | null {
    const row = this.db
      .prepare("SELECT body_json, mac FROM dep_clearances WHERE job_id = ?")
      .get(jobId) as { readonly body_json: string; readonly mac: string } | undefined;
    if (!row) return null;
    const expected = NodeCrypto.createHmac("sha256", this.clearanceKey())
      .update(row.body_json)
      .digest("hex");
    const a = Buffer.from(row.mac, "utf8");
    const b = Buffer.from(expected, "utf8");
    if (a.length !== b.length || !NodeCrypto.timingSafeEqual(a, b)) return null;
    const parsed = JSON.parse(row.body_json) as DepClearanceRecord;
    if (parsed.jobId !== jobId || parsed.repo !== repo || parsed.worktree !== worktree) return null;
    return parsed;
  }
}
