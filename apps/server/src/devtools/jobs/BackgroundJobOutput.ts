// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalDateInEffect:off - Live output, metric extraction, progress/ETA tracking, and safe log tailing for background jobs.
import { ThreadId, TurnItemId, type OrchestrationV2CommandOutputFrame } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Stream from "effect/Stream";

import { extractCommandLogPath } from "./commandJobParser.ts";
import {
  appendMetricPoint,
  createLineExtractor,
  splitLogLines,
  stripAnsi,
  type ExtractedLineRecord,
  type ExtractedNumericValue,
} from "./extractors.ts";
import { formatMetricLabel, isNoiseMetricKey, mapLogOpenFailureKind } from "./jobMetricFilter.ts";
import { openValidatedLogFile } from "./logFileGuard.ts";
import { AdaptiveLogTailer, type LogTailBatch } from "./LogTailer.ts";
import { isStallAnomalyText, type ManagedJobRecord } from "./managedJobHelpers.ts";
import { extractGenericProgress } from "./progressExtractor.ts";
import { isSafeMetricKey, isTerminalJobState, sanitizeJobText } from "./types.ts";

const MAX_SERIES_PER_JOB = 16;
const MAX_STREAM_TAIL_LINES = 200;
const MAX_STREAM_TAIL_BYTES = 64 * 1024;
const LOG_RETRY_DELAYS_MS = [1_000, 3_000, 8_000] as const;

const EMPTY_FIELDS: ReadonlyMap<string, ExtractedNumericValue> = new Map();
const EMPTY_STRINGS: ReadonlyMap<string, string> = new Map();
const KV_EXTRACTOR = createLineExtractor("kv");

const PROGRESS_KEY_DEFAULTS = [
  { current: "step", total: "total_steps", outerCurrent: "epoch", outerTotal: "total_epochs" },
  { current: "current", total: "total", outerCurrent: undefined, outerTotal: undefined },
  { current: "epoch", total: "total_epochs", outerCurrent: undefined, outerTotal: undefined },
] as const;

function updateProgressAndEta(
  job: ManagedJobRecord,
  input: {
    readonly current: number;
    readonly total: number;
    readonly unit?: string | undefined;
    readonly rate?: number | undefined;
    readonly rateUnit?: string | undefined;
    readonly stageLabel?: string | undefined;
  },
  nowMs: number,
): void {
  if (!Number.isFinite(input.current) || !Number.isFinite(input.total) || input.total <= 0) return;
  const current = Math.max(0, input.current);
  const total = Math.max(1e-9, input.total);
  const fraction = Math.max(0, Math.min(1, current / total));

  const last = job.rateSamples.at(-1);
  const totalChanged = job.progress !== undefined && job.progress.total !== total;
  if (totalChanged || (last && current < last.current)) {
    job.rateSamples.length = 0;
  }
  const latestAfterReset = job.rateSamples.at(-1);
  if (
    !latestAfterReset ||
    current > latestAfterReset.current ||
    nowMs - latestAfterReset.t >= 5_000
  ) {
    job.rateSamples.push({ t: nowMs, current });
    if (job.rateSamples.length > 8) job.rateSamples.shift();
  }

  let computedRate =
    typeof input.rate === "number" && Number.isFinite(input.rate) && input.rate > 0
      ? input.rate
      : undefined;
  if (computedRate === undefined && job.rateSamples.length >= 2) {
    const first = job.rateSamples[0]!;
    const latest = job.rateSamples.at(-1)!;
    const dtSec = (latest.t - first.t) / 1_000;
    const dc = latest.current - first.current;
    if (dtSec >= 1 && dc > 0) computedRate = dc / dtSec;
  }

  const remaining = Math.max(0, total - current);
  job.etaSeconds =
    computedRate && computedRate > 0 && remaining > 0
      ? Math.min(30 * 86_400, Math.round(remaining / computedRate))
      : undefined;

  job.progress = {
    current,
    total,
    fraction,
    ...(input.unit
      ? { unit: sanitizeJobText(input.unit, 16) }
      : job.progress?.unit
        ? { unit: job.progress.unit }
        : {}),
    ...(computedRate !== undefined ? { rate: Math.round(computedRate * 1000) / 1000 } : {}),
    ...(input.rateUnit
      ? { rateUnit: sanitizeJobText(input.rateUnit, 16) }
      : input.unit
        ? { rateUnit: `${sanitizeJobText(input.unit, 12)}/s` }
        : job.progress?.rateUnit
          ? { rateUnit: job.progress.rateUnit }
          : {}),
    ...(input.stageLabel ? { stageLabel: sanitizeJobText(input.stageLabel, 48) } : {}),
  };
}

