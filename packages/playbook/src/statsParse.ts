/**
 * Review-stats parsing: severity counts from adversarial review prose or
 * JSON, verdicts, and records from challenge files and review-stats.jsonl
 * lines. Pure: the store reads the files, this module reads their text.
 */
import { classifyModel, type ClassifiedModel } from "./modelClassify.ts";
import {
  REVIEW_SEVERITIES,
  type ReviewSeverity,
  type ReviewStatRecord,
  type SeverityCounts,
} from "./statsTypes.ts";

const SUMMARY_COUNT_RE = /\b(\d+)\s+(breaking|critical|high|medium|low|info)\b/gi;
const ITEM_SEV_RE =
  /^(?:[-*+]\s+)?(?:\*{0,2}`?)?(?:\[(breaking|critical|high|medium|low|info)\]|(breaking|critical|high|medium|low)(?!-)(?:\s*\d+)?\s*(?::|\s+[-\u2014]|\*{2}\s*[:.\-\u2014])|\b([BCHML])(\d{1,2})\s*[:.\-\u2014)])/i;
const SEV_FIELD_RE = /\bseverity\s*:\s*(breaking|critical|high|medium|low|info)\b/i;
const REVIEWER_LINE_RE = /^\s*(?:[-*+>]\s*)*\*{0,2}`?reviewer`?\*{0,2}\s*:\s*(.+)$/i;
const SUBMITTER_LINE_RE = /^\s*(?:[-*+>]\s*)*\*{0,2}`?(?:submitter|author)`?\*{0,2}\s*:\s*(.+)$/i;
const VERDICT_LINE_RE = /^\s*(?:[-*+>]\s*)*\*{0,2}`?verdict`?\*{0,2}\s*:\s*(.+)$/i;
const STANDALONE_VERDICT_RE =
  /^\s*\*{0,2}`?(REQUEST[\s_-]+CHANGES|CHANGES[\s_-]+REQUESTED|APPROVE[D]?|DO\s+NOT\s+SHIP|REJECT(?:ED)?|PASS(?:ED)?|FAIL(?:ED)?|COMMENT)`?\*{0,2}\s*$/i;
const FAIL_VERDICT_RE =
  /(?:request[\s_-]+changes|changes[\s_-]+requested|do\s+not\s+ship|reject(?:ed)?|\bfail(?:ed)?\b|(?:^|(?<!\bno\s)(?<!\b0\s))\bblock(?:ing|ed)?\b)/i;
const NO_BLOCKING_RE = /\b(?:no|zero|0)\s+blocking\b/i;
const CODE_LETTER: Readonly<Record<string, ReviewSeverity>> = {
  b: "breaking",
  c: "critical",
  h: "high",
  m: "medium",
  l: "low",
};

const UNKNOWN_ACTOR: ClassifiedModel = {
  model: "unknown",
  effort: "",
  family: "Unknown",
  lab: "Unknown",
  provider: "unknown",
};

function emptyCounts(): {
  breaking: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
} {
  return { breaking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
}

function countsFromDefects(defects: unknown): SeverityCounts {
  const c = emptyCounts();
  if (Array.isArray(defects)) {
    for (const item of defects) {
      if (!item || typeof item !== "object") continue;
      const sev = String((item as Record<string, unknown>).severity ?? "")
        .trim()
        .toLowerCase();
      if (
        sev === "breaking" ||
        sev === "critical" ||
        sev === "high" ||
        sev === "medium" ||
        sev === "low" ||
        sev === "info"
      ) {
        c[sev] += 1;
      }
    }
  }
  c.total = c.breaking + c.critical + c.high + c.medium + c.low + c.info;
  return c;
}

export function parseAdversarialReviewCounts(text: string): SeverityCounts {
  const c = emptyCounts();
  const seenCodes = new Set<string>();
  let inFence = false;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("```") || line.startsWith("~~~")) {
      inFence = !inFence;
      continue;
    }
    if (inFence || !line) continue;
    const low = line.toLowerCase();
    if (
      low.startsWith("findings:") ||
      low.startsWith("severity counts:") ||
      low.startsWith("issue counts:")
    ) {
      const explicit = emptyCounts();
      for (const m of line.matchAll(SUMMARY_COUNT_RE)) {
        const sev = m[2]?.toLowerCase() as ReviewSeverity | undefined;
        if (sev) explicit[sev] += Number(m[1] ?? 0);
      }
      explicit.total =
        explicit.breaking +
        explicit.critical +
        explicit.high +
        explicit.medium +
        explicit.low +
        explicit.info;
      if (explicit.total > 0) return explicit;
    }
    const fMatch = SEV_FIELD_RE.exec(line);
    if (fMatch?.[1]) {
      const sev = fMatch[1].toLowerCase() as ReviewSeverity;
      c[sev] += 1;
      continue;
    }
    const iMatch = ITEM_SEV_RE.exec(line);
    if (iMatch) {
      if (iMatch[1]) {
        c[iMatch[1].toLowerCase() as ReviewSeverity] += 1;
      } else if (iMatch[2]) {
        c[iMatch[2].toLowerCase() as ReviewSeverity] += 1;
      } else if (iMatch[3] && iMatch[4]) {
        const codeKey = `${iMatch[3].toLowerCase()}${iMatch[4]}`;
        if (!seenCodes.has(codeKey)) {
          seenCodes.add(codeKey);
          const mapped = CODE_LETTER[iMatch[3].toLowerCase()];
          if (mapped) c[mapped] += 1;
        }
      }
    }
  }
  c.total = c.breaking + c.critical + c.high + c.medium + c.low + c.info;
  if (c.total === 0) {
    for (const m of text.matchAll(SUMMARY_COUNT_RE)) {
      const sev = m[2]?.toLowerCase() as ReviewSeverity | undefined;
      if (sev) c[sev] += Number(m[1] ?? 0);
    }
    c.total = c.breaking + c.critical + c.high + c.medium + c.low + c.info;
  }
  return c;
}

