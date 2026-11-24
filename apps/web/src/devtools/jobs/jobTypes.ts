/**
 * Frontend wire types, formatters, and legacy Ship Queue adapter for unified Bounded Jobs.
 */
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import type { ShipQueueJob, ShipQueueStatusPayload } from "../devtoolsClient";

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

export function isHostJob(job: Pick<JobSummary, "source">): boolean {
  return job.source !== "ship-queue";
}
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
  readonly threadId?: string;
  readonly projectId?: string;
  readonly project?: string;
  readonly repo?: string;
  readonly branch?: string;
  readonly worktreePath?: string;
  readonly host: string;
}

export interface JobTiming {
  readonly startedAt: string;
  readonly endedAt?: string;
  readonly etaSeconds?: number;
}

export interface JobProgress {
  readonly current: number;
  readonly total: number;
  readonly unit?: string;
  readonly fraction: number;
  readonly rate?: number;
  readonly rateUnit?: string;
  readonly stageLabel?: string;
}

export interface JobKpi {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly text?: string;
  readonly unit?: string;
  readonly anomaly?: "nan" | "inf";
  readonly higherIsBetter?: boolean;
}

export interface JobStep {
  readonly id: string;
  readonly label: string;
  readonly state: JobStepState;
  readonly detail?: string;
  readonly badge?: string;
  readonly href?: string;
}

export interface JobArtifact {
  readonly label: string;
  readonly href?: string;
  readonly path?: string;
}

export interface JobMetricPoint {
  readonly t: number;
  readonly x?: number;
  readonly v: number | null;
  readonly anomaly?: "nan" | "inf";
}

export interface JobMetricSeries {
  readonly key: string;
  readonly label: string;
  readonly unit?: string;
  readonly higherIsBetter?: boolean;
  readonly points: ReadonlyArray<JobMetricPoint>;
}

export interface JobCernoVerdict {
  readonly checkedAt: string;
  readonly outcome?: "pass" | "fail" | "unknown";
  readonly hangLoop?: boolean;
  readonly needsInput?: boolean;
  readonly serverReady?: boolean;
  readonly summary?: string;
}

export interface JobPidStats {
  readonly pid: number;
  readonly alive: boolean;
  readonly rssBytes?: number;
  readonly cmdline?: string;
}

export interface JobSparklineSummary {
  readonly key: string;
  readonly label: string;
  readonly values: ReadonlyArray<number | null>;
}

export interface JobSummary {
  readonly id: string;
  readonly revision: number;
  readonly source: JobSourceKind;
  readonly kind: string;
  readonly title: string;
  readonly subtitle?: string;
  readonly phaseLabel: string;
  readonly state: TrackedJobState;
  readonly binding: JobBinding;
  readonly timing: JobTiming;
  readonly progress?: JobProgress;
  readonly kpis?: ReadonlyArray<JobKpi>;
  readonly sparkline?: JobSparklineSummary;
  readonly pidStats?: JobPidStats;
  readonly hasMetrics?: boolean;
  readonly hasLog?: boolean;
  readonly logState?: JobLogState;
  readonly logStateReason?: string;
  readonly recentTail?: ReadonlyArray<string>;
  readonly cancellable: boolean;
  readonly summary?: string;
  readonly anomaly?: string;
  readonly shipJob?: ShipQueueJob;
}

export interface JobDetail {
  readonly id: string;
  readonly revision: number;
  readonly command?: string;
  readonly logState?: JobLogState;
  readonly logStateReason?: string;
  readonly steps?: ReadonlyArray<JobStep>;
  readonly series: ReadonlyArray<JobMetricSeries>;
  readonly logTail: ReadonlyArray<string>;
  readonly artifacts?: ReadonlyArray<JobArtifact>;
  readonly pidStats?: JobPidStats;
  readonly cerno?: JobCernoVerdict;
  readonly logPath?: string;
  readonly linesParsed?: number;
}

export interface JobsQueueMeta {
  readonly queueRoot?: string;
  readonly openCount?: number;
  readonly totalCount?: number;
  readonly upgradePending?: string;
  readonly error?: string;
}

