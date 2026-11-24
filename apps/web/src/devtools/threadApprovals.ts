/**
 * Unified thread-native DevTools approval subroutine.
 * Translates thread-attributed Host Guard overrides and blocking Ship Queue dependency holds
 * into native T3 `ThreadPendingApproval` items and resolves them through one responder.
 */
import type { ThreadPendingApproval } from "@t3tools/client-runtime/state/thread-requests";
import {
  RuntimeRequestId,
  type EnvironmentId,
  type ProviderApprovalDecision,
  type ProviderApprovalOption,
  type ThreadId,
} from "@t3tools/contracts";
import { msg } from "gt-react";

import { m } from "~/i18n/messages";
import {
  fetchDevtoolsJson,
  type PendingGuardRequest,
  type ShipQueueDepRepoSummary,
  type ShipQueueJob,
} from "./devtoolsClient";
import {
  depScanKey,
  markRepoDepsDeciding,
  markRepoDepsScanning,
  refreshSharedShipQueueDeps,
} from "./devtoolsDepsStore";
import { removePendingGuard } from "./devtoolsStore";
import { refreshSharedJobs } from "./jobs/jobsStore";
import { isShipQueueJobLive } from "./ShipQueueSteps";

const DEVTOOLS_GUARD_REQUEST_PREFIX = "devtools:guard:";
const DEVTOOLS_DEP_REQUEST_PREFIX = "devtools:dep:";

// Matches server `CliRunners.ts:20` and `ship-queue/sq_deps_store.py:16` (`ACTIVE`) verbatim (H2).
const ACTIVE_DEP_ATTEMPT_STATES = new Set([
  "preparing",
  "ready",
  "failed",
  "merging",
  "cancelling",
]);
const UNSAFE_SHELL_RE = /[^A-Za-z0-9_./:@=+-]/;
// Strips C0/C1 controls, soft hyphen, Mongolian vowel sep, bidi marks/isolates/overrides,
// invisible formatters (U+200B..U+200F, U+2060..U+2069, U+FEFF), and Unicode Tag chars (U+E0000..U+E007F).
const CONTROL_AND_BIDI_RE =
  /[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u180e\u200b-\u200f\u2028-\u202e\u2060-\u2069\ufeff\u{e0000}-\u{e007f}]/gu;

export function isDevtoolsApprovalRequestId(requestId: string): boolean {
  return (
    requestId.startsWith(DEVTOOLS_GUARD_REQUEST_PREFIX) ||
    requestId.startsWith(DEVTOOLS_DEP_REQUEST_PREFIX)
  );
}

/**
 * Formats the full sanitized command argv without truncation — the approval grant applies to the
 * entire argv and the UI renders it inside a scrollable `<code/pre>` container.
 */
export function formatSafeCommandArgv(argv: ReadonlyArray<string>): string {
  return argv
    .map((raw) => {
      const clean = raw.replace(CONTROL_AND_BIDI_RE, "?");
      if (clean === "") return "''";
      if (!UNSAFE_SHELL_RE.test(clean)) return clean;
      return `'${clean.replace(/'/g, "'\\''")}'`;
    })
    .join(" ");
}

export function sanitizeApprovalDisplayText(raw: string | null | undefined, maxLen = 280): string {
  if (!raw) return "";
  const cleaned = raw.replace(CONTROL_AND_BIDI_RE, " ").replace(/\s+/g, " ").trim();
  return cleaned.length > maxLen ? `${cleaned.slice(0, maxLen - 1)}…` : cleaned;
}

function shipJobMatchesDepRepo(job: ShipQueueJob, depRepo: string): boolean {
  const target = depRepo.trim().toLowerCase();
  if (!target) return false;
  const jobRepo = (job.repo ?? "").trim().toLowerCase();
  if (!jobRepo) return false;
  return jobRepo === target || jobRepo.endsWith(`/${target}`);
}

export function isDepHoldActionable(hold: ShipQueueDepRepoSummary): boolean {
  if (hold.holding !== true) return false;
  if (hold.attemptStatus && ACTIVE_DEP_ATTEMPT_STATES.has(hold.attemptStatus)) return false;
  return true;
}

export function findActionableDepHoldForJob(
  job: ShipQueueJob,
  depsRepos: ReadonlyArray<ShipQueueDepRepoSummary>,
): ShipQueueDepRepoSummary | null {
  if (!isShipQueueJobLive(job)) return null;
  for (const hold of depsRepos) {
    if (!isDepHoldActionable(hold)) continue;
    if (shipJobMatchesDepRepo(job, hold.repo)) return hold;
  }
  return null;
}

export type ThreadDevtoolsApproval =
  | {
      readonly kind: "guard";
      readonly requestId: RuntimeRequestId;
      readonly approval: ThreadPendingApproval;
      readonly guard: PendingGuardRequest;
      readonly scanning: false;
      readonly deciding: false;
      readonly busy: false;
    }
  | {
      readonly kind: "dep";
      readonly requestId: RuntimeRequestId;
      readonly approval: ThreadPendingApproval;
      readonly hold: ShipQueueDepRepoSummary;
      readonly canApprove: boolean;
      readonly canReject: boolean;
      readonly scanning: boolean;
      readonly deciding: boolean;
      readonly busy: boolean;
    };

