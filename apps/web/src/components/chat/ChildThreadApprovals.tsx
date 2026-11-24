import { useAtomValue } from "@effect/atom-react";
import {
  AuthAccessWriteScope,
  AuthOrchestrationOperateScope,
  AuthTerminalOperateScope,
  type EnvironmentId,
  type HostGuardResolveInput,
  type HostGuardResolveResult,
  type ProviderApprovalDecision,
  type RuntimeRequestId,
  type ScopedThreadRef,
  type ShipQueueActionResult,
  type ShipQueueDecideDepsInput,
  type ShipQueueScanDepsInput,
} from "@t3tools/contracts";
import type {
  ChildThreadApproval,
  ThreadPendingApproval,
} from "@t3tools/client-runtime/state/thread-requests";
import { fullAccessOverrideExplanation } from "@t3tools/client-runtime/state/thread-requests";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import { T, useGT, useMessages, Var } from "gt-react";
import { useRef, useState } from "react";

import type { ChildThreadHostGuardApproval } from "../../lib/hostGuardApprovals";
import type { ChildThreadShipQueueDepApproval } from "../../lib/shipQueueApprovals";
import { useEnvironmentScope } from "../../state/session";
import { childThreadApprovalsAtom, threadEnvironment } from "../../state/threads";
import { useAtomCommand } from "../../state/use-atom-command";
import { ComposerPendingApprovalActions } from "./ComposerPendingApprovalActions";

export type ChildHostGuardResolveFn = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: HostGuardResolveInput;
}) => Promise<AtomCommandResult<HostGuardResolveResult, unknown> | undefined>;

export type ChildShipQueueDecideDepsFn = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: ShipQueueDecideDepsInput;
}) => Promise<AtomCommandResult<ShipQueueActionResult, unknown> | undefined>;

export type ChildShipQueueScanDepsFn = (target: {
  readonly environmentId: EnvironmentId;
  readonly input: ShipQueueScanDepsInput;
}) => Promise<AtomCommandResult<ShipQueueActionResult, unknown> | undefined>;

const EMPTY_CHILD_HOST_GUARD_APPROVALS: ReadonlyArray<ChildThreadHostGuardApproval> = [];
const EMPTY_CHILD_SHIP_QUEUE_DEP_APPROVALS: ReadonlyArray<ChildThreadShipQueueDepApproval> = [];

