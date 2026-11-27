// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import type { ProviderUsageScan, UsageRecord } from "@t3tools/provider-core/server/usage";

import { readT3StateGlmRecords } from "./glmStateSqlite.ts";
import {
  glmRateModel,
  normalizeGlmModel,
  readZcodeSqliteRecords,
  resolveZcodeDbPath,
} from "./glmZcodeSqlite.ts";
import type { UsageSqliteIndex } from "./usageSqliteIndex.ts";

export { glmRateModel, normalizeGlmModel };

interface CachedDbEntry {
  readonly fingerprint: string;
  readonly dbMarker?: string;
  readonly persistedCutoffMs?: number;
  readonly persistedIndex?: UsageSqliteIndex;
  readonly hasGlmData: boolean;
  readonly records: readonly UsageRecord[];
}

export type GlmUsageCache = Map<string, CachedDbEntry>;

export function makeGlmUsageCache(): GlmUsageCache {
  return new Map();
}

function sqliteFileFingerprint(dbPath: string): string | null {
  let stat: NodeFS.Stats;
  try {
    stat = NodeFS.statSync(dbPath);
  } catch {
    return null;
  }
  if (!stat.isFile()) return null;
  let walPart = "nowal";
  try {
    const wal = NodeFS.statSync(`${dbPath}-wal`);
    if (wal.isFile()) {
      walPart = `${wal.size}:${wal.mtimeMs}:${wal.ctimeMs}`;
    }
  } catch {
    // WAL file absent; main file stats are sufficient.
  }
  return `${stat.size}:${stat.mtimeMs}:${stat.ctimeMs}|${walPart}`;
}

type DbReadOutcome =
  | { readonly kind: "missing" }
  | {
      readonly kind: "ok";
      readonly hasGlmData: boolean;
      readonly records: readonly UsageRecord[];
    }
  | {
      readonly kind: "partial";
      readonly hasGlmData: boolean;
      readonly records: readonly UsageRecord[];
      readonly message: string;
    };

function readZcodeCached(dbPath: string, cache: GlmUsageCache): DbReadOutcome {
  const fingerprint = sqliteFileFingerprint(dbPath);
  if (fingerprint === null) {
    cache.delete(dbPath);
    return { kind: "missing" };
  }
  const cached = cache.get(dbPath);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return { kind: "ok", hasGlmData: cached.hasGlmData, records: cached.records };
  }
  try {
    const records = readZcodeSqliteRecords(dbPath);
    cache.set(dbPath, { fingerprint, hasGlmData: true, records });
    return { kind: "ok", hasGlmData: true, records };
  } catch {
    return {
      kind: "partial",
      hasGlmData: true,
      records: cached?.records ?? [],
      message: `GLM usage database could not be read (${dbPath}).`,
    };
  }
}

function readStateV2Cached(stateDbPath: string, cache: GlmUsageCache): DbReadOutcome {
  const fingerprint = sqliteFileFingerprint(stateDbPath);
  if (fingerprint === null) {
    cache.delete(stateDbPath);
    return { kind: "missing" };
  }
  const cached = cache.get(stateDbPath);
  if (cached !== undefined && cached.fingerprint === fingerprint) {
    return { kind: "ok", hasGlmData: cached.hasGlmData, records: cached.records };
  }
  try {
    const result = readT3StateGlmRecords(stateDbPath, cached?.dbMarker);
    if ("unchanged" in result && cached !== undefined) {
      cache.set(stateDbPath, { ...cached, fingerprint, dbMarker: result.marker });
      return { kind: "ok", hasGlmData: cached.hasGlmData, records: cached.records };
    }
    if (!("unchanged" in result)) {
      cache.set(stateDbPath, {
        fingerprint,
        dbMarker: result.marker,
        hasGlmData: result.hasGlmData,
        records: result.records,
      });
      return { kind: "ok", hasGlmData: result.hasGlmData, records: result.records };
    }
    return { kind: "ok", hasGlmData: false, records: [] };
  } catch {
    return {
      kind: "partial",
      hasGlmData: cached?.hasGlmData ?? true,
      records: cached?.records ?? [],
      message: `GLM usage database could not be read (${stateDbPath}).`,
    };
  }
}