export interface ChildThreadDevtoolsApproval {
  readonly childThreadId: ThreadId;
  readonly childTitle: string;
  readonly entry: ThreadDevtoolsApproval;
}

export const EMPTY_DEVTOOLS_APPROVALS: ReadonlyArray<ThreadDevtoolsApproval> = [];

function buildGuardApproval(req: PendingGuardRequest): ThreadDevtoolsApproval {
  const requestId = RuntimeRequestId.make(`${DEVTOOLS_GUARD_REQUEST_PREFIX}${req.requestId}`);
  const detail = formatSafeCommandArgv(req.command);
  const guardName = sanitizeApprovalDisplayText(req.guard, 80) || "host-guard";
  const cwd = sanitizeApprovalDisplayText(req.cwd, 120);
  const appName = cwd
    ? m(msg("Host guard ({guard}) · {cwd}"), { guard: guardName, cwd })
    : m(msg("Host guard ({guard})"), { guard: guardName });
  const reason = sanitizeApprovalDisplayText(req.proposedReason || req.refusal, 240);
  const options: ReadonlyArray<ProviderApprovalOption> = [
    { decision: "decline", label: m(msg("Deny")) },
    { decision: "accept", label: m(msg("Approve once")) },
  ];
  return {
    kind: "guard",
    requestId,
    guard: req,
    scanning: false,
    deciding: false,
    busy: false,
    approval: {
      requestId,
      requestKind: "command",
      createdAt: req.createdAt,
      detail,
      appName,
      ...(reason ? { reason } : {}),
      options,
      responseCapability: "live",
      supportsFeedback: false,
    },
  };
}

function summarizeDepUpdates(hold: ShipQueueDepRepoSummary): string {
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
  return m(msg("{count} updates blocking ship: {preview}"), {
    count: hold.updates.length,
    preview: `${preview}${extra}`,
  });
}

