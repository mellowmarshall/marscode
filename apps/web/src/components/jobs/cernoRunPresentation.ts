import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import type {
  CernoLiveRun,
  OrchestrationV2PendingBackgroundTask,
  ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import {
  extractCernoLogPath,
  isCernoCommand,
  normalizeShellCommand,
  unwrapCernoCommand,
} from "./cernoCommand";
import {
  formatCompactElapsed,
  parseCommandOutputMetrics,
  type ParsedJobMetrics,
} from "./jobOutputParser";
import { isShipQueueCommand } from "./shipQueueBackgroundFilter";

export type CernoOperatorTone = "neutral" | "info" | "success" | "warning" | "destructive";

export interface CernoOperatorPresentation {
  readonly verdict: string;
  readonly tone: CernoOperatorTone;
  readonly pips: 1 | 2 | 3 | 4;
  readonly certaintyLabel: string;
  readonly confidencePct: number;
  readonly liveness: string;
  readonly reason: string;
  readonly actionNote: string;
}

export interface CernoMatchCandidate {
  readonly taskId: string;
  readonly command: string | null | undefined;
}

const HEALTHY_MIN_CONFIDENCE = 0.55;

function confidenceToPips(confidence: number): 1 | 2 | 3 | 4 {
  if (confidence >= 0.9) return 4;
  if (confidence >= 0.72) return 3;
  if (confidence >= 0.5) return 2;
  return 1;
}

function certaintyWord(pips: 1 | 2 | 3 | 4): string {
  if (pips >= 4) return m(msg("High", { $context: "cerno certainty level" }));
  if (pips === 3) return m(msg("Medium", { $context: "cerno certainty level" }));
  return m(msg("Low", { $context: "cerno certainty level" }));
}

function formatSilenceAge(silenceSec: number): string {
  const sec = Math.max(0, Math.round(silenceSec));
  if (sec < 60) return `${sec}s`;
  const min = Math.floor(sec / 60);
  if (min < 60) return `${min}m`;
  return `${Math.floor(min / 60)}h`;
}

function formatAgo(age: string): string {
  return m(msg("{age} ago", { age, $context: "cerno relative age" }));
}

export function presentCernoRun(run: CernoLiveRun): CernoOperatorPresentation {
  const age = formatSilenceAge(run.silenceSec);

  if (run.prompt || run.state === "NEEDS_INPUT") {
    const conf = run.state === "NEEDS_INPUT" ? run.confidence : run.stateProbs.NEEDS_INPUT;
    const pct = Math.round(conf * 100);
    const pips = confidenceToPips(conf);
    return {
      verdict: m(msg("Needs input", { $context: "cerno process status" })),
      tone: "destructive",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness: m(msg("stdin blocked", { $context: "cerno liveness status" })),
      reason: run.authRequired
        ? m(msg("Process is blocked waiting on credentials or an interactive prompt."))
        : m(msg("Process is blocked reading stdin and will not finish without input.")),
      actionNote: m(msg("Stop or supply input.")),
    };
  }

  if (run.hangLoop || run.state === "STUCK_LOOP" || run.alert?.startsWith("stall:")) {
    const conf = run.state === "STUCK_LOOP" ? run.confidence : run.stateProbs.STUCK_LOOP;
    const pct = Math.round(conf * 100);
    const pips = confidenceToPips(conf);
    return {
      verdict: m(msg("Stalled", { $context: "cerno process status" })),
      tone: "destructive",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness: m(msg("{age} silent", { age, $context: "cerno silence duration" })),
      reason: m(msg("No output or CPU progress detected; process appears stuck or looping.")),
      actionNote: m(msg("Inspect log output or stop the thread.")),
    };
  }

  if (
    run.state === "FAILED" ||
    run.outcome === "FAIL" ||
    run.pFail >= run.cutoffs.suspThresh ||
    run.alert?.startsWith("mid_stream_fail:")
  ) {
    const conf =
      run.state === "FAILED"
        ? Math.max(run.pFail, run.confidence)
        : Math.max(run.pFail, run.stateProbs.FAILED);
    const pct = Math.round(conf * 100);
    const pips = confidenceToPips(conf);
    const confirmed =
      run.pFail >= run.cutoffs.confThresh || run.alert === "mid_stream_fail:confirmed";
    return {
      verdict: confirmed
        ? m(msg("Failing", { $context: "cerno process status" }))
        : m(msg("Likely failing", { $context: "cerno process status" })),
      tone: confirmed ? "destructive" : "warning",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness: formatAgo(age),
      reason: m(msg("Failure signals detected in the stream; watch log output or stop early.")),
      actionNote: confirmed
        ? m(msg("Confirmed failure threshold reached."))
        : m(msg("Warning threshold crossed; monitoring for confirmation.")),
    };
  }

  if (run.serverReady || run.alert === "server_ready") {
    const pct = Math.round(run.confidence * 100);
    const pips = confidenceToPips(run.confidence);
    return {
      verdict: m(msg("Server ready", { $context: "cerno process status" })),
      tone: "success",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness: run.hasListenSocket
        ? m(msg("listening", { $context: "cerno listening socket status" }))
        : formatAgo(age),
      reason: m(msg("Server reported ready and opened a listening socket.")),
      actionNote: m(msg("Service is up.")),
    };
  }

  if (run.hasExtFileLock) {
    const pct = Math.round(run.confidence * 100);
    const pips = confidenceToPips(run.confidence);
    return {
      verdict: m(msg("Waiting on lock", { $context: "cerno process status" })),
      tone: "info",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness: m(msg("flock · {age}", { age, $context: "cerno file lock wait duration" })),
      reason: m(
        msg("Waiting on an external file lock held by another process; stall alert suppressed."),
      ),
      actionNote: m(msg("Will resume automatically when the lock clears.")),
    };
  }

  if (run.state === "SUCCEEDED") {
    const pct = Math.round(run.confidence * 100);
    const pips = confidenceToPips(run.confidence);
    return {
      verdict: m(msg("Succeeded", { $context: "cerno process status" })),
      tone: "success",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness:
        run.silenceSec < 2
          ? m(msg("active", { $context: "cerno active output status" }))
          : formatAgo(age),
      reason: m(msg("Process output indicates successful completion.")),
      actionNote: m(msg("Waiting for process exit.")),
    };
  }

  const pct = Math.round(run.confidence * 100);
  const pips = confidenceToPips(run.confidence);
  const liveness =
    run.silenceSec < 2
      ? m(msg("active", { $context: "cerno active output status" }))
      : formatAgo(age);

  if (run.confidence < HEALTHY_MIN_CONFIDENCE) {
    return {
      verdict: m(msg("Uncertain", { $context: "cerno process status" })),
      tone: "neutral",
      pips,
      certaintyLabel: certaintyWord(pips),
      confidencePct: pct,
      liveness,
      reason: m(msg("Model confidence is still low; collecting more output signals.")),
      actionNote: m(msg("Monitoring continues; cerno wakes on confirmed failure or stall.")),
    };
  }

  return {
    verdict: m(msg("Healthy", { $context: "cerno process status" })),
    tone: "info",
    pips,
    certaintyLabel: certaintyWord(pips),
    confidencePct: pct,
    liveness,
    reason: run.hasRemoteSocket
      ? m(msg("Remote process is active with no failure or loop signals detected."))
      : m(msg("Process is running normally with no failure or loop signals detected.")),
    actionNote: m(msg("No action needed; cerno wakes on confirmed failure or stall.")),
  };
}

function cwdMatches(run: CernoLiveRun, cwd: string | null | undefined): boolean {
  if (!cwd || !run.cwd) return true;
  return run.cwd === cwd;
}

/**
 * Assigns live cerno runs to tasks one-to-one. Only commands that actually invoke `cerno`
 * are eligible; matches prioritize exact `--log` path, then exact unwrapped child command
 * scoped by `cwd` when present.
 */
const STANDALONE_CERNO_TASK_PREFIX = "cerno-run:";

function resolveMaybeRelativeLogPath(rawLogPath: string, cwd: string | null | undefined): string {
  const cleaned = rawLogPath.replace(/\/+$/u, "");
  if (cleaned.startsWith("/")) return cleaned;
  if (cwd && cwd.startsWith("/")) {
    const base = cwd.replace(/\/+$/u, "");
    const parts = `${base}/${cleaned}`.split("/");
    const stack: string[] = [];
    for (const part of parts) {
      if (!part || part === ".") continue;
      if (part === "..") {
        stack.pop();
      } else {
        stack.push(part);
      }
    }
    return `/${stack.join("/")}`;
  }
  return cleaned;
}

export function matchCernoRunsToTasks(
  tasks: ReadonlyArray<CernoMatchCandidate>,
  runs: ReadonlyArray<CernoLiveRun>,
  cwd?: string | null | undefined,
): ReadonlyMap<string, CernoLiveRun | null> {
  const result = new Map<string, CernoLiveRun | null>();
  for (const task of tasks) {
    result.set(task.taskId, null);
  }
  if (runs.length === 0) return result;

  const usedPids = new Set<number>();

  // Pass 0: synthetic standalone cerno-run:<pid> tasks match directly by PID.
  for (const task of tasks) {
    if (!task.taskId.startsWith(STANDALONE_CERNO_TASK_PREFIX)) continue;
    const pid = Number(task.taskId.slice(STANDALONE_CERNO_TASK_PREFIX.length));
    if (!Number.isInteger(pid) || pid <= 0) continue;
    const picked = runs.find((run) => !usedPids.has(run.pid) && run.pid === pid);
    if (picked) {
      result.set(task.taskId, picked);
      usedPids.add(picked.pid);
    }
  }

  const cernoTasks = tasks.filter(
    (task) => !result.get(task.taskId) && isCernoCommand(task.command),
  );

  // Pass 1: exact --log / tail file path match (resolving relative --log against cwd).
  for (const task of cernoTasks) {
    const rawLogPath = extractCernoLogPath(task.command);
    if (!rawLogPath) continue;
    const resolved = resolveMaybeRelativeLogPath(rawLogPath, cwd);
    const candidates = runs.filter((run) => {
      if (usedPids.has(run.pid) || run.logPath === null) return false;
      const runResolved = resolveMaybeRelativeLogPath(run.logPath, run.cwd);
      const taskResolvedWithRunCwd = resolveMaybeRelativeLogPath(rawLogPath, run.cwd);
      return (
        run.logPath === rawLogPath ||
        run.logPath === resolved ||
        runResolved === resolved ||
        runResolved === taskResolvedWithRunCwd
      );
    });
    if (candidates.length === 0) continue;
    const picked = (cwd ? candidates.find((run) => run.cwd === cwd) : undefined) ?? candidates[0]!;
    result.set(task.taskId, picked);
    usedPids.add(picked.pid);
  }

  // Pass 2: exact unwrapped child command equality, constrained by cwd when known.
  for (const task of cernoTasks) {
    if (result.get(task.taskId)) continue;
    const unwrapped = unwrapCernoCommand(task.command);
    if (!unwrapped) continue;
    const candidates = runs.filter((run) => {
      if (usedPids.has(run.pid)) return false;
      const normRun = normalizeShellCommand(run.command);
      if (normRun !== unwrapped) return false;
      return cwdMatches(run, cwd);
    });
    if (candidates.length === 0) continue;
    if (!cwd && candidates.length > 1) continue;
    const picked = candidates[0]!;
    result.set(task.taskId, picked);
    usedPids.add(picked.pid);
  }

  return result;
}

/**
 * Keeps live thread-attributed `cerno` runs visible in the thread rail even after the harness's
 * post-settle command hold empties `pendingBackgroundTasks` and `turnItems`.
 */
export function mergeStandaloneThreadCernoTasks(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  matchedByTaskId: ReadonlyMap<string, CernoLiveRun | null>,
  runs: ReadonlyArray<CernoLiveRun>,
  threadId: ThreadId,
  options?: { readonly excludeShipQueue?: boolean | undefined },
): {
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
  readonly matchedByTaskId: ReadonlyMap<string, CernoLiveRun | null>;
} {
  if (runs.length === 0) {
    return { tasks, matchedByTaskId };
  }
  const matchedPids = new Set<number>();
  for (const run of matchedByTaskId.values()) {
    if (run) matchedPids.add(run.pid);
  }
  const synthetic: Array<OrchestrationV2PendingBackgroundTask> = [];
  const nextMatched = new Map(matchedByTaskId);
  for (const run of runs) {
    if (matchedPids.has(run.pid)) continue;
    if (run.threadId !== threadId) continue;
    if (options?.excludeShipQueue && isShipQueueCommand(run.command)) continue;
    const taskId = `${STANDALONE_CERNO_TASK_PREFIX}${run.pid}`;
    synthetic.push({
      taskId,
      kind: "monitor",
      command: run.command,
      sourceThreadId: threadId,
    });
    nextMatched.set(taskId, run);
    matchedPids.add(run.pid);
  }
  if (synthetic.length === 0) {
    return { tasks, matchedByTaskId };
  }
  return {
    tasks: [...tasks, ...synthetic],
    matchedByTaskId: nextMatched,
  };
}

export function matchCernoRunForTask(
  runs: ReadonlyArray<CernoLiveRun>,
  command: string | null | undefined,
  cwd?: string | null | undefined,
): CernoLiveRun | null {
  return matchCernoRunsToTasks([{ taskId: "single", command }], runs, cwd).get("single") ?? null;
}

/**
 * Surfaces active foreground `cerno` command items alongside pending background tasks so long
 * foreground `cerno watch` runs also appear in the thread rail.
 */
export function mergeRunningCernoTurnTasks(
  tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>,
  turnItems: ThreadStructure["turnItems"],
): ReadonlyArray<OrchestrationV2PendingBackgroundTask> {
  const knownItemIds = new Set(tasks.map((task) => task.itemId).filter(Boolean));
  const synthetic: Array<OrchestrationV2PendingBackgroundTask> = [];
  for (const item of turnItems) {
    if (item.type !== "command_execution" || item.status !== "running") continue;
    if (knownItemIds.has(item.id)) continue;
    if (!isCernoCommand(item.input)) continue;
    synthetic.push({
      taskId: `cerno-item:${item.id}`,
      kind: "monitor",
      command: item.input,
      itemId: item.id,
      sourceThreadId: item.threadId,
      awaited: true,
    });
  }
  return synthetic.length > 0 ? [...tasks, ...synthetic] : tasks;
}

export function formatCernoElapsed(run: CernoLiveRun, nowMs?: number): string {
  const elapsedMs =
    nowMs !== undefined && run.startedAtMs > 0
      ? Math.max(0, nowMs - run.startedAtMs)
      : Math.max(0, Math.round(run.elapsedSec * 1000));
  return formatCompactElapsed(elapsedMs);
}

/**
 * Parses streamed command output and cerno's file log tail separately so overlapping lines
 * are never double-counted, preferring structured progress/metrics from the log tail.
 */
export function selectCommandOutputMetrics(
  streamText: string,
  cernoLogTail?: string | null,
): ParsedJobMetrics | null {
  const logMetrics = cernoLogTail ? parseCommandOutputMetrics(cernoLogTail) : null;
  const streamMetrics = streamText ? parseCommandOutputMetrics(streamText) : null;
  if (!logMetrics) return streamMetrics;
  if (!streamMetrics) return logMetrics;
  return {
    progress: logMetrics.progress ?? streamMetrics.progress,
    kpis: logMetrics.kpis.length > 0 ? logMetrics.kpis : streamMetrics.kpis,
    series: logMetrics.series.length > 0 ? logMetrics.series : streamMetrics.series,
  };
}
