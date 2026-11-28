/** Review-stats aggregation: group, total and rank records for one side and grouping. */
import type { ClassifiedModel } from "./modelClassify.ts";
import type {
  ReviewStatRecord,
  ReviewStatsGroupBy,
  ReviewStatsGroupRow,
  ReviewStatsHighlight,
  ReviewStatsQuery,
  ReviewStatsResponse,
  ReviewStatsSide,
} from "./statsTypes.ts";

/** Newest first by timestamp (ISO strings that do not parse sort as text). */
export function sortRecordsNewestFirst(
  records: ReadonlyArray<ReviewStatRecord>,
): ReadonlyArray<ReviewStatRecord> {
  return records.toSorted((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) return tb - ta;
    return a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;
  });
}

function modelLabel(actor: ClassifiedModel): string {
  return actor.effort ? `${actor.model} (${actor.effort})` : actor.model;
}

function groupKey(rec: ReviewStatRecord, side: ReviewStatsSide, by: ReviewStatsGroupBy): string {
  if (side === "pair") {
    return `${modelLabel(rec.submitter)} → ${modelLabel(rec.reviewer)}`;
  }
  const actor = side === "submitter" ? rec.submitter : rec.reviewer;
  switch (by) {
    case "model":
      return modelLabel(actor);
    case "family":
      return actor.family || "Unknown";
    case "lab":
      return actor.lab || "Unknown";
    case "provider":
      return actor.provider || "unknown";
    case "effort":
      return actor.effort || "default";
    case "repo":
      return rec.repo || "unknown";
    case "source":
      return rec.source;
    case "day":
      return rec.timestamp.slice(0, 10) || "unknown";
  }
}