/** A record from one `<branch>.<pass>.challenge.json` file's parsed DATA. */
export function challengeRecordFromJson(
  raw: unknown,
  repoDirName: string,
  fileName: string,
): ReviewStatRecord | null {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data = raw as Record<string, unknown>;
  if (typeof data.timestamp !== "string") return null;
  {
    const rejected = Array.isArray(data.rejected_rises) ? data.rejected_rises : [];
    const acceptable = Boolean(data.acceptable);
    const reviewerRaw = String(data.reviewer ?? "unknown");
    const verdict =
      reviewerRaw === "owner-bypass"
        ? "bypassed"
        : acceptable
          ? "pass"
          : rejected.length > 0
            ? "rejected_budget"
            : "challenged";
    const rawCounts =
      data.severity_counts && typeof data.severity_counts === "object"
        ? (data.severity_counts as Record<string, unknown>)
        : null;
    const counts: SeverityCounts = rawCounts
      ? (() => {
          const c = emptyCounts();
          for (const sev of REVIEW_SEVERITIES) {
            c[sev] = Number(rawCounts[sev] ?? 0) || 0;
          }
          c.total = c.breaking + c.critical + c.high + c.medium + c.low + c.info;
          return c;
        })()
      : countsFromDefects(data.defects);
    const reviewerBase = classifyModel(
      typeof data.reviewer_model === "string" && data.reviewer_model
        ? data.reviewer_model
        : reviewerRaw,
      typeof data.reviewer_provider === "string" ? data.reviewer_provider : undefined,
    );
    const reviewer: ClassifiedModel =
      typeof data.reviewer_effort === "string" && data.reviewer_effort && !reviewerBase.effort
        ? { ...reviewerBase, effort: data.reviewer_effort.toLowerCase() }
        : reviewerBase;
    const submitterRaw = typeof data.submitter_model === "string" ? data.submitter_model : "";
    const submitterBase = submitterRaw
      ? classifyModel(
          submitterRaw,
          typeof data.submitter_provider === "string" ? data.submitter_provider : undefined,
        )
      : UNKNOWN_ACTOR;
    const submitter: ClassifiedModel =
      typeof data.submitter_effort === "string" && data.submitter_effort && !submitterBase.effort
        ? { ...submitterBase, effort: data.submitter_effort.toLowerCase() }
        : submitterBase;
    const record: ReviewStatRecord = {
      id: `challenge:${repoDirName}:${fileName}`,
      source: "playbook_challenge",
      timestamp: data.timestamp,
      repo: String(data.repo ?? repoDirName ?? "unknown"),
      branch: String(data.branch ?? ""),
      commit: String(data.commit ?? ""),
      worktree: String(data.worktree ?? ""),
      threadId: String(data.thread_id ?? ""),
      reviewThreadId: String(data.review_thread_id ?? data.reviewThreadId ?? ""),
      verdict,
      reviewer,
      submitter,
      counts,
      bypassDetected: Boolean(data.bypass_detected),
      playbookFriction: Boolean(data.playbook_friction),
      rejectedRisesCount: rejected.length,
      fallbackUsed: Boolean(data.fallback_used),
      durationS: typeof data.duration_s === "number" ? data.duration_s : null,
    };
    return record;
  }
}

function parseVerdictValue(raw: string): "pass" | "fail" {
  const v = raw.trim().toLowerCase();
  if (NO_BLOCKING_RE.test(v)) return "pass";
  return FAIL_VERDICT_RE.test(v) ? "fail" : "pass";
}

