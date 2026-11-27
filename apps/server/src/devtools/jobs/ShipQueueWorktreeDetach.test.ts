import { describe, expect, it, vi } from "vite-plus/test";

import { ShipQueueWorktreeDetacher } from "./ShipQueueWorktreeDetach.ts";
import type { ShipQueueBridgeUpdate } from "./ShipQueueBridge.ts";
import type { JobSummary } from "./types.ts";

function makeShipJob(overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id: "ship:42",
    revision: 1,
    source: "ship-queue",
    kind: "ship",
    title: "fix: demo",
    phaseLabel: "Done",
    state: "done",
    binding: {
      threadId: "thread-1",
      repo: "mellowmarshall/marscode",
      branch: "fix/demo",
      worktreePath: "/data/Dev/marscode/fix-demo",
      host: "devbox",
    },
    timing: { startedAt: "2026-01-01T00:00:00.000Z" },
    cancellable: false,
    ...overrides,
  };
}

function makeUpdate(jobs: ReadonlyArray<JobSummary>): ShipQueueBridgeUpdate {
  const map = new Map<string, JobSummary>();
  for (const job of jobs) map.set(job.id, job);
  return {
    jobs: map,
    changedIds: jobs.map((job) => job.id),
    removedIds: [],
    queueMeta: {},
    queueMetaChanged: false,
  };
}

describe("ShipQueueWorktreeDetacher", () => {
  it("detaches matching threads when a done ship job's worktree and branch were reaped", async () => {
    const detachThread = vi.fn(async () => {});
    const isBranchRemoved = vi.fn(async () => true);
    const detacher = new ShipQueueWorktreeDetacher({
      pathExists: () => false,
      isBranchRemoved,
      findThreadsByWorktreePath: async (worktreePath) =>
        worktreePath === "/data/Dev/marscode/fix-demo"
          ? [
              {
                id: "thread-1",
                projectId: "proj-1",
                worktreePath: "/data/Dev/marscode/fix-demo",
                branch: "fix/demo",
              },
            ]
          : [],
      detachThread,
    });

    await detacher.handleUpdate(makeUpdate([makeShipJob()]));
    expect(isBranchRemoved).toHaveBeenCalledWith({
      threadId: "thread-1",
      projectId: "proj-1",
      branch: "fix/demo",
    });
    expect(detachThread).toHaveBeenCalledTimes(1);
    expect(detachThread).toHaveBeenCalledWith({
      threadId: "thread-1",
      expectedWorktreePath: "/data/Dev/marscode/fix-demo",
      expectedBranch: "fix/demo",
    });

    // Repeated updates for the same completed job are deduplicated.
    await detacher.handleUpdate(makeUpdate([makeShipJob({ revision: 2 })]));
    expect(detachThread).toHaveBeenCalledTimes(1);
  });

  it("does not detach when the worktree still exists on disk (e.g. LEFT_DIRTY)", async () => {
    const detachThread = vi.fn(async () => {});
    const detacher = new ShipQueueWorktreeDetacher({
      pathExists: () => true,
      isBranchRemoved: async () => true,
      findThreadsByWorktreePath: async () => [
        {
          id: "thread-1",
          projectId: "proj-1",
          worktreePath: "/data/Dev/marscode/fix-demo",
          branch: "fix/demo",
        },
      ],
      detachThread,
    });

    await detacher.handleUpdate(makeUpdate([makeShipJob()]));
    expect(detachThread).not.toHaveBeenCalled();
  });

  it("does not detach when the folder is gone but the branch still exists (e.g. LEFT_AHEAD)", async () => {
    const detachThread = vi.fn(async () => {});
    const detacher = new ShipQueueWorktreeDetacher({
      pathExists: () => false,
      isBranchRemoved: async () => false,
      findThreadsByWorktreePath: async () => [
        {
          id: "thread-1",
          projectId: "proj-1",
          worktreePath: "/data/Dev/marscode/fix-demo",
          branch: "fix/demo",
        },
      ],
      detachThread,
    });

    await detacher.handleUpdate(makeUpdate([makeShipJob()]));
    expect(detachThread).not.toHaveBeenCalled();
  });

  it("does not detach a thread on a different branch reusing the same worktree path", async () => {
    const detachThread = vi.fn(async () => {});
    const detacher = new ShipQueueWorktreeDetacher({
      pathExists: () => false,
      isBranchRemoved: async () => true,
      findThreadsByWorktreePath: async () => [
        {
          id: "thread-new",
          projectId: "proj-1",
          worktreePath: "/data/Dev/marscode/fix-demo",
          branch: "fix/reused-path",
        },
      ],
      detachThread,
    });

    await detacher.handleUpdate(makeUpdate([makeShipJob()]));
    expect(detachThread).not.toHaveBeenCalled();
  });

  it("deduplicates overlapping updates and falls back to bound threadId lookup", async () => {
    const detachThread = vi.fn(async () => {});
    let releaseLookup: (() => void) | undefined;
    const lookupBlocked = new Promise<void>((resolve) => {
      releaseLookup = resolve;
    });
    const detacher = new ShipQueueWorktreeDetacher({
      pathExists: () => false,
      isBranchRemoved: async () => true,
      findThreadsByWorktreePath: async () => {
        await lookupBlocked;
        return [];
      },
      getThreadById: async (threadId) =>
        threadId === "thread-bound"
          ? {
              id: "thread-bound",
              projectId: "proj-1",
              worktreePath: "/data/Dev/marscode/fix-demo/",
              branch: "fix/demo",
            }
          : null,
      detachThread,
    });

    const update = makeUpdate([
      makeShipJob({ id: "ship:43", state: "running" }),
      makeShipJob({
        id: "ship:44",
        state: "done",
        binding: {
          threadId: "thread-bound",
          branch: "fix/demo",
          worktreePath: "/data/Dev/marscode/fix-demo",
          host: "devbox",
        },
      }),
    ]);

    const first = detacher.handleUpdate(update);
    const second = detacher.handleUpdate(update);
    releaseLookup!();
    await Promise.all([first, second]);

    expect(detachThread).toHaveBeenCalledTimes(1);
    expect(detachThread).toHaveBeenCalledWith({
      threadId: "thread-bound",
      expectedWorktreePath: "/data/Dev/marscode/fix-demo/",
      expectedBranch: "fix/demo",
    });
  });
});
