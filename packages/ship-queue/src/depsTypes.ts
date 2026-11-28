// @effect-diagnostics nodeBuiltinImport:off - Shared types, summary projection, and legacy state.json reader for ship-queue dependency holds.
import * as NodeFS from "node:fs";

export const DEP_DAY_S = 86_400;
export const ACTIVE_DEP_ATTEMPT_STATES: ReadonlySet<string> = new Set([
  "preparing",
  "ready",
  "failed",
  "merging",
  "cancelling",
]);
export const DEP_REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
export const DEP_REPORT_ID_RE =
  /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}:[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

export interface DepUpdateItem {
  readonly packageFile: string;
  readonly depName: string;
  readonly currentValue: string;
  readonly newValue: string;
  readonly currentVersion?: string | undefined;
  readonly newVersion?: string | undefined;
  readonly releaseTimestamp?: string | null | undefined;
}

export interface DepReportRecord {
  readonly id: string;
  readonly status: string;
  readonly created: number;
  readonly files: Readonly<Record<string, string>>;
  readonly updates: ReadonlyArray<DepUpdateItem>;
  readonly waiting?: ReadonlyArray<unknown> | undefined;
  readonly held?: ReadonlyArray<unknown> | undefined;
  readonly incomplete?: ReadonlyArray<unknown> | undefined;
  readonly source?: { readonly kind: "main" | "checkout"; readonly commit: string } | undefined;
  readonly error?: string | undefined;
  /** How updates were assessed (`"renovate"`); absent on reports that never asked upstream. */
  readonly lookup?: string | undefined;
}

export interface DepAttemptRecord {
  readonly id: string;
  readonly status: string;
  readonly created: number;
  readonly report: DepReportRecord;
  readonly worktree?: string | undefined;
  readonly branch?: string | undefined;
  readonly job?: string | undefined;
  readonly expected?: Readonly<Record<string, string>> | undefined;
  readonly error?: string | undefined;
}

export interface DepDecisionState {
  readonly kind: "reject" | "updated" | "rollback";
  readonly until: number;
  readonly files: Readonly<Record<string, string>>;
  readonly report?: string | undefined;
}

export interface DepRepoState {
  readonly repo: string;
  readonly holding: boolean;
  readonly holdingSince?: number | undefined;
  readonly report?: DepReportRecord | undefined;
  readonly attempt?: DepAttemptRecord | undefined;
  readonly decision?: DepDecisionState | undefined;
  readonly checkouts?: Readonly<Record<string, DepReportRecord>> | undefined;
  readonly checkoutDecisions?: ReadonlyArray<DepDecisionState> | undefined;
  readonly scanStarted?: number | undefined;
}

export interface RecordedReportDecision {
  readonly reportId: string;
  readonly repo: string;
  readonly decision: "approve" | "reject";
  readonly attemptId: string | null;
  readonly decidedAt: number;
  readonly actor: string;
  readonly reason: string;
  readonly message: string;
}

export interface DepUpdateSummary {
  readonly packageFile: string;
  readonly depName: string;
  readonly currentValue: string;
  readonly newValue: string;
  readonly releaseTimestamp: string | null;
}

export interface DepRepoSummary {
  readonly repo: string;
  readonly reportId: string | null;
  readonly status: string;
  readonly scannedAt: number | null;
  readonly active: boolean;
  readonly holding: boolean;
  readonly pendingCount: number;
  readonly waitingCount: number;
  readonly heldCount: number;
  readonly failedCount: number;
  readonly attemptId: string | null;
  readonly attemptStatus: string | null;
  readonly decisionKind: string | null;
  readonly decisionUntil: number | null;
  readonly error: string | null;
  readonly updates: ReadonlyArray<DepUpdateSummary>;
}

export interface DepClearanceRecord {
  readonly jobId: string;
  readonly repo: string;
  readonly worktree: string;
  readonly head: string;
  readonly files: Readonly<Record<string, string>>;
  readonly basis: string;
  readonly at: number;
}

function parseDepUpdateSummary(item: unknown): DepUpdateSummary | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const packageFile = typeof rec.packageFile === "string" ? rec.packageFile : "";
  const depName = typeof rec.depName === "string" ? rec.depName : "";
  if (!packageFile && !depName) return null;
  const rawCur = typeof rec.currentValue === "string" ? rec.currentValue : "";
  const rawNew = typeof rec.newValue === "string" ? rec.newValue : "";
  const currentValue =
    rawCur && rawCur === rawNew && typeof rec.currentVersion === "string"
      ? rec.currentVersion
      : rawCur;
  const newValue =
    rawCur && rawCur === rawNew && typeof rec.newVersion === "string" ? rec.newVersion : rawNew;
  const releaseTimestamp =
    typeof rec.releaseTimestamp === "string" && rec.releaseTimestamp.trim()
      ? rec.releaseTimestamp
      : null;
  return { packageFile, depName, currentValue, newValue, releaseTimestamp };
}

