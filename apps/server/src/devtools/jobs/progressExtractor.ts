// @effect-diagnostics globalDate:off - O(n) generic progress extractor for real ML training, eval, and tqdm log lines.
import { sanitizeJobText } from "./types.ts";

export interface GenericProgressMatch {
  readonly current: number;
  readonly total: number;
  readonly unit?: string | undefined;
  readonly outerCurrent?: number | undefined;
  readonly outerTotal?: number | undefined;
  readonly outerUnit?: string | undefined;
  readonly rate?: number | undefined;
  readonly rateUnit?: string | undefined;
  readonly stageLabel?: string | undefined;
  /** True for tqdm bars labeled Eval/Val/Validation so inner eval bars do not reset training progress. */
  readonly isEvalStage?: boolean | undefined;
}

const MAX_SCAN_LEN = 1_024;

// Strips common leading logger timestamps (`2026-11-22 10:00:01 INFO `, `[10:00:01] `) so
// anchored tqdm and counter matchers work on timestamped training logs.
const LEADING_LOG_PREFIX_RE =
  /^(?:\[?\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}:\d{2}(?:[.,]\d+)?Z?\]?\s+|\[\d{2}:\d{2}:\d{2}\]\s+|\d{2}:\d{2}:\d{2}\s+)(?:(?:INFO|WARN|WARNING|DEBUG|ERROR)[:|\s]+)?/i;

// Skip transient HuggingFace / model-loading tqdm bars so a 0.3s `Loading weights: 100% | 391/391`
// never overwrites multi-minute encoding or training progress.
const TRANSIENT_NOISE_PREFIX_RE =
  /^(?:loading\s+(?:weights|checkpoint\s+shards|model|safetensors|tokenizer)|fetching\s+\d+\s+files|downloading\b)/i;

const EVAL_PREFIX_RE = /^(?:eval(?:uating|uation)?|val(?:id(?:ating|ation)?)?|dev\s+eval)\b/i;

const EPOCH_RATIO_RE =
  /(?:^|[\s[(|,:])(?:epoch|ep)\.?\s*[:=]?\s*(\d[\d,]{0,8})\s*\/\s*(\d[\d,]{0,8})(?=$|[\s\]|,:)])/i;

const STEP_RATIO_RE =
  /(?:^|[\s[(|,:])(steps?|global_step|iters?|iterations?|batch(?:es)?|chunks?|samples?|packs?|pairs?|evals?|shards?|splits?|cases?|items?)\.?\s*[:=]?\s*(\d[\d,]{0,11})\s*\/\s*(\d[\d,]{0,11})(?=$|[\s\]|,:)])/i;

const TQDM_BAR_RE =
  /^(?:([^|\r\n]{1,40}):\s*)?(\d{1,3})%\|[^|]{1,64}\|\s*(\d[\d,]{0,11})\s*\/\s*(\d[\d,]{0,11})\b/;

const INDENTED_RATIO_PAREN_RE = /^(\d[\d,]{0,11})\s*\/\s*(\d[\d,]{0,11})\s+\(([^)\r\n]{1,80})\)/;

const LEADING_BRACKET_RATIO_RE =
  /^\[(\d[\d,]{0,9})\s*\/\s*(\d[\d,]{0,9})\]\s+([A-Za-z][^\r\n]{0,80})/;

const LABELED_PCT_RE =
  /(?:^|[\s[(|])(?:progress|complete|completed)\s*[:=]?\s*(\d{1,3}(?:\.\d+)?)\s*%(?=$|[\s\]|,;)])/i;

const RATE_RE =
  /\b(\d+(?:\.\d+)?)\s*(it|its|steps?|batch(?:es)?|packs?|pairs?|samples?|seqs?|ex|examples|rows?|docs?|items?|queries)\/s\b/i;

const SEC_PER_IT_RE = /\b(\d+(?:\.\d+)?)\s*s\/(?:it|step|batch)\b/i;

function parseCount(raw: string | undefined): number | null {
  if (!raw) return null;
  const cleaned = raw.replaceAll(",", "");
  const num = Number.parseInt(cleaned, 10);
  return Number.isSafeInteger(num) && num >= 0 ? num : null;
}

