import type { UsageRecord } from "@t3tools/provider-core/server/usage";

type FieldValue = number | bigint | Uint8Array;
type ProtoFields = Map<number, FieldValue[]>;

export function decodeProtoFields(bytes: Uint8Array): ProtoFields {
  let offset = 0;
  const result: ProtoFields = new Map();
  const varint = () => {
    let value = 0n;
    for (let shift = 0n; shift < 70n; shift += 7n) {
      const byte = bytes[offset++];
      if (byte === undefined || (shift === 63n && byte > 1)) {
        throw new Error("Invalid Antigravity protobuf varint");
      }
      value |= BigInt(byte & 127) << shift;
      if (byte < 128) {
        return value > BigInt(Number.MAX_SAFE_INTEGER) ? value : Number(value);
      }
    }
    throw new Error("Invalid Antigravity protobuf varint");
  };
  while (offset < bytes.length) {
    const tag = varint();
    if (typeof tag !== "number") throw new Error("Invalid protobuf field");
    const number = Math.floor(tag / 8);
    const wire = tag % 8;
    if (number === 0) throw new Error("Invalid protobuf field");
    let value: FieldValue;
    if (wire === 0) {
      value = varint();
    } else if (wire === 1 || wire === 5 || wire === 2) {
      const length = wire === 2 ? varint() : wire === 1 ? 8 : 4;
      if (typeof length !== "number") throw new Error("Invalid protobuf field length");
      if (length > bytes.length - offset) throw new Error("Truncated protobuf field");
      value = bytes.subarray(offset, offset + length);
      offset += length;
      if (wire !== 2) continue;
    } else {
      throw new Error("Unsupported protobuf wire type");
    }
    const entries = result.get(number) ?? [];
    entries.push(value);
    result.set(number, entries);
  }
  return result;
}

const textDecoder = new TextDecoder("utf-8", { fatal: true });

const protoNumberAt = (value: ProtoFields, key: number) => {
  const entry = value.get(key)?.[0];
  return typeof entry === "number" ? entry : 0;
};

const protoBytesAt = (value: ProtoFields, key: number) => {
  const entry = value.get(key)?.[0];
  return entry instanceof Uint8Array ? entry : undefined;
};

export const protoNested = (value: ProtoFields, key: number) => {
  const bytes = protoBytesAt(value, key);
  return bytes === undefined ? new Map<number, FieldValue[]>() : decodeProtoFields(bytes);
};

const protoTextAt = (value: ProtoFields, key: number) => {
  const bytes = protoBytesAt(value, key);
  return bytes === undefined ? "" : textDecoder.decode(bytes).trim();
};

export const protoTimestamp = (value: ProtoFields) => {
  const seconds = protoNumberAt(value, 1);
  return seconds > 0 ? seconds * 1000 + Math.floor(protoNumberAt(value, 2) / 1_000_000) : null;
};

// Offline fallback for records without names. New names are learned from the scanned metadata.
export const ANTIGRAVITY_MODEL_IDS: Record<number, string> = {
  246: "gemini-2.5-pro",
  312: "gemini-2.5-flash",
  313: "gemini-2.5-flash-thinking",
  329: "gemini-2.5-flash-thinking",
  330: "gemini-2.5-flash-lite",
  281: "claude-sonnet-4",
  282: "claude-sonnet-4",
  290: "claude-opus-4",
  291: "claude-opus-4",
  333: "claude-sonnet-4-5",
  334: "claude-sonnet-4-5",
  340: "claude-haiku-4-5",
  341: "claude-haiku-4-5",
  342: "gpt-oss-120b-medium",
  1026: "claude-opus-4-6",
  1035: "claude-sonnet-4-6",
  1016: "gemini-3.1-pro",
  1036: "gemini-3.1-pro",
  1037: "gemini-3.1-pro",
  1018: "gemini-3-flash-preview",
  1084: "gemini-3-flash-preview",
  1047: "gemini-3-flash-preview",
  1020: "gemini-3.5-flash-medium",
  1021: "gemini-3.1-flash-image",
  1050: "gemini-3.1-flash-lite",
  1071: "gemini-3.6-flash-high",
  1072: "gemini-3.6-flash-medium",
  1073: "gemini-3.6-flash-low",
  1132: "gemini-3.5-flash-high",
  1133: "gemini-3.5-flash-high",
  1187: "gemini-3.5-flash-extra-low",
  1196: "gemini-3.6-flash",
  1266: "gemini-3.6-flash",
  1298: "gemini-3.7-flash-high",
  1299: "gemini-3.7-flash-medium",
  1300: "gemini-3.7-flash-low",
  1301: "gemini-3.7-flash-tiered",
  1318: "gemini-3.8-flash-high",
  1319: "gemini-3.8-flash-medium",
  1320: "gemini-3.8-flash-low",
  1322: "gemini-3.8-flash-tiered",
  1402: "claude-opus-5-5",
  1417: "gemini-4-argon",
  1418: "gemini-4-argon",
  1419: "gemini-4-argon",
  1537: "gemini-pro-orchestrator-neon",
};