export function parseLegacyStateFile(repo: string, statePath: string): DepRepoState | null {
  try {
    const parsed = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    const raw = parsed as Record<string, unknown>;
    const holding = typeof raw.holding === "boolean" ? raw.holding : Boolean(raw.enabled);
    return {
      repo,
      holding,
      ...(typeof raw.holdingSince === "number" ? { holdingSince: raw.holdingSince } : {}),
      ...(raw.report && typeof raw.report === "object"
        ? { report: raw.report as DepReportRecord }
        : {}),
      ...(raw.attempt && typeof raw.attempt === "object"
        ? { attempt: raw.attempt as DepAttemptRecord }
        : {}),
      ...(raw.decision && typeof raw.decision === "object"
        ? { decision: raw.decision as DepDecisionState }
        : {}),
      ...(raw.checkouts && typeof raw.checkouts === "object"
        ? { checkouts: raw.checkouts as Record<string, DepReportRecord> }
        : {}),
      ...(Array.isArray(raw.checkoutDecisions)
        ? { checkoutDecisions: raw.checkoutDecisions as DepDecisionState[] }
        : {}),
      ...(typeof raw.scanStarted === "number" ? { scanStarted: raw.scanStarted } : {}),
    };
  } catch {
    return null;
  }
}

export function summarizeDepRepoState(state: DepRepoState, nowEpochSec: number): DepRepoSummary {
  const report = state.report;
  const attempt = state.attempt;
  const decision = state.decision;

  const reportId = typeof report?.id === "string" && report.id.trim() ? report.id.trim() : null;
  const rawStatus =
    typeof report?.status === "string" && report.status.trim() ? report.status.trim() : "unknown";
  const scannedAt =
    typeof report?.created === "number" && Number.isFinite(report.created) ? report.created : null;
  const attemptId = typeof attempt?.id === "string" && attempt.id.trim() ? attempt.id.trim() : null;
  const attemptStatus =
    typeof attempt?.status === "string" && attempt.status.trim() ? attempt.status.trim() : null;
  const attemptReportId =
    typeof attempt?.report?.id === "string" && attempt.report.id.trim()
      ? attempt.report.id.trim()
      : null;

  const superseded =
    attemptStatus === "merged" && attemptReportId !== null && attemptReportId === reportId;
  const rawUpdates = Array.isArray(report?.updates) ? report.updates : [];
  const updates = superseded
    ? []
    : rawUpdates
        .slice(0, 50)
        .map(parseDepUpdateSummary)
        .filter((u): u is DepUpdateSummary => u !== null);
  const pendingCount = superseded ? 0 : rawUpdates.length;
  const waitingCount = Array.isArray(report?.waiting) ? report.waiting.length : 0;
  const heldCount = Array.isArray(report?.held) ? report.held.length : 0;
  const failedCount = Array.isArray(report?.incomplete) ? report.incomplete.length : 0;

  const decisionUntil =
    typeof decision?.until === "number" && Number.isFinite(decision.until) ? decision.until : null;
  const decided = decisionUntil !== null && decisionUntil > nowEpochSec;
  const decisionKind =
    decided && typeof decision?.kind === "string" && decision.kind.trim()
      ? decision.kind.trim()
      : null;
  const fresh = scannedAt !== null && scannedAt > nowEpochSec - DEP_DAY_S;
  const active = state.holding;
  const activeAttempt = attemptStatus !== null && ACTIVE_DEP_ATTEMPT_STATES.has(attemptStatus);
  const holding = active && (activeAttempt || !(decided || (rawStatus === "clean" && fresh)));
  const error =
    typeof report?.error === "string" && report.error.trim() ? report.error.trim() : null;

  return {
    repo: state.repo,
    reportId,
    status: superseded ? "superseded" : rawStatus,
    scannedAt,
    active,
    holding,
    pendingCount,
    waitingCount,
    heldCount,
    failedCount,
    attemptId,
    attemptStatus,
    decisionKind,
    decisionUntil: decided ? decisionUntil : null,
    error,
    updates,
  };
}
