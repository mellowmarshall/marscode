import type { OrchestrationV2PendingBackgroundTask } from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "../../i18n/messages";
import { flattenShellContinuations, unwrapCernoTokens } from "./cernoCommand";

export interface ParsedJobProgress {
  readonly current: number;
  readonly total: number;
  readonly fraction: number;
  readonly unit?: string;
  readonly stageLabel?: string;
  readonly rate?: string;
  readonly etaText?: string;
}

export interface ParsedJobKpi {
  readonly key: string;
  readonly label: string;
  readonly value: number | null;
  readonly text: string;
  readonly anomaly?: "nan" | "inf";
}

export interface ParsedJobMetricPoint {
  readonly index: number;
  readonly step: number | null;
  readonly value: number | null;
  readonly anomaly?: "nan" | "inf";
}

export interface ParsedJobMetricSeries {
  readonly key: string;
  readonly label: string;
  readonly unit?: string;
  readonly points: ReadonlyArray<ParsedJobMetricPoint>;
}

export interface ParsedJobMetrics {
  readonly progress: ParsedJobProgress | null;
  readonly kpis: ReadonlyArray<ParsedJobKpi>;
  readonly series: ReadonlyArray<ParsedJobMetricSeries>;
}

const MAX_SCAN_LINES = 400;
const MAX_SERIES_POINTS = 120;
const MAX_KPIS = 6;
// Match CSI / SGR and OSC terminal escape sequences cleanly before parsing metrics.
const ANSI_ESCAPE_PATTERN = /(?:\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\))/gu;

const TRACKED_KPI_KEYS = new Map<string, { readonly label: string; readonly unit?: string }>([
  ["train/loss", { label: "train/loss" }],
  ["eval/loss", { label: "eval/loss" }],
  ["val/loss", { label: "val/loss" }],
  ["eval_loss", { label: "eval_loss" }],
  ["val_loss", { label: "val_loss" }],
  ["loss", { label: "loss" }],
  ["lr", { label: "lr" }],
  ["grad_norm", { label: "grad_norm" }],
  ["accuracy", { label: "accuracy" }],
  ["acc", { label: "acc" }],
  ["ppl", { label: "ppl" }],
  ["fps", { label: "fps", unit: "fps" }],
  ["tok/s", { label: "tok/s", unit: "tok/s" }],
  ["tokens/s", { label: "tokens/s", unit: "tok/s" }],
  ["it/s", { label: "it/s", unit: "it/s" }],
  ["passed", { label: "passed" }],
  ["failed", { label: "failed" }],
]);

const SERIES_EXCLUDED_KEYS = new Set(["passed", "failed"]);

const KV_METRIC_RE =
  /(?<![a-zA-Z0-9_/])([a-zA-Z][a-zA-Z0-9_./-]{0,24})\s*[=:]\s*([-+]?(?:\d+(?:\.\d+)?(?:[eE][-+]?\d+)?|nan|NaN|NAN|inf|Inf|INF|infinity|Infinity))/gu;

const RATE_RE = /(\d+(?:\.\d+)?)\s*(it\/s|s\/it|tok\/s|tokens\/s|steps\/s|samples\/s|fps)/iu;
const ETA_WORD_RE = /\bETA\s*[:=]?\s*(\d{1,2}:\d{2}(?::\d{2})?|\d+[hms](?:\s*\d+[ms])?)/iu;
const TQDM_RE = /(\d{1,3})%\|[^|]*\|\s*(\d+(?:\.\d+)?)\s*\/\s*(\d+(?:\.\d+)?)\s*(?:\[([^\]]*)\])?/u;
const STEP_FRACTION_RE =
  /\b(step|steps|iter|batch|batches|sample|samples|frame|frames|epoch|epochs)\s*[=:]?\s*(\d+)\s*\/\s*(\d+)/giu;
const BRACKET_FRACTION_RE = /\[(\d+)\s*\/\s*(\d+)\]/u;
const VITEST_PASSED_RE = /\b(\d+)\s+passed\s+\((\d+)\)/iu;
const PERCENT_WORD_RE = /\b(\d{1,3}(?:\.\d+)?)%\s+(?:complete|done|progress)\b/iu;