export const antigravityRateModel = (model: string) => {
  const base = model.replace(
    /-(?:extra-low|low|medium|high|tiered|control|thinking|agent|orchestrator)$/,
    "",
  );
  return /^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
    ? "gemini-3.5-flash"
    : model === "gemini-3.7-flash-safety-le"
      ? "gemini-3.7-flash"
      : model === "gemini-pro-orchestrator-neon"
        ? "gemini-4-neon"
        : model === "gemini-pro-orchestrator-g1-pro"
          ? "gemini-4-argon"
          : base === "gemini-3-flash"
            ? "gemini-3-flash-preview"
            : base;
};

export function withAntigravityRateModel(record: UsageRecord): UsageRecord {
  const rateModel = antigravityRateModel(record.model);
  return rateModel === record.model ? record : { ...record, rateModel };
}

function modelName(name: string): string {
  if (!name) return "";
  const normalized = name
    .toLowerCase()
    .replace(/\s*\(([^)]*)\)\s*$/, "-$1")
    .replace(/\s+/g, "-");
  if (normalized.startsWith("claude-")) {
    return normalized
      .replace(/^claude-(\d+(?:\.\d+)?)-(sonnet|opus|haiku)/, "claude-$2-$1")
      .replaceAll(".", "-");
  }
  return normalized;
}

export function isConcreteAntigravityModel(model: string): boolean {
  return (
    /^(?:gemini-\d|claude-(?:sonnet|opus|haiku)-\d|gpt-)/.test(model) &&
    !/^gemini-3-flash-(?:agent(?:-[ab])?|[ab])$/.test(model)
  );
}

export function rememberAntigravityModel(
  models: Map<number, string | null>,
  id: number,
  model: string | null,
) {
  const previous = models.get(id);
  models.set(id, previous === undefined || previous === model ? model : null);
}

export interface AntigravityMetadata {
  model: string;
  modelId: number;
  timestampMs: number | null;
  usages: ProtoFields[];
}

export function decodeAntigravityMetadata(bytes: Uint8Array, step: boolean): AntigravityMetadata {
  const root = decodeProtoFields(bytes);
  if (!step && protoBytesAt(root, 1) === undefined) {
    throw new Error("Missing Antigravity generation metadata");
  }
  const data = step ? root : protoNested(root, 1);
  const model = step ? protoNested(data, 24) : data;
  const usage = protoBytesAt(data, step ? 9 : 4);
  // Copy usage bytes so subarrays do not retain the full row blob.
  const primaryUsage = usage === undefined ? undefined : decodeProtoFields(usage.slice());
  const usages = primaryUsage === undefined ? [] : [primaryUsage];
  for (const retry of data.get(step ? 28 : 17) ?? []) {
    if (!(retry instanceof Uint8Array)) throw new Error("Invalid retry metadata");
    const retryUsage = protoBytesAt(decodeProtoFields(retry), 2);
    if (retryUsage !== undefined) usages.push(decodeProtoFields(retryUsage.slice()));
  }
  const names = [protoTextAt(model, step ? 12 : 19), protoTextAt(model, step ? 8 : 21)].map(
    modelName,
  );
  return {
    model:
      names.find(isConcreteAntigravityModel) ??
      names.find((name) => name && !/^model[_-]/.test(name)) ??
      "",
    modelId:
      protoNumberAt(model, step ? 1 : 3) ||
      (primaryUsage === undefined ? 0 : protoNumberAt(primaryUsage, 1)),
    timestampMs: step
      ? (protoTimestamp(protoNested(data, 8)) ?? protoTimestamp(protoNested(data, 1)))
      : protoTimestamp(protoNested(protoNested(data, 9), 4)),
    usages,
  };
}

export interface AntigravityUsageCandidate {
  record: UsageRecord;
  modelId: number;
  modelQuality: number;
  keys: readonly string[];
  timestampQuality: number;
}

