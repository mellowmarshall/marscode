// @effect-diagnostics nodeBuiltinImport:off
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

import { glmRateModel, normalizeGlmModel } from "./glmZcodeSqlite.ts";

const SQLITE_BUSY_TIMEOUT_MS = 2_000;
const SQLITE_IN_CHUNK_SIZE = 400;

const NON_GLM_BUILT_IN_PROVIDERS = new Set([
  "claudeagent",
  "claude",
  "codex",
  "antigravity",
  "grok",
  "cursor",
  "opencode",
  "pi",
  "muse",
  "fx",
  "kiro",
]);

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isNonGlmBuiltInProvider(value: unknown): boolean {
  if (typeof value !== "string") return false;
  return NON_GLM_BUILT_IN_PROVIDERS.has(value.trim().toLowerCase());
}

function isGlmProviderId(value: unknown): boolean {
  if (typeof value !== "string") return false;
  const lower = value.trim().toLowerCase();
  if (lower.length === 0 || NON_GLM_BUILT_IN_PROVIDERS.has(lower)) return false;
  return lower.includes("glm") || lower.includes("zcode");
}

function listTables(db: NodeSqlite.DatabaseSync): Set<string> {
  const rows = db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all() as Array<{
    readonly name?: unknown;
  }>;
  const names = new Set<string>();
  for (const row of rows) {
    if (typeof row.name === "string") names.add(row.name);
  }
  return names;
}

export interface StateGlmReadResult {
  readonly marker: string;
  readonly hasGlmData: boolean;
  readonly records: readonly UsageRecord[];
}

function readGlmTurnMarker(db: NodeSqlite.DatabaseSync, threadIds: readonly string[]): string {
  let turnCount = 0;
  let maxRowId = 0;
  let completedCount = 0;
  let maxCompletedAt = "";
  for (let offset = 0; offset < threadIds.length; offset += SQLITE_IN_CHUNK_SIZE) {
    const chunk = threadIds.slice(offset, offset + SQLITE_IN_CHUNK_SIZE);
    const placeholders = chunk.map(() => "?").join(", ");
    const row = db
      .prepare(
        `SELECT count(*) AS turn_count,
                coalesce(max(rowid), 0) AS max_rowid,
                count(completed_at) AS completed_count,
                coalesce(max(completed_at), '') AS max_completed_at
         FROM orchestration_v2_projection_provider_turns
         WHERE thread_id IN (${placeholders})`,
      )
      .get(...chunk) as
      | {
          readonly turn_count?: unknown;
          readonly max_rowid?: unknown;
          readonly completed_count?: unknown;
          readonly max_completed_at?: unknown;
        }
      | undefined;
    turnCount += Number(row?.turn_count ?? 0);
    maxRowId = Math.max(maxRowId, Number(row?.max_rowid ?? 0));
    completedCount += Number(row?.completed_count ?? 0);
    const completed = typeof row?.max_completed_at === "string" ? row.max_completed_at : "";
    if (completed > maxCompletedAt) maxCompletedAt = completed;
  }
  return `${threadIds.join(",")}|${turnCount}:${maxRowId}:${completedCount}:${maxCompletedAt}`;
}