export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_PATTERN, "");
}

function clampFraction(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

function parseNumericOrAnomaly(raw: string): {
  readonly value: number | null;
  readonly anomaly?: "nan" | "inf";
} {
  const lower = raw.toLowerCase();
  if (lower === "nan") return { value: null, anomaly: "nan" };
  if (lower.includes("inf")) return { value: null, anomaly: "inf" };
  const parsed = Number(raw);
  if (!Number.isFinite(parsed)) return { value: null, anomaly: "inf" };
  return { value: parsed };
}

export function formatMetricValue(value: number | null, anomaly?: "nan" | "inf"): string {
  if (anomaly === "nan") return "NaN";
  if (anomaly === "inf") return m(msg("Inf"));
  if (value === null || !Number.isFinite(value)) return "-";
  if (value === 0) return "0";
  const abs = Math.abs(value);
  if (abs < 1e-3 || abs >= 1e5) return value.toExponential(2);
  if (Number.isInteger(value)) return String(value);
  if (abs < 1) return value.toPrecision(3);
  return Number(value.toFixed(3)).toString();
}

function normalizeUnit(token: string): string {
  const lower = token.toLowerCase();
  if (lower === "step") return "steps";
  if (lower === "batch") return "batches";
  if (lower === "sample") return "samples";
  if (lower === "frame") return "frames";
  if (lower === "epoch") return "epochs";
  return lower;
}

function parseLineProgress(line: string): ParsedJobProgress | null {
  const rateMatch = RATE_RE.exec(line);
  const rate = rateMatch ? `${rateMatch[1]} ${rateMatch[2]}` : undefined;
  const etaWordMatch = ETA_WORD_RE.exec(line);
  const etaFromWord = etaWordMatch?.[1];

  const tqdm = TQDM_RE.exec(line);
  if (tqdm) {
    const pct = Number(tqdm[1]);
    const current = Number(tqdm[2]);
    const total = Number(tqdm[3]);
    if (Number.isFinite(total) && total > 0 && Number.isFinite(current)) {
      const bracket = tqdm[4] ?? "";
      const bracketEta = /<\s*([0-9:?]+)/u.exec(bracket)?.[1];
      const etaText = etaFromWord ?? (bracketEta && bracketEta !== "?" ? bracketEta : undefined);
      return {
        current,
        total,
        fraction: clampFraction(Number.isFinite(pct) ? pct / 100 : current / total),
        unit: "items",
        ...(rate ? { rate } : {}),
        ...(etaText ? { etaText } : {}),
      };
    }
  }

  let primary: { current: number; total: number; unit: string } | null = null;
  let epochStage: string | undefined;
  STEP_FRACTION_RE.lastIndex = 0;
  let match = STEP_FRACTION_RE.exec(line);
  while (match !== null) {
    const rawUnit = match[1]?.toLowerCase() ?? "";
    const current = Number(match[2]);
    const total = Number(match[3]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current <= total * 1.1) {
      if (rawUnit === "epoch" || rawUnit === "epochs") {
        epochStage = `Epoch ${current}/${total}`;
      }
      if (!primary || rawUnit !== "epoch") {
        primary = { current, total, unit: normalizeUnit(rawUnit) };
      }
    }
    match = STEP_FRACTION_RE.exec(line);
  }
  if (primary) {
    return {
      current: primary.current,
      total: primary.total,
      fraction: clampFraction(primary.current / primary.total),
      unit: primary.unit,
      ...(epochStage && primary.unit !== "epochs" ? { stageLabel: epochStage } : {}),
      ...(rate ? { rate } : {}),
      ...(etaFromWord ? { etaText: etaFromWord } : {}),
    };
  }

  const bracket = BRACKET_FRACTION_RE.exec(line);
  if (bracket) {
    const current = Number(bracket[1]);
    const total = Number(bracket[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current <= total) {
      return {
        current,
        total,
        fraction: clampFraction(current / total),
        ...(epochStage ? { stageLabel: epochStage } : {}),
        ...(rate ? { rate } : {}),
        ...(etaFromWord ? { etaText: etaFromWord } : {}),
      };
    }
  }

  const vitest = VITEST_PASSED_RE.exec(line);
  if (vitest) {
    const current = Number(vitest[1]);
    const total = Number(vitest[2]);
    if (Number.isFinite(current) && Number.isFinite(total) && total > 0 && current <= total) {
      return {
        current,
        total,
        fraction: clampFraction(current / total),
        unit: "tests",
      };
    }
  }

  const percentWord = PERCENT_WORD_RE.exec(line);
  if (percentWord) {
    const pct = Number(percentWord[1]);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      return {
        current: pct,
        total: 100,
        fraction: clampFraction(pct / 100),
        unit: "%",
        ...(rate ? { rate } : {}),
        ...(etaFromWord ? { etaText: etaFromWord } : {}),
      };
    }
  }

  return null;
}

export function isPlottableSeries(series: Pick<ParsedJobMetricSeries, "points">): boolean {
  let minVal = Number.POSITIVE_INFINITY;
  let maxVal = Number.NEGATIVE_INFINITY;
  let finiteCount = 0;
  for (const pt of series.points) {
    if (pt.anomaly) return true;
    if (pt.value !== null && Number.isFinite(pt.value)) {
      finiteCount += 1;
      if (pt.value < minVal) minVal = pt.value;
      if (pt.value > maxVal) maxVal = pt.value;
    }
  }
  return finiteCount >= 2 && maxVal - minVal > 1e-12;
}

export function parseCommandOutputMetrics(rawText: string): ParsedJobMetrics {
  const clean = stripAnsi(rawText);
  if (!clean.trim()) {
    return { progress: null, kpis: [], series: [] };
  }

  const lines = clean
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .slice(-MAX_SCAN_LINES);

  let latestProgress: ParsedJobProgress | null = null;
  const latestKpiByKey = new Map<string, ParsedJobKpi>();
  const seriesPointsByKey = new Map<string, Array<ParsedJobMetricPoint>>();

  for (let lineIdx = 0; lineIdx < lines.length; lineIdx += 1) {
    const line = lines[lineIdx]!;
    const lineProgress = parseLineProgress(line);
    if (lineProgress) {
      latestProgress = lineProgress;
    }

    const lineStepMatch = /\b(?:step|steps|iter)\s*[=:]?\s*(\d+)/iu.exec(line);
    const step = lineStepMatch ? Number(lineStepMatch[1]) : null;

    KV_METRIC_RE.lastIndex = 0;
    let kv = KV_METRIC_RE.exec(line);
    while (kv !== null) {
      const rawKey = kv[1]!.toLowerCase();
      const rawVal = kv[2]!;
      const tracked = TRACKED_KPI_KEYS.get(rawKey);
      if (tracked) {
        const parsed = parseNumericOrAnomaly(rawVal);
        latestKpiByKey.set(rawKey, {
          key: rawKey,
          label: tracked.label,
          value: parsed.value,
          text: formatMetricValue(parsed.value, parsed.anomaly),
          ...(parsed.anomaly ? { anomaly: parsed.anomaly } : {}),
        });
        if (!SERIES_EXCLUDED_KEYS.has(rawKey)) {
          let list = seriesPointsByKey.get(rawKey);
          if (!list) {
            list = [];
            seriesPointsByKey.set(rawKey, list);
          }
          list.push({
            index: list.length,
            step: step !== null && Number.isFinite(step) ? step : null,
            value: parsed.value,
            ...(parsed.anomaly ? { anomaly: parsed.anomaly } : {}),
          });
          if (list.length > MAX_SERIES_POINTS) {
            list.shift();
          }
        }
      }
      kv = KV_METRIC_RE.exec(line);
    }

    const inlineRate = RATE_RE.exec(line);
    if (inlineRate) {
      const rateUnitKey = inlineRate[2]!.toLowerCase();
      const numeric = Number(inlineRate[1]);
      if (Number.isFinite(numeric)) {
        const key = rateUnitKey;
        let list = seriesPointsByKey.get(key);
        if (!list) {
          list = [];
          seriesPointsByKey.set(key, list);
        }
        list.push({
          index: list.length,
          step: step !== null && Number.isFinite(step) ? step : null,
          value: numeric,
        });
        if (list.length > MAX_SERIES_POINTS) {
          list.shift();
        }
      }
    }
  }

  const kpis = [...latestKpiByKey.values()].slice(0, MAX_KPIS);
  const series: Array<ParsedJobMetricSeries> = [];
  for (const [key, points] of seriesPointsByKey) {
    const meta = TRACKED_KPI_KEYS.get(key);
    const label = meta?.label ?? key;
    const candidate: ParsedJobMetricSeries = {
      key,
      label,
      ...(meta?.unit ? { unit: meta.unit } : {}),
      points,
    };
    if (isPlottableSeries(candidate)) {
      series.push(candidate);
    }
  }

  return {
    progress: latestProgress,
    kpis,
    series,
  };
}

export function detectSilentStallSeconds(
  lastUpdatedAtMs: number | null,
  nowMs: number,
  running: boolean,
  thresholdSeconds = 60,
): number | null {
  if (!running || lastUpdatedAtMs === null || !Number.isFinite(lastUpdatedAtMs)) return null;
  const silentSeconds = Math.floor((nowMs - lastUpdatedAtMs) / 1000);
  return silentSeconds >= thresholdSeconds ? silentSeconds : null;
}

export function formatCompactElapsed(elapsedMs: number): string {
  if (!Number.isFinite(elapsedMs) || elapsedMs < 0) return "0s";
  const totalSeconds = Math.floor(elapsedMs / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const totalMinutes = Math.floor(totalSeconds / 60);
  if (totalMinutes < 60) return `${totalMinutes}m`;
  const hours = Math.floor(totalMinutes / 60);
  return `${hours}h`;
}

function summarizeShellCommand(rawCommand: string): string {
  const flat = flattenShellContinuations(rawCommand);
  const firstLine =
    flat
      .split(/\r?\n/u)
      .map((l) => l.trim())
      .find((l) => l.length > 0 && !l.startsWith("#")) ?? "";
  if (!firstLine) return "";

  const tokens = firstLine.split(/\s+/u).filter(Boolean);
  let idx = 0;
  while (idx < tokens.length && /^[A-Za-z_][A-Za-z0-9_]*=/.test(tokens[idx]!)) idx += 1;
  const rest = unwrapCernoTokens(tokens.slice(idx));
  if (rest.length === 0) return firstLine;

  const execRaw = rest[0]!;
  const execName = execRaw.split("/").pop() || execRaw;
  const meaningful: string[] = [execName];

  for (let i = 1; i < rest.length && meaningful.length < 3; i += 1) {
    const token = rest[i]!.replace(/^['"]|['"]$/gu, "");
    if (!token || token === "\\") continue;
    if (
      execName === "ssh" &&
      meaningful.length >= 2 &&
      (token === "set" || token === "cd" || token === "export")
    )
      break;
    if (token === "-m" && i + 1 < rest.length) {
      meaningful.push(rest[++i]!);
      continue;
    }
    if (token.startsWith("-")) {
      if (meaningful.length >= 2) break;
      if (
        token.startsWith("--") &&
        !token.includes("=") &&
        i + 1 < rest.length &&
        !rest[i + 1]!.startsWith("-")
      ) {
        i += 1;
      }
      continue;
    }
    if (token.includes("/") && token.length > 22) {
      const leaf = token.split("/").filter(Boolean).pop();
      if (leaf) meaningful.push(leaf);
      continue;
    }
    meaningful.push(token);
  }

  return meaningful.join(" ");
}

export function shortJobLabel(
  task: Pick<OrchestrationV2PendingBackgroundTask, "kind" | "description" | "command">,
  fallbackCommand?: string,
): string {
  const description = task.description?.replace(/\s+/gu, " ").trim();
  const cmd = (task.command ?? fallbackCommand)?.trim();
  if (description && description !== cmd) {
    return description;
  }
  if (cmd) {
    const short = summarizeShellCommand(cmd);
    if (short) return short;
  }
  if (task.kind === "subagent") return m(msg("Subagent", { $context: "background job kind" }));
  if (task.kind === "monitor") return m(msg("Monitor", { $context: "background job kind" }));
  if (task.kind === "command") return m(msg("Command", { $context: "background job kind" }));
  return m(msg("Background task", { $context: "background job kind" }));
}
