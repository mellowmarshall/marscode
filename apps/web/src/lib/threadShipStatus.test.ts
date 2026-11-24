import type { ShipQueueDepRepo, ShipQueueJob } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildShipQueueDepApproval,
  deriveThreadShipQueueDepApprovals,
  findActionableDepHoldForJob,
  isShipQueueDepApprovalRequestId,
} from "./shipQueueApprovals";
import {
  matchThreadShipJobs,
  resolveThreadShipStatus,
  selectVisibleThreadShipJobs,
} from "./threadShipStatus";

describe("threadShipStatus & shipQueueApprovals", () => {
  it("matches jobs by threadId, exact worktree, or non-default branch+primary", () => {
    const jobs: ShipQueueJob[] = [
      { id: "1", state: "running", threadId: "t-1", branch: "main", primary: "/data/Dev/a" },
      { id: "2", state: "running", worktree: "/data/Dev/wt-2/", repo: "repo-b" },
      {
        id: "3",
        state: "running",
        branch: "feat/x",
        primary: "/data/Dev/repo-c",
        stage: "deploy",
        postMerge: true,
      },
    ];

    expect(matchThreadShipJobs(jobs, "t-1", null, "", "").map((j) => j.id)).toEqual(["1"]);
    expect(
      matchThreadShipJobs(jobs, "t-other", null, "/data/Dev/wt-2", "").map((j) => j.id),
    ).toEqual(["2"]);
    expect(
      matchThreadShipJobs(jobs, "t-other", "feat/x", "", "/data/Dev/other").map((j) => j.id),
    ).toEqual([]);
    expect(
      resolveThreadShipStatus({
        jobs,
        threadId: "t-other",
        branch: "feat/x",
        worktreePath: null,
        gitCwd: "/data/Dev/repo-c",
      }),
    ).toMatchObject({ phase: "deploying" });
  });

  it("keeps done ship jobs only inside linger window and hides cancelled jobs", () => {
    const t0 = Date.parse("2026-11-23T12:00:00.000Z");
    const doneJob: ShipQueueJob = {
      id: "10",
      state: "done",
      submittedAt: "2026-11-23T11:55:00.000Z",
      lastMarker: "DONE job=10 at=2026-11-23T12:00:00Z",
    };
    expect(
      selectVisibleThreadShipJobs([doneJob], t0 + 60_000, undefined, 300_000).jobs,
    ).toHaveLength(1);
    expect(
      selectVisibleThreadShipJobs([doneJob], t0 + 301_000, undefined, 300_000).jobs,
    ).toHaveLength(0);
    expect(
      selectVisibleThreadShipJobs([{ id: "11", state: "cancelled" }], t0 + 1000).jobs,
    ).toHaveLength(0);
  });

  it("maps actionable dependency holds to native ThreadPendingApproval options", () => {
    const nowMs = 1_800_000_000_000;
    const hold: ShipQueueDepRepo = {
      repo: "devtools",
      reportId: "devtools:r1",
      status: "pending",
      scannedAt: Math.floor(nowMs / 1000) - 30,
      active: true,
      holding: true,
      pendingCount: 1,
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
          packageFile: "package.json",
          depName: "effect",
          currentValue: "4.0.0",
          newValue: "4.1.0",
          releaseTimestamp: null,
        },
      ],
    };
    const job: ShipQueueJob = {
      id: "50",
      repo: "private-repo",
      state: "queued",
      threadId: "t-ship",
    };
    expect(findActionableDepHoldForJob(job, [hold])?.repo).toBe("devtools");
    const built = buildShipQueueDepApproval({ hold, nowMs });
    expect(isShipQueueDepApprovalRequestId(built.requestId)).toBe(true);
    expect(built.canApprove).toBe(true);
    expect(built.canReject).toBe(true);
    expect((built.approval.options ?? []).map((o) => o.label)).toEqual([
      "Reject (24h)",
      "Approve",
      "Rescan",
    ]);

    const deduped = deriveThreadShipQueueDepApprovals({
      jobs: [job, { ...job, id: "51" }],
      deps: [hold],
      nowMs,
    });
    expect(deduped).toHaveLength(1);
  });
});