function recordSeriesPoint(
  job: ManagedJobRecord,
  key: string,
  val: { readonly value: number | null; readonly anomaly?: "nan" | "inf" | undefined },
  nowMs: number,
  xIndex: number | undefined,
): void {
  if (!isSafeMetricKey(key) || isNoiseMetricKey(key)) return;
  let series = job.series.get(key);
  if (!series) {
    if (job.series.size >= MAX_SERIES_PER_JOB) return;
    series = { key, label: formatMetricLabel(key), points: [], latestValue: null };
    job.series.set(key, series);
  }
  series.latestValue = val.value;
  series.latestAnomaly = val.anomaly;
  appendMetricPoint(series.points, {
    t: nowMs,
    ...(xIndex !== undefined ? { x: xIndex } : {}),
    v: val.value,
    ...(val.anomaly ? { anomaly: val.anomaly } : {}),
  });
  if (val.anomaly) job.anomalyText = `${key}=${val.anomaly}`;
}

function ingestExtractedRecords(
  job: ManagedJobRecord,
  records: ReadonlyArray<ExtractedLineRecord>,
  nowMs: number,
): boolean {
  let changed = false;
  for (const rec of records) {
    const progressSpec = PROGRESS_KEY_DEFAULTS.find(
      (cand) => rec.fields.has(cand.current) && rec.fields.has(cand.total),
    );
    const skippedProgressKeys = new Set<string>();
    let matchedExplicitProgress = false;

    if (progressSpec) {
      const curVal = rec.fields.get(progressSpec.current)?.value;
      const totVal = rec.fields.get(progressSpec.total)?.value;
      if (
        curVal !== null &&
        curVal !== undefined &&
        totVal !== null &&
        totVal !== undefined &&
        totVal > 0
      ) {
        matchedExplicitProgress = true;
        skippedProgressKeys.add(progressSpec.current);
        skippedProgressKeys.add(progressSpec.total);
        let overallCurrent = curVal;
        let overallTotal = totVal;
        let stageLabel: string | undefined;
        if (progressSpec.outerCurrent && progressSpec.outerTotal) {
          const outCur = rec.fields.get(progressSpec.outerCurrent)?.value;
          const outTot = rec.fields.get(progressSpec.outerTotal)?.value;
          if (
            outCur !== null &&
            outCur !== undefined &&
            outTot !== null &&
            outTot !== undefined &&
            outTot > 0
          ) {
            skippedProgressKeys.add(progressSpec.outerCurrent);
            skippedProgressKeys.add(progressSpec.outerTotal);
            overallCurrent = Math.max(0, outCur - 1) * totVal + curVal;
            overallTotal = outTot * totVal;
            stageLabel = `${formatMetricLabel(progressSpec.outerCurrent)} ${Math.round(outCur)}/${Math.round(outTot)}`;
          }
        }
        const rateVal = rec.fields.get("rate")?.value ?? undefined;
        if (rateVal !== undefined) skippedProgressKeys.add("rate");
        updateProgressAndEta(
          job,
          {
            current: overallCurrent,
            total: overallTotal,
            unit: progressSpec.current,
            rate: rateVal,
            stageLabel,
          },
          nowMs,
        );
        changed = true;
      }
    }

    if (!matchedExplicitProgress && rec.genericProgress) {
      const gp = rec.genericProgress;
      if (!(gp.isEvalStage && job.lastGenericOuter !== undefined)) {
        let overallCurrent = gp.current;
        let overallTotal = gp.total;
        let stageLabel = gp.stageLabel;

        if (gp.outerCurrent !== undefined && gp.outerTotal !== undefined && gp.outerTotal > 0) {
          let perEpoch = job.genericStepPerEpoch;
          if (
            perEpoch === undefined &&
            job.lastGenericOuter !== undefined &&
            gp.outerCurrent > job.lastGenericOuter &&
            job.lastGenericInner !== undefined
          ) {
            perEpoch = gp.current < job.lastGenericInner;
            job.genericStepPerEpoch = perEpoch;
          }
          if (perEpoch === true) {
            overallCurrent = Math.max(0, gp.outerCurrent - 1) * gp.total + gp.current;
            overallTotal = gp.outerTotal * gp.total;
          }
          stageLabel = `${gp.outerUnit ?? "Ep"} ${Math.round(gp.outerCurrent)}/${Math.round(gp.outerTotal)}`;
          job.lastGenericOuter = gp.outerCurrent;
          job.lastGenericInner = gp.current;
        }

        updateProgressAndEta(
          job,
          {
            current: overallCurrent,
            total: overallTotal,
            unit: gp.unit,
            rate: gp.rate,
            rateUnit: gp.rateUnit,
            stageLabel,
          },
          nowMs,
        );
        changed = true;
      }
    }

    const xIndex = job.progress?.current;
    for (const [key, val] of rec.fields) {
      if (skippedProgressKeys.has(key)) continue;
      recordSeriesPoint(job, key, val, nowMs, xIndex);
      changed = true;
    }
  }
  return changed;
}

