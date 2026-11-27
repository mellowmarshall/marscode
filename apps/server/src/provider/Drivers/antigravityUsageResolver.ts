import type { UsageRecord } from "@t3tools/provider-core/server/usage";
import * as Effect from "effect/Effect";

import {
  ANTIGRAVITY_MODEL_IDS,
  type AntigravityUsageCandidate,
  rememberAntigravityModel,
  withAntigravityRateModel,
} from "./antigravityProtobuf.ts";

interface AntigravityDatabaseData {
  readonly candidates: readonly AntigravityUsageCandidate[];
  readonly models: ReadonlyMap<number, string | null>;
}

export interface AntigravityActiveFile {
  readonly root: string;
  readonly path: string;
  readonly canonical: string;
  readonly fingerprint: string;
  readonly data: AntigravityDatabaseData;
}

interface MemoizedFile extends AntigravityActiveFile {
  readonly records: readonly UsageRecord[];
  readonly minTimestampMs: number;
  readonly maxTimestampMs: number;
  readonly keys: readonly string[];
}

interface MemoizedSnapshot {
  readonly files: readonly MemoizedFile[];
  readonly models: ReadonlyMap<number, string | null>;
  readonly keyOwner: Map<string, string>;
  readonly hadCrossFileMerge: boolean;
}

interface MergeGroup extends AntigravityUsageCandidate {
  parent: number;
  size: number;
  owner: number;
  fileIndex: number;
}

const MAX_INCREMENTAL_FILES = 32;
const memoSnapshots = new WeakMap<object, MemoizedSnapshot>();

function resolveModelFields(
  candidate: AntigravityUsageCandidate,
  models: ReadonlyMap<number, string | null>,
) {
  const learned = models.get(candidate.modelId);
  const fallback = learned === null ? undefined : ANTIGRAVITY_MODEL_IDS[candidate.modelId];
  const model =
    (candidate.modelQuality === 4 ? candidate.record.model : "") ||
    learned ||
    fallback ||
    candidate.record.model ||
    (candidate.modelId > 0 ? `antigravity-model-${candidate.modelId}` : "antigravity-unknown");
  const record =
    model === candidate.record.model ? candidate.record : { ...candidate.record, model };
  const modelQuality =
    candidate.modelQuality === 4 ? 4 : learned ? 3 : fallback ? 2 : candidate.modelQuality;
  return { record, modelQuality };
}

function createGroupMerger() {
  const groups: MergeGroup[] = [];
  const identities = new Map<string, number>();
  const find = (index: number): number => {
    let root = index;
    while (groups[root]!.parent !== root) root = groups[root]!.parent;
    while (index !== root) {
      const parent = groups[index]!.parent;
      groups[index]!.parent = root;
      index = parent;
    }
    return root;
  };
  const merge = (left: number, right: number): number => {
    let a = find(left);
    let b = find(right);
    if (a === b) return a;
    if (groups[a]!.size < groups[b]!.size) [a, b] = [b, a];
    const target = groups[a]!;
    const source = groups[b]!;
    const first = target.owner < source.owner ? target : source;
    const bestModel =
      source.modelQuality === target.modelQuality
        ? first
        : source.modelQuality > target.modelQuality
          ? source
          : target;
    const bestTime =
      source.timestampQuality > target.timestampQuality ||
      (source.timestampQuality === target.timestampQuality &&
        source.record.timestampMs < target.record.timestampMs)
        ? source
        : target;
    const x = target.record.totals;
    const y = source.record.totals;
    target.record = {
      ...first.record,
      model: bestModel.record.model,
      timestampMs: bestTime.record.timestampMs,
      totals: {
        uncachedInputTokens: Math.max(x.uncachedInputTokens, y.uncachedInputTokens),
        cachedInputTokens: Math.max(x.cachedInputTokens, y.cachedInputTokens),
        cacheCreationTokens: Math.max(x.cacheCreationTokens, y.cacheCreationTokens),
        outputTokens: Math.max(x.outputTokens, y.outputTokens),
        reasoningTokens: Math.max(x.reasoningTokens, y.reasoningTokens),
      },
    };
    target.timestampQuality = bestTime.timestampQuality;
    target.modelQuality = bestModel.modelQuality;
    target.owner = first.owner;
    target.fileIndex = first.fileIndex;
    target.size += source.size;
    source.parent = a;
    return a;
  };
  const append = (
    candidate: AntigravityUsageCandidate,
    models: ReadonlyMap<number, string | null>,
    fileIndex: number,
  ) => {
    const index = groups.length;
    const { record, modelQuality } = resolveModelFields(candidate, models);
    groups.push({
      record,
      modelId: candidate.modelId,
      modelQuality,
      keys: candidate.keys,
      timestampQuality: candidate.timestampQuality,
      parent: index,
      size: 1,
      owner: index,
      fileIndex,
    });
    for (const key of candidate.keys) {
      const existing = identities.get(key);
      if (existing !== undefined) merge(index, existing);
      identities.set(key, index);
    }
  };
  return { groups, append };
}