export function parseStructuredReviewText(text: string): {
  readonly reviewer: ClassifiedModel;
  readonly submitter: ClassifiedModel;
  readonly verdict: string;
  readonly counts: SeverityCounts;
  readonly reviewThreadId: string;
} {
  const trimmed = text.trim();
  if (trimmed.startsWith("{")) {
    try {
      const parsed = JSON.parse(trimmed) as Record<string, unknown>;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        const revField = parsed.reviewer;
        const revObj =
          revField && typeof revField === "object" && !Array.isArray(revField)
            ? (revField as Record<string, unknown>)
            : null;
        const revModelRaw =
          (typeof revObj?.model === "string" && revObj.model) ||
          (typeof revField === "string" && revField) ||
          (typeof parsed.reviewer_model === "string" && parsed.reviewer_model) ||
          "unknown";
        const revProviderRaw =
          (typeof revObj?.provider === "string" && revObj.provider) ||
          (typeof parsed.reviewer_provider === "string" && parsed.reviewer_provider) ||
          (typeof parsed.provider === "string" && parsed.provider) ||
          undefined;
        const revEffortRaw =
          (typeof revObj?.effort === "string" && revObj.effort) ||
          (typeof parsed.reviewer_effort === "string" && parsed.reviewer_effort) ||
          (typeof parsed.effort === "string" && parsed.effort) ||
          "";
        const revBase = classifyModel(revModelRaw, revProviderRaw);
        const reviewer: ClassifiedModel =
          revEffortRaw && !revBase.effort
            ? { ...revBase, effort: revEffortRaw.toLowerCase() }
            : revBase;

        const subField = parsed.submitter;
        const subObj =
          subField && typeof subField === "object" && !Array.isArray(subField)
            ? (subField as Record<string, unknown>)
            : null;
        const subModelRaw =
          (typeof subObj?.model === "string" && subObj.model) ||
          (typeof subField === "string" && subField) ||
          (typeof parsed.submitter_model === "string" && parsed.submitter_model) ||
          "";
        const submitter = subModelRaw
          ? classifyModel(
              subModelRaw,
              typeof subObj?.provider === "string" ? subObj.provider : undefined,
            )
          : UNKNOWN_ACTOR;

        const rawCounts =
          parsed.counts && typeof parsed.counts === "object"
            ? (parsed.counts as Record<string, unknown>)
            : parsed.severity_counts && typeof parsed.severity_counts === "object"
              ? (parsed.severity_counts as Record<string, unknown>)
              : null;
        let counts: SeverityCounts;
        if (rawCounts) {
          const c = emptyCounts();
          for (const sev of REVIEW_SEVERITIES) {
            c[sev] = Number(rawCounts[sev] ?? 0) || 0;
          }
          c.total = c.breaking + c.critical + c.high + c.medium + c.low + c.info;
          counts = c;
        } else {
          counts = countsFromDefects(parsed.findings ?? parsed.defects);
        }
        const rawVerdict = typeof parsed.verdict === "string" ? parsed.verdict : "";
        const verdict = rawVerdict ? parseVerdictValue(rawVerdict) : "pass";
        const reviewThreadId = String(parsed.review_thread_id ?? parsed.reviewThreadId ?? "");
        return { reviewer, submitter, verdict, counts, reviewThreadId };
      }
    } catch {
      // Fall through to markdown extraction.
    }
  }

  let reviewerRaw = "unknown";
  let submitterRaw = "";
  let verdict = "pass";
  let sawExplicitVerdict = false;
  for (const line of text.split(/\r?\n/)) {
    const rm = reviewerRaw === "unknown" ? REVIEWER_LINE_RE.exec(line) : null;
    if (rm?.[1]) {
      reviewerRaw = rm[1].trim().replace(/^[`*]+|[`*]+$/g, "");
      continue;
    }
    const sm = !submitterRaw ? SUBMITTER_LINE_RE.exec(line) : null;
    if (sm?.[1]) {
      submitterRaw = sm[1].trim().replace(/^[`*]+|[`*]+$/g, "");
      continue;
    }
    const vm = VERDICT_LINE_RE.exec(line);
    if (vm?.[1]) {
      verdict = parseVerdictValue(vm[1]);
      sawExplicitVerdict = true;
      continue;
    }
    if (!sawExplicitVerdict) {
      const sv = STANDALONE_VERDICT_RE.exec(line);
      if (sv?.[1]) {
        verdict = parseVerdictValue(sv[1]);
      }
    }
  }
  return {
    reviewer: classifyModel(reviewerRaw),
    submitter: submitterRaw ? classifyModel(submitterRaw) : UNKNOWN_ACTOR,
    verdict,
    counts: parseAdversarialReviewCounts(text),
    reviewThreadId: "",
  };
}

