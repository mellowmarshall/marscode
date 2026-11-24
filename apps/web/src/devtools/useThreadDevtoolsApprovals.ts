/**
 * React hook bindings for thread-native DevTools approvals (`threadApprovals.ts`).
 * Includes descendant subagent roll-up (M6) and lazy jobs-stream subscription for sidebar rows (L12).
 */
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";

import { useQuietThreadShells } from "../state/entities";
import type { ShipQueueJob } from "./devtoolsClient";
import {
  useHasPassiveShipQueueDepHold,
  usePassiveShipQueueDeps,
  useSharedShipQueueDeps,
} from "./devtoolsDepsStore";
import { useDevtoolsSelector } from "./devtoolsStore";
import { useSharedJobs } from "./jobs/jobsStore";
import { isShipQueueJobLive } from "./ShipQueueSteps";
import {
  deriveThreadDevtoolsApprovals,
  EMPTY_DEVTOOLS_APPROVALS,
  isDepHoldActionable,
  type ChildThreadDevtoolsApproval,
  type ThreadDevtoolsApproval,
} from "./threadApprovals";

export function collectDescendantSubagentIds(
  threads: ReadonlyArray<{
    readonly id: ThreadId;
    readonly environmentId: EnvironmentId;
    readonly deletedAt: string | null;
    readonly archivedAt: string | null;
    readonly lineage: {
      readonly parentThreadId: ThreadId | null;
      readonly relationshipToParent: string | null;
    };
  }>,
  environmentId: EnvironmentId,
  rootThreadId: ThreadId,
): ReadonlySet<ThreadId> {
  const byParent = new Map<ThreadId, ThreadId[]>();
  for (const t of threads) {
    if (
      t.environmentId !== environmentId ||
      t.deletedAt !== null ||
      t.archivedAt !== null ||
      t.lineage.relationshipToParent !== "subagent" ||
      t.lineage.parentThreadId === null
    ) {
      continue;
    }
    const list = byParent.get(t.lineage.parentThreadId);
    if (list) list.push(t.id);
    else byParent.set(t.lineage.parentThreadId, [t.id]);
  }
  const out = new Set<ThreadId>();
  const queue: ThreadId[] = [rootThreadId];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    for (const childId of byParent.get(cur) ?? []) {
      if (!out.has(childId)) {
        out.add(childId);
        queue.push(childId);
      }
    }
  }
  return out;
}

export function useThreadDevtoolsApprovals(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly enabled?: boolean;
}): ReadonlyArray<ThreadDevtoolsApproval> {
  const active = Boolean(input.enabled !== false && input.environmentId && input.threadId);
  const envId = active ? input.environmentId : null;

  const envGuards = useDevtoolsSelector((s) =>
    envId ? (s.pendingByEnv.get(envId) ?? null) : null,
  );
  const jobsState = useSharedJobs(envId);
  const shipJobs: ReadonlyArray<ShipQueueJob> = jobsState.jobs.flatMap((j) =>
    j.source === "ship-queue" && j.shipJob ? [j.shipJob] : [],
  );
  const hasLiveShip = shipJobs.some(isShipQueueJobLive);
  const depsState = useSharedShipQueueDeps(envId, active && hasLiveShip);

  if (!active || !input.threadId) return EMPTY_DEVTOOLS_APPROVALS;
  const pendingGuards = envGuards ? envGuards.map((item) => item.request) : [];
  const depsRepos = depsState.payload?.repos ?? [];
  if (pendingGuards.length === 0 && depsRepos.length === 0) {
    return EMPTY_DEVTOOLS_APPROVALS;
  }

  return deriveThreadDevtoolsApprovals({
    threadId: input.threadId,
    pendingGuards,
    shipJobs,
    depsRepos,
    scanningRepos: depsState.scanningRepos,
    decidingRepos: depsState.decidingRepos,
  });
}