function buildDepHoldApproval(
  hold: ShipQueueDepRepoSummary,
  scanningRepos: Readonly<Record<string, string | null>>,
  decidingRepos: Readonly<Record<string, string | null>>,
  nowMs: number,
): ThreadDevtoolsApproval {
  const requestId = RuntimeRequestId.make(
    `${DEVTOOLS_DEP_REQUEST_PREFIX}${hold.repo}:${hold.reportId ?? "missing"}`,
  );
  const isFresh = hold.scannedAt !== null && nowMs / 1000 - hold.scannedAt < 86_400;
  const canReject = Boolean(hold.reportId) && isFresh;
  const canApprove = canReject && hold.status === "pending" && hold.updates.length > 0;
  const reportKey = depScanKey(hold);
  const scanning = scanningRepos[hold.repo] === reportKey;
  const deciding = decidingRepos[hold.repo] === reportKey;
  const repoLabel = sanitizeApprovalDisplayText(hold.repo, 80);
  const reportLabel = sanitizeApprovalDisplayText(hold.reportId, 120);

  const detail = reportLabel
    ? m(msg("Dependency hold · {reportId}"), { reportId: reportLabel })
    : m(msg("Dependency hold · {repo}"), { repo: repoLabel });
  const appName = scanning
    ? m(msg("Ship Queue · {repo} (scanning…)"), { repo: repoLabel })
    : deciding
      ? m(msg("Ship Queue · {repo} (updating…)"), { repo: repoLabel })
      : m(msg("Ship Queue · {repo}"), { repo: repoLabel });

  let reason: string;
  if (canApprove) {
    reason = summarizeDepUpdates(hold);
  } else if (hold.error) {
    reason = sanitizeApprovalDisplayText(hold.error, 260);
  } else if (!isFresh && hold.scannedAt !== null) {
    reason = m(msg("Dependency report is older than 24h; rescan before deciding."));
  } else {
    reason = m(msg("Dependency report is incomplete or unknown; rescan before approving."));
  }

  const options: ProviderApprovalOption[] = [];
  if (canReject) {
    options.push({ decision: "decline", label: m(msg("Reject (24h)")) });
  }
  if (canApprove) {
    options.push({ decision: "accept", label: m(msg("Approve")) });
    options.push({ decision: "cancel", label: m(msg("Rescan")) });
  } else {
    options.push({ decision: "accept", label: scanning ? m(msg("Scanning…")) : m(msg("Rescan")) });
  }

  return {
    kind: "dep",
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

/**
 * Derives DevTools approvals strictly attributed to `threadId` (no worktree/branch heuristics, M5).
 * Orphan requests started outside T3 Code (`threadId === ""` or missing `job.thread_id`) are excluded.
 */
export function deriveThreadDevtoolsApprovals(input: {
  readonly threadId: string;
  readonly pendingGuards: ReadonlyArray<PendingGuardRequest>;
  readonly shipJobs: ReadonlyArray<ShipQueueJob>;
  readonly depsRepos: ReadonlyArray<ShipQueueDepRepoSummary>;
  readonly scanningRepos?: Readonly<Record<string, string | null>> | undefined;
  readonly decidingRepos?: Readonly<Record<string, string | null>> | undefined;
  readonly nowMs?: number | undefined;
}): ReadonlyArray<ThreadDevtoolsApproval> {
  const { threadId } = input;
  if (!threadId) return EMPTY_DEVTOOLS_APPROVALS;
  const nowMs = input.nowMs ?? Date.now();
  const results: ThreadDevtoolsApproval[] = [];

  for (const req of input.pendingGuards) {
    if (!req.threadId || req.threadId !== threadId) continue;
    const expMs = Date.parse(req.expiresAt);
    if (Number.isFinite(expMs) && expMs <= nowMs) continue;
    results.push(buildGuardApproval(req));
  }

  if (input.depsRepos.length > 0 && input.shipJobs.length > 0) {
    const matchedLiveJobs = input.shipJobs.filter(
      (job) => job.thread_id === threadId && isShipQueueJobLive(job),
    );
    if (matchedLiveJobs.length > 0) {
      const seenRepos = new Set<string>();
      const scanningRepos = input.scanningRepos ?? {};
      const decidingRepos = input.decidingRepos ?? {};
      for (const hold of input.depsRepos) {
        if (!isDepHoldActionable(hold) || seenRepos.has(hold.repo)) continue;
        if (!matchedLiveJobs.some((job) => shipJobMatchesDepRepo(job, hold.repo))) continue;
        seenRepos.add(hold.repo);
        results.push(buildDepHoldApproval(hold, scanningRepos, decidingRepos, nowMs));
      }
    }
  }

  return results.length === 0 ? EMPTY_DEVTOOLS_APPROVALS : results;
}

export async function respondToDevtoolsApproval(
  environmentId: EnvironmentId,
  entry: ThreadDevtoolsApproval,
  decision: ProviderApprovalDecision,
): Promise<{ readonly ok: true } | { readonly ok: false; readonly error: string }> {
  if (entry.kind === "guard") {
    const apiDecision = decision === "accept" ? "approve" : "deny";
    const res = await fetchDevtoolsJson<{ readonly ok?: boolean; readonly error?: string }>(
      environmentId,
      `/guards/requests/${encodeURIComponent(entry.guard.requestId)}/resolve`,
      {
        method: "POST",
        body: {
          decision: apiDecision,
          ...(apiDecision === "approve"
            ? { reason: entry.guard.proposedReason || "Approved via T3 thread approval" }
            : {}),
        },
      },
    );
    if (!res.ok || res.data?.ok === false) {
      if (res.status === 404) {
        removePendingGuard(environmentId, entry.guard.requestId);
        return {
          ok: false,
          error: m(msg("Host guard request expired or was already resolved.")),
        };
      }
      return {
        ok: false,
        error:
          sanitizeApprovalDisplayText(res.data?.error ?? res.error, 240) ||
          m(msg("Failed to resolve host guard request.")),
      };
    }
    removePendingGuard(environmentId, entry.guard.requestId);
    return { ok: true };
  }

  const { hold, canApprove, canReject } = entry;
  const shouldScan = decision === "cancel" || (decision === "accept" && !canApprove);
  if (shouldScan) {
    const res = await fetchDevtoolsJson<{ readonly ok?: boolean; readonly error?: string }>(
      environmentId,
      "/ship-queue/deps/scan",
      {
        method: "POST",
        body: { repo: hold.repo },
      },
    );
    if (!res.ok || res.data?.ok === false) {
      return {
        ok: false,
        error:
          sanitizeApprovalDisplayText(res.data?.error ?? res.error, 240) ||
          m(msg("Failed to start dependency scan.")),
      };
    }
    markRepoDepsScanning(environmentId, hold.repo, depScanKey(hold));
    void refreshSharedJobs(environmentId);
    return { ok: true };
  }

  const verb =
    decision === "accept" && canApprove
      ? "approve"
      : decision === "decline" && canReject
        ? "reject"
        : null;
  if (!verb || !hold.reportId) {
    return {
      ok: false,
      error: m(msg("This dependency hold cannot take that action right now. Try Rescan.")),
    };
  }

  const res = await fetchDevtoolsJson<{ readonly ok?: boolean; readonly error?: string }>(
    environmentId,
    "/ship-queue/deps/decide",
    {
      method: "POST",
      body: { repo: hold.repo, reportId: hold.reportId, decision: verb },
    },
  );
  if (!res.ok || res.data?.ok === false) {
    return {
      ok: false,
      error:
        sanitizeApprovalDisplayText(res.data?.error ?? res.error, 240) ||
        m(msg("Failed to submit dependency decision.")),
    };
  }
  markRepoDepsDeciding(environmentId, hold.repo, depScanKey(hold));
  refreshSharedShipQueueDeps(environmentId);
  void refreshSharedJobs(environmentId);
  return { ok: true };
}
