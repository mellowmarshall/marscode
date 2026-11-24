import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  RuntimeRequestId,
  type ProviderApprovalOption,
  type ShipQueueDepRepo,
  type ShipQueueJob,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m, type MessageResolver } from "~/i18n/messages";
import { sanitizeApprovalDisplayText } from "./hostGuardApprovals";
import { isShipQueueJobLive } from "./shipQueueSteps";

const SHIP_QUEUE_DEP_REQUEST_PREFIX = "ship-queue:dep:";
const ACTIVE_DEP_ATTEMPT_STATES = new Set([
  "preparing",
  "ready",
  "failed",
  "merging",
  "cancelling",
]);

export interface ThreadShipQueueDepApproval {
  readonly requestId: RuntimeRequestId;
  readonly hold: ShipQueueDepRepo;
  readonly approval: ThreadPendingApproval;
  readonly canApprove: boolean;
  readonly canReject: boolean;
  readonly scanning: boolean;
  readonly deciding: boolean;
  readonly busy: boolean;
}

export interface ChildThreadShipQueueDepApproval {
  readonly childThreadId: ThreadId;
  readonly childTitle: string;
  readonly entry: ThreadShipQueueDepApproval;
}

export const EMPTY_SHIP_QUEUE_DEP_APPROVALS: ReadonlyArray<ThreadShipQueueDepApproval> = [];

export function isShipQueueDepApprovalRequestId(requestId: string): boolean {
  return requestId.startsWith(SHIP_QUEUE_DEP_REQUEST_PREFIX);
}

export function depHoldReportKey(hold: Pick<ShipQueueDepRepo, "reportId" | "scannedAt">): string {
  return `${hold.reportId ?? "missing"}:${hold.scannedAt ?? "none"}`;
}

function shipJobMatchesDepRepo(job: ShipQueueJob, depRepo: string): boolean {
  const target = depRepo.trim().toLowerCase();
  if (!target) return false;
  const jobRepo = (job.repo ?? "").trim().toLowerCase();
  if (!jobRepo) return false;
  return jobRepo === target || jobRepo.endsWith(`/${target}`);
}

export function isDepHoldActionable(hold: ShipQueueDepRepo): boolean {
  if (!hold.holding) return false;
  if (hold.attemptStatus && ACTIVE_DEP_ATTEMPT_STATES.has(hold.attemptStatus)) return false;
  return true;
}

export function findActionableDepHoldForJob(
  job: ShipQueueJob,
  deps: ReadonlyArray<ShipQueueDepRepo>,
): ShipQueueDepRepo | null {
  if (!isShipQueueJobLive(job)) return null;
  for (const hold of deps) {
    if (!isDepHoldActionable(hold)) continue;
    if (shipJobMatchesDepRepo(job, hold.repo)) return hold;
  }
  return null;
}

function summarizeDepUpdates(hold: ShipQueueDepRepo, resolve: MessageResolver): string {
  const preview = hold.updates
    .slice(0, 3)
    .map((u) => {
      const name = sanitizeApprovalDisplayText(u.depName, 64);
      const cur = sanitizeApprovalDisplayText(u.currentValue, 32);
      const next = sanitizeApprovalDisplayText(u.newValue, 32);
      return `${name} ${cur}→${next}`;
    })
    .join(", ");
  const extra = hold.updates.length > 3 ? ` +${hold.updates.length - 3}` : "";
  return resolve(
    msg("{count} updates blocking ship: {preview}", {
      count: hold.updates.length,
      preview: `${preview}${extra}`,
    }),
  );
}

