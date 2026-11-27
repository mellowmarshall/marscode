// @effect-diagnostics globalDate:off - Review Stats' server cache over @t3tools/playbook's stored records and live T3 review threads.
import {
  collectReviewRecords,
  appendReviewStatRecord,
  defaultPlaybookStateDir,
  defaultReviewStatsJsonlPath,
  defaultShipJobsDir,
  reviewStatsWriteGeneration,
} from "@t3tools/playbook/statsStore";
import { sortRecordsNewestFirst } from "@t3tools/playbook/statsAggregate";
import type { ReviewStatRecord, ReviewStatsPaths } from "@t3tools/playbook/statsTypes";

import {
  buildRecordFromDelegatedReview,
  buildSubmitterLookupFromRows,
  classifyFromThreadInfo,
  deriveRepoNameFromWorktree,
  type DelegatedReviewSubagentRow,
  type SubmitterProjectionRow,
  type ThreadSubmitterLookup,
} from "./ReviewStatsThreads.ts";

export function shouldAutoRecordDelegatedReview(): boolean {
  return !process.env.VITEST || Boolean(process.env.T3_REVIEW_STATS_JSONL);
}

/** Record a completed delegated review thread into review-stats.jsonl once. */
export function tryRecordCompletedDelegatedReview(
  row: DelegatedReviewSubagentRow,
  parentRows: ReadonlyArray<SubmitterProjectionRow>,
  jsonlPath: string = defaultReviewStatsJsonlPath(),
): ReviewStatRecord | null {
  if (!shouldAutoRecordDelegatedReview()) return null;
  try {
    const lookup = buildSubmitterLookupFromRows(parentRows);
    const record = buildRecordFromDelegatedReview(row, lookup, new Date().toISOString());
    if (!record) return null;
    appendReviewStatRecord(record, jsonlPath);
    return record;
  } catch {
    return null;
  }
}

function enrichActors(
  rec: ReviewStatRecord,
  lookup: ThreadSubmitterLookup | undefined,
): ReviewStatRecord {
  if (!lookup) return rec;
  let next = rec;
  const parentById = rec.threadId ? lookup.byThreadId.get(rec.threadId) : undefined;
  if (rec.submitter.model === "unknown") {
    const info =
      parentById ??
      (rec.worktree ? lookup.byWorktree.get(rec.worktree) : undefined) ??
      (rec.branch ? lookup.byBranch.get(rec.branch) : undefined);
    if (info) next = { ...next, submitter: classifyFromThreadInfo(info) };
  }
  if (parentById) {
    const worktree = next.worktree || parentById.worktreePath || "";
    const branch = next.branch || parentById.branch || "";
    const repo =
      next.repo && next.repo !== "unknown" ? next.repo : deriveRepoNameFromWorktree(worktree);
    if (worktree !== next.worktree || branch !== next.branch || repo !== next.repo) {
      next = { ...next, worktree, branch, repo };
    }
  }
  if (rec.reviewThreadId) {
    const revInfo = lookup.byThreadId.get(rec.reviewThreadId);
    if (revInfo) next = { ...next, reviewer: classifyFromThreadInfo(revInfo) };
  }
  return next;
}

/** Every record: the playbook store's, live delegated reviews merged in, actors enriched, newest first. */
export function loadReviewRecords(
  paths: ReviewStatsPaths = {},
  lookup?: ThreadSubmitterLookup,
  delegatedReviews?: ReadonlyArray<DelegatedReviewSubagentRow>,
): ReadonlyArray<ReviewStatRecord> {
  const nowIso = new Date().toISOString();
  const live = (delegatedReviews ?? []).flatMap((row) => {
    const rec = buildRecordFromDelegatedReview(row, lookup, nowIso);
    return rec ? [rec] : [];
  });
  return sortRecordsNewestFirst(
    collectReviewRecords(paths, live).map((rec) => enrichActors(rec, lookup)),
  );
}

const REVIEW_RECORDS_CACHE_TTL_MS = 30_000;
let cachedReviewSnapshot: {
  readonly cacheKey: string;
  readonly generation: number;
  readonly loadedAtMs: number;
  readonly lookupRef: ThreadSubmitterLookup | undefined;
  readonly delegatedRef: ReadonlyArray<DelegatedReviewSubagentRow> | undefined;
  readonly records: ReadonlyArray<ReviewStatRecord>;
} | null = null;
let cachedSubmitterLookup: {
  readonly fetchedAtMs: number;
  readonly lookup: ThreadSubmitterLookup;
} | null = null;
let cachedDelegatedReviews: {
  readonly fetchedAtMs: number;
  readonly rows: ReadonlyArray<DelegatedReviewSubagentRow>;
} | null = null;

export function getCachedSubmitterLookup(forceRefresh = false): ThreadSubmitterLookup | null {
  if (forceRefresh || !cachedSubmitterLookup) return null;
  if (Date.now() - cachedSubmitterLookup.fetchedAtMs >= REVIEW_RECORDS_CACHE_TTL_MS) return null;
  return cachedSubmitterLookup.lookup;
}

export function setCachedSubmitterLookup(lookup: ThreadSubmitterLookup): void {
  cachedSubmitterLookup = { fetchedAtMs: Date.now(), lookup };
}

export function getCachedDelegatedReviews(
  forceRefresh = false,
): ReadonlyArray<DelegatedReviewSubagentRow> | null {
  if (forceRefresh || !cachedDelegatedReviews) return null;
  if (Date.now() - cachedDelegatedReviews.fetchedAtMs >= REVIEW_RECORDS_CACHE_TTL_MS) return null;
  return cachedDelegatedReviews.rows;
}

export function setCachedDelegatedReviews(rows: ReadonlyArray<DelegatedReviewSubagentRow>): void {
  cachedDelegatedReviews = { fetchedAtMs: Date.now(), rows };
}

export function loadReviewRecordsCached(
  paths: ReviewStatsPaths = {},
  lookup?: ThreadSubmitterLookup,
  options?: {
    readonly forceRefresh?: boolean;
    readonly delegatedReviews?: ReadonlyArray<DelegatedReviewSubagentRow> | undefined;
  },
): ReadonlyArray<ReviewStatRecord> {
  const resolved = {
    playbookStateDir: paths.playbookStateDir ?? defaultPlaybookStateDir(),
    shipJobsDir: paths.shipJobsDir ?? defaultShipJobsDir(),
    jsonlPath: paths.jsonlPath ?? defaultReviewStatsJsonlPath(),
  };
  const cacheKey = `${resolved.playbookStateDir}\0${resolved.shipJobsDir}\0${resolved.jsonlPath}`;
  const generation = reviewStatsWriteGeneration();
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedReviewSnapshot &&
    cachedReviewSnapshot.cacheKey === cacheKey &&
    cachedReviewSnapshot.generation === generation &&
    cachedReviewSnapshot.lookupRef === lookup &&
    cachedReviewSnapshot.delegatedRef === options?.delegatedReviews &&
    now - cachedReviewSnapshot.loadedAtMs < REVIEW_RECORDS_CACHE_TTL_MS
  ) {
    return cachedReviewSnapshot.records;
  }
  const records = loadReviewRecords(resolved, lookup, options?.delegatedReviews);
  cachedReviewSnapshot = {
    cacheKey,
    generation,
    loadedAtMs: now,
    lookupRef: lookup,
    delegatedRef: options?.delegatedReviews,
    records,
  };
  return records;
}
