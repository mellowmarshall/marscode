// @effect-diagnostics nodeBuiltinImport:off - Parity tests read real DevDeck snapshot fixtures and source files on disk.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { describe, expect, it } from "vite-plus/test";

import { hostHasGpuTelemetry } from "./DeckHeaderStrip";
import {
  decodeDevdeckHostTelemetry,
  decodeDevdeckHostsPanel,
  decodeDevdeckShipPanel,
} from "./devdeckSchema";
import { mergeFleetHosts } from "./devdeckTypes";
import {
  DEVTOOLS_ERROR_CODES,
  deriveFetchResourceStatus,
  deriveStreamResourceStatus,
  parseDevtoolsErrorCode,
} from "./devtoolsState";
import { resolveShipJobDisplayState } from "./ShipQueueSteps";
import { isActionableDevdeckSession, selectVisibleThreadManagedJobs } from "./threadShipStatus";
import { groupRowsByModelAndEffort } from "./usageReviewsMerge";

describe("Devtools web contract parity", () => {
  it("decodes the real DevDeck snapshot fixture, survives numeric/object wire drift, and shows GPU telemetry on all GPU hosts", () => {
    const fixtureCandidates = [
      "/home/dev/.t3/worktrees/example-repo/10d85e80-d5cc5e1cf0080568/devdeck/web/fixtures/snapshot.json",
      "/home/dev/Dev/example-repo/devdeck/web/fixtures/snapshot.json",
    ];
    const fixturePath = fixtureCandidates.find((p) => NodeFS.existsSync(p));
    if (fixturePath) {
      const fixture = JSON.parse(NodeFS.readFileSync(fixturePath, "utf8")) as Record<
        string,
        unknown
      >;
      const decodedHost = decodeDevdeckHostTelemetry(fixture.host);
      const decodedHosts = decodeDevdeckHostsPanel(fixture.hosts);
      const decodedShip = decodeDevdeckShipPanel(fixture.ship);
      expect(decodedHost).not.toBeNull();
      expect(decodedHosts).not.toBeNull();
      expect(decodedHosts?.report?.hosts?.length ?? 0).toBeGreaterThan(0);
      expect(decodedShip).not.toBeNull();
    }

    // Wire-shape edge cases: real `report.hosts`, object drift, numeric tool version, numeric `pr: 12`, array `no_grant`.
    const rawHosts = {
      report: {
        at: "2026-11-22T00:00:00Z",
        hosts: [
          {
            name: "host-c",
            platform: "linux",
            reached: true,
            tools: [{ name: "node", version: 22, state: "ok" }],
            drift: [{ text: "uv 0.7.1 → 0.7.2", state: "drift" }],
            no_grant: ["ship-queue"],
          },
          {
            name: "host-b",
            platform: "linux",
            reached: true,
            drift: [],
            no_grant: [],
          },
        ],
      },
    };
    const decoded = decodeDevdeckHostsPanel(rawHosts);
    expect(decoded).not.toBeNull();
    expect(decoded?.report?.hosts).toHaveLength(2);
    expect(decoded?.report?.hosts?.[0]?.tools?.[0]?.version).toBe("22");
    expect(decoded?.report?.hosts?.[0]?.drift).toEqual([
      { text: "uv 0.7.1 → 0.7.2", state: "drift" },
    ]);

    const decodedShipNumericPr = decodeDevdeckShipPanel({
      daemon_up: true,
      jobs: [{ id: "10945", repo: "project-b", pr: 4548, state: "running", stage: "deploy" }],
    });
    expect(decodedShipNumericPr?.jobs?.[0]?.pr).toBe("4548");

    const merged = mergeFleetHosts({
      localHost: {
        name: "host-a",
        gpu: { busy_pct: 42, vram_used: 4e9, vram_total: 17e9, busy_hist: [10, 42] },
      },
      localServers: [],
      localSessions: [],
      localAlerts: [],
      localWorktrees: null,
      nodes: {
        "host-b": {
          host: {
            name: "host-b",
            gpu: { busy_pct: 0, vram_used: 197e6, vram_total: 17_163_091_968, busy_hist: [0, 0] },
          },
        },
        "host-d": {
          host: {
            name: "host-d",
            gpu: { busy_pct: 2, vram_used: 0, vram_total: 0, busy_hist: [1, 2] },
          },
        },
      },
      hostsReport: decoded,
      shipPanel: null,
    });
    const hostB = merged.find((h) => h.id === "host-b") ?? null;
    const hostMac = merged.find((h) => h.id === "host-d") ?? null;
    const hostA = merged.find((h) => h.id === "host-a") ?? null;
    expect(hostHasGpuTelemetry(hostA)).toBe(true);
    expect(hostHasGpuTelemetry(hostB)).toBe(true);
    expect(hostHasGpuTelemetry(hostMac)).toBe(true);
  });

  it("matches server/DevDeck POST payloads for dependency decisions and CI host toggles", () => {
    const approvalsSrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "threadApprovals.ts"),
      "utf8",
    );
    expect(approvalsSrc).toContain("decision: verb");
    expect(approvalsSrc).not.toContain("{ repo: hold.repo, reportId: hold.reportId, action }");

    const fleetMachinesSrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "FleetMachinesView.tsx"),
      "utf8",
    );
    expect(fleetMachinesSrc).toMatch(/\{\s*on:\s*enabled,?\s*\}/);
    expect(fleetMachinesSrc).toContain("/devdeck/nodes/");
    expect(fleetMachinesSrc).toContain("/kick");
  });

  it("lingers clean exited/done background jobs for 5m, pins anomalous exited/failed jobs, tracks hiddenLiveCount, and drops Observed stubs", () => {
    const now = Date.parse("2026-11-22T03:00:00Z");
    const oldDone = {
      id: "bg:old",
      revision: 1,
      source: "background" as const,
      kind: "train",
      title: "Old finished run",
      phaseLabel: "Done",
      state: "done" as const,
      binding: { host: "host-a" },
      timing: { startedAt: "2026-11-22T01:00:00Z", endedAt: "2026-11-22T02:00:00Z" },
      cancellable: false,
    };
    const oldCleanExited = {
      ...oldDone,
      id: "mcp:exited-clean",
      title: "Old clean exited run",
      phaseLabel: "Exited",
      state: "exited" as const,
      timing: { startedAt: "2026-11-22T02:30:00Z", endedAt: "2026-11-22T02:50:00Z" },
    };
    const recentCleanExited = {
      ...oldCleanExited,
      id: "mcp:exited-recent",
      timing: { startedAt: "2026-11-22T02:50:00Z", endedAt: "2026-11-22T02:58:00Z" },
    };
    const anomalousExited = {
      ...oldCleanExited,
      id: "mcp:exited-anomaly",
      anomaly: "OOM killed",
    };

    expect(selectVisibleThreadManagedJobs([oldDone], now, new Set(), 5 * 60_000).jobs).toEqual([]);
    expect(
      selectVisibleThreadManagedJobs([oldCleanExited], now, new Set(), 5 * 60_000).jobs,
    ).toEqual([]);
    expect(
      selectVisibleThreadManagedJobs([recentCleanExited], now, new Set(), 5 * 60_000).jobs.map(
        (j) => j.id,
      ),
    ).toEqual(["mcp:exited-recent"]);
    expect(
      selectVisibleThreadManagedJobs(
        [anomalousExited, oldDone],
        now,
        new Set(),
        5 * 60_000,
      ).jobs.map((j) => j.id),
    ).toEqual(["mcp:exited-anomaly"]);
    expect(
      selectVisibleThreadManagedJobs(
        [anomalousExited, oldDone],
        now,
        new Set(["mcp:exited-anomaly"]),
        5 * 60_000,
      ).jobs,
    ).toEqual([]);

    const fourLive = [1, 2, 3, 4].map((n) => ({
      ...oldDone,
      id: `mcp:live-${n}`,
      state: "running" as const,
      timing: { startedAt: `2026-11-22T02:5${n}:00Z` },
    }));
    const liveSel = selectVisibleThreadManagedJobs(fourLive, now);
    expect(liveSel.jobs).toHaveLength(3);
    expect(liveSel.hiddenLiveCount).toBe(1);

    expect(
      isActionableDevdeckSession({ id: "obs1", managed: "Observed", close_allowed: false }),
    ).toBe(false);
    expect(isActionableDevdeckSession({ id: "dev1", managed: "Dev", close_allowed: true })).toBe(
      true,
    );
  });

  it("groups review stats by Model -> Effort and resolves POST_MERGE jobs as deploying", () => {
    const grouped = groupRowsByModelAndEffort([
      {
        key: "claude-fable-5-2 (medium)",
        model: "claude-fable-5-2",
        effort: "medium",
        family: "Claude Fable",
        reviews: 4,
        passed: 3,
        flagged: 1,
        bypasses: 0,
        friction: 0,
        fallbacks: 0,
        breaking: 0,
        critical: 0,
        high: 1,
        medium: 0,
        low: 0,
        info: 0,
        total: 1,
        passRatePct: 75,
        avgIssues: 0.25,
      },
      {
        key: "claude-fable-5-2 (high)",
        model: "claude-fable-5-2",
        effort: "high",
        family: "Claude Fable",
        reviews: 6,
        passed: 4,
        flagged: 2,
        bypasses: 0,
        friction: 0,
        fallbacks: 0,
        breaking: 1,
        critical: 0,
        high: 2,
        medium: 1,
        low: 0,
        info: 0,
        total: 4,
        passRatePct: 66.7,
        avgIssues: 0.67,
      },
    ]);
    expect(grouped).toHaveLength(1);
    expect(grouped[0]?.model).toBe("claude-fable-5-2");
    expect(grouped[0]?.reviews).toBe(10);
    expect(grouped[0]?.efforts.map((e) => e.effort)).toEqual(["high", "medium"]);

    expect(
      resolveShipJobDisplayState({
        id: "10945",
        repo: "project-b",
        state: "running",
        stage: "deploy",
        merge_exit: 0,
      }),
    ).toBe("deploying");
  });

  it("derives explicit resource states and keeps active-count badges off Issues and Fleet sidebar icons", () => {
    expect(
      deriveStreamResourceStatus({
        unsupported: false,
        live: false,
        hasData: false,
        error: null,
      }),
    ).toBe("connecting");
    expect(
      deriveStreamResourceStatus({
        unsupported: false,
        live: false,
        hasData: false,
        error: "DevDeck daemon is not running on this host",
      }),
    ).toBe("offline");
    expect(
      deriveStreamResourceStatus({
        unsupported: false,
        live: false,
        hasData: true,
        error: "DevDeck daemon is not running on this host",
      }),
    ).toBe("degraded");
    expect(
      deriveStreamResourceStatus({
        unsupported: true,
        live: false,
        hasData: false,
        error: null,
      }),
    ).toBe("unconfigured");
    expect(
      deriveFetchResourceStatus({
        loading: false,
        hasData: false,
        error: "HTTP 500",
      }),
    ).toBe("error");

    const sidebarChromeSrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../components/sidebar/SidebarChrome.tsx"),
      "utf8",
    );
    expect(sidebarChromeSrc).not.toContain("activeShipCount");

    const entrySrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "DevtoolsEntry.tsx"),
      "utf8",
    );
    expect(entrySrc).not.toContain("liveHostJobCount");

    // L3: validate error codes at the client boundary and keep server/web union contracts in lockstep
    expect(parseDevtoolsErrorCode("stale_state")).toBe("stale_state");
    expect(parseDevtoolsErrorCode("unknown_garbage_code")).toBeUndefined();
    const serverErrorsSrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../../server/src/devtools/DevtoolsErrors.ts"),
      "utf8",
    );
    const serverCodes = Array.from(
      serverErrorsSrc
        .match(/export type DevtoolsErrorCode =[\s\S]*?;/m)?.[0]
        .matchAll(/"([a-z_]+)"/g) ?? [],
    ).map((m) => m[1]);
    expect(serverCodes).toEqual([...DEVTOOLS_ERROR_CODES]);

    const serverJobTypesSrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "../../../server/src/devtools/jobs/types.ts"),
      "utf8",
    );
    const webJobTypesSrc = NodeFS.readFileSync(
      NodePath.resolve(import.meta.dirname, "jobs/jobTypes.ts"),
      "utf8",
    );
    const extractLogStates = (src: string) =>
      Array.from(
        src.match(/export type JobLogState =[\s\S]*?;/m)?.[0].matchAll(/"([a-z_]+)"/g) ?? [],
      ).map((m) => m[1]);
    expect(extractLogStates(webJobTypesSrc)).toEqual(extractLogStates(serverJobTypesSrc));
  });
});
