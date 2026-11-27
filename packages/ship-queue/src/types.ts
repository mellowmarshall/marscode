import type { WireGuardBundle } from "@t3tools/guard-protocol/bundle-inspect";

import type { ProcessIdentity } from "./processIdentity.ts";
import type { WorkerRuntimeVersion } from "./workerVersion.ts";

/** The record states the server's `ShipQueueBridge` maps; a cancel ends as `failed reason=cancelled`. */
export type JobState = "queued" | "running" | "waiting" | "done" | "failed";

export type JobWait = "watcher" | "action";

/** `jobs/<id>/job.json`. Field names follow the legacy queue so `ship-queue status --json` stays wire-compatible. */
export interface JobRecord {
  readonly id: string;
  readonly repo: string;
  readonly primary: string;
  readonly worktree: string;
  readonly branch: string;
  readonly base_branch: string;
  readonly remote: string;
  readonly title: string;
  readonly head_sha: string;
  readonly submitted_at: string;
  readonly key: string;
  readonly state: JobState;
  readonly thread_id?: string | undefined;
  readonly waiting_for?: JobWait | undefined;
  readonly waiting_since?: string | undefined;
  readonly action_digest?: string | undefined;
  readonly rebased_onto?: string | undefined;
  readonly pushed_sha?: string | undefined;
  readonly push_exit?: number | undefined;
  readonly pr?: number | undefined;
  readonly merge_exit?: number | undefined;
  readonly sync_exit?: number | undefined;
  readonly reason?: string | undefined;
  readonly ended_at?: string | undefined;
  /** The detached worker that last advanced the job, so a restarted client can tell it is still running. */
  readonly worker?: ProcessIdentity | undefined;
  /** Pinned worker runtime version recorded at spawn/start time so upgrades never drain in-flight jobs. */
  readonly worker_version?: string | undefined;
  /** Canonical CLI entrypoint path for `worker_version`. */
  readonly worker_entry?: string | undefined;
}

export interface ProcessResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface ProcessInput {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>> | undefined;
  /** When true, runs with `env` verbatim instead of merging `process.env`. */
  readonly replaceEnv?: boolean | undefined;
  /** Optional wall-clock limit in milliseconds; kills the child and returns exitCode 124 on expiry. */
  readonly timeoutMs?: number | undefined;
  readonly stdin?: string | undefined;
}

/** Runs one host process to completion. Non-zero exits resolve; only a spawn failure rejects. */
export type ProcessRunner = (input: ProcessInput) => Promise<ProcessResult>;

export interface Clock {
  /** ISO-8601 instant. */
  readonly now: () => string;
}

export interface PullRequestRef {
  readonly number: number;
}

export interface MergeOutcome {
  readonly exitCode: number;
  readonly message: string;
}

/** The forge the queue opens and merges pull requests on (GitHub via `gh` in the headless CLI). */
export interface ShipForge {
  readonly findOpenPullRequest: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly head: string;
  }) => Promise<PullRequestRef | null>;
  readonly createPullRequest: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly head: string;
    readonly base: string;
    readonly title: string;
    readonly body: string;
  }) => Promise<PullRequestRef>;
  /** Whether the forge already merged the pull request, whatever this queue recorded. */
  readonly isPullRequestMerged: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly number: number;
  }) => Promise<boolean>;
  readonly mergePullRequest: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly number: number;
    readonly headSha: string;
    readonly title: string;
  }) => Promise<MergeOutcome>;
  readonly commentOnPullRequest?: (input: {
    readonly cwd: string;
    readonly repo: string;
    readonly number: number;
    readonly body: string;
  }) => Promise<void>;
}

export interface GuardCheck {
  readonly ok: boolean;
  readonly reason?: string | undefined;
}

/** The `#6` owner-grant broker: a protected-diff bundle ships only on an approved grant. */
export interface ShipGuard {
  readonly inspect: (input: {
    readonly worktree: string;
    readonly branch: string;
    readonly baseRef: string;
  }) => WireGuardBundle | undefined;
  readonly check: (input: {
    readonly worktree: string;
    readonly branch: string;
    readonly bundle: WireGuardBundle;
  }) => Promise<GuardCheck>;
}

export interface SecretFinding {
  readonly summary: string;
}

/** House secret scan over `baseSha..HEAD`; `null` means the scanner is unavailable on this host. */
export type SecretScanner = (input: {
  readonly worktree: string;
  readonly baseSha: string;
}) => Promise<ReadonlyArray<SecretFinding> | null>;

/** Advisory post-check playbook declaration challenge writing its report to `outFile`. */
export type DeclarationChallenger = (input: {
  readonly jobId: string;
  readonly worktree: string;
  readonly baseSha: string;
  readonly tipSha: string;
  readonly bodyFile: string;
  readonly outFile: string;
  readonly threadId?: string | undefined;
}) => Promise<{ readonly output: string; readonly report: string | null }>;

export interface MergedJob {
  readonly job: JobRecord;
  readonly pr: number;
}

/** Ports the engine runs on. The headless CLI wires Node and `gh`; the server can wire its own. */
export interface ShipQueueDeps {
  readonly root: string;
  readonly run: ProcessRunner;
  readonly forge: ShipForge;
  readonly guard: ShipGuard;
  readonly secretScan: SecretScanner;
  readonly declarationChallenge?: DeclarationChallenger | undefined;
  readonly clock: Clock;
  readonly isProcessAlive: (identity: ProcessIdentity) => boolean;
  readonly self: ProcessIdentity;
  readonly watcherWaitMs: number;
  /** Optional bounded timeout for `ship_post_merge` steps (defaults to 10 minutes). */
  readonly postMergeTimeoutMs?: number | undefined;
  /** Runtime version identity of this worker, enabling version-pinned execution without global drain locks. */
  readonly workerVersion?: WorkerRuntimeVersion | undefined;
  /** Post-merge subscribers (`subscribeMerges`); a throwing subscriber is logged, never fatal. */
  readonly onMerged?: ReadonlyArray<(merged: MergedJob) => Promise<void> | void> | undefined;
}