function normalizeUnit(raw: string): string {
  const lower = raw.toLowerCase();
  if (lower === "step" || lower === "steps" || lower === "global_step") return "steps";
  if (lower === "iter" || lower === "iters" || lower === "iteration" || lower === "iterations") {
    return "iters";
  }
  if (lower === "batch" || lower === "batches") return "batches";
  if (lower === "epoch" || lower === "epochs" || lower === "ep") return "epochs";
  if (lower === "pack" || lower === "packs") return "packs";
  if (lower === "pair" || lower === "pairs") return "pairs";
  if (lower === "sample" || lower === "samples") return "samples";
  if (lower === "chunk" || lower === "chunks") return "chunks";
  if (lower === "shard" || lower === "shards") return "shards";
  if (lower === "split" || lower === "splits") return "splits";
  if (lower === "eval" || lower === "evals") return "evals";
  if (lower === "case" || lower === "cases") return "cases";
  if (lower === "item" || lower === "items") return "items";
  return lower.slice(0, 12);
}

function extractRate(
  line: string,
  counterUnit?: string,
): {
  readonly rate?: number | undefined;
  readonly rateUnit?: string | undefined;
} {
  const m = RATE_RE.exec(line);
  if (m) {
    const rate = Number.parseFloat(m[1]!);
    if (!Number.isFinite(rate) || rate <= 0) return {};
    const rawUnit = m[2]!.toLowerCase();
    const unitTok = rawUnit === "its" ? "it" : rawUnit;
    if (counterUnit && unitTok !== "it" && normalizeUnit(unitTok) !== counterUnit) {
      return {};
    }
    return { rate, rateUnit: `${unitTok}/s` };
  }
  const slow = SEC_PER_IT_RE.exec(line);
  if (slow) {
    const secPerIt = Number.parseFloat(slow[1]!);
    if (Number.isFinite(secPerIt) && secPerIt > 0) {
      return { rate: 1 / secPerIt, rateUnit: "it/s" };
    }
  }
  return {};
}

/**
 * Extracts step/epoch/tqdm/percentage progress from plain, unstructured training or eval logs
 * when explicit `logSource.progressFields` are not configured and the agent has not pushed progress.
 */