export function useChildThreadDevtoolsApprovals(
  environmentId: EnvironmentId | null,
  parentThreadId: ThreadId | null,
): ReadonlyArray<ChildThreadDevtoolsApproval> {
  const active = Boolean(environmentId && parentThreadId);
  const envId = active ? environmentId : null;
  const threads = useQuietThreadShells();
  const envGuards = useDevtoolsSelector((s) =>
    envId ? (s.pendingByEnv.get(envId) ?? null) : null,
  );
  const hasHoldingDep = useHasPassiveShipQueueDepHold(envId, active, isDepHoldActionable);
  const depsState = usePassiveShipQueueDeps(envId, active && hasHoldingDep);
  const depsRepos = depsState.payload?.repos ?? [];
  const jobsState = useSharedJobs(active && hasHoldingDep ? envId : null);

  if (!active || !environmentId || !parentThreadId) return [];
  const pendingGuards = envGuards ? envGuards.map((item) => item.request) : [];
  if (pendingGuards.length === 0 && !hasHoldingDep) return [];

  const childIds = collectDescendantSubagentIds(threads, environmentId, parentThreadId);
  if (childIds.size === 0) return [];
  const titleById = new Map(threads.map((t) => [t.id, t.title] as const));
  const shipJobs: ReadonlyArray<ShipQueueJob> = hasHoldingDep
    ? jobsState.jobs.flatMap((j) => (j.source === "ship-queue" && j.shipJob ? [j.shipJob] : []))
    : [];

  const out: ChildThreadDevtoolsApproval[] = [];
  for (const childId of childIds) {
    const entries = deriveThreadDevtoolsApprovals({
      threadId: childId,
      pendingGuards,
      shipJobs,
      depsRepos,
      scanningRepos: depsState.scanningRepos,
      decidingRepos: depsState.decidingRepos,
    });
    const childTitle = titleById.get(childId) || childId;
    for (const entry of entries) {
      out.push({ childThreadId: childId, childTitle, entry });
    }
  }
  return out;
}

/**
 * Lightweight sidebar/list approval indicator.
 * Passively watches cached dep-hold status (no `/ship-queue/deps` fetches when idle and no
 * per-row re-renders while no hold exists) and subscribes to jobs ONLY when a hold is active.
 */
export function useThreadHasDevtoolsApproval(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly enabled?: boolean;
}): boolean {
  const active = Boolean(input.enabled !== false && input.environmentId && input.threadId);
  const envId = active ? input.environmentId : null;
  const threads = useQuietThreadShells();

  const envGuards = useDevtoolsSelector((s) =>
    envId ? (s.pendingByEnv.get(envId) ?? null) : null,
  );
  const hasHoldingDep = useHasPassiveShipQueueDepHold(envId, active, isDepHoldActionable);
  const depsState = usePassiveShipQueueDeps(envId, active && hasHoldingDep);
  const depsRepos = depsState.payload?.repos ?? [];
  const jobsState = useSharedJobs(active && hasHoldingDep ? envId : null);

  if (!active || !input.environmentId || !input.threadId) return false;
  const pendingGuards = envGuards ? envGuards.map((item) => item.request) : [];
  if (pendingGuards.length === 0 && !hasHoldingDep) return false;

  const targetIds = new Set<string>([
    input.threadId,
    ...collectDescendantSubagentIds(threads, input.environmentId, input.threadId),
  ]);
  const shipJobs: ReadonlyArray<ShipQueueJob> = hasHoldingDep
    ? jobsState.jobs.flatMap((j) => (j.source === "ship-queue" && j.shipJob ? [j.shipJob] : []))
    : [];

  for (const tid of targetIds) {
    if (
      deriveThreadDevtoolsApprovals({
        threadId: tid,
        pendingGuards,
        shipJobs,
        depsRepos,
        scanningRepos: depsState.scanningRepos,
        decidingRepos: depsState.decidingRepos,
      }).length > 0
    ) {
      return true;
    }
  }
  return false;
}
