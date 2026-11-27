import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import type { MergedFleetHost } from "./devdeckTypes";
import {
  matchHostEnvironmentId,
  mergeRemoteEnvironmentJobs,
  normalizeFleetHostToken,
  resolveFleetJobTarget,
} from "./fleetHostEnvironment";
import type { JobSummary } from "./jobs/jobTypes";

function makeHost(overrides: Partial<MergedFleetHost>): MergedFleetHost {
  return {
    id: "host-c",
    shortName: "host-c",
    probeHostName: "host-c",
    isLocal: false,
    hasDevdeckNode: true,
    status: "online",
    problem: null,
    platform: "linux",
    ssh: "host-c-wsl",
    note: null,
    telemetry: null,
    power: null,
    powerSaver: false,
    members: [],
    probe: null,
    ciOff: false,
    ciOffReason: null,
    drift: [],
    notes: [],
    servers: [],
    sessions: [],
    alerts: [],
    worktrees: null,
    error: null,
    ...overrides,
  };
}

function makeJob(id: string, overrides: Partial<JobSummary> = {}): JobSummary {
  return {
    id,
    revision: 1,
    source: "background",
    kind: "test",
    title: `job ${id}`,
    phaseLabel: "Running",
    state: "running",
    binding: { host: "" },
    timing: { startedAt: "2026-11-25T07:00:00Z" },
    cancellable: true,
    ...overrides,
  };
}

describe("Fleet host environment matching", () => {
  it("normalizes host labels by case, WSL suffix, .local suffix, and punctuation", () => {
    expect(normalizeFleetHostToken("Host-C WSL")).toBe("hostc");
    expect(normalizeFleetHostToken("host-c-wsl WSL")).toBe("hostc");
    expect(normalizeFleetHostToken("box_wsl")).toBe("box");
    expect(normalizeFleetHostToken("Dev-Model-7X")).toBe("devmodel7x");
    expect(normalizeFleetHostToken("host-d.local")).toBe("hostd");
    expect(normalizeFleetHostToken(null)).toBe("");
  });

  it("matches a remote host to its linked environment by a WSL label or its SSH alias", () => {
    const active = EnvironmentId.make("env-local");
    const hostCEnv = EnvironmentId.make("env-host-c");
    const environments = [
      { environmentId: active, label: "This machine", serverConfig: null },
      { environmentId: hostCEnv, label: "host-c-wsl WSL", serverConfig: null },
    ];
    expect(matchHostEnvironmentId(makeHost({}), active, environments)).toBe(hostCEnv);
    // Only the SSH alias names the peer.
    const byAlias = makeHost({ id: "alias-only", shortName: "alias-only", probeHostName: null });
    expect(matchHostEnvironmentId(byAlias, active, environments)).toBe(hostCEnv);
    expect(matchHostEnvironmentId(makeHost({ isLocal: true }), active, environments)).toBe(active);
    expect(
      matchHostEnvironmentId(
        makeHost({ id: "other", shortName: "other", probeHostName: null, ssh: null }),
        active,
        environments,
      ),
    ).toBeNull();
  });

  it("never matches the active environment for a remote host", () => {
    const active = EnvironmentId.make("env-local");
    const environments = [{ environmentId: active, label: "host-c", serverConfig: null }];
    expect(matchHostEnvironmentId(makeHost({}), active, environments)).toBeNull();
  });

  it("keeps same-id local and remote jobs apart and routes each to its environment", () => {
    const active = EnvironmentId.make("env-local");
    const hostCEnv = EnvironmentId.make("env-host-c");
    const local = [makeJob("a"), makeJob("sq", { source: "ship-queue" })];
    const remote = [
      makeJob("r1", { binding: { host: "DESKTOP-123" } }),
      makeJob("a"),
      makeJob("sq2", { source: "ship-queue" }),
    ];
    const merged = mergeRemoteEnvironmentJobs({
      activeEnvironmentId: active,
      localJobs: local,
      remoteEnvironmentId: hostCEnv,
      remoteJobs: remote,
      remoteHost: makeHost({}),
    });
    const keys = merged.jobs.map((j) => j.id);
    expect(keys).toEqual(["a", "env:env-host-c:r1", "env:env-host-c:a"]);
    for (const j of merged.jobs.slice(1)) expect(j.binding.host).toBe("host-c");
    expect(merged.jobs[0]!.binding.host).toBe("");
    expect(resolveFleetJobTarget(merged.targets, "a", active)).toEqual({
      environmentId: active,
      jobId: "a",
    });
    expect(resolveFleetJobTarget(merged.targets, "env:env-host-c:a", active)).toEqual({
      environmentId: hostCEnv,
      jobId: "a",
    });
    expect(resolveFleetJobTarget(merged.targets, "unknown", active)).toEqual({
      environmentId: active,
      jobId: "unknown",
    });

    for (const remoteHost of [null, makeHost({ isLocal: true })]) {
      const only = mergeRemoteEnvironmentJobs({
        activeEnvironmentId: active,
        localJobs: local,
        remoteEnvironmentId: hostCEnv,
        remoteJobs: remote,
        remoteHost,
      });
      expect(only.jobs.map((j) => j.id)).toEqual(["a"]);
    }
    const sameEnv = mergeRemoteEnvironmentJobs({
      activeEnvironmentId: active,
      localJobs: local,
      remoteEnvironmentId: active,
      remoteJobs: remote,
      remoteHost: makeHost({}),
    });
    expect(sameEnv.jobs.map((j) => j.id)).toEqual(["a"]);
  });
});