function ChildApprovalCard({
  title,
  approval,
  canRespond,
  responding,
  error,
  onRespond,
}: {
  readonly title: string;
  readonly approval: ThreadPendingApproval;
  readonly canRespond: boolean;
  readonly responding: boolean;
  readonly error: string | null;
  readonly onRespond: (
    requestId: RuntimeRequestId,
    decision: ProviderApprovalDecision,
  ) => Promise<unknown>;
}) {
  const gt = useGT();
  const messages = useMessages();
  return (
    <section
      aria-label={gt("Approval from {title}", { title })}
      className="rounded-lg border border-border bg-background p-3 text-xs"
    >
      <p className="mb-2 font-medium">
        <T>
          Approval needed from <Var>{title}</Var>
        </T>
      </p>
      <pre className="max-h-40 overflow-auto whitespace-pre-wrap break-words font-mono">
        {approval.detail || approval.requestKind}
      </pre>
      {approval.appName ? <p className="mt-2 text-muted-foreground">{approval.appName}</p> : null}
      {approval.responseCapability !== "live" ? (
        <p className="mt-2 text-warning">
          <T>Provider process is gone. Interrupt or restart the child thread to respond.</T>
        </p>
      ) : null}
      {approval.reason ? <p className="mt-2 text-muted-foreground">{approval.reason}</p> : null}
      {approval.fullAccessOverride ? (
        <p className="mt-2 text-muted-foreground">
          {fullAccessOverrideExplanation(approval.fullAccessOverride, messages)}
        </p>
      ) : null}
      <div className="mt-2 flex flex-wrap gap-2">
        <ComposerPendingApprovalActions
          presentation="inline"
          requestId={approval.requestId}
          isResponding={responding}
          canRespond={approval.responseCapability === "live"}
          disabled={!canRespond}
          options={approval.options}
          onRespondToApproval={onRespond}
        />
      </div>
      {error !== null ? (
        <p role="alert" className="mt-2 text-destructive">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function ChildApproval({ entry }: { readonly entry: ChildThreadApproval }) {
  const canRespond = useEnvironmentScope(entry.thread.environmentId, AuthOrchestrationOperateScope);
  const respond = useAtomCommand(threadEnvironment.respondToApproval, { reportFailure: false });
  const gt = useGT();
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  return (
    <ChildApprovalCard
      title={entry.title}
      approval={entry.approval}
      canRespond={canRespond}
      responding={responding}
      error={error}
      onRespond={async (requestId, decision) => {
        if (!canRespond || responding) return;
        setResponding(true);
        setError(null);
        const result = await respond({
          environmentId: entry.thread.environmentId,
          input: { threadId: entry.thread.threadId, requestId, decision },
        });
        if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error ? failure.message : gt("Failed to submit approval decision."),
          );
        }
        setResponding(false);
        return result;
      }}
    />
  );
}

function ChildHostGuardApproval({
  environmentId,
  item,
  onResolveHostGuard,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly item: ChildThreadHostGuardApproval;
  readonly onResolveHostGuard?: ChildHostGuardResolveFn | undefined;
}) {
  const hasAccessWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const hasTerminalOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canRespond =
    environmentId !== null &&
    onResolveHostGuard !== undefined &&
    hasAccessWrite &&
    hasTerminalOperate;
  const gt = useGT();
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  return (
    <ChildApprovalCard
      title={item.childTitle}
      approval={item.entry.approval}
      canRespond={canRespond && !responding}
      responding={responding}
      error={error}
      onRespond={async (_requestId, decision) => {
        if (
          !canRespond ||
          !environmentId ||
          !onResolveHostGuard ||
          responding ||
          inFlightRef.current
        )
          return;
        inFlightRef.current = true;
        setResponding(true);
        setError(null);
        const result = await onResolveHostGuard({
          environmentId,
          input: {
            requestId: item.entry.request.requestId,
            decision: decision === "accept" ? "approve" : "deny",
            ...(decision === "accept" && item.entry.request.proposedReason
              ? { reason: item.entry.request.proposedReason }
              : {}),
          },
        });
        inFlightRef.current = false;
        setResponding(false);
        if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : gt("Failed to resolve host guard request."),
          );
        } else if (result?._tag === "Success" && !result.value.resolved) {
          setError(gt("Host guard request expired or was already resolved."));
        }
        return result;
      }}
    />
  );
}

