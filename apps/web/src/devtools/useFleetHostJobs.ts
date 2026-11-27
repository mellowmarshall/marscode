/**
 * Host jobs for Fleet Console: the active environment's jobs plus, when the selected
 * host is a remote host linked as its own T3 environment, that environment's jobs.
 */
import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironments } from "../state/environments";
import type { MergedFleetHost } from "./devdeckTypes";
import {
  matchHostEnvironmentId,
  mergeRemoteEnvironmentJobs,
  type FleetHostJobs,
} from "./fleetHostEnvironment";
import { refreshSharedJobs, useSharedJobs } from "./jobs/jobsStore";

export interface FleetConsoleHostJobs extends FleetHostJobs {
  readonly refresh: () => Promise<unknown>;
}

export function useFleetHostJobs(
  environmentId: EnvironmentId,
  selectedHost: MergedFleetHost | null,
): FleetConsoleHostJobs {
  const { environments } = useEnvironments();
  const localJobs = useSharedJobs(environmentId);
  const matchedEnvId =
    selectedHost && !selectedHost.isLocal
      ? matchHostEnvironmentId(selectedHost, environmentId, environments)
      : null;
  const remoteEnvId = matchedEnvId === environmentId ? null : matchedEnvId;
  const remoteJobs = useSharedJobs(remoteEnvId);
  const merged = mergeRemoteEnvironmentJobs({
    activeEnvironmentId: environmentId,
    localJobs: localJobs.jobs,
    remoteEnvironmentId: remoteEnvId,
    remoteJobs: remoteJobs.jobs,
    remoteHost: selectedHost,
  });
  const refresh = () =>
    Promise.all([
      refreshSharedJobs(environmentId),
      ...(remoteEnvId ? [refreshSharedJobs(remoteEnvId)] : []),
    ]);
  return { ...merged, refresh };
}
