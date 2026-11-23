import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { EnvironmentPresentation } from "../../state/environments";
import { makeThreadFixture, type ThreadFixtureOverrides } from "../../test-fixtures";
import type { SidebarThreadSummary } from "../../types";
import {
  clampRatio,
  countEnvironmentThreadStates,
  formatPercent,
  formatUptime,
  metricTone,
  readMachinesTab,
  selectEnvironmentThreads,
  shortMountLabel,
  sortMachineEnvironments,
} from "./machines.logic";

function fakeEnvironment(
  id: string,
  label: string,
  phase: EnvironmentPresentation["connection"]["phase"],
): EnvironmentPresentation {
  return {
    environmentId: EnvironmentId.make(id),
    label,
    displayUrl: null,
    relayManaged: false,
    entry: {
      target: { id: EnvironmentId.make(id), label },
    } as unknown as EnvironmentPresentation["entry"],
    connection: {
      phase,
      error: null,
      traceId: null,
    } as unknown as EnvironmentPresentation["connection"],
    serverConfig: null,
    refusedRouteIds: [],
  };
}

function fakeThread(
  id: string,
  envId: string,
  overrides: ThreadFixtureOverrides = {},
): SidebarThreadSummary {
  return makeThreadFixture({
    environmentId: EnvironmentId.make(envId),
    id: ThreadId.make(id),
    title: `Thread ${id}`,
    updatedAt: "2026-11-22T10:00:00.000Z",
    ...overrides,
  });
}

describe("machines.logic", () => {
  it("parses valid machine tabs and falls back to overview", () => {
    expect(readMachinesTab("overview")).toBe("overview");
    expect(readMachinesTab("processes")).toBe("processes");
    expect(readMachinesTab("servers")).toBe("servers");
    expect(readMachinesTab("unknown")).toBe("overview");
    expect(readMachinesTab(null)).toBe("overview");
  });

  it("sorts primary environment first, then connected alphabetically, then offline", () => {
    const envs = [
      fakeEnvironment("e3", "Zeta Offline", "offline"),
      fakeEnvironment("e2", "Beta Box", "connected"),
      fakeEnvironment("e1", "Alpha Primary", "connected"),
      fakeEnvironment("e4", "Connecting Node", "connecting"),
      fakeEnvironment("e0", "Aardvark Remote", "connected"),
    ];
    const sorted = sortMachineEnvironments(envs, EnvironmentId.make("e1"));
    expect(sorted.map((e) => e.label)).toEqual([
      "Alpha Primary",
      "Aardvark Remote",
      "Beta Box",
      "Connecting Node",
      "Zeta Offline",
    ]);
  });

  it("clamps ratios and derives warning and danger thresholds", () => {
    expect(clampRatio(null)).toBeNull();
    expect(clampRatio(-0.5)).toBe(0);
    expect(clampRatio(1.4)).toBe(1);
    expect(formatPercent(null)).toBe("-");
    expect(formatPercent(0.846)).toBe("85%");
    expect(metricTone(null)).toBe("default");
    expect(metricTone(0.79)).toBe("default");
    expect(metricTone(0.8)).toBe("warning");
    expect(metricTone(0.92)).toBe("danger");
  });

  it("formats uptime and short mount labels cleanly", () => {
    expect(formatUptime(null)).toBeNull();
    expect(formatUptime(30)).toBe("<1m");
    expect(formatUptime(18 * 60)).toBe("18m");
    expect(formatUptime(3 * 3600 + 12 * 60)).toBe("3h 12m");
    expect(formatUptime(4 * 86400 + 6 * 3600)).toBe("4d 6h");

    expect(shortMountLabel("/")).toBe("/");
    expect(shortMountLabel("C:\\")).toBe("C:");
    expect(shortMountLabel("/data")).toBe("/data");
    expect(shortMountLabel("/var/lib/containers/storage/volumes")).toBe("…/storage/volumes");
  });

  it("selects and ranks environment threads by urgency then recency while excluding archived", () => {
    const envA = EnvironmentId.make("env-a");
    const envB = EnvironmentId.make("env-b");
    const threads = [
      fakeThread("ready-new", "env-a", { updatedAt: "2026-11-22T12:00:00.000Z" }),
      fakeThread("archived", "env-a", {
        archivedAt: "2026-11-22T12:30:00.000Z",
        hasPendingApprovals: true,
      }),
      fakeThread("other-env", "env-b", { hasPendingApprovals: true }),
      fakeThread("working", "env-a", {
        updatedAt: "2026-11-22T09:00:00.000Z",
        runtime: {
          status: "running",
          lastError: null,
          lastErrorClass: null,
        } as SidebarThreadSummary["runtime"],
      }),
      fakeThread("approval", "env-a", {
        updatedAt: "2026-11-22T08:00:00.000Z",
        hasPendingApprovals: true,
      }),
      fakeThread("failed", "env-a", {
        updatedAt: "2026-11-22T11:00:00.000Z",
        runtime: {
          status: "failed",
          lastError: "boom",
          lastErrorClass: null,
        } as SidebarThreadSummary["runtime"],
      }),
    ];

    const selected = selectEnvironmentThreads(threads, envA);
    expect(selected.map((t) => t.id)).toEqual(["approval", "working", "failed", "ready-new"]);

    expect(countEnvironmentThreadStates(threads, envA)).toEqual({
      total: 4,
      active: 1,
      attention: 2,
    });
    expect(countEnvironmentThreadStates(threads, envB)).toEqual({
      total: 1,
      active: 0,
      attention: 1,
    });
  });
});
