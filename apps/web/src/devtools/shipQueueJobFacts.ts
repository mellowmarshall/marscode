/**
 * Facts about one ship-queue job that the Ship Queue table shows beside its pipeline steps:
 * repo name, CI host, list order, step timings, the playbook challenge, and the post-merge sync.
 */
import type { ShipQueueJob, ShipQueueStepTiming } from "./devtoolsClient";

const CI_STEP_NAME = "ship_ci";
const LOCAL_HOST = "local";

/** The repository name without its owner (`owner/name` -> `name`). */
export function shipJobRepoName(job: ShipQueueJob): string | null {
  const repo = job.repo?.trim();
  if (!repo) return null;
  const slash = repo.lastIndexOf("/");
  return slash >= 0 && slash < repo.length - 1 ? repo.slice(slash + 1) : repo;
}

export function shipJobSteps(job: ShipQueueJob): ReadonlyArray<ShipQueueStepTiming> {
  return Array.isArray(job.steps)
    ? job.steps.filter((step) => step && typeof step.name === "string" && step.name.trim())
    : [];
}

/**
 * Where the job's CI ran or runs: the host of its recorded `ship_ci` step, else the host its
 * running CI step holds, else its route, else the last non-local step host.
 */
export function shipJobCiHost(job: ShipQueueJob): string | null {
  const steps = shipJobSteps(job);
  const ciStepHost = steps.find((step) => step.name === CI_STEP_NAME)?.host?.trim();
  if (ciStepHost) return ciStepHost;
  const leased = job.ci_lease?.host?.trim();
  if (leased) return leased;
  const routed = job.route?.host?.trim();
  if (routed) return routed;
  const remote = steps.findLast((step) => step.host && step.host.trim() !== LOCAL_HOST);
  return remote?.host?.trim() || null;
}

function shipJobOrderKey(job: ShipQueueJob): number {
  const submitted = job.submitted_at ? Date.parse(job.submitted_at) : Number.NaN;
  if (Number.isFinite(submitted)) return submitted;
  const id = Number(job.id);
  return Number.isFinite(id) ? id : 0;
}

/** Newest submitted first; job ids break ties (they only grow). */
export function compareShipJobsNewestFirst(a: ShipQueueJob, b: ShipQueueJob): number {
  const byTime = shipJobOrderKey(b) - shipJobOrderKey(a);
  if (byTime !== 0) return byTime;
  return (Number(b.id) || 0) - (Number(a.id) || 0);
}

/** A step's wall time: `420ms`, `38.9s`, `2m 05s`. */
export function formatStepDuration(ms: number | undefined): string | null {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  if (ms < 1000) return `${Math.round(ms)}ms`;
  const secs = ms / 1000;
  if (secs < 60) return `${secs.toFixed(1)}s`;
  const mins = Math.floor(secs / 60);
  return `${mins}m ${String(Math.floor(secs % 60)).padStart(2, "0")}s`;
}

export type ShipJobChallenge =
  | { readonly kind: "overridden"; readonly reason: string; readonly at: string | null }
  | { readonly kind: "challenged"; readonly tip: string };

/** The playbook review's verdict when it stopped the job, and the agent's override if any. */
export function shipJobChallenge(job: ShipQueueJob): ShipJobChallenge | null {
  const override = job.challenge_override;
  if (override?.reason?.trim()) {
    return { kind: "overridden", reason: override.reason.trim(), at: override.at ?? null };
  }
  const tip = job.challenged_tip?.trim();
  return tip ? { kind: "challenged", tip } : null;
}

export interface ShipJobSync {
  readonly exit: number;
  readonly reason: string | null;
  /** The job merged its PR; a failed sync leaves the PR merged. */
  readonly merged: boolean;
}

/** The post-merge sync's recorded exit, when the job ran one. */
export function shipJobSync(job: ShipQueueJob): ShipJobSync | null {
  const raw = job.sync_exit;
  if (raw === undefined || raw === null || String(raw).trim() === "") return null;
  const exit = Number(raw);
  if (!Number.isFinite(exit)) return null;
  return {
    exit,
    reason: job.sync_reason?.trim() || null,
    merged: Number(job.merge_exit) === 0 || (job.state ?? "").toLowerCase() === "done",
  };
}

export function shortSha(sha: string | undefined): string | null {
  const value = sha?.trim();
  return value && /^[0-9a-f]{7,40}$/i.test(value) ? value.slice(0, 7) : null;
}
