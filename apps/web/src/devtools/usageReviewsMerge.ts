/** Pure aggregation and Model -> Effort grouping helpers for multi-environment Usage Reviews + Cerno stats. */
import type {
  CernoGroupRow,
  CernoStatsPayload,
  ReviewStatsGroupRow,
  ReviewStatsHighlight,
  ReviewStatsPayload,
} from "./devtoolsClient";

export interface ModelEffortGroup {
  readonly model: string;
  readonly family: string;
  readonly reviews: number;
  readonly passed: number;
  readonly challenges: number;
  readonly overrides: number;
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly total: number;
  readonly efforts: ReadonlyArray<ReviewStatsGroupRow>;
}

function parseModelAndEffort(row: ReviewStatsGroupRow): { model: string; effort: string } {
  if (row.model) return { model: row.model, effort: row.effort || "default" };
  if (row.key.includes(" → ")) return { model: row.key, effort: "default" };
  const m = /^(.+?)\s+\(([^)]+)\)$/.exec(row.key.trim());
  return m?.[1] && m[2]
    ? { model: m[1].trim(), effort: m[2].trim() }
    : { model: row.key, effort: "default" };
}

type MutableModelGroup = {
  -readonly [K in Exclude<keyof ModelEffortGroup, "efforts">]: ModelEffortGroup[K];
} & { efforts: ReviewStatsGroupRow[] };

export function groupRowsByModelAndEffort(
  rows: ReadonlyArray<ReviewStatsGroupRow>,
): ReadonlyArray<ModelEffortGroup> {
  const byModel = new Map<string, MutableModelGroup>();
  for (const row of rows) {
    const { model, effort } = parseModelAndEffort(row);
    let grp = byModel.get(model);
    if (!grp) {
      grp = {
        model,
        family: row.family ?? "",
        reviews: 0,
        passed: 0,
        challenges: 0,
        overrides: 0,
        breaking: 0,
        critical: 0,
        high: 0,
        medium: 0,
        low: 0,
        info: 0,
        total: 0,
        efforts: [],
      };
      byModel.set(model, grp);
    }
    grp.reviews += row.reviews;
    grp.passed += row.passed;
    grp.challenges += row.challenges ?? 0;
    grp.overrides += row.overrides ?? 0;
    grp.breaking += row.breaking;
    grp.critical += row.critical;
    grp.high += row.high;
    grp.medium += row.medium;
    grp.low += row.low;
    grp.info += row.info;
    grp.total += row.total;
    grp.efforts.push({ ...row, model, effort });
  }
  const sortDesc = (
    a: { total: number; reviews: number },
    b: { total: number; reviews: number },
  ) => (b.total !== a.total ? b.total - a.total : b.reviews - a.reviews);
  return Array.from(byModel.values())
    .map((g) => ({ ...g, efforts: g.efforts.toSorted(sortDesc) }))
    .toSorted(sortDesc);
}

function addReviewRows(base: ReviewStatsGroupRow, inc: ReviewStatsGroupRow): ReviewStatsGroupRow {
  const reviews = base.reviews + inc.reviews;
  const passed = base.passed + inc.passed;
  const total = base.total + inc.total;
  return {
    ...base,
    reviews,
    passed,
    flagged: base.flagged + inc.flagged,
    passRatePct: reviews > 0 ? Math.round((passed / reviews) * 1000) / 10 : 0,
    avgIssues: reviews > 0 ? Math.round((total / reviews) * 100) / 100 : 0,
    bypasses: base.bypasses + inc.bypasses,
    friction: base.friction + inc.friction,
    fallbacks: base.fallbacks + inc.fallbacks,
    challenges: (base.challenges ?? 0) + (inc.challenges ?? 0),
    overrides: (base.overrides ?? 0) + (inc.overrides ?? 0),
    breaking: base.breaking + inc.breaking,
    critical: base.critical + inc.critical,
    high: base.high + inc.high,
    medium: base.medium + inc.medium,
    low: base.low + inc.low,
    info: base.info + inc.info,
    total,
  };
}

function pickTopHighlight(
  items: ReadonlyArray<ReviewStatsHighlight | null>,
): ReviewStatsHighlight | null {
  let best: ReviewStatsHighlight | null = null;
  for (const item of items) {
    if (!item) continue;
    if (
      !best ||
      item.totalIssues > best.totalIssues ||
      (item.totalIssues === best.totalIssues && item.avgIssues > best.avgIssues)
    ) {
      best = item;
    }
  }
  return best;
}

