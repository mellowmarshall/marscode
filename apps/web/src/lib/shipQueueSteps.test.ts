import type { ShipQueueJob } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  buildSafePrUrl,
  deriveShipJobSteps,
  extractShipIssueRefs,
  formatShipJobElapsed,
  formatShipWhenStamp,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
  shipQueueStatusVariant,
  shouldHideRedundantStatusBadge,
} from "./shipQueueSteps";

const LABELS = {
  queued: "Queued",
  watcher: "Watcher",
  ci: "CI",
  push: "Push",
  pr: "PR",
  merge: "Merge",
  land: "Deploy",
};

describe("shipQueueSteps", () => {
  it("keeps live deploy state strictly between POST_MERGE and SYNC_EXIT=0", () => {
    const mergingOnly: ShipQueueJob = {
      id: "101",
      state: "running",
      mergeExit: 0,
      lastMarker: "CLEANED at=2026-11-23T12:00:00Z",
    };
    expect(resolveShipJobDisplayState(mergingOnly)).toBe("running");

    const deploying: ShipQueueJob = {
      id: "102",
      state: "running",
      stage: "deploy",
      postMerge: true,
      mergeExit: 0,
      lastMarker: "POST_MERGE job=102",
    };
    expect(resolveShipJobDisplayState(deploying)).toBe("deploying");
    const stepsDeploying = deriveShipJobSteps(deploying, LABELS);
    expect(stepsDeploying).toHaveLength(7);
    expect(stepsDeploying[6]).toMatchObject({ id: "land", state: "active" });

    const deployed: ShipQueueJob = {
      id: "103",
      state: "running",
      stage: "deployed",
      postMerge: true,
      mergeExit: 0,
      syncExit: 0,
    };
    expect(resolveShipJobDisplayState(deployed)).toBe("post-merge");
    expect(deriveShipJobSteps(deployed, LABELS)[6]).toMatchObject({ id: "land", state: "done" });
  });

  it("handles round-2 rebase failure without showing stale round-1 green PR/Merge", () => {
    const failedRound2: ShipQueueJob = {
      id: "104",
      state: "failed",
      pushExit: 0,
      pr: "88",
      mergeExit: 75,
      reason: "ci_failed",
    };
    const steps = deriveShipJobSteps(failedRound2, LABELS);
    expect(steps).toHaveLength(6);
    expect(steps[2]?.state).toBe("failed");
    expect(steps[3]?.state).toBe("pending");
    expect(steps[4]?.state).toBe("pending");
    expect(steps[5]?.state).toBe("pending");
  });

  it("formats elapsed, PR URLs, issue refs, and status helpers safely", () => {
    const live: ShipQueueJob = {
      id: "105",
      key: "1795470000-j105",
      state: "running",
      displayState: "running",
      branch: "fix/issue-921-auth",
      title: "Fix token refresh (#921)",
      pr: "44",
      prRepo: "private-repo",
      prUrl: "javascript:alert(1)",
      submittedAt: "2026-11-23T12:00:00.000Z",
    };
    expect(isShipQueueJobLive(live)).toBe(true);
    expect(shouldHideRedundantStatusBadge("running")).toBe(true);
    expect(shouldHideRedundantStatusBadge("deploying")).toBe(false);
    expect(shipQueueStatusVariant("deploying")).toBe("info");
    expect(shipQueueStatusVariant("failed")).toBe("error");
    expect(buildSafePrUrl(live)).toBeNull();
    expect(
      buildSafePrUrl({
        id: "106",
        state: "done",
        pr: "44",
        prRepo: "private-repo",
      }),
    ).toBe("https://github.com/private-repo/pull/44");
    expect(extractShipIssueRefs(live)).toEqual([
      { num: 921, url: "https://github.com/private-repo/issues/921" },
    ]);
    expect(formatShipJobElapsed(live, Date.parse("2026-11-23T12:02:05.000Z"))).toBe("2m 05s");
    expect(
      formatShipWhenStamp("2026-11-23T12:00:00.000Z", Date.parse("2026-11-23T14:00:00.000Z")),
    ).toMatch(/^\d{2}:\d{2}$/u);
  });
});
