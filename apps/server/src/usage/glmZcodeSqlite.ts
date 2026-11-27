// @effect-diagnostics nodeBuiltinImport:off
import * as NodePath from "node:path";
import * as NodeSqlite from "node:sqlite";

import type { UsageTokenTotals } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  parseTimestampMs,
  tokenCount,
  totalTokens,
  type UsageRecord,
} from "@t3tools/provider-core/server/usage";

const SQLITE_BUSY_TIMEOUT_MS = 2_000;

const KNOWN_GLM_PREFIXES = [
  "builtin:zai-coding-plan/",
  "zai-coding-plan/",
  "zai-org/",
  "zai/",
  "bigmodel/",
  "zhipu/",
] as const;

export function normalizeGlmModel(raw: unknown): string {
  if (typeof raw !== "string") return "";
  let value = raw.trim();
  if (value.length === 0) return "";
  const lower = value.toLowerCase();
  for (const prefix of KNOWN_GLM_PREFIXES) {
    if (lower.startsWith(prefix)) {
      value = value.slice(prefix.length).trim();
      break;
    }
  }
  return value.toLowerCase();
}

export function glmRateModel(model: string): string {
  const normalized = normalizeGlmModel(model);
  if (normalized.length === 0 || normalized === "unknown") return model;
  return normalized.includes("/") ? normalized : `zai/${normalized}`;
}

