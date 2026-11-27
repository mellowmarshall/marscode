import { describe, expect, it } from "vite-plus/test";

import type { ShipQueueJob } from "./devtoolsClient";
import { resolveShipJobPhase, resolveThreadShipStatus } from "./threadShipStatus";

describe("resolveShipJobPhase", () => {
  it("classifies queued, waiting, running, parked, and needs-root jobs before POST_MERGE as shipping", () => {
    const shippingJobs: ShipQueueJob[] = [
      { id: "1", state: "queued" },
      { id: "2", state: "waiting_watcher", last_marker: "WAITING_WATCHER" },
      { id: "3", state: "running", last_marker: "REBASED abc1234" },
      { id: "4", state: "running", last_marker: "PR=42", pr: 42 },
      { id: "5", state: "running", last_marker: "MERGE_EXIT=0", merge_exit: 0 },
      { id: "6", state: "running", last_marker: "CLEANED worktree", merge_exit: 0 },
      { id: "7", state: "parked", parked: { for: "ci-host" } },
      { id: "8", state: "needs-root", needs_root: { request: "r1", hosts: ["box"] } },
    ];
    for (const job of shippingJobs) {
      expect(resolveShipJobPhase(job)).toBe("shipping");
    }
  });

  it("classifies live jobs between POST_MERGE and SYNC_EXIT as deploying", () => {
    expect(
      resolveShipJobPhase({
        id: "42",
        state: "running",
        merge_exit: 0,
        last_marker: "POST_MERGE job=42",
      }),
    ).toBe("deploying");

    expect(
      resolveShipJobPhase({
        id: "43",
        state: "running",
        display_state: "deploying",
      }),
    ).toBe("deploying");
  });

  it("returns shipping once SYNC_EXIT is recorded while post-merge wrapup finishes", () => {
    expect(
      resolveShipJobPhase({
        id: "44",
        state: "running",
        merge_exit: 0,
        sync_exit: 0,
        last_marker: "SYNC_EXIT=0",
      }),
    ).toBe("shipping");
  });

  it("returns null for terminal job states", () => {
    for (const state of ["done", "failed", "cancelled"]) {
      expect(
        resolveShipJobPhase({
          id: "50",
          state,
          last_marker: "POST_MERGE job=50",
        }),
      ).toBeNull();
    }
  });
});

describe("resolveThreadShipStatus", () => {
  it("matches a thread's live job and extracts startedAt from submitted_at or key", () => {
    const jobs: ShipQueueJob[] = [
      {
        id: "100",
        thread_id: "thread-a",
        state: "done",
        submitted_at: "2026-11-21T12:00:00Z",
      },
      {
        id: "101",
        thread_id: "thread-a",
        state: "running",
        last_marker: "REBASED deadbee",
        submitted_at: "2026-11-21T13:00:00Z",
      },
      {
        id: "102",
        worktree: "/home/dev/.t3/worktrees/project-b/wt-b",
        branch: "feat/deploy-me",
        state: "running",
        last_marker: "POST_MERGE job=102",
        key: "1763730000-j102",
      },
    ];

    expect(
      resolveThreadShipStatus({
        jobs,
        threadId: "thread-a",
        branch: "feat/a",
        worktreePath: null,
        gitCwd: "/home/dev/Dev/example-repo",
      }),
    ).toEqual({
      phase: "shipping",
      startedAt: "2026-11-21T13:00:00Z",
    });

    expect(
      resolveThreadShipStatus({
        jobs,
        threadId: "thread-b",
        branch: "feat/deploy-me",
        worktreePath: "/home/dev/.t3/worktrees/project-b/wt-b/",
        gitCwd: "/home/dev/Dev/project-b",
      }),
    ).toEqual({
      phase: "deploying",
      startedAt: new Date(1763730000 * 1000).toISOString(),
    });
  });

  it("prefers deploying when a thread has both shipping and deploying live jobs", () => {
    const jobs: ShipQueueJob[] = [
      {
        id: "201",
        thread_id: "thread-x",
        state: "queued",
        submitted_at: "2026-11-21T13:05:00Z",
      },
      {
        id: "202",
        thread_id: "thread-x",
        state: "running",
        last_marker: "POST_MERGE job=202",
        submitted_at: "2026-11-21T13:00:00Z",
      },
    ];
    expect(
      resolveThreadShipStatus({
        jobs,
        threadId: "thread-x",
        branch: "feat/x",
        worktreePath: null,
        gitCwd: null,
      }),
    ).toEqual({
      phase: "deploying",
      startedAt: "2026-11-21T13:00:00Z",
    });
  });

  it("returns null for unrelated threads or when only terminal jobs match", () => {
    const jobs: ShipQueueJob[] = [
      {
        id: "300",
        thread_id: "thread-other",
        state: "running",
        last_marker: "POST_MERGE job=300",
      },
      {
        id: "301",
        thread_id: "thread-done",
        state: "done",
      },
    ];
    expect(
      resolveThreadShipStatus({
        jobs,
        threadId: "thread-done",
        branch: "main",
        worktreePath: null,
        gitCwd: "/home/dev/Dev/example-repo",
      }),
    ).toBeNull();
  });
});
