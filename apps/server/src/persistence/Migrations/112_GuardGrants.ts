import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE IF NOT EXISTS guard_grants (
      grant_id TEXT PRIMARY KEY,
      bundle_key TEXT NOT NULL,
      thread_id TEXT NOT NULL,
      repo TEXT NOT NULL,
      branch TEXT NOT NULL,
      worktree TEXT NOT NULL,
      pr_or_issue TEXT NOT NULL,
      guard TEXT NOT NULL,
      gate_ids_json TEXT NOT NULL,
      protected_paths_json TEXT NOT NULL,
      protected_diff_sha256 TEXT NOT NULL,
      body_sha256 TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL,
      approved_via TEXT NOT NULL,
      signature TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT,
      revoked_at TEXT,
      revoked_via TEXT,
      use_count INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS guard_grants_active_bundle_idx
    ON guard_grants(bundle_key)
    WHERE revoked_at IS NULL
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS guard_grants_active_repo_branch_idx
    ON guard_grants(repo, branch)
    WHERE revoked_at IS NULL
  `;

  yield* sql`
    CREATE TABLE IF NOT EXISTS guard_grant_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      ts TEXT NOT NULL,
      event_type TEXT NOT NULL,
      request_id TEXT,
      grant_id TEXT,
      thread_id TEXT NOT NULL,
      guard TEXT NOT NULL,
      scope TEXT NOT NULL,
      argv_sha256 TEXT NOT NULL,
      command_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      reason TEXT NOT NULL
    )
  `;

  yield* sql`
    CREATE INDEX IF NOT EXISTS guard_grant_events_ts_idx
    ON guard_grant_events(ts DESC)
  `;
});
