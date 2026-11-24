/**
 * Pure filters for background job metric noise suppression and explicit log-state classification.
 * Prevents shell check/exit-code key-value pairs (`dirty=0`, `playbook_rc=0`, `pid=...`) from
 * polluting KPI tiles and time-series charts, and classifies log tailing failures into explicit
 * user-facing states.
 */
import { redactLogLine, type LogOpenFailureKind } from "./logFileGuard.ts";
import { getProgressBarFrameKey } from "./progressExtractor.ts";
import {
  sanitizeJobText,
  type JobKpi,
  type JobLogState,
  type JobMetricPoint,
  type JobSummary,
} from "./types.ts";

const MAX_KPIS_PER_JOB = 6;

export interface SeriesProjectionEntry {
  readonly key: string;
  readonly label: string;
  readonly unit?: string | undefined;
  readonly higherIsBetter?: boolean | undefined;
  readonly points: ReadonlyArray<JobMetricPoint>;
  readonly latestValue: number | null;
  readonly latestAnomaly?: "nan" | "inf" | undefined;
}

export function formatMetricLabel(key: string): string {
  const leaf = key.includes("/") ? (key.split("/").at(-1) ?? key) : key;
  return leaf.replace(/[_-]+/g, " ").trim().slice(0, 32) || key.slice(0, 32);
}

const NOISE_METRIC_BARE_EXACT = new Set([
  "rc",
  "exit",
  "exit_code",
  "exitcode",
  "returncode",
  "return_code",
  "status_code",
  "http_status",
  "dirty",
  "from_head",
  "gitleaks",
  "pid",
  "ppid",
  "uid",
  "gid",
  "port",
  "errno",
  "ok",
  "code",
  "seed",
  "status",
  "job_id",
  "pr",
]);

const NOISE_METRIC_SUFFIX_RE = /(?:^|[_-])(?:rc|exit|exit_code|pid|ppid|uid|gid|port|errno)$/;

/**
 * Returns `true` for shell exit codes, git cleanliness flags, process IDs, and other discrete
 * control tokens that are not meaningful continuous job metrics.
 * Namespaced metrics (e.g. `acc/clean`, `eval/code`) are preserved unless their leaf ends in an
 * unambiguous control suffix (`_rc`, `_exit`, `_pid`, etc.).
 */
export function isNoiseMetricKey(key: string): boolean {
  const trimmed = key.trim().toLowerCase();
  if (!trimmed) return true;
  const hasNamespace = trimmed.includes("/");
  const leaf = hasNamespace ? (trimmed.split("/").at(-1) ?? trimmed) : trimmed;
  if (!leaf) return true;
  if (!hasNamespace && NOISE_METRIC_BARE_EXACT.has(leaf)) return true;
  if (NOISE_METRIC_SUFFIX_RE.test(leaf)) return true;
  return false;
}

/**
 * Returns `true` only when a metric series contains a meaningful curve to plot:
 * either an anomaly (NaN/Inf) or at least two finite points with non-zero variation.
 */
export function isPlottableMetricPoints(points: ReadonlyArray<JobMetricPoint>): boolean {
  let minVal = Number.POSITIVE_INFINITY;
  let maxVal = Number.NEGATIVE_INFINITY;
  let finiteCount = 0;
  for (const pt of points) {
    if (pt.anomaly) return true;
    if (pt.v !== null && Number.isFinite(pt.v)) {
      finiteCount += 1;
      if (pt.v < minVal) minVal = pt.v;
      if (pt.v > maxVal) maxVal = pt.v;
    }
  }
  return finiteCount >= 2 && maxVal - minVal > 1e-12;
}

/**
 * Maps the typed failure kind from `openValidatedLogFile` to an explicit `JobLogState`
 * and retry policy without brittle error-string regexes.
 */
export function mapLogOpenFailureKind(kind: LogOpenFailureKind): {
  readonly state: Extract<JobLogState, "restricted" | "pending_file" | "unreadable">;
  readonly retryable: boolean;
} {
  if (kind === "restricted") {
    return { state: "restricted", retryable: false };
  }
  if (kind === "missing") {
    return { state: "pending_file", retryable: true };
  }
  return { state: "unreadable", retryable: true };
}