export function isJobLive(job: Pick<JobSummary, "state">): boolean {
  return (
    job.state === "queued" ||
    job.state === "running" ||
    job.state === "waiting" ||
    job.state === "cancelling"
  );
}

export function sanitizeJobHref(raw: string | undefined): string | null {
  if (!raw) return null;
  const trimmed = raw.trim();
  if (!/^https?:\/\/[^\s"'<>]+$/i.test(trimmed)) return null;
  try {
    const parsed = new URL(trimmed);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.toString() : null;
  } catch {
    return null;
  }
}

export function formatJobDuration(seconds: number | undefined): string {
  if (seconds === undefined || !Number.isFinite(seconds) || seconds < 0) return "";
  const s = Math.round(seconds);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  const remS = s % 60;
  if (m < 60) return remS > 0 ? `${m}m ${remS}s` : `${m}m`;
  const h = Math.floor(m / 60);
  const remM = m % 60;
  return remM > 0 ? `${h}h ${remM}m` : `${h}h`;
}

export function formatJobElapsed(timing: JobTiming, nowMs: number): string {
  const startMs = Date.parse(timing.startedAt);
  if (!Number.isFinite(startMs)) return "";
  const endMs = timing.endedAt ? Date.parse(timing.endedAt) : nowMs;
  const sec = Math.max(0, Math.floor(((Number.isFinite(endMs) ? endMs : nowMs) - startMs) / 1_000));
  return formatJobDuration(sec);
}

export function formatMetricNumber(value: number | null, anomaly?: "nan" | "inf"): string {
  if (anomaly === "nan") return "NaN";
  if (anomaly === "inf") return m(msg("Inf"));
  if (value === null || !Number.isFinite(value)) return "--";
  const abs = Math.abs(value);
  if (abs === 0) return "0";
  if (abs < 0.001 || abs >= 100_000) return value.toExponential(2);
  if (abs >= 100) return value.toFixed(1);
  if (abs >= 1) return value.toFixed(3);
  return value.toFixed(4);
}

export function formatJobBytes(bytes: number | undefined): string {
  if (!bytes || !Number.isFinite(bytes) || bytes <= 0) return "";
  if (bytes >= 1024 ** 3) return `${(bytes / 1024 ** 3).toFixed(1)} GiB`;
  if (bytes >= 1024 ** 2) return `${Math.round(bytes / 1024 ** 2)} MiB`;
  return `${Math.round(bytes / 1024)} KiB`;
}

export function jobStateBadgeVariant(
  state: TrackedJobState,
): "info" | "success" | "warning" | "error" | "secondary" | "outline" {
  switch (state) {
    case "running":
      return "info";
    case "queued":
    case "waiting":
      return "warning";
    case "cancelling":
    case "failed":
    case "cancelled":
      return "error";
    case "done":
      return "success";
    default:
      return "outline";
  }
}

export function jobKindLabel(kind: string): string {
  switch (kind.toLowerCase()) {
    case "ship":
      return m(msg("Ship"));
    case "render":
      return m(msg("Render"));
    case "train":
      return m(msg("Train"));
    case "eval":
      return m(msg("Eval"));
    case "bench":
    case "benchmark":
      return m(msg("Bench"));
    case "build":
      return m(msg("Build"));
    case "migrate":
    case "migration":
      return m(msg("Migrate"));
    case "test":
      return m(msg("Test"));
    case "command":
      return m(msg("Run"));
    default:
      return kind ? `${kind.charAt(0).toUpperCase()}${kind.slice(1)}` : m(msg("Job"));
  }
}

/**
 * Compact 1-word status label for the narrow left-sidebar thread status slot.
 * Never returns unbounded agent `phaseLabel` strings that would crush the thread title.
 */
export function sidebarJobStatusLabel(job: Pick<JobSummary, "kind" | "state">): string {
  switch (job.state) {
    case "cancelling":
      return m(msg("Cancelling"));
    case "queued":
      return m(msg("Queued"));
    case "waiting":
      return m(msg("Waiting"));
    default:
      return jobKindLabel(job.kind);
  }
}

export function jobTerminalStateLabel(state: TrackedJobState): string {
  switch (state) {
    case "queued":
      return m(msg("Queued"));
    case "waiting":
      return m(msg("Waiting"));
    case "cancelling":
      return m(msg("Cancelling"));
    case "done":
      return m(msg("Done"));
    case "failed":
      return m(msg("Failed"));
    case "cancelled":
      return m(msg("Cancelled"));
    case "exited":
      return m(msg("Exited"));
    default:
      return m(msg("Running"));
  }
}

const JOB_KEY_EPOCH_RE = /^(\d{9,11})-j/;

/** Adapts legacy `/api/devtools/ship-queue/events` snapshots for older linked peers. */
export function adaptLegacyShipQueuePayload(payload: ShipQueueStatusPayload): {
  readonly jobs: ReadonlyArray<JobSummary>;
  readonly queueMeta: JobsQueueMeta;
} {
  const jobs: JobSummary[] = [];
  for (const raw of payload.jobs ?? []) {
    const rawId = raw.id?.trim() ?? "";
    const id = `ship:${rawId || `${raw.repo ?? "repo"}:${raw.branch ?? "job"}`}`;
    const s = (raw.state ?? raw.display_state ?? "").toLowerCase();
    let state: TrackedJobState = "running";
    if (s === "done" || s === "merged") state = "done";
    else if (s === "cancelled") state = "cancelled";
    else if (s === "failed" || s.includes("fail")) state = "failed";
    else if (s === "queued" || s === "pending") state = "queued";
    else if (
      s.includes("wait") ||
      s.includes("parked") ||
      s.includes("needs-root") ||
      raw.parked?.for
    ) {
      state = "waiting";
    }
    const marker = (raw.last_marker ?? "").trim();
    const hasSync =
      (typeof raw.sync_exit === "number" && Number.isFinite(raw.sync_exit)) ||
      (typeof raw.sync_exit === "string" && raw.sync_exit.trim() !== "");
    const rawStage = (raw.stage ?? "").trim().toLowerCase();
    const phaseLabel =
      state === "running" &&
      !hasSync &&
      (rawStage === "deploy" ||
        rawStage === "deploying" ||
        /^POST_MERGE\b/i.test(marker) ||
        s === "deploy" ||
        s === "deploying")
        ? "Deploying"
        : "Shipping";
    let startedAt = raw.submitted_at ?? "";
    if (!startedAt || !Number.isFinite(Date.parse(startedAt))) {
      const m = JOB_KEY_EPOCH_RE.exec(raw.key ?? "");
      startedAt = m?.[1] ? new Date(Number(m[1]) * 1000).toISOString() : new Date().toISOString();
    }
    jobs.push({
      id,
      revision: 1,
      source: "ship-queue",
      kind: "ship",
      title:
        raw.title?.trim() ||
        raw.branch?.trim() ||
        (rawId ? m(msg("Ship #{id}"), { id: rawId }) : m(msg("Ship job"))),
      ...(raw.branch?.trim() ? { subtitle: raw.branch.trim() } : {}),
      phaseLabel,
      state,
      binding: {
        ...(raw.thread_id?.trim() ? { threadId: raw.thread_id.trim() } : {}),
        ...(raw.repo?.trim() ? { repo: raw.repo.trim(), project: raw.repo.trim() } : {}),
        ...(raw.branch?.trim() ? { branch: raw.branch.trim() } : {}),
        ...(raw.worktree?.trim() ? { worktreePath: raw.worktree.trim() } : {}),
        host: raw.route?.host?.trim() || "local",
      },
      timing: { startedAt },
      cancellable:
        (state === "queued" || state === "running" || state === "waiting") &&
        /^[0-9]{1,16}$/.test(rawId),
      shipJob: raw,
    });
  }
  return {
    jobs,
    queueMeta: {
      ...(payload.queue_root ? { queueRoot: payload.queue_root } : {}),
      ...(typeof payload.open_count === "number" ? { openCount: payload.open_count } : {}),
      ...(typeof payload.total_count === "number" ? { totalCount: payload.total_count } : {}),
      ...(payload.upgrade_pending ? { upgradePending: payload.upgrade_pending } : {}),
    },
  };
}
