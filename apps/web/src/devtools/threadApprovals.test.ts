import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import type { PendingGuardRequest, ShipQueueDepRepoSummary, ShipQueueJob } from "./devtoolsClient";
import * as devtoolsClient from "./devtoolsClient";
import {
  _resetDepsStoreForTests,
  depScanKey,
  markRepoDepsDeciding,
  markRepoDepsScanning,
} from "./devtoolsDepsStore";
import * as devtoolsStore from "./devtoolsStore";
import { applyGuardBrokerEvent, clearPendingGuardsForEnv } from "./devtoolsStore";
import {
  deriveThreadDevtoolsApprovals,
  formatSafeCommandArgv,
  isDevtoolsApprovalRequestId,
  respondToDevtoolsApproval,
  sanitizeApprovalDisplayText,
} from "./threadApprovals";
import { collectDescendantSubagentIds } from "./useThreadDevtoolsApprovals";

const envId = EnvironmentId.make("env-local");
const nowMs = Date.parse("2026-11-22T18:00:00Z");
const freshScannedAt = Math.floor(nowMs / 1000) - 300;
const staleScannedAt = Math.floor(nowMs / 1000) - 90_000;

function makeGuard(overrides: Partial<PendingGuardRequest> = {}): PendingGuardRequest {
  return {
    requestId: "req-1",
    guard: "ship-queue",
    command: ["git", "push", "--force"],
    argvSha256: "a".repeat(64),
    cwd: "/dataprivate-repo/wt-1",
    session: "sess-1",
    pid: 1234,
    threadId: "thread-A",
    proposedReason: "Rebase approved by owner",
    refusal: "force push blocked",
    createdAt: "2026-11-22T17:59:00Z",
    expiresAt: "2026-11-22T18:10:00Z",
    ...overrides,
  };
}

function makeHold(overrides: Partial<ShipQueueDepRepoSummary> = {}): ShipQueueDepRepoSummary {
  return {
    repo: "devtools",
    reportId: "devtools:abc123",
    status: "pending",
    scannedAt: freshScannedAt,
    active: true,
    holding: true,
    pendingCount: 2,
    waitingCount: 0,
    heldCount: 0,
    failedCount: 0,
    attemptId: null,
    attemptStatus: null,
    decisionKind: null,
    decisionUntil: null,
    error: null,
    updates: [
      {
        depName: "vitest",
        packageFile: "package.json",
        currentValue: "4.0.0",
        newValue: "5.0.5",
        releaseTimestamp: null,
      },
    ],
    ...overrides,
  };
}

