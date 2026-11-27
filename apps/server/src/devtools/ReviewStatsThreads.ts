/**
 * Review Stats' T3 thread side: who submitted and who reviewed, read from the
 * orchestration projection rows, and records built from completed delegated
 * review subagents. The record types and parsers are @t3tools/playbook's.
 */
import { classifyModel, type ClassifiedModel } from "@t3tools/playbook/modelClassify";
import { extractEffortFromOptions, parseStructuredReviewText } from "@t3tools/playbook/statsParse";
import type { ReviewStatRecord } from "@t3tools/playbook/statsTypes";

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

export function classifyFromThreadInfo(info: ThreadSubmitterInfo): ClassifiedModel {
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
  lookup: ThreadSubmitterLookup | undefined,
  nowIso: string,
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
    timestamp: row.completedAt || row.updatedAt || nowIso,
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
