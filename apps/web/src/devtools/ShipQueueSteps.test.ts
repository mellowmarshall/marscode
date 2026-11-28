import { describe, expect, it } from "vite-plus/test";

import { aggregateFleetAlerts, isAlertFiring, mergeFleetHosts } from "./devdeckTypes";
import {
  buildSafePrUrl,
  deriveShipJobSteps,
  formatShipJobElapsed,
  isShipQueueJobLive,
  resolveShipJobDisplayState,
  shipQueueStatusVariant,
  shouldHideRedundantStatusBadge,
} from "./ShipQueueSteps";
import {
  matchThreadJobs,
  matchThreadSessions,
  selectVisibleThreadShipJobs,
} from "./threadShipStatus";

const LABELS = {
  queued: "Queued",
  watcher: "Watcher",
  ci: "CI & Checks",
  push: "Push",
  pr: "Pull Request",
  merge: "Merge Gate",
  land: "Land & Sync",
} as const;

describe("deriveShipJobSteps", () => {
  it("places a failure after STARTED in CI even when only the log stage records the start", () => {
    const steps = deriveShipJobSteps(
      {
        id: "300",
        state: "failed",
        reason: "rebase_conflict",
        stage: "rebase",
        last_marker: "FAILED reason=rebase_conflict",
      },
      LABELS,
    );
    expect(steps.find((s) => s.id === "queued")?.state).toBe("done");
    expect(steps.find((s) => s.id === "ci")).toMatchObject({
      state: "failed",
      detail: "rebase_conflict",
    });
  });

  it("times a finished job from its millisecond `at=` stamp or ended_at, keeping the zone", () => {
    const base = { id: "301", state: "done", submitted_at: "2026-01-02T10:00:00.000Z" };
    expect(
      formatShipJobElapsed(
        { ...base, last_marker: "DONE job=301 pr=63 at=2026-01-02T10:00:42.898Z" },
        0,
      ),
    ).toBe("42s");
    expect(formatShipJobElapsed({ ...base, ended_at: "2026-01-02T10:03:05.000Z" }, 0)).toBe(
      "3m 05s",
    );
  });

  it("marks CI & Checks failed when ci_done=1 on a CI failure", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j1",
        state: "failed",
        ci_done: 1,
        route: { host: "builder-1" },
        reason: "pytest failed",
      },
      LABELS,
    );
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "failed"],
      ["push", "pending"],
      ["pr", "pending"],
      ["merge", "pending"],
    ]);
  });

  it("ignores stale needs_root when hosts is empty and highlights waiting when hosts is non-empty", () => {
    const resolved = deriveShipJobSteps(
      {
        id: "j2",
        state: "running",
        route: { host: "builder-1" },
        needs_root: { request: "install pkg", hosts: [] },
      },
      LABELS,
    );
    expect(resolved.find((s) => s.id === "ci")?.state).toBe("active");

    const blocked = deriveShipJobSteps(
      {
        id: "j3",
        state: "running",
        route: { host: "builder-1" },
        needs_root: { request: "install pkg", hosts: ["builder-1"] },
      },
      LABELS,
    );
    expect(blocked.find((s) => s.id === "ci")?.state).toBe("waiting");
  });

  it("marks Round-2 retry (running + merge_exit=75) as re-running CI with Merge Gate waiting", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j4",
        state: "running",
        ci_done: 1,
        push_exit: 0,
        pr: 42,
        pr_repo: "example-org/example-repo",
        merge_exit: 75,
        last_marker: "WAITING_CHECKS",
      },
      LABELS,
    );
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "active"],
      ["push", "pending"],
      ["pr", "done"],
      ["merge", "waiting"],
    ]);
  });

  it("marks CI & Checks failed when Round-2 CI fails after a Round-1 merge_exit=75", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j4b",
        state: "failed",
        ci_done: 1,
        push_exit: 0,
        pr: 42,
        merge_exit: 75,
        reason: "ci failed on round 2",
      },
      LABELS,
    );
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "failed"],
      ["push", "pending"],
      ["pr", "pending"],
      ["merge", "pending"],
    ]);
  });

  it("marks Pull Request failed on Round-2 pr_head_stale with push_exit=0 and Round-1 merge_exit=75", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j4c",
        state: "failed",
        ci_done: 1,
        push_exit: 0,
        pr: 42,
        merge_exit: 75,
        reason: "pr_head_stale",
      },
      LABELS,
    );
    expect(steps.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "done"],
      ["push", "done"],
      ["pr", "failed"],
      ["merge", "pending"],
    ]);
  });

  it("marks Pull Request failed on Round-1 pr_head_stale and Round-2 push failure without blaming Merge Gate", () => {
    const r1Pr = deriveShipJobSteps(
      {
        id: "j4d",
        state: "failed",
        ci_done: 1,
        push_exit: 0,
        pr: 42,
        reason: "pr_head_stale",
      },
      LABELS,
    );
    expect(r1Pr.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "done"],
      ["push", "done"],
      ["pr", "failed"],
      ["merge", "pending"],
    ]);

    const r2Push = deriveShipJobSteps(
      {
        id: "j4e",
        state: "failed",
        ci_done: 1,
        push_exit: 1,
        pr: 42,
        merge_exit: 75,
        reason: "push rejected",
      },
      LABELS,
    );
    expect(r2Push.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "done"],
      ["push", "failed"],
      ["pr", "pending"],
      ["merge", "pending"],
    ]);
  });

  it("marks Push failed before PR when push_exit != 0 even if an older PR number exists", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j5",
        state: "failed",
        ci_done: 1,
        push_exit: 1,
        pr: 42,
        reason: "non-fast-forward",
      },
      LABELS,
    );
    expect(steps.find((s) => s.id === "push")?.state).toBe("failed");
    expect(steps.find((s) => s.id === "pr")?.state).toBe("pending");
  });

  it("marks Land & Sync failed when merge_exit=0 and landing/sync fails", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j6",
        state: "failed",
        ci_done: 1,
        push_exit: 0,
        pr: 42,
        merge_exit: 0,
        sync_exit: 1,
        reason: "rebase conflict on main",
      },
      LABELS,
    );
    expect(steps.find((s) => s.id === "merge")?.state).toBe("done");
    expect(steps.find((s) => s.id === "land")?.state).toBe("failed");
  });

  it("keeps parked jobs waiting at Queued without marking Watcher started", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j7",
        state: "queued",
        parked: { for: "ci-slot", hosts: ["builder-1"] },
        last_marker: "STARTED_PREV",
      },
      LABELS,
    );
    expect(steps.find((s) => s.id === "queued")?.state).toBe("waiting");
    expect(steps.find((s) => s.id === "watcher")?.state).toBe("pending");
  });

  it("marks Queued failed for pre-start cancellations/failures", () => {
    const steps = deriveShipJobSteps(
      {
        id: "j8",
        state: "cancelled",
        reason: "cancelled before start",
      },
      LABELS,
    );
    expect(steps.find((s) => s.id === "queued")?.state).toBe("failed");
    expect(steps.find((s) => s.id === "watcher")?.state).toBe("pending");
  });

  it("marks all 7 steps done ONLY when sync_exit=0 ran and omits Deploy completely on repos with no post-merge step", () => {
    const withDeploy = {
      id: "j9",
      state: "done",
      ci_done: 1,
      push_exit: 0,
      pr: 108,
      pr_repo: "example-org/example-repo",
      merge_exit: 0,
      sync_exit: 0,
    };
    const withDeploySteps = deriveShipJobSteps(withDeploy, LABELS);
    expect(withDeploySteps).toHaveLength(7);
    expect(withDeploySteps.every((s) => s.state === "done")).toBe(true);
    expect(withDeploySteps.find((s) => s.id === "pr")?.href).toBe(
      "https://github.com/example-org/example-repo/pull/108",
    );
    expect(buildSafePrUrl({ id: "bad", pr: 1, pr_repo: "../evil/repo" })).toBeNull();
    // The queue keys jobs by `owner/name`, so a job without `pr_repo` still links its PR.
    expect(buildSafePrUrl({ id: "63", pr: 63, repo: "example-org/example-repo" })).toBe(
      "https://github.com/example-org/example-repo/pull/63",
    );
    expect(buildSafePrUrl({ id: "64", pr: 64, repo: "example-repo" })).toBeNull();

    // Exact job 10984 shape (tools): DONE with MERGE_EXIT=0 -> CLEANED -> DONE, NO POST_MERGE, NO sync_exit.
    const noDeployDone = {
      id: "10984",
      repo: "tools",
      state: "done",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      pr_repo: "example-org/tools",
      merge_exit: "0",
      last_marker: "DONE job=10984 pr=110 at=2026-11-22T18:02:18",
    };
    const noDeploySteps = deriveShipJobSteps(noDeployDone, LABELS);
    expect(noDeploySteps.map((s) => [s.id, s.state])).toEqual([
      ["queued", "done"],
      ["watcher", "done"],
      ["ci", "done"],
      ["push", "done"],
      ["pr", "done"],
      ["merge", "done"],
    ]);
    expect(noDeploySteps.find((s) => s.id === "land")).toBeUndefined();

    // Live job after MERGE_EXIT=0 / CLEANED with NO POST_MERGE is NOT "deploying" and has no Deploy step.
    const cleaningLive = {
      id: "201",
      state: "running",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      stage: "post-merge",
      last_marker: "CLEANED worktree=/tmp/wt",
    };
    expect(resolveShipJobDisplayState(cleaningLive)).toBe("running");
    expect(deriveShipJobSteps(cleaningLive, LABELS).find((s) => s.id === "land")).toBeUndefined();

    // Live job that entered POST_MERGE shows Deploy active and display state "deploying".
    const deployingLive = {
      id: "202",
      state: "running",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      stage: "deploy",
      last_marker: "POST_MERGE job=202",
    };
    expect(resolveShipJobDisplayState(deployingLive)).toBe("deploying");
    const deployingSteps = deriveShipJobSteps(deployingLive, LABELS);
    expect(deployingSteps.find((s) => s.id === "merge")?.state).toBe("done");
    expect(deployingSteps.find((s) => s.id === "land")?.state).toBe("active");

    // Live job after SYNC_EXIT=0 shows Deploy done and display state "post-merge".
    const deployedLive = {
      id: "204",
      state: "running",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      sync_exit: "0",
      stage: "deployed",
      last_marker: "SYNC_EXIT=0",
    };
    expect(resolveShipJobDisplayState(deployedLive)).toBe("post-merge");
    expect(deriveShipJobSteps(deployedLive, LABELS).find((s) => s.id === "land")?.state).toBe(
      "done",
    );

    // Failed job that crashed mid-POST_MERGE before writing SYNC_EXIT= shows Deploy failed.
    const crashedMidDeploy = {
      id: "205",
      state: "failed",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      post_merge: true,
      reason: "post_merge timeout",
    };
    expect(deriveShipJobSteps(crashedMidDeploy, LABELS).find((s) => s.id === "land")?.state).toBe(
      "failed",
    );

    // A done job's non-zero SYNC_EXIT is a warning on Deploy (the PR stays merged), never done or failed.
    const failedSyncDone = {
      id: "206",
      state: "done",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      sync_exit: "1",
      stage: "deployed",
      post_merge: true,
    };
    const failedSyncLand = deriveShipJobSteps(
      { ...failedSyncDone, sync_reason: "install.sh: unknown argument" },
      LABELS,
    ).find((s) => s.id === "land");
    expect(failedSyncLand?.state).toBe("warning");
    expect(failedSyncLand?.detail).toBe("exit 1: install.sh: unknown argument");
    expect(
      deriveShipJobSteps({ ...failedSyncDone, state: "failed" }, LABELS).find(
        (s) => s.id === "land",
      )?.state,
    ).toBe("failed");

    // M2: Post-merge failures on repos with NO Deploy step (remote_branch_left, pre_cleanup_failed, post-merge cancel)
    // must mark Merge failed instead of rendering 6 green done steps, and L5 must not misclassify pre_cleanup_failed as PR failure.
    const remoteBranchLeft = {
      id: "207",
      repo: "tools",
      state: "failed",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      reason: "remote_branch_left pr=110 (merged)",
    };
    const rblSteps = deriveShipJobSteps(remoteBranchLeft, LABELS);
    expect(rblSteps).toHaveLength(6);
    expect(rblSteps.find((s) => s.id === "pr")?.state).toBe("done");
    expect(rblSteps.find((s) => s.id === "merge")?.state).toBe("failed");

    const preCleanupFailed = {
      id: "208",
      repo: "tools",
      state: "failed",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      reason: "pre_cleanup_failed pr=110 (merged)",
    };
    const pcfSteps = deriveShipJobSteps(preCleanupFailed, LABELS);
    expect(pcfSteps).toHaveLength(6);
    expect(pcfSteps.find((s) => s.id === "pr")?.state).toBe("done");
    expect(pcfSteps.find((s) => s.id === "merge")?.state).toBe("failed");

    const cancelledAfterMerge = {
      id: "209",
      repo: "tools",
      state: "cancelled",
      ci_done: "1",
      push_exit: "0",
      pr: "110",
      merge_exit: "0",
      reason: "cancelled",
    };
    const camSteps = deriveShipJobSteps(cancelledAfterMerge, LABELS);
    expect(camSteps).toHaveLength(6);
    expect(camSteps.find((s) => s.id === "merge")?.state).toBe("failed");
  });
  it("cleans noisy REBASED and STARTED CI markers into concise details", () => {
    const rebasedSteps = deriveShipJobSteps(
      {
        id: "j10",
        state: "running",
        route: { host: "host-d-linux" },
        last_marker: "REBASED 6f2a82fbde60 ship-queue: some very long commit title here",
      },
      LABELS,
    );
    expect(rebasedSteps.find((s) => s.id === "ci")?.detail).toBe("rebased 6f2a82f");

    const startedSteps = deriveShipJobSteps(
      {
        id: "j11",
        state: "running",
        route: { host: "host-d-linux" },
        last_marker: "STARTED job=11 host=host-d-linux",
      },
      LABELS,
    );
    expect(startedSteps.find((s) => s.id === "ci")?.detail).toBeUndefined();
  });

  it("formats elapsed time for live and completed jobs and hides only the redundant running badge", () => {
    const baseMs = Date.parse("2026-11-20T18:00:00Z");
    expect(
      formatShipJobElapsed(
        { id: "j1", state: "running", submitted_at: "2026-11-20T17:59:15Z" },
        baseMs,
      ),
    ).toBe("45s");
    expect(
      formatShipJobElapsed(
        { id: "j2", state: "running", submitted_at: "2026-11-20T17:58:51Z" },
        baseMs,
      ),
    ).toBe("1m 09s");
    expect(
      formatShipJobElapsed(
        { id: "j3", state: "running", submitted_at: "2026-11-20T16:55:00Z" },
        baseMs,
      ),
    ).toBe("1h 05m");
    expect(
      formatShipJobElapsed(
        {
          id: "j4",
          state: "done",
          submitted_at: "2026-11-20T17:50:00Z",
          last_marker: "DONE job=j4 pr=1 at=2026-11-20T17:55:26Z",
        },
        baseMs,
      ),
    ).toBe("5m 26s");
    expect(
      formatShipJobElapsed(
        {
          id: "j5",
          state: "failed",
          submitted_at: "2026-11-20T17:50:00Z",
          last_marker: "FAILED reason=ci",
        },
        baseMs,
      ),
    ).toBeNull();

    expect(shouldHideRedundantStatusBadge("running")).toBe(true);
    expect(shouldHideRedundantStatusBadge("RUNNING")).toBe(true);
    expect(shouldHideRedundantStatusBadge("queued")).toBe(false);
    expect(shouldHideRedundantStatusBadge("parked")).toBe(false);
    expect(shouldHideRedundantStatusBadge("needs-root")).toBe(false);
    expect(shouldHideRedundantStatusBadge("failed")).toBe(false);
    expect(shouldHideRedundantStatusBadge("done")).toBe(false);
  });
});

