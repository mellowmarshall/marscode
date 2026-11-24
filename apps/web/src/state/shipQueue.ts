import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  AuthAccessWriteScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type ShipQueueDepRepo,
  type ShipQueueJob,
  type ShipQueueSnapshot,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMessages } from "gt-react";

import { useNowSecond } from "../hooks/useNowSecond";
import { collectDescendantSubagentIds } from "../lib/hostGuardApprovals";
import {
  buildShipQueueDepApproval,
  depHoldReportKey,
  deriveThreadShipQueueDepApprovals,
  EMPTY_SHIP_QUEUE_DEP_APPROVALS,
  findActionableDepHoldForJob,
  type ChildThreadShipQueueDepApproval,
  type ThreadShipQueueDepApproval,
} from "../lib/shipQueueApprovals";
import {
  matchThreadShipJobs,
  normalizeDirectoryPath,
  resolveThreadShipStatus,
  type ThreadShipStatus,
} from "../lib/threadShipStatus";
import { appAtomRegistry } from "../rpc/atomRegistry";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import { environmentThreadShells } from "./threads";

export const EMPTY_SHIP_QUEUE_SNAPSHOT: ShipQueueSnapshot = {
  available: false,
  daemonRunning: false,
  daemonPid: null,
  openCount: 0,
  totalCount: 0,
  jobs: [],
  deps: [],
};

const EMPTY_SHIP_JOBS: ReadonlyArray<ShipQueueJob> = [];
const EMPTY_CHILD_DEP_APPROVALS: ReadonlyArray<ChildThreadShipQueueDepApproval> = [];

interface RepoBusyEntry {
  readonly reportKey: string;
  readonly untilMs: number;
}

export interface ShipQueueBusyState {
  readonly scanning: Readonly<Record<string, RepoBusyEntry>>;
  readonly deciding: Readonly<Record<string, RepoBusyEntry>>;
}

const EMPTY_BUSY_STATE: ShipQueueBusyState = { scanning: {}, deciding: {} };

export const shipQueueBusyAtom = Atom.make<ShipQueueBusyState>(EMPTY_BUSY_STATE).pipe(
  Atom.withLabel("web-ship-queue-busy"),
);

export function markShipQueueRepoBusy(
  kind: "scanning" | "deciding",
  repo: string,
  reportKey: string,
  ttlMs = 25_000,
): void {
  const nextEntry: RepoBusyEntry = { reportKey, untilMs: Date.now() + ttlMs };
  appAtomRegistry.update(shipQueueBusyAtom, (cur) => ({
    ...cur,
    [kind]: { ...cur[kind], [repo]: nextEntry },
  }));
}

export function clearShipQueueRepoBusy(
  kind: "scanning" | "deciding",
  repo: string,
  reportKey?: string,
): void {
  appAtomRegistry.update(shipQueueBusyAtom, (cur) => {
    const existing = cur[kind][repo];
    if (!existing || (reportKey !== undefined && existing.reportKey !== reportKey)) {
      return cur;
    }
    const nextGroup = { ...cur[kind] };
    delete nextGroup[repo];
    return { ...cur, [kind]: nextGroup };
  });
}

function activeBusyKeys(
  records: Readonly<Record<string, RepoBusyEntry>>,
  nowMs: number,
): Readonly<Record<string, string | null>> {
  const out: Record<string, string | null> = {};
  for (const [repo, entry] of Object.entries(records)) {
    if (entry.untilMs > nowMs) {
      out[repo] = entry.reportKey;
    }
  }
  return out;
}

const EMPTY_SNAPSHOT_ATOM = Atom.make(EMPTY_SHIP_QUEUE_SNAPSHOT).pipe(
  Atom.withLabel("web-ship-queue-snapshot:empty"),
);
const NULL_STATUS_ATOM = Atom.make<ThreadShipStatus | null>(null).pipe(
  Atom.withLabel("web-ship-queue-status:null"),
);
const FALSE_ATOM = Atom.make(false).pipe(Atom.withLabel("web-ship-queue-has-dep:false"));
const EMPTY_DEP_LIST_ATOM = Atom.make<
  ReadonlyArray<{
    readonly childThreadId: ThreadId;
    readonly childTitle: string;
    readonly hold: ShipQueueDepRepo;
  }>
>([]).pipe(Atom.withLabel("web-ship-queue-child-deps:empty"));

const canReadShipQueueAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const configs = get(environmentServerConfigsAtom);
    if (configs.get(environmentId)?.environment.capabilities.shipQueue !== true) {
      return false;
    }
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return sessionHasScope(session, AuthOrchestrationReadScope);
  }).pipe(Atom.withLabel(`web-ship-queue-readable:${environmentId}`)),
);

export const canDecideShipQueueDepsAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const configs = get(environmentServerConfigsAtom);
    if (configs.get(environmentId)?.environment.capabilities.shipQueue !== true) {
      return false;
    }
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return (
      sessionHasScope(session, AuthAccessWriteScope) &&
      sessionHasScope(session, AuthTerminalOperateScope)
    );
  }).pipe(Atom.withLabel(`web-ship-queue-decidable:${environmentId}`)),
);

export const shipQueueSnapshotAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ShipQueueSnapshot => {
    if (!get(canReadShipQueueAtom(environmentId))) {
      return EMPTY_SHIP_QUEUE_SNAPSHOT;
    }
    const result = get(serverEnvironment.shipQueueLive({ environmentId, input: {} }));
    const value = Option.getOrUndefined(AsyncResult.value(result));
    return value && value.available ? value : EMPTY_SHIP_QUEUE_SNAPSHOT;
  }).pipe(Atom.withLabel(`web-ship-queue-snapshot:${environmentId}`)),
);

const childShipQueueDepsAtom = Atom.family((key: string) => {
  const { environmentId, threadId: parentThreadId } = parseThreadKey(key);
  return Atom.make((get) => {
    if (!get(canDecideShipQueueDepsAtom(environmentId))) {
      return [];
    }
    const snap = get(shipQueueSnapshotAtom(environmentId));
    if (!snap.available || snap.jobs.length === 0 || snap.deps.length === 0) {
      return [];
    }
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const childIds = collectDescendantSubagentIds(threads, parentThreadId);
    if (childIds.size === 0) return [];
    const byId = new Map(threads.map((t) => [t.id, t] as const));
    const seenRepos = new Set<string>();
    const out: Array<{
      readonly childThreadId: ThreadId;
      readonly childTitle: string;
      readonly hold: ShipQueueDepRepo;
    }> = [];
    for (const childId of childIds) {
      const child = byId.get(childId);
      if (!child) continue;
      const matchedJobs = matchThreadShipJobs(
        snap.jobs,
        child.id,
        child.branch ?? null,
        normalizeDirectoryPath(child.worktreePath),
        "",
      );
      for (const job of matchedJobs) {
        const hold = findActionableDepHoldForJob(job, snap.deps);
        if (!hold || seenRepos.has(hold.repo)) continue;
        seenRepos.add(hold.repo);
        out.push({
          childThreadId: child.id,
          childTitle: child.title || child.id,
          hold,
        });
      }
    }
    return out;
  }).pipe(Atom.withLabel(`web-ship-queue-child-deps:${key}`));
});

const threadHasShipQueueDepApprovalAtom = Atom.family((key: string) => {
  const { environmentId, threadId } = parseThreadKey(key);
  return Atom.make((get): boolean => {
    if (!get(canDecideShipQueueDepsAtom(environmentId))) {
      return false;
    }
    const snap = get(shipQueueSnapshotAtom(environmentId));
    if (!snap.available || snap.jobs.length === 0 || snap.deps.length === 0) {
      return false;
    }
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const target = threads.find((t) => t.id === threadId);
    const matchedOwn = matchThreadShipJobs(
      snap.jobs,
      threadId,
      target?.branch ?? null,
      normalizeDirectoryPath(target?.worktreePath),
      "",
    );
    if (matchedOwn.some((job) => findActionableDepHoldForJob(job, snap.deps) !== null)) {
      return true;
    }
    const descendants = collectDescendantSubagentIds(threads, threadId);
    for (const childId of descendants) {
      const child = threads.find((t) => t.id === childId);
      if (!child) continue;
      const matchedChild = matchThreadShipJobs(
        snap.jobs,
        child.id,
        child.branch ?? null,
        normalizeDirectoryPath(child.worktreePath),
        "",
      );
      if (matchedChild.some((job) => findActionableDepHoldForJob(job, snap.deps) !== null)) {
        return true;
      }
    }
    return false;
  }).pipe(Atom.withLabel(`web-thread-has-ship-dep:${key}`));
});

const threadShipStatusAtom = Atom.family((serialized: string) => {
  const { environmentId, threadId, branch, worktreePath, gitCwd } = JSON.parse(serialized) as {
    readonly environmentId: EnvironmentId;
    readonly threadId: ThreadId;
    readonly branch: string | null;
    readonly worktreePath: string | null;
    readonly gitCwd: string | null;
  };
  return Atom.make((get): ThreadShipStatus | null => {
    const snap = get(shipQueueSnapshotAtom(environmentId));
    if (!snap.available || snap.jobs.length === 0) return null;
    return resolveThreadShipStatus({
      jobs: snap.jobs,
      threadId,
      branch,
      worktreePath,
      gitCwd,
    });
  }).pipe(Atom.withLabel(`web-thread-ship-status:${environmentId}:${threadId}`));
});