function ChildShipQueueDepApprovalCard({
  environmentId,
  item,
  onDecideShipQueueDeps,
  onScanShipQueueDeps,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly item: ChildThreadShipQueueDepApproval;
  readonly onDecideShipQueueDeps?: ChildShipQueueDecideDepsFn | undefined;
  readonly onScanShipQueueDeps?: ChildShipQueueScanDepsFn | undefined;
}) {
  const hasAccessWrite = useEnvironmentScope(environmentId, AuthAccessWriteScope);
  const hasTerminalOperate = useEnvironmentScope(environmentId, AuthTerminalOperateScope);
  const canRespond =
    environmentId !== null &&
    hasAccessWrite &&
    hasTerminalOperate &&
    (onDecideShipQueueDeps !== undefined || onScanShipQueueDeps !== undefined);
  const gt = useGT();
  const [responding, setResponding] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const inFlightRef = useRef(false);
  const isBusy = responding || item.entry.busy;
  return (
    <ChildApprovalCard
      title={item.childTitle}
      approval={item.entry.approval}
      canRespond={canRespond && !isBusy}
      responding={isBusy}
      error={error}
      onRespond={async (_requestId, decision) => {
        if (!canRespond || !environmentId || isBusy || inFlightRef.current) return;
        const entry = item.entry;
        const runScan = decision === "cancel" || (decision === "accept" && !entry.canApprove);
        if (runScan) {
          if (!onScanShipQueueDeps) return;
          inFlightRef.current = true;
          setResponding(true);
          setError(null);
          const result = await onScanShipQueueDeps({
            environmentId,
            input: { repo: entry.hold.repo },
          });
          inFlightRef.current = false;
          setResponding(false);
          if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
            const failure = squashAtomCommandFailure(result);
            setError(
              failure instanceof Error ? failure.message : gt("Failed to start dependency scan."),
            );
          } else if (result?._tag === "Success" && !result.value.ok) {
            setError(result.value.error ?? gt("Failed to start dependency scan."));
          }
          return result;
        }
        if (
          !onDecideShipQueueDeps ||
          !entry.hold.reportId ||
          (decision === "accept" && !entry.canApprove) ||
          (decision === "decline" && !entry.canReject)
        ) {
          return;
        }
        inFlightRef.current = true;
        setResponding(true);
        setError(null);
        const result = await onDecideShipQueueDeps({
          environmentId,
          input: {
            reportId: entry.hold.reportId,
            decision: decision === "accept" ? "approve" : "reject",
          },
        });
        inFlightRef.current = false;
        setResponding(false);
        if (result?._tag === "Failure" && !isAtomCommandInterrupted(result)) {
          const failure = squashAtomCommandFailure(result);
          setError(
            failure instanceof Error
              ? failure.message
              : gt("Failed to submit dependency decision."),
          );
        } else if (result?._tag === "Success" && !result.value.ok) {
          setError(result.value.error ?? gt("Failed to submit dependency decision."));
        }
        return result;
      }}
    />
  );
}

export function ChildThreadApprovals({
  threadRef,
  hostGuardApprovals = EMPTY_CHILD_HOST_GUARD_APPROVALS,
  shipQueueDepApprovals = EMPTY_CHILD_SHIP_QUEUE_DEP_APPROVALS,
  onResolveHostGuard,
  onDecideShipQueueDeps,
  onScanShipQueueDeps,
}: {
  readonly threadRef: ScopedThreadRef | null;
  readonly hostGuardApprovals?: ReadonlyArray<ChildThreadHostGuardApproval> | undefined;
  readonly shipQueueDepApprovals?: ReadonlyArray<ChildThreadShipQueueDepApproval> | undefined;
  readonly onResolveHostGuard?: ChildHostGuardResolveFn | undefined;
  readonly onDecideShipQueueDeps?: ChildShipQueueDecideDepsFn | undefined;
  readonly onScanShipQueueDeps?: ChildShipQueueScanDepsFn | undefined;
}) {
  const approvals = useAtomValue(childThreadApprovalsAtom(threadRef));
  if (
    approvals.length === 0 &&
    hostGuardApprovals.length === 0 &&
    shipQueueDepApprovals.length === 0
  ) {
    return null;
  }
  return (
    <div className="mb-2 flex max-h-80 flex-col gap-2 overflow-auto">
      {approvals.map((entry) => (
        <ChildApproval
          key={JSON.stringify([
            entry.thread.environmentId,
            entry.thread.threadId,
            entry.approval.requestId,
          ])}
          entry={entry}
        />
      ))}
      {hostGuardApprovals.map((item) => (
        <ChildHostGuardApproval
          key={JSON.stringify([
            threadRef?.environmentId ?? null,
            item.childThreadId,
            item.entry.requestId,
          ])}
          environmentId={threadRef?.environmentId ?? null}
          item={item}
          onResolveHostGuard={onResolveHostGuard}
        />
      ))}
      {shipQueueDepApprovals.map((item) => (
        <ChildShipQueueDepApprovalCard
          key={JSON.stringify([
            threadRef?.environmentId ?? null,
            item.childThreadId,
            item.entry.requestId,
          ])}
          environmentId={threadRef?.environmentId ?? null}
          item={item}
          onDecideShipQueueDeps={onDecideShipQueueDeps}
          onScanShipQueueDeps={onScanShipQueueDeps}
        />
      ))}
    </div>
  );
}