export function extractGenericProgress(cleanLine: string): GenericProgressMatch | null {
  const trimmed = cleanLine.trim();
  if (!trimmed) return null;
  const bounded = trimmed.length > MAX_SCAN_LEN ? trimmed.slice(0, MAX_SCAN_LEN) : trimmed;
  const line = bounded.replace(LEADING_LOG_PREFIX_RE, "");
  if (!line || TRANSIENT_NOISE_PREFIX_RE.test(line)) return null;

  // 1. Labeled epoch + step/iter/batch pair, or either standalone
  const epochMatch = EPOCH_RATIO_RE.exec(line);
  const stepMatch = STEP_RATIO_RE.exec(line);

  const epCur = epochMatch ? parseCount(epochMatch[1]) : null;
  const epTot = epochMatch ? parseCount(epochMatch[2]) : null;
  const hasValidEpoch = epCur !== null && epTot !== null && epTot > 0 && epCur <= epTot;

  const stCur = stepMatch ? parseCount(stepMatch[2]) : null;
  const stTot = stepMatch ? parseCount(stepMatch[3]) : null;
  const hasValidStep = stCur !== null && stTot !== null && stTot > 0 && stCur <= stTot;

  if (hasValidEpoch && hasValidStep) {
    const unit = normalizeUnit(stepMatch![1]!);
    const rateInfo = extractRate(line, unit);
    return {
      current: stCur,
      total: stTot,
      unit,
      outerCurrent: epCur,
      outerTotal: epTot,
      outerUnit: "Ep",
      ...(rateInfo.rate !== undefined ? { rate: rateInfo.rate } : {}),
      ...(rateInfo.rateUnit ? { rateUnit: rateInfo.rateUnit } : {}),
    };
  }

  if (hasValidStep) {
    const unit = normalizeUnit(stepMatch![1]!);
    const rateInfo = extractRate(line, unit);
    return {
      current: stCur,
      total: stTot,
      unit,
      ...(rateInfo.rate !== undefined ? { rate: rateInfo.rate } : {}),
      ...(rateInfo.rateUnit ? { rateUnit: rateInfo.rateUnit } : {}),
    };
  }

  // 2. tqdm / bar progress (`Training:  45%|████▌     | 450/1000 [01:23<01:41, 5.42it/s]`)
  const tqdmMatch = TQDM_BAR_RE.exec(line);
  if (tqdmMatch) {
    const prefix = tqdmMatch[1]?.trim() ?? "";
    if (prefix && TRANSIENT_NOISE_PREFIX_RE.test(prefix)) return null;
    const cur = parseCount(tqdmMatch[3]);
    const tot = parseCount(tqdmMatch[4]);
    if (cur !== null && tot !== null && tot > 0 && cur <= tot) {
      const stageLabel = prefix ? sanitizeJobText(prefix, 36) : undefined;
      const isEvalStage = prefix ? EVAL_PREFIX_RE.test(prefix) : false;
      const rateInfo = extractRate(line);
      return {
        current: cur,
        total: tot,
        ...(rateInfo.rate !== undefined ? { rate: rateInfo.rate } : {}),
        ...(rateInfo.rateUnit ? { rateUnit: rateInfo.rateUnit } : {}),
        ...(stageLabel ? { stageLabel } : {}),
        ...(isEvalStage ? { isEvalStage: true } : {}),
      };
    }
  }

  // 3. Standalone epoch ratio (`Epoch 2/10`)
  if (hasValidEpoch) {
    return {
      current: epCur,
      total: epTot,
      unit: "epochs",
    };
  }

  // 4. Standalone counter with parenthesized timing/throughput (`19200/40458 (215.1s)`)
  const parenMatch = INDENTED_RATIO_PAREN_RE.exec(line);
  if (parenMatch) {
    const cur = parseCount(parenMatch[1]);
    const tot = parseCount(parenMatch[2]);
    const parenBody = parenMatch[3]!;
    const looksLikeTimingOrRate =
      /\b\d+(?:\.\d+)?\s*(?:ms|s|m|min|h)\b/i.test(parenBody) ||
      RATE_RE.test(parenBody) ||
      SEC_PER_IT_RE.test(parenBody);
    if (cur !== null && tot !== null && tot >= 2 && cur <= tot && looksLikeTimingOrRate) {
      return {
        current: cur,
        total: tot,
      };
    }
  }

  // 5. Leading bracket counter (`[12/50] Evaluating split ...`) — excludes `=== [1/2] ... ===` banners
  const bracketMatch = LEADING_BRACKET_RATIO_RE.exec(line);
  if (bracketMatch) {
    const cur = parseCount(bracketMatch[1]);
    const tot = parseCount(bracketMatch[2]);
    if (cur !== null && tot !== null && tot >= 2 && cur <= tot) {
      return {
        current: cur,
        total: tot,
      };
    }
  }

  // 6. Explicitly labeled progress percentage (`progress: 64.5%`, `completed=80%`)
  const pctMatch = LABELED_PCT_RE.exec(line);
  if (pctMatch) {
    const pct = Number.parseFloat(pctMatch[1]!);
    if (Number.isFinite(pct) && pct >= 0 && pct <= 100) {
      return {
        current: Math.round(pct * 10) / 10,
        total: 100,
        unit: "%",
      };
    }
  }

  return null;
}

/**
 * Returns a normalized prefix key for tqdm-style progress lines (`Loading weights: 49%|...| ...`)
 * so `buildRecentTail` collapses duplicate redraw frames from the same progress bar.
 */
export function getProgressBarFrameKey(line: string): string | null {
  const stripped = line.trim().replace(LEADING_LOG_PREFIX_RE, "");
  const m = TQDM_BAR_RE.exec(stripped);
  if (!m) return null;
  return (m[1]?.trim() || "__bar__").toLowerCase();
}