export function buildAntigravityCandidates(
  sessionId: string,
  generations: ReadonlyArray<{ idx: number; entry: AntigravityMetadata }>,
  steps: ReadonlyArray<{ idx: number; entry: AntigravityMetadata }>,
  trajectoryTimestamp: number | null,
  fallbackTimestamp: number,
): AntigravityUsageCandidate[] {
  const records: AntigravityUsageCandidate[] = [];
  const generationModels = new Map(generations.map(({ idx, entry }) => [idx, entry]));
  for (const [source, entries] of [
    ["step", steps],
    ["generation", generations],
  ] as const) {
    for (const [index, { idx, entry }] of entries.entries()) {
      for (const [usageIndex, usage] of entry.usages.entries()) {
        const modelId = protoNumberAt(usage, 1) || entry.modelId;
        const generation = source === "step" ? generationModels.get(idx) : undefined;
        // A retry can use a different model than its enclosing generation or step.
        const matches = (meta: AntigravityMetadata) => modelId === 0 || meta.modelId === modelId;
        const model =
          matches(entry) && entry.model
            ? entry.model
            : generation && matches(generation)
              ? generation.model
              : "";
        const outputTokens = Math.max(
          protoNumberAt(usage, 3),
          protoNumberAt(usage, 9) + protoNumberAt(usage, 10),
        );
        const totals = {
          uncachedInputTokens: protoNumberAt(usage, 2),
          cachedInputTokens: protoNumberAt(usage, 5),
          cacheCreationTokens: protoNumberAt(usage, 4),
          outputTokens,
          reasoningTokens: Math.min(outputTokens, protoNumberAt(usage, 9)),
        };
        if (
          totals.uncachedInputTokens +
            totals.cachedInputTokens +
            totals.cacheCreationTokens +
            outputTokens ===
          0
        ) {
          continue;
        }
        const keys = ([11, 12, 7] as const).flatMap((key) => {
          const id = protoTextAt(usage, key);
          return id ? [`antigravity:${key}:${id}`] : [];
        });
        const record: UsageRecord = {
          provider: "antigravity",
          sessionId,
          timestampMs: entry.timestampMs ?? trajectoryTimestamp ?? fallbackTimestamp,
          model,
          totals,
          reportedCostUsd: null,
          speed: "standard",
          dedupeKey: keys[0] ?? `antigravity:${sessionId}:${source}:${index}:${usageIndex}`,
        };
        records.push({
          record,
          modelId,
          modelQuality: isConcreteAntigravityModel(model) ? 4 : model ? 1 : 0,
          keys,
          timestampQuality: entry.timestampMs !== null ? 2 : trajectoryTimestamp !== null ? 1 : 0,
        });
      }
    }
  }
  return records;
}

// Collapse duplicate step+generation records inside a single DB before caching.
// Only pre-merges a connected key component if it has a concrete (q4) model or one shared modelId.
export function dedupeSingleDbCandidates(
  candidates: readonly AntigravityUsageCandidate[],
): AntigravityUsageCandidate[] {
  if (candidates.length <= 1) return [...candidates];
  const parent = candidates.map((_, index) => index);
  const find = (index: number): number => {
    let root = index;
    while (parent[root]! !== root) root = parent[root]!;
    while (index !== root) {
      const next = parent[index]!;
      parent[index] = root;
      index = next;
    }
    return root;
  };
  const identities = new Map<string, number>();
  for (const [index, candidate] of candidates.entries()) {
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) {
        const a = find(index);
        const b = find(existing);
        if (a !== b) parent[a] = b;
      }
      identities.set(key, index);
    }
  }
  const components = new Map<number, number[]>();
  for (let index = 0; index < candidates.length; index++) {
    const root = find(index);
    const members = components.get(root);
    if (members !== undefined) members.push(index);
    else components.set(root, [index]);
  }
  const out: Array<{ owner: number; candidate: AntigravityUsageCandidate }> = [];
  for (const members of components.values()) {
    if (members.length === 1) {
      const owner = members[0]!;
      out.push({ owner, candidate: candidates[owner]! });
      continue;
    }
    const firstModelId = candidates[members[0]!]!.modelId;
    let maxQuality = 0;
    let sameModelId = true;
    for (const memberIndex of members) {
      const c = candidates[memberIndex]!;
      if (c.modelQuality > maxQuality) maxQuality = c.modelQuality;
      if (c.modelId !== firstModelId) sameModelId = false;
    }
    let uniqueTopModel = true;
    if (maxQuality > 0) {
      let topModel: string | undefined;
      for (const memberIndex of members) {
        const c = candidates[memberIndex]!;
        if (c.modelQuality !== maxQuality) continue;
        if (topModel === undefined) topModel = c.record.model;
        else if (topModel !== c.record.model) {
          uniqueTopModel = false;
          break;
        }
      }
    }
    if ((maxQuality < 4 && !sameModelId) || !uniqueTopModel) {
      for (const memberIndex of members) {
        out.push({ owner: memberIndex, candidate: candidates[memberIndex]! });
      }
      continue;
    }
    // All highest-quality members share one model, so merge order cannot alter model choice.
    let merged = candidates[members[0]!]!;
    const keySet = new Set<string>(merged.keys);
    for (let i = 1; i < members.length; i++) {
      const next = candidates[members[i]!]!;
      const bestModel = next.modelQuality > merged.modelQuality ? next : merged;
      const bestTime =
        next.timestampQuality > merged.timestampQuality ||
        (next.timestampQuality === merged.timestampQuality &&
          next.record.timestampMs < merged.record.timestampMs)
          ? next
          : merged;
      const x = merged.record.totals;
      const y = next.record.totals;
      merged = {
        record: {
          ...merged.record,
          model: bestModel.record.model,
          timestampMs: bestTime.record.timestampMs,
          totals: {
            uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
            cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
            cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
            outputTokens: Math.max(x.outputTokens, y.outputTokens),
            reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
          },
        },
        modelId: bestModel.modelId,
        modelQuality: bestModel.modelQuality,
        keys: merged.keys,
        timestampQuality: bestTime.timestampQuality,
      };
      for (const key of next.keys) keySet.add(key);
    }
    out.push({
      owner: members[0]!,
      candidate: { ...merged, keys: [...keySet] },
    });
  }
  out.sort((a, b) => a.owner - b.owner);
  return out.map((item) => item.candidate);
}