function summarizeBounds(records: readonly UsageRecord[]) {
  let minTimestampMs = Infinity;
  let maxTimestampMs = -Infinity;
  for (const record of records) {
    if (record.timestampMs < minTimestampMs) minTimestampMs = record.timestampMs;
    if (record.timestampMs > maxTimestampMs) maxTimestampMs = record.timestampMs;
  }
  return { minTimestampMs, maxTimestampMs };
}

const resolveSingleFile = Effect.fnUntraced(function* (
  entry: AntigravityActiveFile,
  models: ReadonlyMap<number, string | null>,
) {
  const { groups, append } = createGroupMerger();
  const keySet = new Set<string>();
  for (const [index, candidate] of entry.data.candidates.entries()) {
    for (const key of candidate.keys) keySet.add(key);
    append(candidate, models, 0);
    if (index % 256 === 255) yield* Effect.yieldNow;
  }
  const records: UsageRecord[] = [];
  for (const [index, group] of groups.entries()) {
    if (group.parent === index) records.push(withAntigravityRateModel(group.record));
  }
  const { minTimestampMs, maxTimestampMs } = summarizeBounds(records);
  return {
    ...entry,
    records,
    minTimestampMs,
    maxTimestampMs,
    keys: [...keySet],
  } satisfies MemoizedFile;
});

const resolveAllFiles = Effect.fnUntraced(function* (
  activeFiles: readonly AntigravityActiveFile[],
  models: ReadonlyMap<number, string | null>,
) {
  const { groups, append } = createGroupMerger();
  const keyOwner = new Map<string, string>();
  const fileKeys = activeFiles.map(() => new Set<string>());
  let hadCrossFileMerge = false;
  let processed = 0;
  for (const [fileIndex, entry] of activeFiles.entries()) {
    const keysForFile = fileKeys[fileIndex]!;
    for (const candidate of entry.data.candidates) {
      for (const key of candidate.keys) {
        keysForFile.add(key);
        const prev = keyOwner.get(key);
        if (prev === undefined) keyOwner.set(key, entry.canonical);
        else if (prev !== entry.canonical) hadCrossFileMerge = true;
      }
      append(candidate, models, fileIndex);
      if (++processed % 256 === 0) yield* Effect.yieldNow;
    }
  }
  const recordsByFile: UsageRecord[][] = activeFiles.map(() => []);
  for (const [index, group] of groups.entries()) {
    if (group.parent === index) {
      recordsByFile[group.fileIndex]!.push(withAntigravityRateModel(group.record));
    }
  }
  const memoFiles: MemoizedFile[] = activeFiles.map((entry, index) => {
    const records = recordsByFile[index]!;
    const { minTimestampMs, maxTimestampMs } = summarizeBounds(records);
    return {
      ...entry,
      records,
      minTimestampMs,
      maxTimestampMs,
      keys: [...fileKeys[index]!],
    };
  });
  return { files: memoFiles, models, keyOwner, hadCrossFileMerge } satisfies MemoizedSnapshot;
});

function modelsEqual(
  a: ReadonlyMap<number, string | null>,
  b: ReadonlyMap<number, string | null>,
): boolean {
  if (a.size !== b.size) return false;
  for (const [id, model] of a) {
    if (!b.has(id) || b.get(id) !== model) return false;
  }
  return true;
}

function isExactMemoHit(
  memo: MemoizedSnapshot,
  activeFiles: readonly AntigravityActiveFile[],
): boolean {
  if (memo.files.length !== activeFiles.length) return false;
  for (let i = 0; i < activeFiles.length; i++) {
    const prev = memo.files[i]!;
    const cur = activeFiles[i]!;
    if (
      prev.canonical !== cur.canonical ||
      prev.fingerprint !== cur.fingerprint ||
      prev.data !== cur.data ||
      prev.root !== cur.root ||
      prev.path !== cur.path
    ) {
      return false;
    }
  }
  return true;
}

