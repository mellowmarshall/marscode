import { useAtomValue } from "@effect/atom-react";
import { parseThreadKey, threadKey } from "@t3tools/client-runtime/state/entities";
import {
  AuthAccessWriteScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type PendingHostGuardRequest,
  type ThreadId,
} from "@t3tools/contracts";
import * as Option from "effect/Option";
import { AsyncResult, Atom } from "effect/reactivity";
import { useMessages } from "gt-react";

import {
  buildHostGuardApproval,
  collectDescendantSubagentIds,
  deriveThreadHostGuardApprovals,
  EMPTY_HOST_GUARD_APPROVALS,
  isPendingHostGuardActive,
  type ChildThreadHostGuardApproval,
  type ThreadHostGuardApproval,
} from "../lib/hostGuardApprovals";
import { environmentServerConfigsAtom, serverEnvironment } from "./server";
import { environmentSession, sessionHasScope } from "./session";
import { environmentThreadShells } from "./threads";

const EMPTY_PENDING_HOST_GUARD: ReadonlyArray<PendingHostGuardRequest> = [];
const EMPTY_CHILD_HOST_GUARD_APPROVALS: ReadonlyArray<ChildThreadHostGuardApproval> = [];

const EMPTY_PENDING_ATOM = Atom.make(EMPTY_PENDING_HOST_GUARD).pipe(
  Atom.withLabel("web-host-guard-pending:empty"),
);
const FALSE_ATOM = Atom.make(false).pipe(Atom.withLabel("web-thread-host-guard:false"));
const EMPTY_CHILD_PENDING_ATOM = Atom.make<
  ReadonlyArray<{
    readonly childThreadId: ThreadId;
    readonly childTitle: string;
    readonly request: PendingHostGuardRequest;
  }>
>([]).pipe(Atom.withLabel("web-child-host-guard:empty"));

const canApproveHostGuardAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get) => {
    const configs = get(environmentServerConfigsAtom);
    if (configs.get(environmentId)?.environment.capabilities.hostGuardBroker !== true) {
      return false;
    }
    const session = get(environmentSession.sessionStateAtom(environmentId));
    return (
      sessionHasScope(session, AuthAccessWriteScope) &&
      sessionHasScope(session, AuthTerminalOperateScope)
    );
  }).pipe(Atom.withLabel(`web-host-guard-eligible:${environmentId}`)),
);

export const hostGuardPendingAtom = Atom.family((environmentId: EnvironmentId) =>
  Atom.make((get): ReadonlyArray<PendingHostGuardRequest> => {
    if (!get(canApproveHostGuardAtom(environmentId))) {
      return EMPTY_PENDING_HOST_GUARD;
    }
    const result = get(serverEnvironment.hostGuardLive({ environmentId, input: {} }));
    const value = Option.getOrUndefined(AsyncResult.value(result));
    if (!value || !value.listening || value.pending.length === 0) {
      return EMPTY_PENDING_HOST_GUARD;
    }
    return value.pending;
  }).pipe(Atom.withLabel(`web-host-guard-pending:${environmentId}`)),
);

const childHostGuardPendingAtom = Atom.family((key: string) => {
  const { environmentId, threadId: parentThreadId } = parseThreadKey(key);
  return Atom.make((get) => {
    const pending = get(hostGuardPendingAtom(environmentId));
    if (pending.length === 0) return [];
    const nowMs = Date.now();
    const activePending = pending.filter((req) => isPendingHostGuardActive(req, nowMs));
    if (activePending.length === 0) return [];
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const childIds = collectDescendantSubagentIds(threads, parentThreadId);
    if (childIds.size === 0) return [];
    const titleById = new Map(threads.map((thread) => [thread.id, thread.title] as const));
    const out: Array<{
      readonly childThreadId: ThreadId;
      readonly childTitle: string;
      readonly request: PendingHostGuardRequest;
    }> = [];
    for (const req of activePending) {
      const childId = req.threadId as ThreadId;
      if (!childIds.has(childId)) continue;
      out.push({
        childThreadId: childId,
        childTitle: titleById.get(childId) || childId,
        request: req,
      });
    }
    return out;
  }).pipe(Atom.withLabel(`web-child-host-guard:${key}`));
});

const threadHasHostGuardApprovalAtom = Atom.family((key: string) => {
  const { environmentId, threadId } = parseThreadKey(key);
  return Atom.make((get): boolean => {
    const pending = get(hostGuardPendingAtom(environmentId));
    if (pending.length === 0) return false;
    const nowMs = Date.now();
    const activePending = pending.filter((req) => isPendingHostGuardActive(req, nowMs));
    if (activePending.length === 0) return false;
    if (activePending.some((req) => req.threadId === threadId)) return true;
    const threads = get(environmentThreadShells.environmentThreadsAtom(environmentId));
    const descendants = collectDescendantSubagentIds(threads, threadId);
    return activePending.some((req) => descendants.has(req.threadId as ThreadId));
  }).pipe(Atom.withLabel(`web-thread-has-host-guard:${key}`));
});

export function useThreadHostGuardApprovals(
  environmentId: EnvironmentId | null,
  threadId: ThreadId | null,
): ReadonlyArray<ThreadHostGuardApproval> {
  const pending = useAtomValue(
    environmentId ? hostGuardPendingAtom(environmentId) : EMPTY_PENDING_ATOM,
  );
  const resolve = useMessages();
  if (!environmentId || !threadId || pending.length === 0) {
    return EMPTY_HOST_GUARD_APPROVALS;
  }
  return deriveThreadHostGuardApprovals({ threadId, pending, resolve });
}

export function useChildThreadHostGuardApprovals(
  environmentId: EnvironmentId | null,
  parentThreadId: ThreadId | null,
): ReadonlyArray<ChildThreadHostGuardApproval> {
  const pendingChildren = useAtomValue(
    environmentId && parentThreadId
      ? childHostGuardPendingAtom(threadKey({ environmentId, threadId: parentThreadId }))
      : EMPTY_CHILD_PENDING_ATOM,
  );
  const resolve = useMessages();
  if (pendingChildren.length === 0) {
    return EMPTY_CHILD_HOST_GUARD_APPROVALS;
  }
  return pendingChildren.map((item) => ({
    childThreadId: item.childThreadId,
    childTitle: item.childTitle,
    entry: buildHostGuardApproval(item.request, resolve),
  }));
}

export function useThreadHasHostGuardApproval(input: {
  readonly environmentId: EnvironmentId | null;
  readonly threadId: ThreadId | null;
  readonly enabled?: boolean;
}): boolean {
  const active = input.enabled !== false && input.environmentId !== null && input.threadId !== null;
  return useAtomValue(
    active && input.environmentId && input.threadId
      ? threadHasHostGuardApprovalAtom(
          threadKey({ environmentId: input.environmentId, threadId: input.threadId }),
        )
      : FALSE_ATOM,
  );
}
