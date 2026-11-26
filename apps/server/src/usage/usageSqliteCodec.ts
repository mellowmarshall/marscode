// @effect-diagnostics nodeBuiltinImport:off
import * as NodeZlib from "node:zlib";

import type { UsageProviderKind } from "@t3tools/contracts";
import type {
  TranscriptUsageFormat,
  UsageRecord,
  UsageSpeed,
} from "@t3tools/provider-core/server/usage";
import * as Schema from "effect/Schema";

import { CLAUDE_SYNTHETIC_MODEL } from "../provider/Drivers/claudeUsage.ts";
import type { CachedFile } from "./usageScanCache.ts";
import type { AntigravityCachedPayload } from "./usageSqliteSchema.ts";
import { GUARD_LENGTH } from "./usageTranscriptReader.ts";

const SPEEDS: readonly UsageSpeed[] = ["standard", "fast", "ultrafast"];

type CompactRecord = readonly [
  timestampMs: number,
  modelIndex: number,
  sessionIndex: number,
  uncachedInputTokens: number,
  cachedInputTokens: number,
  cacheCreationTokens: number,
  outputTokens: number,
  reasoningTokens: number,
  dedupeKey: string | null,
  reportedCostUsd: number | null,
  speedIndex: number,
  rateModelIndex?: number | null,
  unresolvedServiceTierTurnId?: string | null,
  cacheCreation1hTokens?: number,
];

interface CompactFilePayload {
  readonly models: readonly string[];
  readonly sessions: readonly string[];
  readonly r: readonly CompactRecord[];
  readonly t: readonly CompactRecord[];
  readonly mt: readonly number[];
  readonly o: number;
  readonly gl: number;
  readonly gh: number;
  readonly cs: unknown;
}

function intern(table: string[], index: Map<string, number>, value: string): number {
  const existing = index.get(value);
  if (existing !== undefined) return existing;
  const next = table.length;
  table.push(value);
  index.set(value, next);
  return next;
}

export function encodeFilePayload(entry: CachedFile): Buffer {
  const models: string[] = [];
  const sessions: string[] = [];
  const modelIndex = new Map<string, number>();
  const sessionIndex = new Map<string, number>();
  const pack = (record: UsageRecord): CompactRecord => [
    record.timestampMs,
    intern(models, modelIndex, record.model),
    intern(sessions, sessionIndex, record.sessionId),
    record.totals.uncachedInputTokens,
    record.totals.cachedInputTokens,
    record.totals.cacheCreationTokens,
    record.totals.outputTokens,
    record.totals.reasoningTokens,
    record.dedupeKey,
    record.reportedCostUsd,
    SPEEDS.indexOf(record.speed),
    record.rateModel === undefined ? null : intern(models, modelIndex, record.rateModel),
    ...(record.cacheCreation1hTokens !== undefined
      ? ([record.unresolvedServiceTierTurnId ?? null, record.cacheCreation1hTokens] as const)
      : record.unresolvedServiceTierTurnId !== undefined
        ? ([record.unresolvedServiceTierTurnId] as const)
        : ([] as const)),
  ];
  const payload: CompactFilePayload = {
    models,
    sessions,
    r: entry.records.map(pack),
    t: entry.tailRecords.map(pack),
    mt: entry.malformedRecords,
    o: entry.position.resumeOffset,
    gl: entry.position.guardLength,
    gh: entry.position.guardHash,
    cs: entry.position.state,
  };
  return NodeZlib.zstdCompressSync(Buffer.from(JSON.stringify(payload), "utf8"));
}