function filterMemoFiles(memoFiles: readonly MemoizedFile[], sinceMs: number) {
  return memoFiles.map((file) => {
    if (file.records.length === 0 || file.maxTimestampMs < sinceMs) {
      return { root: file.root, path: file.path, records: [] as UsageRecord[] };
    }
    if (file.minTimestampMs >= sinceMs) {
      return { root: file.root, path: file.path, records: [...file.records] };
    }
    return {
      root: file.root,
      path: file.path,
      records: file.records.filter((record) => record.timestampMs >= sinceMs),
    };
  });
}

const tryIncrementalUpdate = Effect.fnUntraced(function* (
  cacheKey: object,
  memo: MemoizedSnapshot,
  activeFiles: readonly AntigravityActiveFile[],
  nextModels: ReadonlyMap<number, string | null>,
) {
  if (memo.hadCrossFileMerge || !modelsEqual(memo.models, nextModels)) return null;
  const oldByCanonical = new Map(memo.files.map((file) => [file.canonical, file]));
  const activeCanonicals = new Set(activeFiles.map((file) => file.canonical));
  const removedFiles = memo.files.filter((file) => !activeCanonicals.has(file.canonical));
  const changedFiles: AntigravityActiveFile[] = [];
  for (const cur of activeFiles) {
    const prev = oldByCanonical.get(cur.canonical);
    if (
      prev === undefined ||
      prev.fingerprint !== cur.fingerprint ||
      prev.data !== cur.data ||
      prev.root !== cur.root ||
      prev.path !== cur.path
    ) {
      changedFiles.push(cur);
    }
  }
  if (changedFiles.length + removedFiles.length > MAX_INCREMENTAL_FILES) return null;
  const replacedCanonicals = new Set<string>();
  for (const file of removedFiles) replacedCanonicals.add(file.canonical);
  for (const file of changedFiles) replacedCanonicals.add(file.canonical);
  const newKeys = new Map<string, string>();
  for (const file of changedFiles) {
    for (const candidate of file.data.candidates) {
      for (const key of candidate.keys) {
        const seenInBatch = newKeys.get(key);
        if (seenInBatch !== undefined && seenInBatch !== file.canonical) return null;
        const existingOwner = memo.keyOwner.get(key);
        if (existingOwner !== undefined && !replacedCanonicals.has(existingOwner)) return null;
        newKeys.set(key, file.canonical);
      }
    }
  }
  const patchedByCanonical = new Map<string, MemoizedFile>();
  for (const file of changedFiles) {
    patchedByCanonical.set(file.canonical, yield* resolveSingleFile(file, nextModels));
  }
  // Guard, mutate, and publish synchronously with no yield in between.
  if (memoSnapshots.get(cacheKey) !== memo) return null;
  for (const file of removedFiles) {
    for (const key of file.keys) memo.keyOwner.delete(key);
  }
  for (const file of changedFiles) {
    const prev = oldByCanonical.get(file.canonical);
    if (prev !== undefined) {
      for (const key of prev.keys) memo.keyOwner.delete(key);
    }
  }
  for (const [key, canonical] of newKeys) memo.keyOwner.set(key, canonical);
  const nextFiles = activeFiles.map(
    (file) => patchedByCanonical.get(file.canonical) ?? oldByCanonical.get(file.canonical)!,
  );
  const patched: MemoizedSnapshot = {
    files: nextFiles,
    models: nextModels,
    keyOwner: memo.keyOwner,
    hadCrossFileMerge: false,
  };
  memoSnapshots.set(cacheKey, patched);
  return patched;
});

export const resolveAntigravityFiles = Effect.fnUntraced(function* (
  activeFiles: readonly AntigravityActiveFile[],
  sinceMs: number,
  cacheKey: object | undefined,
  allowMemo: boolean,
) {
  const prevMemo = cacheKey !== undefined ? memoSnapshots.get(cacheKey) : undefined;
  if (prevMemo !== undefined && allowMemo && isExactMemoHit(prevMemo, activeFiles)) {
    return filterMemoFiles(prevMemo.files, sinceMs);
  }
  const models = new Map<number, string | null>();
  for (const file of activeFiles) {
    for (const [id, model] of file.data.models) {
      rememberAntigravityModel(models, id, model);
    }
  }
  if (prevMemo !== undefined && cacheKey !== undefined && allowMemo) {
    const patched = yield* tryIncrementalUpdate(cacheKey, prevMemo, activeFiles, models);
    if (patched !== null) {
      return filterMemoFiles(patched.files, sinceMs);
    }
  }
  const snapshot = yield* resolveAllFiles(activeFiles, models);
  if (cacheKey !== undefined && allowMemo) {
    memoSnapshots.set(cacheKey, snapshot);
  }
  return filterMemoFiles(snapshot.files, sinceMs);
});
