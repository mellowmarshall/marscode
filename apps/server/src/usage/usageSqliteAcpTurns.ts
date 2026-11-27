// @effect-diagnostics nodeBuiltinImport:off
import type * as NodeSqlite from "node:sqlite";

import type { UsageProviderKind } from "@t3tools/contracts";
import type { UsageRecord } from "@t3tools/provider-core/server/usage";

export function loadAcpUsageTurns(
  db: NodeSqlite.DatabaseSync,
  provider: UsageProviderKind,
  minTimestampMs: number,
): UsageRecord[] {
  const rows = db
    .prepare(
      `SELECT dedupe_key, provider, session_id, timestamp_ms, model, rate_model,
              uncached_input_tokens, cached_input_tokens, cache_creation_tokens,
              output_tokens, reasoning_tokens
       FROM acp_usage_turns
       WHERE provider = ? AND timestamp_ms >= ?
       ORDER BY timestamp_ms ASC, dedupe_key ASC`,
    )
    .all(provider, minTimestampMs) as Array<{
    readonly dedupe_key: string;
    readonly provider: UsageProviderKind;
    readonly session_id: string;
    readonly timestamp_ms: number;
    readonly model: string;
    readonly rate_model: string | null;
    readonly uncached_input_tokens: number;
    readonly cached_input_tokens: number;
    readonly cache_creation_tokens: number;
    readonly output_tokens: number;
    readonly reasoning_tokens: number;
  }>;
  return rows.map((row) => ({
    provider: row.provider,
    timestampMs: row.timestamp_ms,
    model: row.model,
    ...(typeof row.rate_model === "string" && row.rate_model.length > 0
      ? { rateModel: row.rate_model }
      : {}),
    sessionId: row.session_id,
    totals: {
      uncachedInputTokens: row.uncached_input_tokens,
      cachedInputTokens: row.cached_input_tokens,
      cacheCreationTokens: row.cache_creation_tokens,
      outputTokens: row.output_tokens,
      reasoningTokens: row.reasoning_tokens,
    },
    reportedCostUsd: null,
    speed: "standard",
    dedupeKey: row.dedupe_key,
  }));
}

export function upsertAcpUsageTurns(
  db: NodeSqlite.DatabaseSync,
  records: readonly UsageRecord[],
  updatedAtMs: number,
): void {
  const keyed = records.filter(
    (record): record is UsageRecord & { readonly dedupeKey: string } =>
      typeof record.dedupeKey === "string" && record.dedupeKey.length > 0,
  );
  if (keyed.length === 0) return;
  const stmt = db.prepare(
    `INSERT INTO acp_usage_turns (
       dedupe_key, provider, session_id, timestamp_ms, model, rate_model,
       uncached_input_tokens, cached_input_tokens, cache_creation_tokens,
       output_tokens, reasoning_tokens, updated_at_ms
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(dedupe_key) DO UPDATE SET
       provider = excluded.provider,
       session_id = excluded.session_id,
       timestamp_ms = excluded.timestamp_ms,
       model = excluded.model,
       rate_model = excluded.rate_model,
       uncached_input_tokens = excluded.uncached_input_tokens,
       cached_input_tokens = excluded.cached_input_tokens,
       cache_creation_tokens = excluded.cache_creation_tokens,
       output_tokens = excluded.output_tokens,
       reasoning_tokens = excluded.reasoning_tokens,
       updated_at_ms = excluded.updated_at_ms`,
  );
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const record of keyed) {
      stmt.run(
        record.dedupeKey,
        record.provider,
        record.sessionId,
        record.timestampMs,
        record.model,
        record.rateModel ?? null,
        record.totals.uncachedInputTokens,
        record.totals.cachedInputTokens,
        record.totals.cacheCreationTokens,
        record.totals.outputTokens,
        record.totals.reasoningTokens,
        updatedAtMs,
      );
    }
    db.exec("COMMIT");
  } catch (error) {
    try {
      db.exec("ROLLBACK");
    } catch {
      // Ignore rollback errors.
    }
    throw error;
  }
}

export function pruneAcpUsageTurnsBefore(
  db: NodeSqlite.DatabaseSync,
  retentionCutoffMs: number,
): number {
  if (retentionCutoffMs <= 0) return 0;
  const result = db
    .prepare("DELETE FROM acp_usage_turns WHERE timestamp_ms < ?")
    .run(retentionCutoffMs);
  return Number(result.changes);
}