export function useShipQueueSnapshot(environmentId: EnvironmentId | null): ShipQueueSnapshot {
  return useAtomValue(environmentId ? shipQueueSnapshotAtom(environmentId) : EMPTY_SNAPSHOT_ATOM);
}

export function useThreadShipJobs(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
}): ReadonlyArray<ShipQueueJob> {
  const snap = useShipQueueSnapshot(input.environmentId);
  if (!input.environmentId || !input.threadId || !snap.available || snap.jobs.length === 0) {
    return EMPTY_SHIP_JOBS;
  }
  return matchThreadShipJobs(
    snap.jobs,
    input.threadId,
    input.branch,
    normalizeDirectoryPath(input.worktreePath),
    normalizeDirectoryPath(input.gitCwd),
  );
}

export function useThreadShipStatus(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
  readonly enabled?: boolean;
}): ThreadShipStatus | null {
  const active = input.enabled !== false && input.environmentId !== null && input.threadId !== null;
  return useAtomValue(
    active && input.environmentId && input.threadId
      ? threadShipStatusAtom(
          JSON.stringify({
            environmentId: input.environmentId,
            threadId: input.threadId,
            branch: input.branch,
            worktreePath: input.worktreePath,
            gitCwd: input.gitCwd,
          }),
        )
      : NULL_STATUS_ATOM,
  );
}

export function useThreadShipQueueDepApprovals(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly branch: string | null;
  readonly worktreePath: string | null;
  readonly gitCwd: string | null;
}): ReadonlyArray<ThreadShipQueueDepApproval> {
  const snap = useShipQueueSnapshot(input.environmentId);
  const canDecide = useAtomValue(
    input.environmentId ? canDecideShipQueueDepsAtom(input.environmentId) : FALSE_ATOM,
  );
  const busyState = useAtomValue(shipQueueBusyAtom);
  const nowMs = useNowSecond();
  const resolve = useMessages();
  if (!canDecide || !input.environmentId || !input.threadId || !snap.available) {
    return EMPTY_SHIP_QUEUE_DEP_APPROVALS;
  }
  const threadJobs = matchThreadShipJobs(
    snap.jobs,
    input.threadId,
    input.branch,
    normalizeDirectoryPath(input.worktreePath),
    normalizeDirectoryPath(input.gitCwd),
  );
  if (threadJobs.length === 0 || snap.deps.length === 0) {
    return EMPTY_SHIP_QUEUE_DEP_APPROVALS;
  }
  return deriveThreadShipQueueDepApprovals({
    jobs: threadJobs,
    deps: snap.deps,
    scanningRepos: activeBusyKeys(busyState.scanning, nowMs),
    decidingRepos: activeBusyKeys(busyState.deciding, nowMs),
    nowMs,
    resolve,
  });
}

export function useChildThreadShipQueueDepApprovals(
  environmentId: EnvironmentId | null,
  parentThreadId: ThreadId | null,
): ReadonlyArray<ChildThreadShipQueueDepApproval> {
  const pendingChildren = useAtomValue(
    environmentId && parentThreadId
      ? childShipQueueDepsAtom(threadKey({ environmentId, threadId: parentThreadId }))
      : EMPTY_DEP_LIST_ATOM,
  );
  const busyState = useAtomValue(shipQueueBusyAtom);
  const nowMs = useNowSecond();
  const resolve = useMessages();
  if (pendingChildren.length === 0) {
    return EMPTY_CHILD_DEP_APPROVALS;
  }
  const scanningRepos = activeBusyKeys(busyState.scanning, nowMs);
  const decidingRepos = activeBusyKeys(busyState.deciding, nowMs);
  return pendingChildren.map((item) => ({
    childThreadId: item.childThreadId,
    childTitle: item.childTitle,
    entry: buildShipQueueDepApproval({
      hold: item.hold,
      scanningRepos,
      decidingRepos,
      nowMs,
      resolve,
    }),
  }));
}

export function useThreadHasShipQueueDepApproval(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly enabled?: boolean;
}): boolean {
  const active = input.enabled !== false && input.environmentId !== null && input.threadId !== null;
  return useAtomValue(
    active && input.environmentId && input.threadId
      ? threadHasShipQueueDepApprovalAtom(
          threadKey({ environmentId: input.environmentId, threadId: input.threadId }),
        )
      : FALSE_ATOM,
  );
}

export function findDepApprovalBusyReportKey(hold: ShipQueueDepRepo): string {
  return depHoldReportKey(hold);
}
