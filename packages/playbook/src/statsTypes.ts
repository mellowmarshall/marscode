/** Review-stats record and query types shared by the CLI, the challenger and the server. */
import type { ClassifiedModel } from "./modelClassify.ts";

export const REVIEW_SEVERITIES = ["breaking", "critical", "high", "medium", "low", "info"] as const;

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
  /** A failing playbook challenge the agent shipped past with `ship-queue override`. */
  readonly overridden?: boolean | undefined;
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
  /** Failing playbook challenges, and how many of them were overridden. */
  readonly challenges: number;
  readonly overrides: number;
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
  /** The clock `days` counts back from; without it `days` filters nothing. */
  readonly nowMs?: number | undefined;
  readonly includeBypasses?: boolean | undefined;
  readonly recentLimit?: number | undefined;
}

export interface ReviewStatsPaths {
  readonly playbookStateDir?: string | undefined;
  readonly shipJobsDir?: string | undefined;
  readonly jsonlPath?: string | undefined;
}
