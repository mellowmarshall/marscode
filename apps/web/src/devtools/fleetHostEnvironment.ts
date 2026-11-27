/**
 * Matches Fleet Console hosts to linked T3 environments and to the jobs those
 * environments report, with the same host-name rules as the server prober.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import type { MergedFleetHost } from "./devdeckTypes";
import { readCachedCapabilities } from "./devtoolsStreams";
import { isHostJob, type JobSummary } from "./jobs/jobTypes";

/** Same rules as `normalizeToken` in the server `RemoteNodeProber.ts`. */
export function normalizeFleetHostToken(raw: string | null | undefined): string {
  return (raw ?? "")
    .trim()
    .toLowerCase()
    .replace(/^dev-/, "")
    .replace(/\.local$/, "")
    .replace(/(?:[\s_-]+wsl)+$/, "")
    .replace(/[^a-z0-9]+/g, "");
}

export function fleetHostTokens(host: MergedFleetHost): ReadonlySet<string> {
  return new Set(
    [host.id, host.shortName, host.probeHostName ?? "", host.ssh ?? "", ...host.members]
      .map(normalizeFleetHostToken)
      .filter(Boolean),
  );
}

export interface FleetEnvironmentCandidate {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly serverConfig: { readonly environment: { readonly label: string } } | null;
}

export function matchHostEnvironmentId(
  host: MergedFleetHost,
  activeEnvironmentId: EnvironmentId,
  environments: ReadonlyArray<FleetEnvironmentCandidate>,
): EnvironmentId | null {
  if (host.isLocal) return activeEnvironmentId;
  const hostTokens = fleetHostTokens(host);
  for (const env of environments) {
    // The active environment is the local host, so it never stands for a remote one.
    if (env.environmentId === activeEnvironmentId) continue;
    const capHost = readCachedCapabilities(env.environmentId)?.capabilities?.host;
    const candidates = [capHost, env.serverConfig?.environment.label, env.label];
    for (const candidate of candidates) {
      const token = normalizeFleetHostToken(candidate);
      if (token && hostTokens.has(token)) {
        return env.environmentId;
      }
    }
  }
  return null;
}

/** Where a shown job lives: the environment to inspect, cancel, and open its thread in. */
export interface FleetJobTarget {
  readonly environmentId: EnvironmentId;
  readonly jobId: string;
}

export interface FleetHostJobs {
  /** Local jobs keep their id; remote jobs get a key scoped to their environment. */
  readonly jobs: ReadonlyArray<JobSummary>;
  /** Shown job key -> owning environment and real job id. */
  readonly targets: ReadonlyMap<string, FleetJobTarget>;
}

function remoteJobKey(environmentId: EnvironmentId, jobId: string): string {
  return `env:${environmentId}:${jobId}`;
}

/**
 * Adds the host jobs of a remote host's own linked environment to the active host's jobs.
 * The matched environment runs on that remote host, so each of its jobs gets the host's
 * name. Each remote job gets a key scoped to its environment, so a local and a remote job
 * with the same id never replace each other or reach the wrong environment.
 */
export function mergeRemoteEnvironmentJobs(input: {
  readonly activeEnvironmentId: EnvironmentId;
  readonly localJobs: ReadonlyArray<JobSummary>;
  readonly remoteEnvironmentId: EnvironmentId | null;
  readonly remoteJobs: ReadonlyArray<JobSummary>;
  readonly remoteHost: MergedFleetHost | null;
}): FleetHostJobs {
  const targets = new Map<string, FleetJobTarget>();
  const local = input.localJobs.filter(isHostJob);
  for (const j of local) {
    targets.set(j.id, { environmentId: input.activeEnvironmentId, jobId: j.id });
  }
  const remoteEnvId = input.remoteEnvironmentId;
  const host = input.remoteHost;
  if (!remoteEnvId || remoteEnvId === input.activeEnvironmentId || !host || host.isLocal) {
    return { jobs: local, targets };
  }
  const hostName = host.probeHostName ?? host.id;
  const remote = input.remoteJobs.filter(isHostJob).map((j): JobSummary => {
    const key = remoteJobKey(remoteEnvId, j.id);
    targets.set(key, { environmentId: remoteEnvId, jobId: j.id });
    return { ...j, id: key, binding: { ...j.binding, host: hostName } };
  });
  return { jobs: [...local, ...remote], targets };
}

/** The owning environment and real id of a shown job; unknown keys stay on the active host. */
export function resolveFleetJobTarget(
  targets: ReadonlyMap<string, FleetJobTarget> | undefined,
  key: string,
  activeEnvironmentId: EnvironmentId,
): FleetJobTarget {
  return targets?.get(key) ?? { environmentId: activeEnvironmentId, jobId: key };
}
