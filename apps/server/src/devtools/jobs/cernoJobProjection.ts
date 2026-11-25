// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Pure record projection and summary/detail builders for live cerno jobs.
import * as NodePath from "node:path";

import {
  buildCernoVerdict,
  deriveCernoAnomaly,
  deriveCernoJobTitle,
  extractSshTargetHost,
  type RawCernoLiveSnapshot,
} from "./cernoSnapshotReader.ts";
import { inferCommandJobKind } from "./commandJobParser.ts";
import { inferTargetHost, type FleetHostDescriptor } from "./fleetHostInference.ts";
import { buildRecentTail, formatRedactedCommand } from "./jobMetricFilter.ts";
import { defaultPhaseLabel } from "./managedJobHelpers.ts";
import type {
  JobCernoVerdict,
  JobDetail,
  JobPidStats,
  JobSummary,
  TrackedJobState,
} from "./types.ts";

export interface CernoJobRecord {
  readonly id: string;
  readonly pid: number;
  readonly startTicks: number | null;
  revision: number;
  semanticKey: string;
  state: TrackedJobState;
  phaseLabel: string;
  kind: string;
  title: string;
  host: string;
  threadId?: string | undefined;
  cwd: string;
  command: string;
  fullCommand: string;
  logPath?: string | undefined;
  startedAt: string;
  endedAt?: string | undefined;
  cancellingSinceMs?: number | undefined;
  cancelTimedOut?: boolean | undefined;
  anomaly?: string | undefined;
  cancellable: boolean;
  lastState: string;
  lastOutcome?: string | undefined;
  lastAlert?: string | null | undefined;
  cerno: JobCernoVerdict;
  pidStats: JobPidStats;
  tailLines: ReadonlyArray<string>;
}

export function upsertCernoRecord(
  jobs: Map<string, CernoJobRecord>,
  input: {
    readonly id: string;
    readonly snap: RawCernoLiveSnapshot;
    readonly startTicks: number | null;
    readonly fullCommand: string;
    readonly canonicalLogPath: string | undefined;
    readonly threadId: string | undefined;
    readonly rssBytes: number | undefined;
    readonly tailLines: ReadonlyArray<string>;
    readonly localHostname: string;
    readonly fleetHosts: ReadonlyArray<FleetHostDescriptor>;
    readonly platform: NodeJS.Platform;
    readonly now: number;
    readonly cancelTimeoutMs: number;
  },
): boolean {
  const { id, snap, startTicks, fullCommand, canonicalLogPath, threadId, rssBytes, tailLines } =
    input;
  const existing = jobs.get(id);
  const stillCancelling =
    existing?.state === "cancelling" &&
    existing.cancellingSinceMs !== undefined &&
    input.now - existing.cancellingSinceMs < input.cancelTimeoutMs;
  const cancelTimedOut =
    (existing?.state === "cancelling" && !stillCancelling) ||
    Boolean(existing?.cancelTimedOut && !stillCancelling);
  const isWaiting = Boolean(snap.prompt || snap.auth_required || snap.state === "NEEDS_INPUT");
  const nextState: TrackedJobState = stillCancelling
    ? "cancelling"
    : isWaiting
      ? "waiting"
      : "running";
  const kind = inferCommandJobKind(`${fullCommand} ${canonicalLogPath ?? ""}`);
  const title = deriveCernoJobTitle(snap, fullCommand);
  const inferredHost = inferTargetHost(
    fullCommand,
    undefined,
    input.localHostname,
    input.fleetHosts,
  );
  const host =
    inferredHost !== input.localHostname
      ? inferredHost
      : (extractSshTargetHost(snap.command) ?? input.localHostname);
  const phaseLabel = defaultPhaseLabel(kind, nextState);
  const anomaly =
    deriveCernoAnomaly(snap) ?? (cancelTimedOut ? "Process did not exit after SIGTERM" : undefined);
  const cerno = buildCernoVerdict(snap);
  const cancellable =
    nextState !== "cancelling" && input.platform === "linux" && startTicks !== null && snap.pid > 1;
  const semanticKey = JSON.stringify([
    nextState,
    phaseLabel,
    kind,
    title,
    host,
    threadId ?? "",
    anomaly ?? "",
    cancellable,
    cerno.outcome,
    cerno.hangLoop,
    cerno.needsInput,
    cerno.serverReady,
    buildRecentTail(tailLines) ?? [],
  ]);
  const pidStats: JobPidStats = {
    pid: snap.pid,
    alive: true,
    ...(rssBytes !== undefined ? { rssBytes } : {}),
    cmdline: formatRedactedCommand(fullCommand),
  };

  if (!existing) {
    jobs.set(id, {
      id,
      pid: snap.pid,
      startTicks,
      revision: 1,
      semanticKey,
      state: nextState,
      phaseLabel,
      kind,
      title,
      host,
      threadId,
      cwd: snap.cwd,
      command: snap.command,
      fullCommand,
      logPath: canonicalLogPath,
      startedAt: new Date(snap.started_at_ms).toISOString(),
      anomaly,
      cancellable,
      lastState: snap.state,
      lastOutcome: snap.outcome,
      lastAlert: snap.alert,
      cerno,
      pidStats,
      tailLines,
    });
    return true;
  }

  Object.assign(existing, {
    cerno,
    pidStats,
    tailLines,
    logPath: canonicalLogPath,
    lastState: snap.state,
    lastOutcome: snap.outcome,
    lastAlert: snap.alert,
    cancellingSinceMs: stillCancelling ? existing.cancellingSinceMs : undefined,
    cancelTimedOut,
  });
  if (existing.semanticKey === semanticKey) return false;
  Object.assign(existing, {
    semanticKey,
    state: nextState,
    phaseLabel,
    kind,
    title,
    host,
    threadId,
    anomaly,
    cancellable,
    revision: existing.revision + 1,
  });
  return true;
}

