// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Incremental review-stats aggregator joining Playbook Challenges, Ship Queue adversarial reviews, and T3 thread submitter models.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { classifyModel, type ClassifiedModel } from "./DevtoolsConfig.ts";

const REVIEW_SEVERITIES = ["breaking", "critical", "high", "medium", "low", "info"] as const;

export type ReviewSeverity = (typeof REVIEW_SEVERITIES)[number];
export type ReviewStatsSide = "reviewer" | "submitter" | "pair";
export type ReviewStatsGroupBy =
  | "model"
  | "family"
  | "lab"
  | "provider"
  | "repo"
  | "source"
  | "effort"
  | "day";

export interface SeverityCounts {
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly total: number;
}

export interface ReviewStatRecord {
  readonly id: string;
  readonly source: "playbook_challenge" | "ship_queue_review";
  readonly timestamp: string;
  readonly repo: string;
  readonly branch: string;
  readonly commit: string;
  readonly worktree: string;
  readonly threadId: string;
  readonly reviewThreadId: string;
  readonly verdict: string;
  readonly reviewer: ClassifiedModel;
  readonly submitter: ClassifiedModel;
  readonly counts: SeverityCounts;
  readonly bypassDetected: boolean;
  readonly playbookFriction: boolean;
  readonly rejectedRisesCount: number;
  readonly fallbackUsed: boolean;
  readonly durationS: number | null;
}

export interface DelegatedReviewSubagentRow {
  readonly subagentId: string;
  readonly parentThreadId: string;
  readonly childThreadId: string;
  readonly status: string;
  readonly startedAt: string | null;
  readonly completedAt: string | null;
  readonly updatedAt: string | null;
  readonly prompt: string;
  readonly result: string;
  readonly model?: string | null | undefined;
  readonly provider?: string | null | undefined;
  readonly providerInstanceId?: string | null | undefined;
  readonly modelSelection?: {
    readonly model?: string | null | undefined;
    readonly provider?: string | null | undefined;
    readonly instanceId?: string | null | undefined;
    readonly options?: unknown;
  } | null;
  readonly worktree?: string | null | undefined;
  readonly branch?: string | null | undefined;
}

export interface ThreadSubmitterInfo {
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly branch?: string | undefined;
  readonly worktreePath?: string | undefined;
}

export interface ThreadSubmitterLookup {
  readonly byThreadId: ReadonlyMap<string, ThreadSubmitterInfo>;
  readonly byWorktree: ReadonlyMap<string, ThreadSubmitterInfo>;
  readonly byBranch: ReadonlyMap<string, ThreadSubmitterInfo>;
}

export interface ReviewStatsGroupRow {
  readonly key: string;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly family?: string | undefined;
  readonly reviews: number;
  readonly passed: number;
  readonly flagged: number;
  readonly passRatePct: number;
  readonly avgIssues: number;
  readonly bypasses: number;
  readonly friction: number;
  readonly fallbacks: number;
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
  readonly medium: number;
  readonly low: number;
  readonly info: number;
  readonly total: number;
}

export interface ReviewStatsHighlight {
  readonly label: string;
  readonly reviews: number;
  readonly totalIssues: number;
  readonly avgIssues: number;
  readonly breaking: number;
  readonly critical: number;
  readonly high: number;
}

export interface ReviewStatsResponse {
  readonly side: ReviewStatsSide;
  readonly by: ReviewStatsGroupBy;
  readonly totals: ReviewStatsGroupRow;
  readonly groups: ReadonlyArray<ReviewStatsGroupRow>;
  readonly recent: ReadonlyArray<ReviewStatRecord>;
  readonly highlights: {
    readonly topBugSubmitter: ReviewStatsHighlight | null;
    readonly topBugCatcher: ReviewStatsHighlight | null;
  };
  readonly facets: {
    readonly repos: ReadonlyArray<string>;
    readonly labs: ReadonlyArray<string>;
    readonly families: ReadonlyArray<string>;
    readonly hosts: ReadonlyArray<string>;
  };
}

export interface ReviewStatsQuery {
  readonly side?: ReviewStatsSide | undefined;
  readonly by?: ReviewStatsGroupBy | undefined;
  readonly source?: "all" | "playbook_challenge" | "ship_queue_review" | undefined;
  readonly repo?: string | undefined;
  readonly lab?: string | undefined;
  readonly family?: string | undefined;
  readonly host?: string | undefined;
  readonly localHostName?: string | undefined;
  readonly days?: number | undefined;
  readonly includeBypasses?: boolean | undefined;
  readonly recentLimit?: number | undefined;
}

export interface ReviewStatsPaths {
  readonly playbookStateDir?: string | undefined;
  readonly shipJobsDir?: string | undefined;
  readonly jsonlPath?: string | undefined;
}

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