function pushStreamTailLine(job: ManagedJobRecord, raw: string): void {
  const clean = stripAnsi(raw).trimEnd();
  if (!clean) return;
  const clipped = clean.length > 512 ? `${clean.slice(0, 512)}…` : clean;
  const bytes = Buffer.byteLength(clipped, "utf8");
  job.streamTailLines.push(clipped);
  job.streamTailBytes += bytes;
  while (
    job.streamTailLines.length > MAX_STREAM_TAIL_LINES ||
    job.streamTailBytes > MAX_STREAM_TAIL_BYTES
  ) {
    const dropped = job.streamTailLines.shift();
    if (dropped === undefined) break;
    job.streamTailBytes -= Buffer.byteLength(dropped, "utf8");
  }
}

export function ingestCommandOutputFrame(
  job: ManagedJobRecord,
  frame: { readonly kind: "replace" | "append"; readonly text: string },
  nowMs: number,
): { readonly hasNewLines: boolean; readonly metricsChanged: boolean } {
  if (frame.kind === "replace") {
    job.streamTailLines = [];
    job.streamTailBytes = 0;
    job.streamPendingLine = "";
  }
  if (!frame.text) return { hasNewLines: false, metricsChanged: false };

  const { lines, remainder } = splitLogLines(job.streamPendingLine, frame.text);
  job.streamPendingLine = remainder;
  const allLines =
    frame.kind === "replace" && remainder.trim() ? [...lines, remainder.trim()] : lines;
  if (frame.kind === "replace" && remainder.trim()) job.streamPendingLine = "";

  const extracted: ExtractedLineRecord[] = [];
  for (const rawLine of allLines) {
    pushStreamTailLine(job, rawLine);
    const clean = stripAnsi(rawLine);
    const rec = KV_EXTRACTOR(clean);
    const genericProgress = extractGenericProgress(clean);
    if (rec) {
      extracted.push(genericProgress ? { ...rec, genericProgress } : rec);
    } else if (genericProgress) {
      extracted.push({ fields: EMPTY_FIELDS, strings: EMPTY_STRINGS, genericProgress });
    }
  }

  const metricsChanged =
    extracted.length > 0 ? ingestExtractedRecords(job, extracted, nowMs) : false;
  return { hasNewLines: allLines.length > 0, metricsChanged };
}

export interface JobStreamAttachmentHooks {
  readonly localHostname: string;
  readonly isDisposed: () => boolean;
  readonly isWorkspaceAllowed: (realPath: string) => Promise<boolean>;
  readonly subscribeCommandOutput: (target: {
    readonly threadId: ThreadId;
    readonly itemId: TurnItemId;
  }) => Stream.Stream<OrchestrationV2CommandOutputFrame, unknown>;
  readonly onJobUpdated: (jobId: string, urgent: boolean) => void;
}

function emitThrottledUpdate(
  job: ManagedJobRecord,
  hasLines: boolean,
  metricsChanged: boolean,
  now: number,
  onJobUpdated: (jobId: string, urgent: boolean) => void,
): void {
  const throttleDue = hasLines && now - (job.lastTailEmitAtMs ?? 0) >= 1_000;
  if (metricsChanged || throttleDue) {
    job.lastTailEmitAtMs = now;
    job.revision += 1;
    onJobUpdated(job.id, false);
  }
}