function mergeStateAndDurableRecords(
  liveRecords: readonly UsageRecord[],
  durableRecords: readonly UsageRecord[],
): UsageRecord[] {
  if (durableRecords.length === 0) return [...liveRecords];
  const byKey = new Map<string, UsageRecord>();
  const unkeyed: UsageRecord[] = [];
  for (const record of durableRecords) {
    if (record.dedupeKey !== null) byKey.set(record.dedupeKey, record);
    else unkeyed.push(record);
  }
  for (const record of liveRecords) {
    if (record.dedupeKey !== null) byKey.set(record.dedupeKey, record);
    else unkeyed.push(record);
  }
  return [...byKey.values(), ...unkeyed].toSorted((a, b) => a.timestampMs - b.timestampMs);
}

export function readGlmUsage(input: {
  readonly homeDir: string;
  readonly stateDir: string;
  readonly environment: NodeJS.ProcessEnv;
  readonly windowStartMs: number;
  readonly retentionCutoffMs?: number;
  readonly nowMs?: number;
  readonly sqliteIndex?: UsageSqliteIndex | null;
  readonly cache: GlmUsageCache;
}): ReadonlyArray<ProviderUsageScan> {
  const {
    homeDir,
    stateDir,
    environment,
    windowStartMs,
    retentionCutoffMs = 0,
    nowMs = 0,
    sqliteIndex = null,
    cache,
  } = input;
  const effectiveStartMs = Math.max(windowStartMs, retentionCutoffMs);
  const scans: ProviderUsageScan[] = [];

  const zcodeDbPath = resolveZcodeDbPath(homeDir, environment);
  const zcodeResult = readZcodeCached(zcodeDbPath, cache);
  if (zcodeResult.kind === "ok" || zcodeResult.kind === "partial") {
    scans.push({
      dir: NodePath.dirname(zcodeDbPath),
      files: [
        {
          path: zcodeDbPath,
          records: zcodeResult.records.filter((record) => record.timestampMs >= effectiveStartMs),
        },
      ],
      status: zcodeResult.kind === "ok" ? "ok" : "partial",
      ...(zcodeResult.kind === "partial" ? { message: zcodeResult.message } : {}),
    });
  }

  const stateDbPath = NodePath.join(stateDir, "statev2.sqlite");
  const stateResult = readStateV2Cached(stateDbPath, cache);
  const cachedState = cache.get(stateDbPath);
  const needsPersist =
    stateResult.kind === "ok" &&
    stateResult.records.length > 0 &&
    sqliteIndex !== null &&
    (cachedState?.persistedIndex !== sqliteIndex ||
      cachedState.persistedCutoffMs === undefined ||
      retentionCutoffMs < cachedState.persistedCutoffMs);
  if (needsPersist && sqliteIndex !== null && stateResult.kind === "ok") {
    const retained =
      retentionCutoffMs > 0
        ? stateResult.records.filter((record) => record.timestampMs >= retentionCutoffMs)
        : stateResult.records;
    try {
      sqliteIndex.upsertAcpTurns(retained, nowMs);
      if (cachedState !== undefined) {
        cache.set(stateDbPath, {
          ...cachedState,
          persistedIndex: sqliteIndex,
          persistedCutoffMs: retentionCutoffMs,
        });
      }
    } catch {
      // Non-fatal: next scan retries durable persistence.
    }
  }

  let durableRecords: UsageRecord[] = [];
  if (sqliteIndex !== null) {
    try {
      durableRecords = sqliteIndex.loadAcpTurns("glm", effectiveStartMs);
    } catch {
      durableRecords = [];
    }
  }

  const liveFiltered =
    stateResult.kind === "ok" || stateResult.kind === "partial"
      ? stateResult.records.filter((record) => record.timestampMs >= effectiveStartMs)
      : [];
  const mergedStateRecords = mergeStateAndDurableRecords(liveFiltered, durableRecords);
  const hasStateSource =
    mergedStateRecords.length > 0 || (stateResult.kind !== "missing" && stateResult.hasGlmData);
  if (hasStateSource) {
    scans.push({
      dir: stateDir,
      files: [{ path: stateDbPath, records: mergedStateRecords }],
      status: stateResult.kind === "partial" ? "partial" : "ok",
      ...(stateResult.kind === "partial" ? { message: stateResult.message } : {}),
    });
  }

  return scans;
}
