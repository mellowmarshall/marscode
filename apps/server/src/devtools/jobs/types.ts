/**
 * Wire and internal types for the unified in-process Bounded Jobs subsystem.
 * Ship Queue jobs and T3-tracked background commands share this contract across
 * `/api/devtools/jobs/*` and Fleet Console.
 */
import type { DevtoolsJobLoad } from "@t3tools/contracts";

export type TrackedJobState =
  | "queued"
  | "running"
  | "waiting"
  | "cancelling"
  | "done"
  | "failed"
  | "cancelled"
  | "exited";

export type JobSourceKind = "ship-queue" | "background";

export type JobStepState = "done" | "active" | "waiting" | "failed" | "pending";

export type JobLogState =
  | "attached"
  | "stream_only"
  | "pending_file"
  | "no_output"
  | "restricted"
  | "unreadable"
  | "remote_unavailable";

export interface JobBinding {
  readonly threadId?: string | undefined;
  readonly projectId?: string | undefined;
  readonly project?: string | undefined;
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
  readonly host: string;
}

export interface JobTiming {
  readonly startedAt: string;
  readonly endedAt?: string | undefined;
  readonly etaSeconds?: number | undefined;
}

export interface JobProgress {
  readonly current: number;
  readonly total: number;
  readonly unit?: string | undefined;
  /** Clamped 0..1 fraction. */
  readonly fraction: number;
  readonly rate?: number | undefined;
  readonly rateUnit?: string | undefined;
  readonly stageLabel?: string | undefined;
}

export interface JobKpi {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly text?: string | undefined;
  readonly unit?: string | undefined;
  readonly anomaly?: "nan" | "inf" | undefined;
  readonly higherIsBetter?: boolean | undefined;
}

export interface JobStep {
  readonly id: string;
  readonly label: string;
  readonly state: JobStepState;
  readonly detail?: string | undefined;
  readonly badge?: string | undefined;
  readonly href?: string | undefined;
}

export interface JobArtifact {
  readonly label: string;
  readonly href?: string | undefined;
  readonly path?: string | undefined;
}

export interface JobMetricPoint {
  /** Epoch milliseconds. */
  readonly t: number;
  /** Optional step/epoch x-axis index. */
  readonly x?: number | undefined;
  readonly v: number | null;
  readonly anomaly?: "nan" | "inf" | undefined;
}

export interface JobMetricSeries {
  readonly key: string;
  readonly label: string;
  readonly unit?: string | undefined;
  readonly higherIsBetter?: boolean | undefined;
  readonly points: ReadonlyArray<JobMetricPoint>;
}

export type JobCernoTone = "neutral" | "info" | "success" | "warning" | "destructive";

export interface JobCernoVerdict {
  readonly checkedAt: string;
  readonly state?: string | undefined;
  readonly confidence?: number | undefined;
  readonly tone?: JobCernoTone | undefined;
  readonly pips?: 1 | 2 | 3 | 4 | undefined;
  readonly label?: string | undefined;
  readonly outcome?: "pass" | "fail" | "unknown" | undefined;
  readonly hangLoop?: boolean | undefined;
  readonly needsInput?: boolean | undefined;
  readonly serverReady?: boolean | undefined;
  readonly summary?: string | undefined;
}

export interface JobPidStats {
  readonly pid: number;
  readonly alive: boolean;
  readonly rssBytes?: number | undefined;
  readonly cmdline?: string | undefined;
}

export interface JobSparklineSummary {
  readonly key: string;
  readonly label: string;
  readonly values: ReadonlyArray<number | null>;
}

/**
 * Compact summary streamed over `/api/devtools/jobs/events`.
 * Intentionally omits large time series, log tails, and volatile `updatedAt` timestamps
 * so delta frames stay small and semantic `revision` deduplication works cleanly.
 */