function defaultStateHome(): string {
  return process.env.XDG_STATE_HOME?.trim() || NodePath.join(NodeOS.homedir(), ".local", "state");
}

function defaultShipJobsDir(): string {
  const envRoot = process.env.SHIP_QUEUE_ROOT?.trim();
  if (envRoot) return NodePath.join(envRoot, "jobs");
  const confPaths = [
    NodePath.join(NodeOS.homedir(), ".local", "lib", "host-guards.conf"),
    NodePath.join(NodeOS.homedir(), ".local", "lib", "host-guards", "host-guards.conf"),
  ];
  for (const p of confPaths) {
    try {
      const content = NodeFS.readFileSync(p, "utf8");
      const m = /^queue_root=(.+)$/m.exec(content);
      if (m?.[1]?.trim()) return NodePath.join(m[1].trim(), "jobs");
    } catch {
      // continue
    }
  }
  return "/data/Dev/.ship-queue/jobs";
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

interface FileCacheEntry {
  readonly mtimeMs: number;
  readonly size: number;
  readonly record: ReviewStatRecord | null;
}

const fileRecordCache = new Map<string, FileCacheEntry>();

function parseChallengeJsonFile(
  fullPath: string,
  repoDirName: string,
  fileName: string,
): ReviewStatRecord | null {
  try {
    const st = NodeFS.statSync(fullPath);
    const cached = fileRecordCache.get(fullPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.record;
    }
    const data = JSON.parse(NodeFS.readFileSync(fullPath, "utf8")) as Record<string, unknown>;
    if (!data || typeof data !== "object" || typeof data.timestamp !== "string") {
      fileRecordCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, record: null });
      return null;
    }
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
    fileRecordCache.set(fullPath, { mtimeMs: st.mtimeMs, size: st.size, record });
    return record;
  } catch {
    return null;
  }
}

function parseVerdictValue(raw: string): "pass" | "fail" {
  const v = raw.trim().toLowerCase();
  if (NO_BLOCKING_RE.test(v)) return "pass";
  return FAIL_VERDICT_RE.test(v) ? "fail" : "pass";
}

function parseStructuredReviewText(text: string): {
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

function parseShipJobDir(jobDir: string, jobId: string): ReviewStatRecord | null {
  const reviewPath = NodePath.join(jobDir, "adversarial-review.md");
  try {
    const st = NodeFS.statSync(reviewPath);
    const cached = fileRecordCache.get(reviewPath);
    if (cached && cached.mtimeMs === st.mtimeMs && cached.size === st.size) {
      return cached.record;
    }
    const text = NodeFS.readFileSync(reviewPath, "utf8").slice(0, 256 * 1024);
    let job: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse(NodeFS.readFileSync(NodePath.join(jobDir, "job.json"), "utf8"));
      if (parsed && typeof parsed === "object") job = parsed as Record<string, unknown>;
    } catch {
      // optional
    }
    const parsedReview = parseStructuredReviewText(text);
    const ts =
      typeof job.submitted_at === "string" && job.submitted_at
        ? job.submitted_at
        : new Date(st.mtimeMs).toISOString();
    const record: ReviewStatRecord = {
      id: `ship:${jobId}`,
      source: "ship_queue_review",
      timestamp: ts,
      repo: String(job.repo ?? "unknown"),
      branch: String(job.branch ?? ""),
      commit: String(job.bootstrap_sha ?? ""),
      worktree: String(job.worktree ?? ""),
      threadId: String(job.thread_id ?? ""),
      reviewThreadId: String(
        job.review_thread_id ?? job.reviewThreadId ?? parsedReview.reviewThreadId ?? "",
      ),
      verdict: parsedReview.verdict,
      reviewer: parsedReview.reviewer,
      submitter: parsedReview.submitter,
      counts: parsedReview.counts,
      bypassDetected: false,
      playbookFriction: false,
      rejectedRisesCount: 0,
      fallbackUsed: false,
      durationS: null,
    };
    fileRecordCache.set(reviewPath, { mtimeMs: st.mtimeMs, size: st.size, record });
    return record;
  } catch {
    return null;
  }
}

