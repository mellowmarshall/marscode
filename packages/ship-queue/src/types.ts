import type { WireGuardBundle } from "@t3tools/guard-protocol/bundle-inspect";

import type { CiPlacer } from "./ciPlacement.ts";
import type { ProcessIdentity } from "./processIdentity.ts";
import type { RemoteCommandRunner } from "./sshExec.ts";
import type { WorkerRuntimeVersion } from "./workerVersion.ts";

/** The record states the server's `ShipQueueBridge` maps; a cancel ends as `failed reason=cancelled`. */
export type JobState = "queued" | "running" | "waiting" | "done" | "failed";

export type JobWait = "watcher" | "action" | "challenge";

/** One declared step's run (PLAYBOOK §14): where it ran, its exit, and its wall time. */
export interface StepTiming {
  readonly name: string;
  readonly host: string;
  readonly exit: number;
  readonly ms: number;
}

/** The agent's decision to ship past a CHALLENGED playbook review, kept for the job's record. */
export interface ChallengeOverride {
  readonly reason: string;
  readonly at: string;
  /** `git patch-id` of the challenged change: the override covers that change and no other. */
  readonly patch?: string | undefined;
  /** The PR was open before the override, so the PR phase posts the reason as a comment. */
  readonly comment?: boolean | undefined;
  /** The challenged commit: Review Stats match the override to the challenge of this tip. */
  readonly tip?: string | undefined;
}

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
  /** The rebased head the house stages passed on; a resume skips them on the same head. */
  readonly house_tip?: string | undefined;
  /** The protected-diff digest whose owner grant this job already used, so a rebase never asks twice. */
  readonly granted_digest?: string | undefined;
  /** The rebased head the declared steps passed on, and the latest run's per-step timings. */
  readonly steps_tip?: string | undefined;
  /** The head a pre-push hook last passed on; a resumed pre-push job skips the hook only at it. */
  readonly steps_hook_tip?: string | undefined;
  readonly steps?: ReadonlyArray<StepTiming> | undefined;
  /** The PR head the declared `ship_merge_gate` passed on; a transient merge retry skips it. */
  readonly gate_tip?: string | undefined;
  /** The CI host a running CI step holds, read by routing as an active lease. */
  readonly ci_lease?: { readonly host: string; readonly routed_at: string } | undefined;
  /** Why no CI host can take the job yet, and when routing last tried. */
  readonly ci_wait?:
    | {
        readonly reason: string;
        readonly at: string;
        readonly since?: string | undefined;
        readonly tip?: string | undefined;
      }
    | undefined;
  /** The head (and its patch-id) whose playbook review stopped the job, while it waits on the agent. */
  readonly challenged_tip?: string | undefined;
  readonly challenged_patch?: string | undefined;
  readonly challenge_override?: ChallengeOverride | undefined;
  /** Declared merge-step exits 75 (base moved) and 76 (transient) retried so far. */
  readonly merge_retries?: number | undefined;
  /** A transient failure's back-off: the worker leaves the job alone until then. */
  readonly retry_after?: string | undefined;
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
export type RepoVisibility = "public" | "private" | "internal" | "unknown";

export interface ShipForge {
  /** The repo's visibility; absent or `unknown` is treated as public (fail closed). */
  readonly repoVisibility?: (input: {
    readonly cwd: string;
    readonly repo: string;
  }) => Promise<RepoVisibility>;
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
  /** Checks the grant for `jobId`'s recorded thread; `consume` is set only for the house pass itself. */
  readonly check: (input: {
    readonly worktree: string;
    readonly branch: string;
    readonly bundle: WireGuardBundle;
    readonly jobId: string;
    readonly consume: boolean;
  }) => Promise<GuardCheck>;
  /** Opens the owner's approval window for the job's bundle, in the job's thread; never waits. */
  readonly request?: (input: {
    readonly worktree: string;
    readonly branch: string;
    readonly bundle: WireGuardBundle;
    readonly jobId: string;
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

export type HygieneVerdict =
  | { readonly kind: "skip"; readonly log: string }
  | { readonly kind: "pass"; readonly log: string }
  | { readonly kind: "fail"; readonly reason: string; readonly log: string };

/** PLAYBOOK §16 house hygiene stage over the job's tree, commits, and PR text. */
export type HygieneGate = (input: {
  readonly jobId: string;
  readonly queueRoot: string;
  readonly worktree: string;
  readonly repo: string;
  readonly baseSha: string;
  readonly title: string;
  readonly bodyFile: string;
}) => Promise<HygieneVerdict>;

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
  readonly hygieneScan: HygieneGate;
  readonly declarationChallenge?: DeclarationChallenger | undefined;
  readonly clock: Clock;
  readonly isProcessAlive: (identity: ProcessIdentity) => boolean;
  readonly self: ProcessIdentity;
  readonly watcherWaitMs: number;
  /** Where a job's install and CI steps run; absent means this host. */
  readonly ciPlacer?: CiPlacer | undefined;
  /** SSH runner for remote CI hosts (tests inject one). */
  readonly runRemote?: RemoteCommandRunner | undefined;
  /** Optional bounded timeout for `ship_post_merge` steps (defaults to 10 minutes). */
  readonly postMergeTimeoutMs?: number | undefined;
  /** Runtime version identity of this worker, enabling version-pinned execution without global drain locks. */
  readonly workerVersion?: WorkerRuntimeVersion | undefined;
  /** Post-merge subscribers (`subscribeMerges`); a throwing subscriber is logged, never fatal. */
  readonly onMerged?: ReadonlyArray<(merged: MergedJob) => Promise<void> | void> | undefined;
}