export function resolveZcodeDbPath(homeDir: string, environment: NodeJS.ProcessEnv): string {
  const explicitDb = environment["ZCODE_DB_PATH"]?.trim();
  if (explicitDb) return NodePath.resolve(expandHomePath(explicitDb, homeDir));
  const dataDir = environment["ZCODE_DATA_DIR"]?.trim();
  if (dataDir) {
    return NodePath.join(
      NodePath.resolve(expandHomePath(dataDir, homeDir)),
      "cli",
      "db",
      "db.sqlite",
    );
  }
  return NodePath.join(homeDir, ".zcode", "cli", "db", "db.sqlite");
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function normalizeEpochMs(value: unknown): number | null {
  if (typeof value === "number" && Number.isFinite(value) && value > 0) {
    return value < 1e12 ? Math.trunc(value * 1000) : Math.trunc(value);
  }
  if (typeof value === "string") {
    const asNumber = Number(value);
    if (Number.isFinite(asNumber) && asNumber > 0) {
      return asNumber < 1e12 ? Math.trunc(asNumber * 1000) : Math.trunc(asNumber);
    }
    return parseTimestampMs(value);
  }
  return null;
}

function isZcodeGlmEntry(providerRaw: unknown, modelNormalized: string): boolean {
  if (modelNormalized.includes("glm")) return true;
  if (typeof providerRaw === "string") {
    const lower = providerRaw.toLowerCase();
    return (
      lower.includes("zai") ||
      lower.includes("zhipu") ||
      lower.includes("bigmodel") ||
      lower.includes("glm")
    );
  }
  return false;
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

function buildZcodeTotals(input: {
  readonly inputRaw: number;
  readonly outputRaw: number;
  readonly reasoningRaw: number;
  readonly cacheReadRaw: number;
  readonly cacheWriteRaw: number;
  readonly totalRaw: number;
}): UsageTokenTotals {
  const { inputRaw, outputRaw, reasoningRaw, cacheReadRaw, cacheWriteRaw, totalRaw } = input;
  const outputTokens = outputRaw;
  const reasoningTokens = Math.min(reasoningRaw, outputTokens);
  // ZCode stores input inclusive of cache reads (total === input + output).
  // If a future schema records input excluding cache, total will include all components.
  const inputExcludesCache =
    totalRaw > 0 &&
    (cacheReadRaw > 0 || cacheWriteRaw > 0) &&
    totalRaw >= inputRaw + outputRaw + cacheReadRaw + cacheWriteRaw;
  if (inputExcludesCache) {
    return {
      uncachedInputTokens: inputRaw,
      cachedInputTokens: cacheReadRaw,
      cacheCreationTokens: cacheWriteRaw,
      outputTokens,
      reasoningTokens,
    };
  }
  const cachedInputTokens = Math.min(cacheReadRaw, inputRaw);
  const cacheCreationTokens = Math.min(cacheWriteRaw, Math.max(0, inputRaw - cachedInputTokens));
  const uncachedInputTokens = Math.max(0, inputRaw - cachedInputTokens - cacheCreationTokens);
  return {
    uncachedInputTokens,
    cachedInputTokens,
    cacheCreationTokens,
    outputTokens,
    reasoningTokens,
  };
}

function parseZcodeMessageRow(row: {
  readonly id?: unknown;
  readonly session_id?: unknown;
  readonly time_created?: unknown;
  readonly data?: unknown;
}): { readonly messageId: string; readonly record: UsageRecord } | null {
  if (typeof row.id !== "string" || typeof row.data !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(row.data);
  } catch {
    return null;
  }
  const data = asRecord(parsed);
  if (data === null) return null;
  const tokens = asRecord(data["tokens"]) ?? asRecord(data["usage"]);
  if (tokens === null) return null;
  const cache = asRecord(tokens["cache"]);
  const totals = buildZcodeTotals({
    inputRaw: tokenCount(tokens["input"] ?? tokens["inputTokens"]),
    outputRaw: tokenCount(tokens["output"] ?? tokens["outputTokens"]),
    reasoningRaw: tokenCount(tokens["reasoning"] ?? tokens["reasoningTokens"]),
    cacheReadRaw: tokenCount(cache?.["read"] ?? tokens["cacheRead"] ?? tokens["cachedInputTokens"]),
    cacheWriteRaw: tokenCount(
      cache?.["write"] ?? tokens["cacheWrite"] ?? tokens["cacheCreationInputTokens"],
    ),
    totalRaw: tokenCount(tokens["total"] ?? tokens["totalTokens"]),
  });
  if (totalTokens(totals) === 0) return null;

  const timestampMs = normalizeEpochMs(row.time_created);
  if (timestampMs === null) return null;
  const model = normalizeGlmModel(data["modelID"] ?? data["model"]);
  if (model.length === 0) return null;
  if (!isZcodeGlmEntry(data["providerID"] ?? data["provider"], model)) return null;

  const cost = data["cost"];
  const reportedCostUsd =
    typeof cost === "number" && Number.isFinite(cost) && cost > 0 ? cost : null;
  return {
    messageId: row.id,
    record: {
      provider: "glm",
      timestampMs,
      model,
      rateModel: glmRateModel(model),
      sessionId: typeof row.session_id === "string" ? row.session_id : "",
      totals,
      reportedCostUsd,
      speed: "standard",
      dedupeKey: `zcode:msg:${row.id}`,
    },
  };
}

export function readZcodeSqliteRecords(dbPath: string): readonly UsageRecord[] {
  const db = new NodeSqlite.DatabaseSync(dbPath, {
    readOnly: true,
    timeout: SQLITE_BUSY_TIMEOUT_MS,
  });
  try {
    const tables = listTables(db);
    const records: UsageRecord[] = [];
    const seenMessageIds = new Set<string>();

    if (tables.has("message")) {
      const rows = db
        .prepare("SELECT id, session_id, time_created, data FROM message")
        .all() as Array<{
        readonly id?: unknown;
        readonly session_id?: unknown;
        readonly time_created?: unknown;
        readonly data?: unknown;
      }>;
      for (const row of rows) {
        const parsed = parseZcodeMessageRow(row);
        if (parsed === null) continue;
        seenMessageIds.add(parsed.messageId);
        records.push(parsed.record);
      }
    }

    if (tables.has("model_usage")) {
      const rows = db
        .prepare(
          `SELECT id, assistant_message_id, session_id, provider_id, model_id,
                  started_at, completed_at,
                  input_tokens, output_tokens, reasoning_tokens,
                  cache_creation_input_tokens, cache_read_input_tokens,
                  provider_total_tokens, computed_total_tokens
           FROM model_usage
           WHERE status = 'completed'`,
        )
        .all() as Array<Record<string, unknown>>;
      for (const row of rows) {
        const assistantMessageId =
          typeof row["assistant_message_id"] === "string" && row["assistant_message_id"].length > 0
            ? row["assistant_message_id"]
            : null;
        if (assistantMessageId !== null && seenMessageIds.has(assistantMessageId)) {
          continue;
        }
        const id = row["id"];
        if (typeof id !== "string" && typeof id !== "number") continue;
        const model = normalizeGlmModel(row["model_id"]);
        if (model.length === 0) continue;
        if (!isZcodeGlmEntry(row["provider_id"], model)) continue;
        const timestampMs = normalizeEpochMs(row["completed_at"] ?? row["started_at"]);
        if (timestampMs === null) continue;
        const totals = buildZcodeTotals({
          inputRaw: tokenCount(row["input_tokens"]),
          outputRaw: tokenCount(row["output_tokens"]),
          reasoningRaw: tokenCount(row["reasoning_tokens"]),
          cacheReadRaw: tokenCount(row["cache_read_input_tokens"]),
          cacheWriteRaw: tokenCount(row["cache_creation_input_tokens"]),
          totalRaw: tokenCount(row["computed_total_tokens"] ?? row["provider_total_tokens"]),
        });
        if (totalTokens(totals) === 0) continue;
        records.push({
          provider: "glm",
          timestampMs,
          model,
          rateModel: glmRateModel(model),
          sessionId: typeof row["session_id"] === "string" ? row["session_id"] : "",
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey:
            assistantMessageId !== null
              ? `zcode:msg:${assistantMessageId}`
              : `zcode:mu:${String(id)}`,
        });
      }
    }

    return records;
  } finally {
    db.close();
  }
}
