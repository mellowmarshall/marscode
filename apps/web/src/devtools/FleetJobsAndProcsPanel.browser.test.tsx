import { describe, expect, it } from "vite-plus/test";

import "~/index.css";
import { render } from "../../test/render";
import type { DevdeckSessionItem, MergedFleetHost } from "./devdeckTypes";
import { FleetJobsAndProcsPanel } from "./FleetJobsAndProcsPanel";
import type { JobSummary } from "./jobs/jobTypes";

const NOW_MS = Date.parse("2026-11-25T07:10:00Z");

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

// The shape the server sends for a remote host: no PID, command line, or path.
const remoteSessions: ReadonlyArray<DevdeckSessionItem> = [
  {
    id: "remote:0:cargo",
    kind: "process",
    name: "cargo",
    cpu_pct: 95,
    mem_bytes: 512 * 1024 * 1024,
    high: true,
    runaway: true,
    close_allowed: false,
    close_blocked_reason: "Close remote processes from their own host",
  },
  {
    id: "remote:1:postgres",
    kind: "process",
    name: "postgres",
    cpu_pct: 0,
    mem_bytes: 400 * 1024 * 1024,
    high: true,
    close_allowed: false,
  },
];

const remoteJob: JobSummary = {
  id: "bg:remote-train",
  revision: 1,
  source: "background",
  kind: "train",
  title: "Remote distillation run",
  phaseLabel: "Stage 2",
  state: "running",
  binding: { host: "host-c" },
  timing: { startedAt: "2026-11-25T07:00:00Z" },
  cancellable: false,
};

const noop = () => undefined;

describe("FleetJobsAndProcsPanel remote host", () => {
  it("shows a remote host's hot processes as view-only rows next to its jobs", async () => {
    await using screen = await render(
      <FleetJobsAndProcsPanel
        host={makeHost({ sessions: remoteSessions })}
        hostJobs={[remoteJob]}
        nowMs={NOW_MS}
        busyKeys={new Set()}
        onInspectJob={noop}
        onCancelJob={noop}
        onCloseSession={noop}
      />,
    );

    await expect.element(screen.getByText("1 jobs · 2 procs")).toBeVisible();
    await expect.element(screen.getByText("Remote distillation run")).toBeVisible();
    await expect.element(screen.getByText("cargo")).toBeVisible();
    await expect.element(screen.getByText("postgres")).toBeVisible();
    expect(screen.getByText("View only").elements()).toHaveLength(2);
    expect(screen.getByRole("button", { name: /^Kill/ }).elements()).toHaveLength(0);
    expect(screen.container.textContent).not.toContain("PID");
  });

  it("keeps kill controls for the local host's closable processes", async () => {
    await using screen = await render(
      <FleetJobsAndProcsPanel
        host={makeHost({
          isLocal: true,
          sessions: [{ ...remoteSessions[0]!, id: "proc:42:1", pid: 42, close_allowed: true }],
        })}
        hostJobs={[]}
        nowMs={NOW_MS}
        busyKeys={new Set()}
        onInspectJob={noop}
        onCancelJob={noop}
        onCloseSession={noop}
      />,
    );

    await expect.element(screen.getByRole("button", { name: "Kill" })).toBeVisible();
    expect(screen.getByText("View only").elements()).toHaveLength(0);
  });
});