export function finalizeCernoRecord(rec: CernoJobRecord, now: number): void {
  const wasCancelling = rec.state === "cancelling";
  const upperState = rec.lastState.toUpperCase();
  const upperOutcome = (rec.lastOutcome ?? "").toUpperCase();
  let finalState: Extract<TrackedJobState, "done" | "failed" | "cancelled" | "exited"> = "exited";
  if (wasCancelling) finalState = "cancelled";
  else if (upperState === "FAILED" || upperOutcome === "FAIL" || Boolean(rec.lastAlert)) {
    finalState = "failed";
  } else if (upperState === "SUCCEEDED" || upperOutcome === "PASS") {
    finalState = "done";
  }
  Object.assign(rec, {
    state: finalState,
    phaseLabel: defaultPhaseLabel(rec.kind, finalState),
    cancellable: false,
    cancellingSinceMs: undefined,
    cancelTimedOut: false,
    endedAt: new Date(now).toISOString(),
    pidStats: { ...rec.pidStats, alive: false },
    revision: rec.revision + 1,
    semanticKey: `${finalState}:${now}`,
  });
}

export function buildCernoSummary(rec: CernoJobRecord): JobSummary {
  const project = rec.cwd && rec.cwd !== "/" ? NodePath.basename(rec.cwd) : undefined;
  const recentTail = buildRecentTail(rec.tailLines);
  return {
    id: rec.id,
    revision: rec.revision,
    source: "background",
    kind: rec.kind,
    title: rec.title,
    phaseLabel: rec.phaseLabel,
    state: rec.state,
    binding: {
      ...(rec.threadId ? { threadId: rec.threadId } : {}),
      ...(project ? { project } : {}),
      ...(rec.cwd ? { worktreePath: rec.cwd } : {}),
      host: rec.host,
    },
    timing: { startedAt: rec.startedAt, ...(rec.endedAt ? { endedAt: rec.endedAt } : {}) },
    pidStats: rec.pidStats,
    hasLog: Boolean(rec.logPath || rec.tailLines.length > 0),
    logState: rec.logPath ? "attached" : rec.tailLines.length > 0 ? "stream_only" : "no_output",
    ...(recentTail ? { recentTail } : {}),
    cancellable: rec.cancellable,
    ...(rec.anomaly ? { anomaly: rec.anomaly } : {}),
  };
}

export function buildCernoDetail(rec: CernoJobRecord): JobDetail {
  const redactedCmd = formatRedactedCommand(rec.fullCommand);
  return {
    id: rec.id,
    revision: rec.revision,
    ...(redactedCmd ? { command: redactedCmd } : {}),
    logState: rec.logPath ? "attached" : rec.tailLines.length > 0 ? "stream_only" : "no_output",
    series: [],
    logTail: rec.tailLines,
    pidStats: rec.pidStats,
    cerno: rec.cerno,
    ...(rec.logPath ? { logPath: rec.logPath } : {}),
    linesParsed: rec.tailLines.length,
  };
}