async function tryAttachLogTailer(
  job: ManagedJobRecord,
  logPath: string,
  attempt: number,
  hooks: JobStreamAttachmentHooks,
): Promise<void> {
  if (hooks.isDisposed() || isTerminalJobState(job.state) || job.tailer) return;
  const opened = await openValidatedLogFile({
    explicitPath: logPath,
    isWorkspaceAllowed: hooks.isWorkspaceAllowed,
  });
  if (hooks.isDisposed() || isTerminalJobState(job.state)) {
    if (opened.ok) await opened.file.handle.close().catch(() => undefined);
    return;
  }
  const startedMs = Date.parse(job.startedAt);
  const isStaleLeftover =
    opened.ok && Number.isFinite(startedMs) && opened.file.mtimeMs < startedMs - 5_000;
  if (!opened.ok || isStaleLeftover) {
    if (opened.ok) await opened.file.handle.close().catch(() => undefined);
    const classified =
      isStaleLeftover || opened.ok
        ? { state: "pending_file" as const, retryable: true }
        : mapLogOpenFailureKind(opened.kind);
    const delay = classified.retryable ? LOG_RETRY_DELAYS_MS[attempt] : undefined;
    const rawReason = isStaleLeftover
      ? "Log file has not updated since job start"
      : opened.ok
        ? ""
        : classified.state === "pending_file" && delay === undefined
          ? "Log file did not appear while job ran"
          : opened.error;
    const nextState = classified.state;
    const nextReason = sanitizeJobText(rawReason, 180) || undefined;
    if (job.logState !== nextState || job.logStateReason !== nextReason) {
      job.logState = nextState;
      job.logStateReason = nextReason;
      job.revision += 1;
      hooks.onJobUpdated(job.id, false);
    }
    if (delay !== undefined) {
      job.logAttachTimer = setTimeout(() => {
        job.logAttachTimer = null;
        void tryAttachLogTailer(job, logPath, attempt + 1, hooks);
      }, delay);
      job.logAttachTimer.unref();
    }
    return;
  }

  job.logSource = { format: "kv", path: logPath };
  job.persistedLogPath = opened.file.realPath;
  const attachedChanged = job.logState !== "attached" || job.logStateReason !== undefined;
  job.logState = "attached";
  job.logStateReason = undefined;
  job.tailer = new AdaptiveLogTailer({
    file: opened.file,
    config: job.logSource,
    isWorkspaceAllowed: hooks.isWorkspaceAllowed,
    onBatch: (batch: LogTailBatch) => {
      if (isTerminalJobState(job.state)) return;
      const now = Date.now();
      job.lastActivityAtMs = now;
      job.persistedLinesParsed = batch.totalLinesParsed;
      if (isStallAnomalyText(job.anomalyText)) job.anomalyText = undefined;
      const changed = ingestExtractedRecords(job, batch.extracted, now);
      emitThrottledUpdate(job, batch.rawLines.length > 0, changed, now, hooks.onJobUpdated);
    },
  });
  job.tailer.start();
  if (attachedChanged) {
    job.revision += 1;
    hooks.onJobUpdated(job.id, false);
  }
}

export function attachJobStreamsIfNeeded(
  job: ManagedJobRecord,
  hooks: JobStreamAttachmentHooks,
): void {
  if (isTerminalJobState(job.state) || hooks.isDisposed()) return;

  if (job.itemId && !job.stopOutputStream) {
    const target = {
      threadId: ThreadId.make(job.threadId),
      itemId: TurnItemId.make(job.itemId),
    };
    const fiber = Effect.runFork(
      hooks.subscribeCommandOutput(target).pipe(
        Stream.runForEach((frame) =>
          Effect.sync(() => {
            if (hooks.isDisposed() || isTerminalJobState(job.state)) return;
            const now = Date.now();
            const { hasNewLines, metricsChanged } = ingestCommandOutputFrame(job, frame, now);
            if (!hasNewLines && !metricsChanged) return;
            job.lastActivityAtMs = now;
            if (isStallAnomalyText(job.anomalyText)) job.anomalyText = undefined;
            emitThrottledUpdate(job, hasNewLines, metricsChanged, now, hooks.onJobUpdated);
          }),
        ),
        Effect.ignore,
      ),
    );
    job.stopOutputStream = () => {
      void Effect.runPromise(Fiber.interrupt(fiber)).catch(() => undefined);
    };
  }

  const isRemoteHost = Boolean(job.binding.host && job.binding.host !== hooks.localHostname);
  if (isRemoteHost && !job.logState) {
    job.logState = "remote_unavailable";
    job.logStateReason = `Runs on remote host ${job.binding.host}`;
  } else if (!isRemoteHost && !job.tailer && !job.logAttachPath && job.command) {
    const logPath = extractCommandLogPath(job.command, job.binding.worktreePath);
    if (logPath) {
      job.logAttachPath = logPath;
      void tryAttachLogTailer(job, logPath, 0, hooks);
    }
  }
}

export async function cleanupJobStreams(job: ManagedJobRecord): Promise<void> {
  if (job.logAttachTimer) {
    clearTimeout(job.logAttachTimer);
    job.logAttachTimer = null;
  }
  if (job.stopOutputStream) {
    const stop = job.stopOutputStream;
    job.stopOutputStream = null;
    stop();
  }
  if (job.tailer) {
    await job.tailer.flushNow().catch(() => undefined);
    job.persistedTailLines = job.tailer.getTailLines();
    const cur = job.tailer.getCursor();
    job.persistedLogPath = cur.realPath;
    job.persistedLinesParsed = cur.linesParsed;
    await job.tailer.close().catch(() => undefined);
    job.tailer = undefined;
  }
}