describe("devdeckTypes & ThreadDevtoolsPanel helpers", () => {
  it("merges local host, remote nodes, member-joined probes (host-d <-> host-d-linux), and ship.hosts drift", () => {
    const merged = mergeFleetHosts({
      localHost: { name: "host-a", cpu_pct: 12, cpus: 16, load1: 0.7 },
      localServers: [{ id: "devdeck", service: "devdeck", state: "up", port: 3210 }],
      localSessions: [],
      localAlerts: [{ source: "alerts", name: "disk", state: "ok" }],
      nodes: {
        "host-d": {
          status: "up",
          ssh: "host-d",
          members: ["host-d", "host-d-linux"],
          host: { name: "host-d", cpu_pct: 8, load1: 1.2 },
          sessions: [{ id: "s-air", name: "claude", project: "devtools" }],
        },
        "host-b": {
          status: "offline",
          error: "ssh timeout",
        },
      },
      hostsReport: {
        report: {
          hosts: [
            {
              name: "host-a",
              ssh: null,
              reached: true,
              platform: "linux",
              tools: [{ name: "uv", version: "0.13.8", state: "ok" }],
              drift: [],
            },
            {
              name: "host-d-linux",
              ssh: "host-d-linux",
              reached: true,
              platform: "linux-arm64",
              ci_off: true,
              ci_off_reason: "on battery",
              tools: [{ name: "go", version: "1.24", state: "stale" }],
              drift: [{ text: "go 1.24 != 1.25", state: "drift" }],
            },
            {
              name: "host-c",
              ssh: "host-c-wsl",
              reached: true,
              platform: "wsl",
              tools: [{ name: "node", version: "22", state: "ok" }],
            },
          ],
        },
      },
      shipPanel: {
        hosts: {
          hosts: [
            {
              name: "host-d-linux",
              drift: ["go 1.24 != 1.25", "uv missing"],
              notes: ["guest vm"],
            },
          ],
        },
      },
    });

    expect(merged.map((h) => h.id)).toEqual(["host-a", "host-d", "host-b", "host-c"]);
    const local = merged[0]!;
    expect(local.isLocal).toBe(true);
    expect(local.shortName).toBe("host-a");
    expect(local.status).toBe("online");
    expect(local.probeHostName).toBe("host-a");

    const air = merged[1]!;
    expect(air.probeHostName).toBe("host-d-linux");
    expect(air.ciOff).toBe(true);
    expect(air.ciOffReason).toBe("on battery");
    // Routine auto-syncable drift stays online without raising a problem badge on the card.
    expect(air.status).toBe("online");
    expect(air.problem).toBeNull();
    expect(air.drift).toEqual(["go 1.24 != 1.25", "uv missing"]);
    expect(air.sessions).toHaveLength(1);

    const offline = merged[2]!;
    expect(offline.status).toBe("offline");
    expect(offline.problem?.kind).toBe("offline");

    const probeOnly = merged[3]!;
    expect(probeOnly.status).toBe("online");
    expect(probeOnly.ssh).toBe("host-c-wsl");
  });

  it("classifies live states and status badge variants accurately", () => {
    expect(isShipQueueJobLive({ id: "a", state: "needs-root" })).toBe(true);
    expect(isShipQueueJobLive({ id: "b", state: "parked" })).toBe(true);
    expect(isShipQueueJobLive({ id: "c", state: "done" })).toBe(false);
    expect(shipQueueStatusVariant("needs-root")).toBe("warning");
    expect(shipQueueStatusVariant("parked")).toBe("warning");
    expect(shipQueueStatusVariant("ci")).toBe("info");
    expect(shipQueueStatusVariant("failed")).toBe("error");
    expect(shipQueueStatusVariant("done")).toBe("success");
  });

  it("isolates parent-thread jobs and sessions without leaking across main or unrelated repos", () => {
    const jobs = [
      { id: "mine-tid", thread_id: "t1", branch: "main", repo: "other" },
      { id: "other-tid", thread_id: "t2", branch: "feat/a", worktree: "/wt/t1", repo: "devtools" },
      { id: "wt-match", worktree: "/wt/t1", branch: "main", repo: "devtools" },
      { id: "main-leak", branch: "main", repo: "devtools" },
      { id: "other-repo-branch", branch: "feat/a", repo: "unrelated" },
      {
        id: "twin-basename-diff-checkout",
        branch: "feat/a",
        repo: "example-org/example-repo",
        primary: "/other/devtools",
      },
      {
        id: "same-repo-branch",
        branch: "feat/a",
        repo: "example-org/example-repo",
        primary: "/data/devtools",
      },
    ];
    expect(
      matchThreadJobs(jobs, "t1", "feat/a", "/wt/t1", "/data/devtools").map((j) => j.id),
    ).toEqual(["mine-tid", "wt-match", "same-repo-branch"]);
    expect(matchThreadJobs(jobs, "t1", "main", "", "/data/devtools").map((j) => j.id)).toEqual([
      "mine-tid",
    ]);

    const sessions = [
      { id: "s1", lease_id: "l1", project: "other" },
      { id: "s2", cwd: "/wt/t1/pkg", branch: "main" },
      { id: "s3", branch: "feat/a", project: "devtools" },
      { id: "s4", branch: "feat/a", project: "other" },
    ];
    expect(
      matchThreadSessions(sessions, "feat/a", "/wt/t1", "/data/devtools").map((s) => s.id),
    ).toEqual(["s2", "s3"]);
  });

  it("normalizes array node.alerts and deduplicates fleet alerts without dropping distinct details", () => {
    const hosts = mergeFleetHosts({
      localHost: { name: "host-a" },
      localServers: [],
      localSessions: [],
      localAlerts: [
        { source: "local", name: "port collision", state: "firing", detail: "port 5432 collision" },
        { source: "local", name: "port collision", state: "firing", detail: "port 8090 collision" },
        { source: "local", name: "port collision", state: "firing", detail: "port 9090 collision" },
        {
          source: "disk",
          name: "host-b:/",
          state: "firing",
          detail: "90.1% full (42.7 GB free)",
        },
      ],
      nodes: {
        "host-b": {
          status: "online",
          alerts: [
            {
              source: "disk",
              name: "host-b:/",
              state: "firing",
              detail: "90.1% full (42.7 GB free)",
            },
          ],
        },
        "host-d": {
          status: "online",
          members: ["host-d", "host-d-linux"],
          alerts: [
            {
              source: "disk",
              name: "host-d-linux:/",
              state: "ok",
              detail: "5.4% full (731.8 GB free)",
            },
          ],
        },
      },
      hostsReport: null,
      shipPanel: null,
    });

    const remoteA34 = hosts.find((h) => h.id === "host-b");
    expect(remoteA34?.alerts).toHaveLength(1);

    const aggregated = aggregateFleetAlerts(hosts);
    const firing = aggregated.filter((a) => isAlertFiring(a.alert.state));
    // All 3 distinct port collisions are preserved + 1 deduplicated disk alert = 4 firing (not 2, not 5).
    expect(firing).toHaveLength(4);
    const diskAlert = firing.find((a) => a.alert.name === "host-b:/");
    expect(diskAlert?.hostShort).toBe("host-b");
    const guestDisk = aggregated.find((a) => a.alert.name === "host-d-linux:/");
    expect(guestDisk?.hostShort).toBe("host-d");
  });

  it("selectVisibleThreadShipJobs shows live jobs, latest failed until retried/dismissed, and done only for 5 minutes", () => {
    const t0 = Date.parse("2026-11-21T12:00:00Z");
    const doneRecent = {
      id: "101",
      state: "done",
      submitted_at: "2026-11-21T11:58:00Z",
      last_marker: "DONE job=101 pr=10 at=2026-11-21T12:00:00Z",
    };
    const failedOld = {
      id: "100",
      state: "failed",
      submitted_at: "2026-11-21T11:50:00Z",
      reason: "ci",
      last_marker: "FAILED reason=ci",
    };
    const liveNew = {
      id: "102",
      state: "running",
      submitted_at: "2026-11-21T12:01:00Z",
    };

    // Live job supersedes older failed and done jobs.
    const withLive = selectVisibleThreadShipJobs([failedOld, doneRecent, liveNew], t0 + 60_000);
    expect(withLive.jobs.map((j) => j.id)).toEqual(["102"]);
    expect(withLive.lingerUntilMs).toBeNull();

    // Latest failed job stays visible (even hours later) until retried or dismissed.
    const onlyFailed = selectVisibleThreadShipJobs([failedOld], t0 + 3_600_000);
    expect(onlyFailed.jobs.map((j) => j.id)).toEqual(["100"]);
    expect(onlyFailed.lingerUntilMs).toBeNull();

    // Dismissing the failed job hides it.
    const dismissedFailed = selectVisibleThreadShipJobs(
      [failedOld],
      t0 + 3_600_000,
      new Set(["100"]),
    );
    expect(dismissedFailed.jobs).toEqual([]);

    // Done job lingers within 5 minutes and exposes exact expiry timestamp.
    const lingering = selectVisibleThreadShipJobs([failedOld, doneRecent], t0 + 4 * 60_000);
    expect(lingering.jobs.map((j) => j.id)).toEqual(["101"]);
    expect(lingering.lingerUntilMs).toBe(t0 + 5 * 60_000);

    // Once the 5-minute linger expires, neither done nor the older superseded failure shows.
    const expired = selectVisibleThreadShipJobs([failedOld, doneRecent], t0 + 5 * 60_000);
    expect(expired.jobs).toEqual([]);
    expect(expired.lingerUntilMs).toBeNull();

    // Cancelled jobs (including ship-queue's failed+reason=cancelled) hide immediately.
    const cancelled = selectVisibleThreadShipJobs(
      [
        {
          id: "103",
          state: "failed",
          reason: "cancelled",
          submitted_at: "2026-11-21T12:02:00Z",
          last_marker: "FAILED reason=cancelled",
        },
      ],
      t0 + 121_000,
    );
    expect(cancelled.jobs).toEqual([]);
  });
});