interface MutableBucket {
  readonly key: string;
  model?: string | undefined;
  effort?: string | undefined;
  family?: string | undefined;
  reviews: number;
  passed: number;
  flagged: number;
  bypasses: number;
  friction: number;
  fallbacks: number;
  challenges: number;
  overrides: number;
  breaking: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

function newBucket(key: string): MutableBucket {
  return {
    key,
    reviews: 0,
    passed: 0,
    flagged: 0,
    bypasses: 0,
    friction: 0,
    fallbacks: 0,
    challenges: 0,
    overrides: 0,
    breaking: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    total: 0,
  };
}

function accumulate(bucket: MutableBucket, rec: ReviewStatRecord): void {
  const isPass = rec.verdict === "pass";
  bucket.reviews += 1;
  if (isPass) bucket.passed += 1;
  else bucket.flagged += 1;
  if (rec.bypassDetected) bucket.bypasses += 1;
  if (rec.playbookFriction) bucket.friction += 1;
  if (rec.fallbackUsed) bucket.fallbacks += 1;
  if (
    rec.source === "playbook_challenge" &&
    (rec.verdict === "challenged" || rec.verdict === "rejected_budget")
  ) {
    bucket.challenges += 1;
  }
  if (rec.overridden) bucket.overrides += 1;
  bucket.breaking += rec.counts.breaking;
  bucket.critical += rec.counts.critical;
  bucket.high += rec.counts.high;
  bucket.medium += rec.counts.medium;
  bucket.low += rec.counts.low;
  bucket.info += rec.counts.info;
  bucket.total += rec.counts.total;
}

function finalizeBucket(b: MutableBucket): ReviewStatsGroupRow {
  return {
    ...b,
    passRatePct: b.reviews > 0 ? Math.round((1000 * b.passed) / b.reviews) / 10 : 0,
    avgIssues: b.reviews > 0 ? Math.round((100 * b.total) / b.reviews) / 100 : 0,
  };
}

function computeTopActor(
  records: ReadonlyArray<ReviewStatRecord>,
  side: "submitter" | "reviewer",
): ReviewStatsHighlight | null {
  const map = new Map<string, MutableBucket>();
  for (const rec of records) {
    const actor = side === "submitter" ? rec.submitter : rec.reviewer;
    if (actor.model === "unknown" || actor.model === "owner-bypass") continue;
    const key = modelLabel(actor);
    let b = map.get(key);
    if (!b) {
      b = newBucket(key);
      map.set(key, b);
    }
    accumulate(b, rec);
  }
  const ranked = Array.from(map.values())
    .filter((b) => b.total > 0)
    .toSorted((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      const avgDiff = b.total / b.reviews - a.total / a.reviews;
      if (avgDiff !== 0) return avgDiff;
      return b.reviews - a.reviews;
    });
  const top = ranked[0];
  if (!top) return null;
  return {
    label: top.key,
    reviews: top.reviews,
    totalIssues: top.total,
    avgIssues: Math.round((100 * top.total) / top.reviews) / 100,
    breaking: top.breaking,
    critical: top.critical,
    high: top.high,
  };
}

export function aggregateReviewStats(
  allRecords: ReadonlyArray<ReviewStatRecord>,
  query: ReviewStatsQuery = {},
): ReviewStatsResponse {
  const localHost = (query.localHostName ?? "localhost").split(".")[0] || "localhost";
  const side: ReviewStatsSide = query.side ?? "reviewer";
  const by: ReviewStatsGroupBy = query.by ?? "model";
  const includeBypasses = query.includeBypasses === true;
  const cutoffMs =
    typeof query.days === "number" && query.days > 0 && typeof query.nowMs === "number"
      ? query.nowMs - query.days * 86_400_000
      : null;

  const repoSet = new Set<string>();
  const labSet = new Set<string>();
  const familySet = new Set<string>();
  const hostSet = new Set<string>([localHost]);
  const filtered: ReviewStatRecord[] = [];

  for (const rec of allRecords) {
    if (!includeBypasses && rec.verdict === "bypassed") continue;
    if (rec.repo && rec.repo !== "unknown") repoSet.add(rec.repo);
    const facetActor = side === "submitter" ? rec.submitter : rec.reviewer;
    if (facetActor.lab && facetActor.lab !== "Unknown") labSet.add(facetActor.lab);
    if (facetActor.family && facetActor.family !== "Unknown") familySet.add(facetActor.family);

    if (
      query.host &&
      query.host !== "all" &&
      query.host.toLowerCase() !== localHost.toLowerCase()
    ) {
      continue;
    }
    if (query.source && query.source !== "all" && rec.source !== query.source) continue;
    if (query.repo && rec.repo !== query.repo) continue;
    if (query.lab && facetActor.lab.toLowerCase() !== query.lab.toLowerCase()) continue;
    if (query.family && facetActor.family.toLowerCase() !== query.family.toLowerCase()) continue;
    if (cutoffMs !== null) {
      const ts = Date.parse(rec.timestamp);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    }
    filtered.push(rec);
  }

  const totals = newBucket("all");
  const buckets = new Map<string, MutableBucket>();
  for (const rec of filtered) {
    accumulate(totals, rec);
    const key = groupKey(rec, side, by);
    let b = buckets.get(key);
    if (!b) {
      b = newBucket(key);
      if (by === "model" && side !== "pair") {
        const actor = side === "submitter" ? rec.submitter : rec.reviewer;
        b.model = actor.model || "unknown";
        b.effort = actor.effort || "default";
        b.family = actor.family || "Unknown";
      }
      buckets.set(key, b);
    }
    accumulate(b, rec);
  }

  const groups = Array.from(buckets.values(), finalizeBucket).toSorted((a, b) => {
    if (by === "day") return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
    if (b.total !== a.total) return b.total - a.total;
    if (b.flagged !== a.flagged) return b.flagged - a.flagged;
    if (b.reviews !== a.reviews) return b.reviews - a.reviews;
    return a.key.localeCompare(b.key);
  });

  const recentLimit = Math.max(1, Math.min(200, query.recentLimit ?? 80));
  return {
    side,
    by,
    totals: finalizeBucket(totals),
    groups,
    recent: filtered.slice(0, recentLimit),
    highlights: {
      topBugSubmitter: computeTopActor(filtered, "submitter"),
      topBugCatcher: computeTopActor(filtered, "reviewer"),
    },
    facets: {
      repos: Array.from(repoSet).toSorted(),
      labs: Array.from(labSet).toSorted(),
      families: Array.from(familySet).toSorted(),
      hosts: Array.from(hostSet).toSorted(),
    },
  };
}