function unionSorted(
  lists: ReadonlyArray<ReadonlyArray<string> | undefined>,
): ReadonlyArray<string> {
  const set = new Set<string>();
  for (const list of lists) {
    if (!list) continue;
    for (const item of list) {
      if (item) set.add(item);
    }
  }
  return Array.from(set).toSorted();
}

export function mergeReviewStatsPayloads(
  payloads: ReadonlyArray<ReviewStatsPayload>,
): ReviewStatsPayload | null {
  if (payloads.length === 0) return null;
  if (payloads.length === 1) return payloads[0]!;

  const first = payloads[0]!;
  let totals = first.totals;
  for (let i = 1; i < payloads.length; i += 1) {
    totals = addReviewRows(totals, payloads[i]!.totals);
  }

  const groupMap = new Map<string, ReviewStatsGroupRow>();
  for (const p of payloads) {
    for (const row of p.groups) {
      const existing = groupMap.get(row.key);
      groupMap.set(row.key, existing ? addReviewRows(existing, row) : row);
    }
  }
  const groups = Array.from(groupMap.values()).toSorted((a, b) =>
    b.total !== a.total ? b.total - a.total : b.reviews - a.reviews,
  );
  const recent = payloads
    .flatMap((p) => p.recent)
    .toSorted((a, b) => b.timestamp.localeCompare(a.timestamp))
    .slice(0, 40);

  return {
    side: first.side,
    by: first.by,
    totals,
    groups,
    recent,
    highlights: {
      topBugSubmitter: pickTopHighlight(payloads.map((p) => p.highlights.topBugSubmitter)),
      topBugCatcher: pickTopHighlight(payloads.map((p) => p.highlights.topBugCatcher)),
    },
    facets: {
      repos: unionSorted(payloads.map((p) => p.facets.repos)),
      labs: unionSorted(payloads.map((p) => p.facets.labs)),
      families: unionSorted(payloads.map((p) => p.facets.families)),
      hosts: unionSorted(payloads.map((p) => p.facets.hosts)),
    },
  };
}

function addCernoRows(base: CernoGroupRow, inc: CernoGroupRow): CernoGroupRow {
  return {
    key: base.key,
    captures: base.captures + inc.captures,
    complete: base.complete + inc.complete,
    pass: base.pass + inc.pass,
    fail: base.fail + inc.fail,
    alerts: base.alerts + inc.alerts,
    disagreements: base.disagreements + inc.disagreements,
    streamBytes: base.streamBytes + inc.streamBytes,
  };
}

function mergeCernoGroupLists(
  lists: ReadonlyArray<ReadonlyArray<CernoGroupRow>>,
): ReadonlyArray<CernoGroupRow> {
  const byKey = new Map<string, CernoGroupRow>();
  for (const list of lists) {
    for (const row of list) {
      const existing = byKey.get(row.key);
      byKey.set(row.key, existing ? addCernoRows(existing, row) : row);
    }
  }
  return Array.from(byKey.values()).toSorted((a, b) => b.captures - a.captures);
}

export function mergeCernoStatsPayloads(
  payloads: ReadonlyArray<CernoStatsPayload>,
): CernoStatsPayload | null {
  if (payloads.length === 0) return null;
  const enabled = payloads.filter((p) => p.enabled);
  if (enabled.length === 0) return payloads[0]!;
  if (enabled.length === 1) return enabled[0]!;

  const first = enabled[0]!;
  let totals = first.totals;
  for (let i = 1; i < enabled.length; i += 1) {
    totals = addCernoRows(totals, enabled[i]!.totals);
  }
  const recentFindings = enabled
    .flatMap((p) => p.recentFindings)
    .toSorted((a, b) => b.timestampUtc.localeCompare(a.timestampUtc))
    .slice(0, 25);

  return {
    ...first,
    enabled: true,
    totals,
    byHarness: mergeCernoGroupLists(enabled.map((p) => p.byHarness)),
    byMode: mergeCernoGroupLists(enabled.map((p) => p.byMode)),
    recentFindings,
    facets: {
      hosts: unionSorted(enabled.map((p) => p.facets.hosts)),
      harnesses: unionSorted(enabled.map((p) => p.facets.harnesses)),
    },
  };
}