export function buildShipQueueDepApproval(input: {
  readonly hold: ShipQueueDepRepo;
  readonly scanningRepos?: Readonly<Record<string, string | null>> | undefined;
  readonly decidingRepos?: Readonly<Record<string, string | null>> | undefined;
  readonly nowMs?: number | undefined;
  readonly resolve?: MessageResolver | undefined;
}): ThreadShipQueueDepApproval {
  const { hold } = input;
  const nowMs = input.nowMs ?? Date.now();
  const resolve = input.resolve ?? m;
  const requestId = RuntimeRequestId.make(
    `${SHIP_QUEUE_DEP_REQUEST_PREFIX}${hold.repo}:${hold.reportId ?? "missing"}`,
  );
  const isFresh = hold.scannedAt !== null && nowMs / 1000 - hold.scannedAt < 86_400;
  const canReject = Boolean(hold.reportId) && isFresh;
  const canApprove = canReject && hold.status === "pending" && hold.updates.length > 0;
  const reportKey = depHoldReportKey(hold);
  const scanning = input.scanningRepos?.[hold.repo] === reportKey;
  const deciding = input.decidingRepos?.[hold.repo] === reportKey;
  const repoLabel = sanitizeApprovalDisplayText(hold.repo, 80);
  const reportLabel = sanitizeApprovalDisplayText(hold.reportId, 120);

  const detail = reportLabel
    ? resolve(msg("Dependency hold · {reportId}", { reportId: reportLabel }))
    : resolve(msg("Dependency hold · {repo}", { repo: repoLabel }));
  const appName = scanning
    ? resolve(msg("Ship Queue · {repo} (scanning…)", { repo: repoLabel }))
    : deciding
      ? resolve(msg("Ship Queue · {repo} (updating…)", { repo: repoLabel }))
      : resolve(msg("Ship Queue · {repo}", { repo: repoLabel }));

  let reason: string;
  if (canApprove) {
    reason = summarizeDepUpdates(hold, resolve);
  } else if (hold.error) {
    reason = sanitizeApprovalDisplayText(hold.error, 260);
  } else if (!isFresh && hold.scannedAt !== null) {
    reason = resolve(msg("Dependency report is older than 24h; rescan before deciding."));
  } else {
    reason = resolve(msg("Dependency report is incomplete or unknown; rescan before approving."));
  }

  const options: ProviderApprovalOption[] = [];
  if (canReject) {
    options.push({ decision: "decline", label: resolve(msg("Reject (24h)")) });
  }
  if (canApprove) {
    options.push({ decision: "accept", label: resolve(msg("Approve")) });
    options.push({ decision: "cancel", label: resolve(msg("Rescan")) });
  } else {
    options.push({
      decision: "accept",
      label: scanning ? resolve(msg("Scanning…")) : resolve(msg("Rescan")),
    });
  }

  return {
    requestId,
    hold,
    canApprove,
    canReject,
    scanning,
    deciding,
    busy: scanning || deciding,
    approval: {
      requestId,
      requestKind: "permission",
      createdAt:
        hold.scannedAt !== null
          ? new Date(hold.scannedAt * 1000).toISOString()
          : new Date(0).toISOString(),
      detail,
      appName,
      reason,
      options,
      responseCapability: "live",
      supportsFeedback: false,
    },
  };
}

export function deriveThreadShipQueueDepApprovals(input: {
  readonly jobs: ReadonlyArray<ShipQueueJob>;
  readonly deps: ReadonlyArray<ShipQueueDepRepo>;
  readonly scanningRepos?: Readonly<Record<string, string | null>> | undefined;
  readonly decidingRepos?: Readonly<Record<string, string | null>> | undefined;
  readonly nowMs?: number | undefined;
  readonly resolve?: MessageResolver | undefined;
}): ReadonlyArray<ThreadShipQueueDepApproval> {
  if (input.jobs.length === 0 || input.deps.length === 0) {
    return EMPTY_SHIP_QUEUE_DEP_APPROVALS;
  }
  const seenRepos = new Set<string>();
  const out: ThreadShipQueueDepApproval[] = [];
  for (const job of input.jobs) {
    const hold = findActionableDepHoldForJob(job, input.deps);
    if (!hold || seenRepos.has(hold.repo)) continue;
    seenRepos.add(hold.repo);
    out.push(
      buildShipQueueDepApproval({
        hold,
        scanningRepos: input.scanningRepos,
        decidingRepos: input.decidingRepos,
        nowMs: input.nowMs,
        resolve: input.resolve,
      }),
    );
  }
  return out.length === 0 ? EMPTY_SHIP_QUEUE_DEP_APPROVALS : out;
}
