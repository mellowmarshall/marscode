/**
 * Model selection, git metadata, defect counting, and ReviewStats persistence helpers
 * for `t3 generate`. Domain seam extracted from `generate.ts`.
 */
import type { ModelSelection, ProviderInstanceId, ServerProvider } from "@t3tools/contracts";
import { currentBranch, git, repoName } from "@t3tools/playbook/git";
import { classifyModel } from "@t3tools/playbook/modelClassify";
import { appendReviewStatRecord, defaultReviewStatsJsonlPath } from "@t3tools/playbook/statsStore";
import type { ReviewStatRecord, SeverityCounts } from "@t3tools/playbook/statsTypes";

import * as DevtoolsConfig from "../devtools/DevtoolsConfig.ts";

export function emptySeverityCounts(): SeverityCounts {
  return { breaking: 0, critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
}

export function countDefectSeverities(
  defects: ReadonlyArray<{ readonly severity: string }>,
): SeverityCounts {
  let breaking = 0;
  let critical = 0;
  let high = 0;
  let medium = 0;
  let low = 0;
  let info = 0;
  for (const d of defects) {
    switch (d.severity.trim().toLowerCase()) {
      case "breaking":
        breaking += 1;
        break;
      case "critical":
        critical += 1;
        break;
      case "high":
        high += 1;
        break;
      case "medium":
        medium += 1;
        break;
      case "low":
        low += 1;
        break;
      case "info":
        info += 1;
        break;
      default:
        high += 1;
        break;
    }
  }
  return {
    breaking,
    critical,
    high,
    medium,
    low,
    info,
    total: breaking + critical + high + medium + low + info,
  };
}

function effortOptionId(provider: string): string {
  if (provider === "codex") return "reasoningEffort";
  if (provider === "antigravity") return "thinking_level";
  return "effort";
}

export function resolveGenerateModelSelection(input: {
  readonly provider?: string | undefined;
  readonly model?: string | undefined;
  readonly effort?: string | undefined;
  readonly providers?: ReadonlyArray<ServerProvider> | undefined;
}): {
  readonly modelSelection: ModelSelection;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly fallbackUsed: boolean;
  readonly defaultTimeoutMs: number;
} {
  const config = DevtoolsConfig.readDevtoolsHostConfig();
  const defaultTimeoutMs = config.challenge_timeout_s * 1_000;
  if (input.provider && input.model) {
    const effort = input.effort?.trim() || "high";
    return {
      modelSelection: {
        instanceId: input.provider as ProviderInstanceId,
        model: input.model,
        options: [
          {
            id: effortOptionId(input.provider),
            value: effort,
          },
        ],
      },
      provider: input.provider,
      model: input.model,
      effort,
      fallbackUsed: false,
      defaultTimeoutMs,
    };
  }
  const plan = DevtoolsConfig.resolveReviewRolePlan("playbook_challenge", config, {
    providers: input.providers ?? [],
    limitSources: [],
  });
  const candidate =
    plan.candidates.find(
      (c) =>
        c.available &&
        (!input.provider || c.provider === input.provider) &&
        (!input.model || c.model === input.model),
    ) ?? plan.candidates[0];
  if (candidate) {
    const provider = input.provider ?? candidate.provider;
    const model = input.model ?? candidate.model;
    const effort = input.effort ?? candidate.effort;
    return {
      modelSelection: {
        instanceId: provider as ProviderInstanceId,
        model,
        options: [
          {
            id: effortOptionId(provider),
            value: effort,
          },
        ],
      },
      provider,
      model,
      effort,
      fallbackUsed: !candidate.isDefault,
      defaultTimeoutMs,
    };
  }
  const provider = input.provider ?? "codex";
  const model = input.model ?? "gpt-5.4";
  const effort = input.effort ?? "high";
  return {
    modelSelection: {
      instanceId: provider as ProviderInstanceId,
      model,
      options: [{ id: effortOptionId(provider), value: effort }],
    },
    provider,
    model,
    effort,
    fallbackUsed: false,
    defaultTimeoutMs,
  };
}

function safeGitMeta(cwd: string) {
  let repo = "";
  let branch = "";
  let commit = "";
  try {
    repo = repoName(cwd);
  } catch {
    repo = "";
  }
  try {
    branch = currentBranch(cwd) ?? "";
  } catch {
    branch = "";
  }
  try {
    const head = git(cwd, ["rev-parse", "HEAD"]);
    commit = head.code === 0 ? head.stdout.trim() : "";
  } catch {
    commit = "";
  }
  return { repo, branch, commit };
}

export function recordGenerateStats(input: {
  readonly cwd: string;
  readonly fallbackRepoName: string;
  readonly repo?: string | undefined;
  readonly branch?: string | undefined;
  readonly commit?: string | undefined;
  readonly threadId?: string | undefined;
  readonly source: "playbook_challenge" | "ship_queue_review";
  readonly timestamp: string;
  readonly verdict: string;
  readonly provider: string;
  readonly model: string;
  readonly effort: string;
  readonly fallbackUsed: boolean;
  readonly durationS: number;
  readonly counts: SeverityCounts;
  readonly bypassDetected: boolean;
  readonly playbookFriction: boolean;
  readonly rejectedRisesCount: number;
  readonly submitterModel?: string | undefined;
  readonly submitterProvider?: string | undefined;
  readonly submitterEffort?: string | undefined;
  readonly statsFile?: string | undefined;
}): { readonly statsPath: string; readonly recorded: boolean } {
  const gitMeta = safeGitMeta(input.cwd);
  const repo = input.repo?.trim() || gitMeta.repo || input.fallbackRepoName;
  const branch = input.branch?.trim() || gitMeta.branch;
  const commit = input.commit?.trim() || gitMeta.commit;
  const record: ReviewStatRecord = {
    id: `t3-generate:${repo}:${commit || "head"}:${input.timestamp}:${input.provider}:${input.model}`,
    source: input.source,
    timestamp: input.timestamp,
    repo,
    branch,
    commit,
    worktree: input.cwd,
    threadId: input.threadId?.trim() ?? "",
    reviewThreadId: "",
    verdict: input.verdict,
    reviewer: classifyModel(
      input.effort ? `${input.model} (${input.effort})` : input.model,
      input.provider,
    ),
    submitter: classifyModel(
      input.submitterModel && input.submitterEffort
        ? `${input.submitterModel} (${input.submitterEffort})`
        : (input.submitterModel ?? ""),
      input.submitterProvider ?? "",
    ),
    counts: input.counts,
    bypassDetected: input.bypassDetected,
    playbookFriction: input.playbookFriction,
    rejectedRisesCount: input.rejectedRisesCount,
    fallbackUsed: input.fallbackUsed,
    durationS: input.durationS,
  };
  const statsPath = input.statsFile?.trim() || defaultReviewStatsJsonlPath();
  const recorded = appendReviewStatRecord(record, statsPath);
  return { statsPath, recorded };
}