export function readT3StateGlmRecords(
  stateDbPath: string,
  previousMarker?: string,
): StateGlmReadResult | { readonly unchanged: true; readonly marker: string } {
  const db = new NodeSqlite.DatabaseSync(stateDbPath, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    const tables = listTables(db);
    if (
      !tables.has("orchestration_v2_projection_provider_sessions") ||
      !tables.has("orchestration_v2_projection_provider_turns")
    ) {
      return { marker: "no-v2-tables", hasGlmData: false, records: [] };
    }

    const sessionCols = db
      .prepare("PRAGMA table_info(orchestration_v2_projection_provider_sessions)")
      .all() as Array<{ readonly name?: unknown }>;
    const hasDriverCol = sessionCols.some((col) => col.name === "driver");
    const sessionRows = db
      .prepare(
        `SELECT thread_id, provider, provider_instance_id, model${hasDriverCol ? ", driver" : ""}
         FROM orchestration_v2_projection_provider_sessions
         WHERE lower(coalesce(provider, '')) LIKE '%glm%'
            OR lower(coalesce(provider_instance_id, '')) LIKE '%glm%'
            OR lower(coalesce(provider, '')) LIKE '%zcode%'
            OR lower(coalesce(provider_instance_id, '')) LIKE '%zcode%'`,
      )
      .all() as Array<{
      readonly thread_id?: unknown;
      readonly provider?: unknown;
      readonly provider_instance_id?: unknown;
      readonly model?: unknown;
      readonly driver?: unknown;
    }>;

    const sessionModelByThread = new Map<string, string>();
    const threadIds: string[] = [];
    for (const row of sessionRows) {
      if (typeof row.thread_id !== "string" || row.thread_id.length === 0) continue;
      // Reject known non-GLM built-in drivers even if their instance id contains "glm" (e.g. claude-glm).
      if (isNonGlmBuiltInProvider(row.provider) || isNonGlmBuiltInProvider(row.driver)) continue;
      if (!isGlmProviderId(row.provider) && !isGlmProviderId(row.provider_instance_id)) continue;
      if (!sessionModelByThread.has(row.thread_id)) {
        threadIds.push(row.thread_id);
        sessionModelByThread.set(row.thread_id, normalizeGlmModel(row.model));
      } else if (!sessionModelByThread.get(row.thread_id)) {
        sessionModelByThread.set(row.thread_id, normalizeGlmModel(row.model));
      }
    }
    threadIds.sort();
    if (threadIds.length === 0) {
      const marker = "empty";
      if (previousMarker === marker) return { unchanged: true, marker };
      return { marker, hasGlmData: false, records: [] };
    }

    const marker = readGlmTurnMarker(db, threadIds);
    if (previousMarker !== undefined && marker === previousMarker) {
      return { unchanged: true, marker };
    }

    const hasAttempts = tables.has("orchestration_v2_projection_run_attempts");
    const hasRuns = tables.has("orchestration_v2_projection_runs");
    const records: UsageRecord[] = [];

    for (let offset = 0; offset < threadIds.length; offset += SQLITE_IN_CHUNK_SIZE) {
      const chunk = threadIds.slice(offset, offset + SQLITE_IN_CHUNK_SIZE);
      const placeholders = chunk.map(() => "?").join(", ");

      const sql =
        hasAttempts && hasRuns
          ? `SELECT
               turn.provider_turn_id,
               turn.thread_id,
               turn.started_at,
               turn.completed_at,
               turn.payload_json AS turn_payload_json,
               attempt.attempt_id AS matched_attempt_id,
               attempt.provider AS attempt_provider,
               attempt.provider_instance_id AS attempt_provider_instance_id,
               run.provider AS run_provider,
               run.provider_instance_id AS run_provider_instance_id,
               run.payload_json AS run_payload_json
             FROM orchestration_v2_projection_provider_turns AS turn
             LEFT JOIN orchestration_v2_projection_run_attempts AS attempt
               ON attempt.attempt_id = turn.run_attempt_id
               AND attempt.thread_id = turn.thread_id
               AND attempt.provider_thread_id = turn.provider_thread_id
             LEFT JOIN orchestration_v2_projection_runs AS run
               ON run.run_id = attempt.run_id
               AND run.thread_id = attempt.thread_id
             WHERE turn.thread_id IN (${placeholders})`
          : `SELECT
               turn.provider_turn_id,
               turn.thread_id,
               turn.started_at,
               turn.completed_at,
               turn.payload_json AS turn_payload_json,
               NULL AS matched_attempt_id,
               NULL AS attempt_provider,
               NULL AS attempt_provider_instance_id,
               NULL AS run_provider,
               NULL AS run_provider_instance_id,
               NULL AS run_payload_json
             FROM orchestration_v2_projection_provider_turns AS turn
             WHERE turn.thread_id IN (${placeholders})`;

      const rows = db.prepare(sql).all(...chunk) as Array<{
        readonly provider_turn_id?: unknown;
        readonly thread_id?: unknown;
        readonly started_at?: unknown;
        readonly completed_at?: unknown;
        readonly turn_payload_json?: unknown;
        readonly matched_attempt_id?: unknown;
        readonly attempt_provider?: unknown;
        readonly attempt_provider_instance_id?: unknown;
        readonly run_provider?: unknown;
        readonly run_provider_instance_id?: unknown;
        readonly run_payload_json?: unknown;
      }>;

      for (const row of rows) {
        if (
          typeof row.provider_turn_id !== "string" ||
          typeof row.thread_id !== "string" ||
          typeof row.turn_payload_json !== "string"
        ) {
          continue;
        }
        let parsedTurn: Record<string, unknown> | null = null;
        try {
          parsedTurn = asRecord(JSON.parse(row.turn_payload_json));
        } catch {
          continue;
        }
        if (parsedTurn === null) continue;
        const turnUsage = asRecord(parsedTurn["turnTokenUsage"]);
        if (turnUsage === null) continue;

        // Only count complete main-agent model turns; skip local commands and unavailable/partial/subagent rollups.
        if (turnUsage["localCommand"] === true) continue;
        const usageStatus = turnUsage["usageStatus"];
        if (usageStatus !== undefined && usageStatus !== "complete") continue;
        const usageScope = turnUsage["usageScope"];
        if (usageScope !== undefined && usageScope !== "main_agent") continue;

        let runModel = "";
        let runPayloadInstance: unknown;
        if (typeof row.run_payload_json === "string") {
          try {
            const parsedRun = asRecord(JSON.parse(row.run_payload_json));
            const modelSelection = asRecord(parsedRun?.["modelSelection"]);
            runModel = normalizeGlmModel(modelSelection?.["model"]);
            runPayloadInstance = parsedRun?.["providerInstanceId"];
          } catch {
            // Ignore malformed run payload; rely on row columns.
          }
        }

        // Attribute strictly by non-builtin GLM provider; reject known non-GLM drivers even if instance id has "glm".
        const hasAttemptMatch = typeof row.matched_attempt_id === "string";
        if (
          hasAttemptMatch &&
          (isNonGlmBuiltInProvider(row.attempt_provider) ||
            isNonGlmBuiltInProvider(row.run_provider))
        ) {
          continue;
        }
        const isGlmTurn = hasAttemptMatch
          ? isGlmProviderId(row.attempt_provider) ||
            isGlmProviderId(row.attempt_provider_instance_id) ||
            isGlmProviderId(row.run_provider) ||
            isGlmProviderId(row.run_provider_instance_id) ||
            isGlmProviderId(runPayloadInstance)
          : isGlmProviderId(row.provider_turn_id);
        if (!isGlmTurn) continue;

        const inputRaw = tokenCount(turnUsage["inputTokens"]);
        const outputRaw = tokenCount(turnUsage["outputTokens"]);
        const cachedRaw = tokenCount(
          turnUsage["cachedInputTokens"] ?? turnUsage["cacheReadTokens"],
        );
        const cacheWriteRaw = tokenCount(
          turnUsage["cacheCreationTokens"] ??
            turnUsage["cacheCreationInputTokens"] ??
            turnUsage["cacheWriteTokens"],
        );
        const reasoningRaw = tokenCount(turnUsage["reasoningTokens"]);
        // TurnTokenUsage contract: inputTokens includes cached + cache-creation; reasoning is subset of output.
        const cachedInputTokens = Math.min(cachedRaw, inputRaw);
        const cacheCreationTokens = Math.min(
          cacheWriteRaw,
          Math.max(0, inputRaw - cachedInputTokens),
        );
        const uncachedInputTokens = Math.max(0, inputRaw - cachedInputTokens - cacheCreationTokens);
        const totals: UsageTokenTotals = {
          uncachedInputTokens,
          cachedInputTokens,
          cacheCreationTokens,
          outputTokens: outputRaw,
          reasoningTokens: Math.min(reasoningRaw, outputRaw),
        };
        if (totalTokens(totals) === 0) continue;

        const timestampMs =
          parseTimestampMs(row.completed_at) ??
          parseTimestampMs(row.started_at) ??
          parseTimestampMs(parsedTurn["completedAt"]) ??
          parseTimestampMs(parsedTurn["startedAt"]);
        if (timestampMs === null) continue;

        const resolvedModel = runModel || sessionModelByThread.get(row.thread_id) || "";
        const model = resolvedModel.length > 0 ? resolvedModel : "unknown";
        records.push({
          provider: "glm",
          timestampMs,
          model,
          ...(resolvedModel.length > 0 ? { rateModel: glmRateModel(resolvedModel) } : {}),
          sessionId: row.thread_id,
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: `t3:glm:turn:${row.provider_turn_id}`,
        });
      }
    }

    return { marker, hasGlmData: true, records };
  } finally {
    db.close();
  }
}