/** Every record of review-stats.jsonl TEXT; malformed lines are skipped. */
export function parseJsonlRecords(raw: string): ReadonlyArray<ReviewStatRecord> {
  const out: ReviewStatRecord[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const obj = JSON.parse(trimmed) as Record<string, unknown>;
      if (!obj || typeof obj !== "object" || typeof obj.id !== "string") continue;
      const src = obj.source === "ship_queue_review" ? "ship_queue_review" : "playbook_challenge";
      const rawCounts = (obj.counts && typeof obj.counts === "object" ? obj.counts : {}) as Record<
        string,
        unknown
      >;
      const c = emptyCounts();
      for (const sev of REVIEW_SEVERITIES) {
        c[sev] = Number(rawCounts[sev] ?? 0) || 0;
      }
      c.total = c.breaking + c.critical + c.high + c.medium + c.low + c.info;
      const revObj = (
        obj.reviewer && typeof obj.reviewer === "object" ? obj.reviewer : {}
      ) as Record<string, unknown>;
      const subObj = (
        obj.submitter && typeof obj.submitter === "object" ? obj.submitter : {}
      ) as Record<string, unknown>;
      const reviewer = classifyModel(
        typeof revObj.model === "string" ? revObj.model : "unknown",
        typeof revObj.provider === "string" ? revObj.provider : undefined,
      );
      const revWithEffort: ClassifiedModel =
        typeof revObj.effort === "string" && revObj.effort && !reviewer.effort
          ? { ...reviewer, effort: revObj.effort }
          : reviewer;
      const submitter =
        typeof subObj.model === "string" && subObj.model && subObj.model !== "unknown"
          ? (() => {
              const s = classifyModel(
                subObj.model,
                typeof subObj.provider === "string" ? subObj.provider : undefined,
              );
              return typeof subObj.effort === "string" && subObj.effort && !s.effort
                ? { ...s, effort: subObj.effort }
                : s;
            })()
          : UNKNOWN_ACTOR;
      out.push({
        id: obj.id,
        source: src,
        timestamp: String(obj.timestamp ?? ""),
        repo: String(obj.repo ?? "unknown"),
        branch: String(obj.branch ?? ""),
        commit: String(obj.commit ?? ""),
        worktree: String(obj.worktree ?? ""),
        threadId: String(obj.thread_id ?? obj.threadId ?? ""),
        reviewThreadId: String(obj.review_thread_id ?? obj.reviewThreadId ?? ""),
        verdict: String(obj.verdict ?? "pass"),
        reviewer: revWithEffort,
        submitter,
        counts: c,
        bypassDetected: Boolean(obj.bypass_detected ?? obj.bypassDetected),
        playbookFriction: Boolean(obj.playbook_friction ?? obj.playbookFriction),
        rejectedRisesCount: Number(obj.rejected_rises_count ?? obj.rejectedRisesCount ?? 0) || 0,
        fallbackUsed: Boolean(obj.fallback_used ?? obj.fallbackUsed),
        durationS: typeof obj.duration_s === "number" ? obj.duration_s : null,
      });
    } catch {
      continue;
    }
  }
  return out;
}

export function extractEffortFromOptions(options: unknown): string {
  if (!options) return "";
  if (Array.isArray(options)) {
    for (const item of options) {
      if (!item || typeof item !== "object") continue;
      const obj = item as Record<string, unknown>;
      const id = String(obj.id ?? "").toLowerCase();
      if (id === "effort" || id === "reasoningeffort" || id === "thought_level") {
        if (typeof obj.value === "string") return obj.value.toLowerCase();
      }
    }
  } else if (typeof options === "object") {
    const obj = options as Record<string, unknown>;
    for (const key of ["effort", "reasoningEffort", "thought_level"]) {
      if (typeof obj[key] === "string") return (obj[key] as string).toLowerCase();
    }
  }
  return "";
}

/** Every top-level JSON object embedded in TEXT, in order (models wrap JSON in prose). */
export function extractJsonCandidates(text: string): ReadonlyArray<unknown> {
  const out: unknown[] = [];
  let i = text.indexOf("{");
  while (i >= 0 && i < text.length) {
    let depth = 0;
    let inString = false;
    let end = -1;
    for (let k = i; k < text.length; k += 1) {
      const ch = text[k]!;
      if (inString) {
        if (ch === "\\") k += 1;
        else if (ch === '"') inString = false;
      } else if (ch === '"') inString = true;
      else if (ch === "{") depth += 1;
      else if (ch === "}") {
        depth -= 1;
        if (depth === 0) {
          end = k;
          break;
        }
      }
    }
    if (end < 0) break;
    try {
      out.push(JSON.parse(text.slice(i, end + 1)) as unknown);
      i = text.indexOf("{", end + 1);
    } catch {
      i = text.indexOf("{", i + 1);
    }
  }
  return out;
}