export interface JobSummary {
  readonly id: string;
  readonly revision: number;
  readonly source: JobSourceKind;
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly phaseLabel: string;
  readonly state: TrackedJobState;
  readonly binding: JobBinding;
  readonly timing: JobTiming;
  readonly progress?: JobProgress | undefined;
  readonly kpis?: ReadonlyArray<JobKpi> | undefined;
  readonly sparkline?: JobSparklineSummary | undefined;
  readonly pidStats?: JobPidStats | undefined;
  /** Live process-tree load; set only for live local jobs with a known root PID. */
  readonly load?: DevtoolsJobLoad | undefined;
  readonly hasMetrics?: boolean | undefined;
  readonly hasLog?: boolean | undefined;
  readonly logState?: JobLogState | undefined;
  readonly logStateReason?: string | undefined;
  /** Compact last 3 non-empty log lines (<=120 chars each) for right-rail live progress visibility. */
  readonly recentTail?: ReadonlyArray<string> | undefined;
  readonly cancellable: boolean;
  readonly summary?: string | undefined;
  readonly anomaly?: string | undefined;
  readonly cerno?: JobCernoVerdict | undefined;
  /** Opaque raw Ship Queue payload preserved for client-side step derivation (zero rewrite). */
  readonly shipJob?: Readonly<Record<string, unknown>> | undefined;
}

export interface JobDetail {
  readonly id: string;
  readonly revision: number;
  readonly command?: string | undefined;
  readonly logState?: JobLogState | undefined;
  readonly logStateReason?: string | undefined;
  readonly steps?: ReadonlyArray<JobStep> | undefined;
  readonly series: ReadonlyArray<JobMetricSeries>;
  readonly logTail: ReadonlyArray<string>;
  readonly artifacts?: ReadonlyArray<JobArtifact> | undefined;
  readonly pidStats?: JobPidStats | undefined;
  readonly cerno?: JobCernoVerdict | undefined;
  readonly logPath?: string | undefined;
  readonly linesParsed?: number | undefined;
}

export interface JobsQueueMeta {
  readonly queueRoot?: string | undefined;
  readonly openCount?: number | undefined;
  readonly totalCount?: number | undefined;
  readonly upgradePending?: string | undefined;
  readonly error?: string | undefined;
}

export type JobLogFormat = "jsonl" | "kv" | "template";

export interface JobLogSourceConfig {
  readonly format: JobLogFormat;
  readonly path?: string | undefined;
  readonly autoFromPidFd?: boolean | undefined;
  /** Fill-in-the-blank templates for `format === "template"` (max 4, linear time, zero regex). */
  readonly templates?: ReadonlyArray<string> | undefined;
  /** Optional field names for progress calculation (`step`/`total`, or nested `epoch`/`total_epochs` + `step`/`total_steps`). */
  readonly progressFields?:
    | {
        readonly current: string;
        readonly total: string;
        readonly outerCurrent?: string | undefined;
        readonly outerTotal?: string | undefined;
        readonly rate?: string | undefined;
        readonly unit?: string | undefined;
      }
    | undefined;
  readonly successMarker?: string | undefined;
  readonly failureMarker?: string | undefined;
  readonly exitCodeFile?: string | undefined;
}

const TERMINAL_JOB_STATES: ReadonlySet<TrackedJobState> = new Set([
  "done",
  "failed",
  "cancelled",
  "exited",
]);

export function isTerminalJobState(
  state: TrackedJobState,
): state is "done" | "failed" | "cancelled" | "exited" {
  return TERMINAL_JOB_STATES.has(state);
}

const UNSAFE_METRIC_KEYS = new Set([
  "__proto__",
  "constructor",
  "prototype",
  "toString",
  "valueOf",
]);
const SAFE_METRIC_KEY_RE = /^[A-Za-z0-9_./-]{1,64}$/;
const CONTROL_CHARS_RE = /[\u0000-\u001f\u007f]/g;

export function sanitizeJobText(raw: string | undefined, maxLen: number): string {
  if (!raw) return "";
  return raw.replace(CONTROL_CHARS_RE, " ").trim().slice(0, maxLen);
}

export function isSafeMetricKey(key: string): boolean {
  return SAFE_METRIC_KEY_RE.test(key) && !UNSAFE_METRIC_KEYS.has(key);
}