export function decodeFilePayload(
  blob: Uint8Array,
  provider: UsageProviderKind,
  size: number,
  mtimeMs: number,
  isValidState: (value: unknown) => boolean,
): CachedFile | null {
  let parsed: CompactFilePayload;
  try {
    const raw = NodeZlib.zstdDecompressSync(blob).toString("utf8");
    parsed = JSON.parse(raw) as CompactFilePayload;
  } catch {
    return null;
  }
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !Array.isArray(parsed.models) ||
    !Array.isArray(parsed.sessions) ||
    !Array.isArray(parsed.r) ||
    !Array.isArray(parsed.t) ||
    !Array.isArray(parsed.mt) ||
    typeof parsed.o !== "number" ||
    !Number.isSafeInteger(parsed.o) ||
    parsed.o < 0 ||
    typeof parsed.gl !== "number" ||
    !Number.isSafeInteger(parsed.gl) ||
    parsed.gl < 0 ||
    parsed.gl > GUARD_LENGTH ||
    parsed.gl > parsed.o ||
    typeof parsed.gh !== "number" ||
    !Number.isFinite(parsed.gh) ||
    !isValidState(parsed.cs)
  ) {
    return null;
  }
  const unpack = (rows: readonly unknown[]): UsageRecord[] | null => {
    const out: UsageRecord[] = [];
    for (const row of rows) {
      if (!Array.isArray(row) || row.length < 11) return null;
      const [
        timestampMs,
        modelIdx,
        sessionIdx,
        uncached,
        cached,
        cacheCreation,
        output,
        reasoning,
        dedupeKey,
        reportedCostUsd,
        speedIdx,
        rateModelIdx,
        unresolvedServiceTierTurnId,
        cacheCreation1h = 0,
      ] = row as unknown as CompactRecord;
      const model = typeof modelIdx === "number" ? parsed.models[modelIdx] : undefined;
      const rateModel = typeof rateModelIdx === "number" ? parsed.models[rateModelIdx] : undefined;
      const speed = typeof speedIdx === "number" ? SPEEDS[speedIdx] : undefined;
      if (
        typeof timestampMs !== "number" ||
        !Number.isFinite(timestampMs) ||
        model === undefined ||
        speed === undefined ||
        (rateModelIdx != null && rateModel === undefined) ||
        (unresolvedServiceTierTurnId != null && typeof unresolvedServiceTierTurnId !== "string") ||
        !Number.isFinite(cacheCreation1h) ||
        !Number.isFinite(uncached) ||
        !Number.isFinite(cached) ||
        !Number.isFinite(cacheCreation) ||
        !Number.isFinite(output) ||
        !Number.isFinite(reasoning)
      ) {
        return null;
      }
      if (provider === "claude" && model === CLAUDE_SYNTHETIC_MODEL) continue;
      out.push({
        provider,
        timestampMs,
        model,
        ...(rateModel === undefined ? {} : { rateModel }),
        sessionId: (typeof sessionIdx === "number" ? parsed.sessions[sessionIdx] : undefined) ?? "",
        totals: {
          uncachedInputTokens: uncached,
          cachedInputTokens: cached,
          cacheCreationTokens: cacheCreation,
          outputTokens: output,
          reasoningTokens: reasoning,
        },
        ...(cacheCreation1h > 0 ? { cacheCreation1hTokens: cacheCreation1h } : {}),
        reportedCostUsd: typeof reportedCostUsd === "number" ? reportedCostUsd : null,
        speed,
        ...(unresolvedServiceTierTurnId != null ? { unresolvedServiceTierTurnId } : {}),
        dedupeKey: typeof dedupeKey === "string" ? dedupeKey : null,
      });
    }
    return out;
  };
  const records = unpack(parsed.r);
  const tailRecords = unpack(parsed.t);
  if (records === null || tailRecords === null) return null;
  if (!parsed.mt.every((value) => typeof value === "number" && Number.isFinite(value))) return null;
  return {
    size,
    mtimeMs,
    provider,
    records,
    tailRecords,
    malformedRecords: parsed.mt,
    position: {
      resumeOffset: parsed.o,
      guardLength: parsed.gl,
      guardHash: parsed.gh,
      state: parsed.cs,
    },
  };
}

export function makeStateValidators(
  formats: ReadonlyMap<UsageProviderKind, TranscriptUsageFormat<unknown>>,
): ReadonlyMap<UsageProviderKind, (value: unknown) => boolean> {
  return new Map(
    [...formats].map(([provider, format]) => {
      const isState = format.state === undefined ? undefined : Schema.is(format.state.schema);
      return [
        provider,
        (value: unknown) => value === null || (isState !== undefined && isState(value)),
      ] as const;
    }),
  );
}

const isFiniteNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);

function isValidAntigravityCandidate(
  value: unknown,
): value is NonNullable<AntigravityCachedPayload["data"]>["candidates"][number] {
  if (typeof value !== "object" || value === null) return false;
  const candidate = value as Record<string, unknown>;
  if (
    !isFiniteNum(candidate.modelId) ||
    !isFiniteNum(candidate.modelQuality) ||
    !isFiniteNum(candidate.timestampQuality) ||
    !Array.isArray(candidate.keys) ||
    !candidate.keys.every((item) => typeof item === "string")
  ) {
    return false;
  }
  const rec = candidate.record;
  if (typeof rec !== "object" || rec === null) return false;
  const record = rec as Record<string, unknown>;
  if (
    record.provider !== "antigravity" ||
    typeof record.model !== "string" ||
    typeof record.sessionId !== "string" ||
    !isFiniteNum(record.timestampMs)
  ) {
    return false;
  }
  const totals = record.totals;
  if (typeof totals !== "object" || totals === null) return false;
  const t = totals as Record<string, unknown>;
  return (
    isFiniteNum(t.uncachedInputTokens) &&
    isFiniteNum(t.cachedInputTokens) &&
    isFiniteNum(t.cacheCreationTokens) &&
    isFiniteNum(t.outputTokens) &&
    isFiniteNum(t.reasoningTokens)
  );
}

/** Decodes and validates a zstd-compressed Antigravity DB payload; returns undefined if malformed. */
export function decodeAntigravityPayload(
  blob: Uint8Array,
): AntigravityCachedPayload["data"] | undefined {
  let parsed: unknown;
  try {
    const raw = NodeZlib.zstdDecompressSync(blob).toString("utf8");
    parsed = JSON.parse(raw);
  } catch {
    return undefined;
  }
  if (parsed === null) return null;
  if (typeof parsed !== "object") return undefined;
  const obj = parsed as { candidates?: unknown; models?: unknown };
  if (!Array.isArray(obj.candidates) || !Array.isArray(obj.models)) return undefined;
  if (!obj.candidates.every(isValidAntigravityCandidate)) return undefined;
  const models = new Map<number, string | null>();
  for (const entry of obj.models) {
    if (
      !Array.isArray(entry) ||
      entry.length !== 2 ||
      !isFiniteNum(entry[0]) ||
      (entry[1] !== null && typeof entry[1] !== "string")
    ) {
      return undefined;
    }
    models.set(entry[0], entry[1]);
  }
  return { candidates: obj.candidates, models };
}