export function resolveJobLogState(input: {
  readonly hasAttachedTailer: boolean;
  readonly hasPersistedLogPath: boolean;
  readonly hasTailLines: boolean;
  readonly explicitState?: JobLogState | undefined;
  readonly explicitReason?: string | undefined;
}): { readonly logState: JobLogState; readonly logStateReason?: string | undefined } {
  if (input.hasAttachedTailer || input.hasPersistedLogPath) {
    return { logState: "attached" };
  }
  if (input.hasTailLines) {
    return {
      logState: "stream_only",
      ...(input.explicitState &&
      input.explicitState !== "pending_file" &&
      input.explicitState !== "no_output" &&
      input.explicitReason
        ? { logStateReason: input.explicitReason }
        : {}),
    };
  }
  if (input.explicitState) {
    return {
      logState: input.explicitState,
      ...(input.explicitReason ? { logStateReason: input.explicitReason } : {}),
    };
  }
  return { logState: "no_output" };
}

export function formatRedactedCommand(rawCommand: string | undefined): string | undefined {
  if (!rawCommand) return undefined;
  const trimmed = rawCommand.trim();
  if (!trimmed) return undefined;
  // Join shell `\` line continuations before redaction so `--token \<nl>secret` redacts the secret.
  const unfolded = trimmed.replace(/\\\r?\n[ \t]*/g, " ");
  const redacted = unfolded
    .split(/\r?\n/)
    .map((line) => redactLogLine(line))
    .join("\n")
    .trim();
  if (!redacted) return undefined;
  return redacted.length > 2048 ? `${redacted.slice(0, 2045)}...` : redacted;
}

export function buildJobKpis(
  seriesMap: ReadonlyMap<string, SeriesProjectionEntry>,
): ReadonlyArray<JobKpi> | undefined {
  if (seriesMap.size === 0) return undefined;
  const orderedKeys: string[] = [];
  for (const [k, s] of seriesMap) {
    if (s.latestAnomaly && !orderedKeys.includes(k)) orderedKeys.push(k);
  }
  for (const k of seriesMap.keys()) {
    if (orderedKeys.length >= MAX_KPIS_PER_JOB) break;
    if (!orderedKeys.includes(k)) orderedKeys.push(k);
  }
  return orderedKeys.slice(0, MAX_KPIS_PER_JOB).map((k) => {
    const s = seriesMap.get(k)!;
    return {
      key: s.key,
      label: s.label,
      value: s.latestValue,
      ...(s.unit ? { unit: s.unit } : {}),
      ...(s.latestAnomaly ? { anomaly: s.latestAnomaly } : {}),
      ...(s.higherIsBetter !== undefined ? { higherIsBetter: s.higherIsBetter } : {}),
    };
  });
}

export function buildPrimarySparkline(
  seriesMap: ReadonlyMap<string, SeriesProjectionEntry>,
  kpis: ReadonlyArray<JobKpi> | undefined,
): JobSummary["sparkline"] {
  const candidateKeys = [...(kpis?.map((k) => k.key) ?? []), ...seriesMap.keys()];
  const s = candidateKeys
    .map((k) => seriesMap.get(k))
    .find((entry): entry is SeriesProjectionEntry =>
      Boolean(entry && isPlottableMetricPoints(entry.points)),
    );
  if (!s) return undefined;
  const maxSamples = 24;
  const pts = s.points;
  const values: Array<number | null> = [];
  if (pts.length <= maxSamples) {
    for (const pt of pts) {
      values.push(pt.v !== null && Number.isFinite(pt.v) ? Number(pt.v.toPrecision(4)) : null);
    }
  } else {
    const step = (pts.length - 1) / (maxSamples - 1);
    for (let i = 0; i < maxSamples; i += 1) {
      const pt = pts[Math.round(i * step)]!;
      values.push(pt.v !== null && Number.isFinite(pt.v) ? Number(pt.v.toPrecision(4)) : null);
    }
  }
  return { key: s.key, label: s.label, values };
}

export function buildRecentTail(lines: ReadonlyArray<string>): ReadonlyArray<string> | undefined {
  if (lines.length === 0) return undefined;
  const recent: string[] = [];
  const seenBarKeys = new Set<string>();
  for (let i = lines.length - 1; i >= 0 && recent.length < 3; i -= 1) {
    const clean = sanitizeJobText(redactLogLine(lines[i] ?? ""), 120);
    if (!clean) continue;
    const barKey = getProgressBarFrameKey(clean);
    if (barKey !== null) {
      if (seenBarKeys.has(barKey)) continue;
      seenBarKeys.add(barKey);
    }
    recent.push(clean);
  }
  if (recent.length === 0) return undefined;
  recent.reverse();
  return recent;
}