describe("threadApprovals unified approval subroutine", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    clearPendingGuardsForEnv(envId);
    _resetDepsStoreForTests();
  });

  it("attributes host-guard requests strictly to their originating thread and ignores orphan CLI runs", () => {
    const orphanGuard = makeGuard({ requestId: "req-orphan", threadId: "" });
    const otherThreadGuard = makeGuard({ requestId: "req-other", threadId: "thread-B" });
    const expiredGuard = makeGuard({
      requestId: "req-expired",
      threadId: "thread-A",
      expiresAt: "2026-11-22T17:55:00Z",
    });
    const ownedGuard = makeGuard({ requestId: "req-owned", threadId: "thread-A" });

    const derived = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [orphanGuard, otherThreadGuard, expiredGuard, ownedGuard],
      shipJobs: [],
      depsRepos: [],
      nowMs,
    });

    expect(derived).toHaveLength(1);
    const entry = derived[0]!;
    expect(entry.kind).toBe("guard");
    expect(isDevtoolsApprovalRequestId(entry.requestId)).toBe(true);
    expect(entry.approval.requestKind).toBe("command");
    expect(entry.approval.options?.map((o) => o.decision)).toEqual(["decline", "accept"]);
    expect(entry.approval.options?.map((o) => o.label)).toEqual(["Deny", "Approve once"]);
    expect(entry.approval.detail).toBe("git push --force");
  });

  it("enforces strict thread_id attribution (no branch/worktree heuristic leak for outside CLI runs, M5) and exact server active attempt states (H2)", () => {
    const liveShipOnA: ShipQueueJob = {
      id: "10984",
      repo: "private-repo",
      branch: "feat/x",
      worktree: "/dataprivate-repo/wt-1",
      thread_id: "thread-A",
      state: "parked",
    };
    // Outside-T3 CLI ship job sharing branch/worktree with thread-A MUST NOT leak into thread-A (M5)!
    const outsideCliShip: ShipQueueJob = {
      id: "10999",
      repo: "private-repo",
      branch: "feat/x",
      worktree: "/dataprivate-repo/wt-1",
      state: "parked",
    };
    const doneShipOnA: ShipQueueJob = { ...liveShipOnA, id: "10980", state: "done" };

    // Outside CLI ship job alone -> zero approvals
    expect(
      deriveThreadDevtoolsApprovals({
        threadId: "thread-A",
        pendingGuards: [],
        shipJobs: [outsideCliShip],
        depsRepos: [makeHold()],
        nowMs,
      }),
    ).toHaveLength(0);

    // Done ship job -> zero approvals
    expect(
      deriveThreadDevtoolsApprovals({
        threadId: "thread-A",
        pendingGuards: [],
        shipJobs: [doneShipOnA],
        depsRepos: [makeHold()],
        nowMs,
      }),
    ).toHaveLength(0);

    // ALL 5 server active attempt states (`preparing`, `ready`, `failed`, `merging`, `cancelling`) are non-actionable (H2)
    for (const attemptStatus of [
      "preparing",
      "ready",
      "failed",
      "merging",
      "cancelling",
    ] as const) {
      expect(
        deriveThreadDevtoolsApprovals({
          threadId: "thread-A",
          pendingGuards: [],
          shipJobs: [liveShipOnA],
          depsRepos: [makeHold({ attemptStatus })],
          nowMs,
        }),
      ).toHaveLength(0);
    }

    // Fresh pending hold -> Reject (24h) + Approve + Rescan
    const pending = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [],
      shipJobs: [liveShipOnA],
      depsRepos: [makeHold()],
      nowMs,
    });
    expect(pending).toHaveLength(1);
    expect(pending[0]!.kind).toBe("dep");
    if (pending[0]!.kind === "dep") {
      expect(pending[0]!.canApprove).toBe(true);
      expect(pending[0]!.canReject).toBe(true);
      expect(pending[0]!.approval.options?.map((o) => o.label)).toEqual([
        "Reject (24h)",
        "Approve",
        "Rescan",
      ]);
    }

    // Fresh unknown / scan-error hold -> Reject (24h) + Rescan (NEVER Approve!)
    const scanErr = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [],
      shipJobs: [liveShipOnA],
      depsRepos: [
        makeHold({
          status: "unknown",
          updates: [],
          error: "git ls-remote origin HEAD exited 128",
        }),
      ],
      nowMs,
    });
    expect(scanErr).toHaveLength(1);
    if (scanErr[0]!.kind === "dep") {
      expect(scanErr[0]!.canApprove).toBe(false);
      expect(scanErr[0]!.canReject).toBe(true);
      expect(scanErr[0]!.approval.options?.map((o) => o.label)).toEqual(["Reject (24h)", "Rescan"]);
    }

    // Stale (>24h) hold -> Rescan only
    const stale = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [],
      shipJobs: [liveShipOnA],
      depsRepos: [makeHold({ scannedAt: staleScannedAt })],
      nowMs,
    });
    expect(stale).toHaveLength(1);
    if (stale[0]!.kind === "dep") {
      expect(stale[0]!.canApprove).toBe(false);
      expect(stale[0]!.canReject).toBe(false);
      expect(stale[0]!.approval.options?.map((o) => o.label)).toEqual(["Rescan"]);
    }

    // Deciding hold stays locked (`busy: true`, L1) until payload key changes
    const hold = makeHold();
    const deciding = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [],
      shipJobs: [liveShipOnA],
      depsRepos: [hold],
      decidingRepos: { [hold.repo]: depScanKey(hold) },
      nowMs,
    });
    expect(deciding[0]!.busy).toBe(true);
  });

  it("strips bidi/control/tag spoofing characters, preserves full argv without truncation (M4), and rolls up descendant subagents (M6)", () => {
    const poisoned = makeHold({
      repo: "dev\u202etools",
      reportId: "devtools:abc\u200b123",
      updates: [
        {
          depName: "pkg\u202efake",
          packageFile: "package.json",
          currentValue: "1.0\u200f",
          newValue: "2.0\u061c",
          releaseTimestamp: null,
        },
      ],
    });
    const longPaddedCmd = ["bash", "-lc", `${"echo ok; ".repeat(80)}rm -rf /important`];
    const derived = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [makeGuard({ guard: "guard\u202ename", command: longPaddedCmd })],
      shipJobs: [{ id: "1", repo: poisoned.repo, thread_id: "thread-A", state: "running" }],
      depsRepos: [poisoned],
      nowMs,
    });
    expect(derived).toHaveLength(2);
    expect(derived[0]!.approval.appName).not.toMatch(/[\u202e\u200f\u061c\u200b]/);
    expect(derived[0]!.approval.detail).toContain("rm -rf /important");
    expect(derived[0]!.approval.detail!.length).toBeGreaterThan(600);
    expect(derived[1]!.approval.reason).not.toMatch(/[\u202e\u200f\u061c\u200b]/);
    expect(formatSafeCommandArgv(["a", `${"b".repeat(600)}TAIL`])).toContain("TAIL");
    expect(
      sanitizeApprovalDisplayText("bad\u00ad\u180e\u2060\u202e\u0085\ufeff\u{e0041}text"),
    ).toBe("bad text");

    // M6: recursive descendant subagent collection
    const rootId = ThreadId.make("t-root");
    const childId = ThreadId.make("t-child");
    const grandChildId = ThreadId.make("t-grandchild");
    const siblingForkId = ThreadId.make("t-fork");
    const ids = collectDescendantSubagentIds(
      [
        {
          id: childId,
          environmentId: envId,
          deletedAt: null,
          archivedAt: null,
          lineage: { parentThreadId: rootId, relationshipToParent: "subagent" },
        },
        {
          id: grandChildId,
          environmentId: envId,
          deletedAt: null,
          archivedAt: null,
          lineage: { parentThreadId: childId, relationshipToParent: "subagent" },
        },
        {
          id: siblingForkId,
          environmentId: envId,
          deletedAt: null,
          archivedAt: null,
          lineage: { parentThreadId: rootId, relationshipToParent: "fork" },
        },
      ],
      envId,
      rootId,
    );
    expect([...ids]).toEqual([childId, grandChildId]);
  });

  it("routes guard approvals, guard 404 expiry (L5), dep decide/rescan, and deciding lock (L1)", async () => {
    const fetchSpy = vi.spyOn(devtoolsClient, "fetchDevtoolsJson").mockResolvedValue({
      ok: true,
      status: 200,
      data: { ok: true },
    });
    const removeSpy = vi.spyOn(devtoolsStore, "removePendingGuard");

    const guard = makeGuard({ requestId: "req-42", threadId: "thread-A" });
    applyGuardBrokerEvent(envId, "Local", { type: "snapshot", pending: [guard] });
    const [guardEntry] = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [guard],
      shipJobs: [],
      depsRepos: [],
      nowMs,
    });
    const guardRes = await respondToDevtoolsApproval(envId, guardEntry!, "accept");
    expect(guardRes.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      envId,
      "/guards/requests/req-42/resolve",
      expect.objectContaining({ method: "POST" }),
    );
    expect(removeSpy).toHaveBeenCalledWith(envId, "req-42");

    // L5: 404 removes guard AND informs the user it expired
    removeSpy.mockClear();
    applyGuardBrokerEvent(envId, "Local", { type: "snapshot", pending: [guard] });
    fetchSpy.mockResolvedValueOnce({
      ok: false,
      status: 404,
      data: { ok: false, error: "not found" },
      error: "not found",
    });
    const expiredRes = await respondToDevtoolsApproval(envId, guardEntry!, "accept");
    expect(expiredRes.ok).toBe(false);
    if (!expiredRes.ok) {
      expect(expiredRes.error.toLowerCase()).toContain("expired");
    }
    expect(removeSpy).toHaveBeenCalledWith(envId, "req-42");

    // Dep reject on unknown hold posts decision="reject" and sets deciding lock
    const hold = makeHold({ status: "unknown", updates: [] });
    const [scanErrEntry] = deriveThreadDevtoolsApprovals({
      threadId: "thread-A",
      pendingGuards: [],
      shipJobs: [{ id: "10984", repo: "devtools", thread_id: "thread-A", state: "running" }],
      depsRepos: [hold],
      nowMs,
    });
    const rejectRes = await respondToDevtoolsApproval(envId, scanErrEntry!, "decline");
    expect(rejectRes.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      envId,
      "/ship-queue/deps/decide",
      expect.objectContaining({
        method: "POST",
        body: { repo: "devtools", reportId: "devtools:abc123", decision: "reject" },
      }),
    );

    // Dep rescan on non-approvable hold routes "accept" -> /ship-queue/deps/scan
    const scanRes = await respondToDevtoolsApproval(envId, scanErrEntry!, "accept");
    expect(scanRes.ok).toBe(true);
    expect(fetchSpy).toHaveBeenCalledWith(
      envId,
      "/ship-queue/deps/scan",
      expect.objectContaining({
        method: "POST",
        body: { repo: "devtools" },
      }),
    );

    // Scan key distinguishes error & scannedAt changes (L4)
    expect(depScanKey(makeHold({ scannedAt: null, error: "err A" }))).not.toBe(
      depScanKey(makeHold({ scannedAt: null, error: "err B" })),
    );
    markRepoDepsScanning(envId, "devtools", depScanKey(hold));
    markRepoDepsDeciding(envId, "devtools", depScanKey(hold));
  });
});