function parseJsonlRecords(jsonlPath: string): ReadonlyArray<ReviewStatRecord> {
  const out: ReviewStatRecord[] = [];
  let raw = "";
  try {
    raw = NodeFS.readFileSync(jsonlPath, "utf8");
  } catch {
    return out;
  }
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

function extractEffortFromOptions(options: unknown): string {
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

export type SubmitterProjectionRow =
  | { readonly thread_id: string; readonly payload_json: string }
  | {
      readonly thread_id: string;
      readonly model: string | null;
      readonly instance_id: string | null;
      readonly provider: string | null;
      readonly default_provider: string | null;
      readonly options_json: string | null;
      readonly branch: string | null;
      readonly worktree_path: string | null;
      readonly is_subagent?: number | boolean | null | undefined;
    };

export function buildSubmitterLookupFromRows(
  rows: ReadonlyArray<SubmitterProjectionRow>,
): ThreadSubmitterLookup {
  const byThreadId = new Map<string, ThreadSubmitterInfo>();
  const byWorktree = new Map<string, ThreadSubmitterInfo>();
  const byBranch = new Map<string, ThreadSubmitterInfo>();
  for (const row of rows) {
    try {
      let model = "";
      let provider = "";
      let effort = "";
      let branch: string | undefined;
      let worktreePath: string | undefined;
      let isSubagent = row.thread_id.startsWith("thread:delegated-task:");
      if ("payload_json" in row) {
        const payload = JSON.parse(row.payload_json) as Record<string, unknown>;
        if (payload.deletedAt) continue;
        const lineage = payload.lineage as Record<string, unknown> | null | undefined;
        if (lineage?.relationshipToParent === "subagent") {
          isSubagent = true;
        }
        const ms = (
          payload.modelSelection && typeof payload.modelSelection === "object"
            ? payload.modelSelection
            : null
        ) as Record<string, unknown> | null;
        model = typeof ms?.model === "string" ? ms.model.trim() : "";
        provider =
          typeof ms?.instanceId === "string"
            ? ms.instanceId
            : typeof ms?.provider === "string"
              ? ms.provider
              : typeof payload.defaultProvider === "string"
                ? payload.defaultProvider
                : "";
        effort = extractEffortFromOptions(ms?.options);
        branch = typeof payload.branch === "string" ? payload.branch.trim() : undefined;
        worktreePath =
          typeof payload.worktreePath === "string" ? payload.worktreePath.trim() : undefined;
      } else {
        if (row.is_subagent) {
          isSubagent = true;
        }
        model = typeof row.model === "string" ? row.model.trim() : "";
        provider =
          (typeof row.instance_id === "string" && row.instance_id.trim()) ||
          (typeof row.provider === "string" && row.provider.trim()) ||
          (typeof row.default_provider === "string" && row.default_provider.trim()) ||
          "";
        if (typeof row.options_json === "string" && row.options_json) {
          effort = extractEffortFromOptions(JSON.parse(row.options_json));
        }
        branch =
          typeof row.branch === "string" && row.branch.trim() ? row.branch.trim() : undefined;
        worktreePath =
          typeof row.worktree_path === "string" && row.worktree_path.trim()
            ? row.worktree_path.trim()
            : undefined;
      }
      if (!model) continue;
      const info: ThreadSubmitterInfo = { provider, model, effort, branch, worktreePath };
      byThreadId.set(row.thread_id, info);
      if (!isSubagent) {
        if (worktreePath) byWorktree.set(worktreePath, info);
        if (branch && branch !== "main" && branch !== "master" && branch !== "HEAD") {
          byBranch.set(branch, info);
        }
      }
    } catch {
      continue;
    }
  }
  return { byThreadId, byWorktree, byBranch };
}

function classifyFromThreadInfo(info: ThreadSubmitterInfo): ClassifiedModel {
  const classified = classifyModel(info.model, info.provider);
  return info.effort && !classified.effort ? { ...classified, effort: info.effort } : classified;
}

export function isDelegatedReviewSubagent(prompt: string | null | undefined): boolean {
  return typeof prompt === "string" && prompt.trimStart().startsWith("Act as the review sub-agent");
}

export function deriveRepoNameFromWorktree(worktree: string | null | undefined): string {
  const raw = typeof worktree === "string" ? worktree.trim().replace(/\/+$/, "") : "";
  if (!raw) return "unknown";
  const parts = raw.split("/").filter(Boolean);
  for (let i = 0; i < parts.length - 1; i += 1) {
    const seg = parts[i];
    if ((seg === "Dev" || seg === "worktrees") && parts[i + 1]) {
      return parts[i + 1]!;
    }
  }
  return parts[parts.length - 1] || "unknown";
}

export function buildRecordFromDelegatedReview(
  row: DelegatedReviewSubagentRow,
  lookup?: ThreadSubmitterLookup,
): ReviewStatRecord | null {
  if (row.status !== "completed" || !isDelegatedReviewSubagent(row.prompt)) {
    return null;
  }
  const reviewThreadId = row.childThreadId.trim();
  const result = row.result.trim();
  if (!reviewThreadId || !result) return null;

  const parsedText = parseStructuredReviewText(result);
  const parentInfo = row.parentThreadId ? lookup?.byThreadId.get(row.parentThreadId) : undefined;
  const childInfo = lookup?.byThreadId.get(reviewThreadId);

  const ms = row.modelSelection;
  const revModel =
    (typeof ms?.model === "string" && ms.model.trim()) ||
    (typeof row.model === "string" && row.model.trim()) ||
    childInfo?.model ||
    "";
  const revProvider =
    (typeof ms?.instanceId === "string" && ms.instanceId.trim()) ||
    (typeof ms?.provider === "string" && ms.provider.trim()) ||
    (typeof row.providerInstanceId === "string" && row.providerInstanceId.trim()) ||
    (typeof row.provider === "string" && row.provider.trim()) ||
    childInfo?.provider ||
    "";
  const revEffort = extractEffortFromOptions(ms?.options) || childInfo?.effort || "";

  let reviewer: ClassifiedModel = parsedText.reviewer;
  if (revModel) {
    const classified = classifyModel(revModel, revProvider || undefined);
    reviewer = revEffort && !classified.effort ? { ...classified, effort: revEffort } : classified;
  }

  const submitter = parentInfo ? classifyFromThreadInfo(parentInfo) : parsedText.submitter;
  const worktree = (row.worktree?.trim() || parentInfo?.worktreePath || "").trim();
  const branch = (row.branch?.trim() || parentInfo?.branch || "").trim();
  const repo = deriveRepoNameFromWorktree(worktree);

  const startedMs = row.startedAt ? Date.parse(row.startedAt) : Number.NaN;
  const completedMs = row.completedAt ? Date.parse(row.completedAt) : Number.NaN;
  const durationS =
    Number.isFinite(startedMs) && Number.isFinite(completedMs) && completedMs >= startedMs
      ? Math.round((completedMs - startedMs) / 100) / 10
      : null;

  return {
    id: `t3-review:${reviewThreadId}`,
    source: "ship_queue_review",
    timestamp: row.completedAt || row.updatedAt || new Date().toISOString(),
    repo,
    branch,
    commit: "",
    worktree,
    threadId: row.parentThreadId,
    reviewThreadId,
    verdict: parsedText.verdict,
    reviewer,
    submitter,
    counts: parsedText.counts,
    bypassDetected: false,
    playbookFriction: false,
    rejectedRisesCount: 0,
    fallbackUsed: false,
    durationS,
  };
}

function defaultReviewStatsJsonlPath(): string {
  const override = process.env.T3_REVIEW_STATS_JSONL?.trim();
  if (override) return override;
  return NodePath.join(defaultStateHome(), "devtools", "review-stats.jsonl");
}

const writtenRecordIdsByPath = new Map<string, Set<string>>();

function getWrittenIdsForPath(jsonlPath: string): Set<string> {
  let seen = writtenRecordIdsByPath.get(jsonlPath);
  if (seen) return seen;
  seen = new Set<string>();
  try {
    const raw = NodeFS.readFileSync(jsonlPath, "utf8");
    for (const line of raw.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        const obj = JSON.parse(trimmed) as { readonly id?: unknown };
        if (typeof obj.id === "string" && obj.id) {
          seen.add(obj.id);
        }
      } catch {
        continue;
      }
    }
  } catch {
    // file does not exist yet
  }
  writtenRecordIdsByPath.set(jsonlPath, seen);
  return seen;
}

export function appendReviewStatRecord(
  record: ReviewStatRecord,
  jsonlPath: string = defaultReviewStatsJsonlPath(),
): boolean {
  try {
    const seen = getWrittenIdsForPath(jsonlPath);
    if (seen.has(record.id)) return false;
    NodeFS.mkdirSync(NodePath.dirname(jsonlPath), { recursive: true, mode: 0o755 });
    const line = JSON.stringify({
      id: record.id,
      source: record.source,
      timestamp: record.timestamp,
      repo: record.repo,
      branch: record.branch,
      commit: record.commit,
      worktree: record.worktree,
      thread_id: record.threadId,
      review_thread_id: record.reviewThreadId,
      verdict: record.verdict,
      reviewer: record.reviewer,
      submitter: record.submitter,
      counts: record.counts,
      bypass_detected: record.bypassDetected,
      playbook_friction: record.playbookFriction,
      rejected_rises_count: record.rejectedRisesCount,
      fallback_used: record.fallbackUsed,
      duration_s: record.durationS,
    });
    NodeFS.appendFileSync(jsonlPath, `${line}\n`, { mode: 0o600 });
    seen.add(record.id);
    cachedReviewSnapshot = null;
    return true;
  } catch {
    return false;
  }
}

export interface RawSubagentProjectionRow {
  readonly subagent_id: string;
  readonly thread_id: string;
  readonly child_thread_id: string | null;
  readonly status: string;
  readonly started_at: string | null;
  readonly completed_at: string | null;
  readonly updated_at: string | null;
  readonly provider: string | null;
  readonly driver: string | null;
  readonly provider_instance_id: string | null;
  readonly payload_json: string;
}

export function mapRawDelegatedReviewRows(
  rows: ReadonlyArray<RawSubagentProjectionRow>,
): ReadonlyArray<DelegatedReviewSubagentRow> {
  const mapped: DelegatedReviewSubagentRow[] = [];
  for (const r of rows) {
    if (!r.child_thread_id) continue;
    try {
      const p = JSON.parse(r.payload_json) as Record<string, unknown>;
      const prompt = typeof p.prompt === "string" ? p.prompt : "";
      const result = typeof p.result === "string" ? p.result : "";
      if (!result.trim()) continue;
      const ms =
        p.modelSelection && typeof p.modelSelection === "object"
          ? (p.modelSelection as {
              readonly model?: string | null;
              readonly provider?: string | null;
              readonly instanceId?: string | null;
              readonly options?: unknown;
            })
          : null;
      mapped.push({
        subagentId: r.subagent_id,
        parentThreadId: r.thread_id,
        childThreadId: r.child_thread_id,
        status: r.status,
        startedAt: r.started_at,
        completedAt: r.completed_at,
        updatedAt: r.updated_at,
        prompt,
        result,
        model: typeof p.model === "string" ? p.model : null,
        provider: r.driver ?? r.provider,
        providerInstanceId: r.provider_instance_id,
        modelSelection: ms,
      });
    } catch {
      continue;
    }
  }
  return mapped;
}

export function shouldAutoRecordDelegatedReview(): boolean {
  return !process.env.VITEST || Boolean(process.env.T3_REVIEW_STATS_JSONL);
}

export function tryRecordCompletedDelegatedReview(
  row: DelegatedReviewSubagentRow,
  parentRows: ReadonlyArray<SubmitterProjectionRow>,
  jsonlPath?: string,
): ReviewStatRecord | null {
  if (!shouldAutoRecordDelegatedReview()) return null;
  try {
    const lookup = buildSubmitterLookupFromRows(parentRows);
    return recordCompletedDelegatedReview(row, lookup, jsonlPath);
  } catch {
    return null;
  }
}

function recordCompletedDelegatedReview(
  row: DelegatedReviewSubagentRow,
  lookup?: ThreadSubmitterLookup,
  jsonlPath: string = defaultReviewStatsJsonlPath(),
): ReviewStatRecord | null {
  const record = buildRecordFromDelegatedReview(row, lookup);
  if (!record) return null;
  appendReviewStatRecord(record, jsonlPath);
  return record;
}

function enrichActors(
  rec: ReviewStatRecord,
  lookup: ThreadSubmitterLookup | undefined,
): ReviewStatRecord {
  if (!lookup) return rec;
  let next = rec;

  const parentById = rec.threadId ? lookup.byThreadId.get(rec.threadId) : undefined;
  if (rec.submitter.model === "unknown") {
    const info =
      parentById ??
      (rec.worktree ? lookup.byWorktree.get(rec.worktree) : undefined) ??
      (rec.branch ? lookup.byBranch.get(rec.branch) : undefined);
    if (info) {
      next = { ...next, submitter: classifyFromThreadInfo(info) };
    }
  }

  if (parentById) {
    const worktree = next.worktree || parentById.worktreePath || "";
    const branch = next.branch || parentById.branch || "";
    const repo =
      next.repo && next.repo !== "unknown" ? next.repo : deriveRepoNameFromWorktree(worktree);
    if (worktree !== next.worktree || branch !== next.branch || repo !== next.repo) {
      next = { ...next, worktree, branch, repo };
    }
  }

  if (rec.reviewThreadId) {
    const revInfo = lookup.byThreadId.get(rec.reviewThreadId);
    if (revInfo) {
      next = { ...next, reviewer: classifyFromThreadInfo(revInfo) };
    }
  }

  return next;
}

const REVIEW_RECORDS_CACHE_TTL_MS = 30_000;
let cachedReviewSnapshot: {
  readonly cacheKey: string;
  readonly loadedAtMs: number;
  readonly lookupRef: ThreadSubmitterLookup | undefined;
  readonly delegatedRef: ReadonlyArray<DelegatedReviewSubagentRow> | undefined;
  readonly records: ReadonlyArray<ReviewStatRecord>;
} | null = null;
let cachedSubmitterLookup: {
  readonly fetchedAtMs: number;
  readonly lookup: ThreadSubmitterLookup;
} | null = null;
let cachedDelegatedReviews: {
  readonly fetchedAtMs: number;
  readonly rows: ReadonlyArray<DelegatedReviewSubagentRow>;
} | null = null;

export function getCachedSubmitterLookup(forceRefresh = false): ThreadSubmitterLookup | null {
  if (forceRefresh || !cachedSubmitterLookup) return null;
  if (Date.now() - cachedSubmitterLookup.fetchedAtMs >= REVIEW_RECORDS_CACHE_TTL_MS) return null;
  return cachedSubmitterLookup.lookup;
}

export function setCachedSubmitterLookup(lookup: ThreadSubmitterLookup): void {
  cachedSubmitterLookup = { fetchedAtMs: Date.now(), lookup };
}

export function getCachedDelegatedReviews(
  forceRefresh = false,
): ReadonlyArray<DelegatedReviewSubagentRow> | null {
  if (forceRefresh || !cachedDelegatedReviews) return null;
  if (Date.now() - cachedDelegatedReviews.fetchedAtMs >= REVIEW_RECORDS_CACHE_TTL_MS) return null;
  return cachedDelegatedReviews.rows;
}

export function setCachedDelegatedReviews(rows: ReadonlyArray<DelegatedReviewSubagentRow>): void {
  cachedDelegatedReviews = { fetchedAtMs: Date.now(), rows };
}

export function loadReviewRecordsCached(
  paths: ReviewStatsPaths = {},
  lookup?: ThreadSubmitterLookup,
  options?: {
    readonly forceRefresh?: boolean;
    readonly delegatedReviews?: ReadonlyArray<DelegatedReviewSubagentRow> | undefined;
  },
): ReadonlyArray<ReviewStatRecord> {
  const pbDir = paths.playbookStateDir ?? NodePath.join(defaultStateHome(), "playbook");
  const shipJobsDir = paths.shipJobsDir ?? defaultShipJobsDir();
  const jsonlPath = paths.jsonlPath ?? defaultReviewStatsJsonlPath();
  const cacheKey = `${pbDir}\0${shipJobsDir}\0${jsonlPath}`;
  const now = Date.now();
  if (
    !options?.forceRefresh &&
    cachedReviewSnapshot &&
    cachedReviewSnapshot.cacheKey === cacheKey &&
    cachedReviewSnapshot.lookupRef === lookup &&
    cachedReviewSnapshot.delegatedRef === options?.delegatedReviews &&
    now - cachedReviewSnapshot.loadedAtMs < REVIEW_RECORDS_CACHE_TTL_MS
  ) {
    return cachedReviewSnapshot.records;
  }
  const records = loadReviewRecords(
    { playbookStateDir: pbDir, shipJobsDir, jsonlPath },
    lookup,
    options?.delegatedReviews,
  );
  cachedReviewSnapshot = {
    cacheKey,
    loadedAtMs: now,
    lookupRef: lookup,
    delegatedRef: options?.delegatedReviews,
    records,
  };
  return records;
}

export function loadReviewRecords(
  paths: ReviewStatsPaths = {},
  lookup?: ThreadSubmitterLookup,
  delegatedReviews?: ReadonlyArray<DelegatedReviewSubagentRow>,
): ReadonlyArray<ReviewStatRecord> {
  const byId = new Map<string, ReviewStatRecord>();
  const pbDir = paths.playbookStateDir ?? NodePath.join(defaultStateHome(), "playbook");
  try {
    if (NodeFS.existsSync(pbDir)) {
      for (const repoEntry of NodeFS.readdirSync(pbDir, { withFileTypes: true })) {
        if (!repoEntry.isDirectory()) continue;
        const repoPath = NodePath.join(pbDir, repoEntry.name);
        let files: string[] = [];
        try {
          files = NodeFS.readdirSync(repoPath);
        } catch {
          continue;
        }
        for (const f of files) {
          if (!f.endsWith(".challenge.json")) continue;
          const rec = parseChallengeJsonFile(NodePath.join(repoPath, f), repoEntry.name, f);
          if (rec) byId.set(rec.id, rec);
        }
      }
    }
  } catch {
    // ignore
  }

  const shipJobsDir = paths.shipJobsDir ?? defaultShipJobsDir();
  const shipIdByReviewThread = new Map<string, string>();
  try {
    if (NodeFS.existsSync(shipJobsDir)) {
      for (const entry of NodeFS.readdirSync(shipJobsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        const rec = parseShipJobDir(NodePath.join(shipJobsDir, entry.name), entry.name);
        if (rec) {
          byId.set(rec.id, rec);
          if (rec.reviewThreadId) {
            shipIdByReviewThread.set(rec.reviewThreadId, rec.id);
          }
        }
      }
    }
  } catch {
    // ignore
  }

  const mergeOrInsert = (rec: ReviewStatRecord) => {
    if (rec.id.startsWith("t3-review:") && rec.reviewThreadId) {
      const shipId = shipIdByReviewThread.get(rec.reviewThreadId);
      const existingShip = shipId ? byId.get(shipId) : undefined;
      if (existingShip) {
        byId.set(existingShip.id, {
          ...existingShip,
          reviewer:
            existingShip.reviewer.model === "unknown" || !existingShip.reviewer.effort
              ? rec.reviewer
              : existingShip.reviewer,
          submitter:
            existingShip.submitter.model === "unknown" ? rec.submitter : existingShip.submitter,
          durationS: existingShip.durationS ?? rec.durationS,
        });
        return;
      }
    }
    if (!byId.has(rec.id)) {
      byId.set(rec.id, rec);
    }
  };

  const jsonlPath = paths.jsonlPath ?? defaultReviewStatsJsonlPath();
  for (const rec of parseJsonlRecords(jsonlPath)) {
    if (rec.id.startsWith("t3-review:")) {
      mergeOrInsert(rec);
    } else {
      byId.set(rec.id, rec);
      if (rec.source === "ship_queue_review" && rec.reviewThreadId) {
        shipIdByReviewThread.set(rec.reviewThreadId, rec.id);
      }
    }
  }

  if (delegatedReviews && delegatedReviews.length > 0) {
    for (const row of delegatedReviews) {
      const rec = buildRecordFromDelegatedReview(row, lookup);
      if (rec) mergeOrInsert(rec);
    }
  }

  const records = Array.from(byId.values(), (rec) => enrichActors(rec, lookup));
  records.sort((a, b) => {
    const ta = Date.parse(a.timestamp);
    const tb = Date.parse(b.timestamp);
    if (Number.isFinite(ta) && Number.isFinite(tb) && ta !== tb) {
      return tb - ta;
    }
    return a.timestamp < b.timestamp ? 1 : a.timestamp > b.timestamp ? -1 : 0;
  });
  return records;
}

function modelLabel(actor: ClassifiedModel): string {
  return actor.effort ? `${actor.model} (${actor.effort})` : actor.model;
}

function groupKey(rec: ReviewStatRecord, side: ReviewStatsSide, by: ReviewStatsGroupBy): string {
  if (side === "pair") {
    return `${modelLabel(rec.submitter)} → ${modelLabel(rec.reviewer)}`;
  }
  const actor = side === "submitter" ? rec.submitter : rec.reviewer;
  switch (by) {
    case "model":
      return modelLabel(actor);
    case "family":
      return actor.family || "Unknown";
    case "lab":
      return actor.lab || "Unknown";
    case "provider":
      return actor.provider || "unknown";
    case "effort":
      return actor.effort || "default";
    case "repo":
      return rec.repo || "unknown";
    case "source":
      return rec.source;
    case "day":
      return rec.timestamp.slice(0, 10) || "unknown";
  }
}

interface MutableBucket {
  readonly key: string;
  model?: string | undefined;
  effort?: string | undefined;
  family?: string | undefined;
  reviews: number;
  passed: number;
  flagged: number;
  bypasses: number;
  friction: number;
  fallbacks: number;
  breaking: number;
  critical: number;
  high: number;
  medium: number;
  low: number;
  info: number;
  total: number;
}

function newBucket(key: string): MutableBucket {
  return {
    key,
    reviews: 0,
    passed: 0,
    flagged: 0,
    bypasses: 0,
    friction: 0,
    fallbacks: 0,
    breaking: 0,
    critical: 0,
    high: 0,
    medium: 0,
    low: 0,
    info: 0,
    total: 0,
  };
}

function accumulate(bucket: MutableBucket, rec: ReviewStatRecord): void {
  const isPass = rec.verdict === "pass";
  bucket.reviews += 1;
  if (isPass) bucket.passed += 1;
  else bucket.flagged += 1;
  if (rec.bypassDetected) bucket.bypasses += 1;
  if (rec.playbookFriction) bucket.friction += 1;
  if (rec.fallbackUsed) bucket.fallbacks += 1;
  bucket.breaking += rec.counts.breaking;
  bucket.critical += rec.counts.critical;
  bucket.high += rec.counts.high;
  bucket.medium += rec.counts.medium;
  bucket.low += rec.counts.low;
  bucket.info += rec.counts.info;
  bucket.total += rec.counts.total;
}

function finalizeBucket(b: MutableBucket): ReviewStatsGroupRow {
  return {
    ...b,
    passRatePct: b.reviews > 0 ? Math.round((1000 * b.passed) / b.reviews) / 10 : 0,
    avgIssues: b.reviews > 0 ? Math.round((100 * b.total) / b.reviews) / 100 : 0,
  };
}

function computeTopActor(
  records: ReadonlyArray<ReviewStatRecord>,
  side: "submitter" | "reviewer",
): ReviewStatsHighlight | null {
  const map = new Map<string, MutableBucket>();
  for (const rec of records) {
    const actor = side === "submitter" ? rec.submitter : rec.reviewer;
    if (actor.model === "unknown" || actor.model === "owner-bypass") continue;
    const key = modelLabel(actor);
    let b = map.get(key);
    if (!b) {
      b = newBucket(key);
      map.set(key, b);
    }
    accumulate(b, rec);
  }
  const ranked = Array.from(map.values())
    .filter((b) => b.total > 0)
    .toSorted((a, b) => {
      if (b.total !== a.total) return b.total - a.total;
      const avgDiff = b.total / b.reviews - a.total / a.reviews;
      if (avgDiff !== 0) return avgDiff;
      return b.reviews - a.reviews;
    });
  const top = ranked[0];
  if (!top) return null;
  return {
    label: top.key,
    reviews: top.reviews,
    totalIssues: top.total,
    avgIssues: Math.round((100 * top.total) / top.reviews) / 100,
    breaking: top.breaking,
    critical: top.critical,
    high: top.high,
  };
}

export function aggregateReviewStats(
  allRecords: ReadonlyArray<ReviewStatRecord>,
  query: ReviewStatsQuery = {},
): ReviewStatsResponse {
  const localHost = (query.localHostName ?? NodeOS.hostname()).split(".")[0] || "localhost";
  const side: ReviewStatsSide = query.side ?? "reviewer";
  const by: ReviewStatsGroupBy = query.by ?? "model";
  const includeBypasses = query.includeBypasses === true;
  const cutoffMs =
    typeof query.days === "number" && query.days > 0 ? Date.now() - query.days * 86_400_000 : null;

  const repoSet = new Set<string>();
  const labSet = new Set<string>();
  const familySet = new Set<string>();
  const hostSet = new Set<string>([localHost]);
  const filtered: ReviewStatRecord[] = [];

  for (const rec of allRecords) {
    if (!includeBypasses && rec.verdict === "bypassed") continue;
    if (rec.repo && rec.repo !== "unknown") repoSet.add(rec.repo);
    const facetActor = side === "submitter" ? rec.submitter : rec.reviewer;
    if (facetActor.lab && facetActor.lab !== "Unknown") labSet.add(facetActor.lab);
    if (facetActor.family && facetActor.family !== "Unknown") familySet.add(facetActor.family);

    if (
      query.host &&
      query.host !== "all" &&
      query.host.toLowerCase() !== localHost.toLowerCase()
    ) {
      continue;
    }
    if (query.source && query.source !== "all" && rec.source !== query.source) continue;
    if (query.repo && rec.repo !== query.repo) continue;
    if (query.lab && facetActor.lab.toLowerCase() !== query.lab.toLowerCase()) continue;
    if (query.family && facetActor.family.toLowerCase() !== query.family.toLowerCase()) continue;
    if (cutoffMs !== null) {
      const ts = Date.parse(rec.timestamp);
      if (!Number.isFinite(ts) || ts < cutoffMs) continue;
    }
    filtered.push(rec);
  }

  const totals = newBucket("all");
  const buckets = new Map<string, MutableBucket>();
  for (const rec of filtered) {
    accumulate(totals, rec);
    const key = groupKey(rec, side, by);
    let b = buckets.get(key);
    if (!b) {
      b = newBucket(key);
      if (by === "model" && side !== "pair") {
        const actor = side === "submitter" ? rec.submitter : rec.reviewer;
        b.model = actor.model || "unknown";
        b.effort = actor.effort || "default";
        b.family = actor.family || "Unknown";
      }
      buckets.set(key, b);
    }
    accumulate(b, rec);
  }

  const groups = Array.from(buckets.values(), finalizeBucket).toSorted((a, b) => {
    if (by === "day") return a.key < b.key ? 1 : a.key > b.key ? -1 : 0;
    if (b.total !== a.total) return b.total - a.total;
    if (b.flagged !== a.flagged) return b.flagged - a.flagged;
    if (b.reviews !== a.reviews) return b.reviews - a.reviews;
    return a.key.localeCompare(b.key);
  });

  const recentLimit = Math.max(1, Math.min(200, query.recentLimit ?? 80));
  return {
    side,
    by,
    totals: finalizeBucket(totals),
    groups,
    recent: filtered.slice(0, recentLimit),
    highlights: {
      topBugSubmitter: computeTopActor(filtered, "submitter"),
      topBugCatcher: computeTopActor(filtered, "reviewer"),
    },
    facets: {
      repos: Array.from(repoSet).toSorted(),
      labs: Array.from(labSet).toSorted(),
      families: Array.from(familySet).toSorted(),
      hosts: Array.from(hostSet).toSorted(),
    },
  };
}
