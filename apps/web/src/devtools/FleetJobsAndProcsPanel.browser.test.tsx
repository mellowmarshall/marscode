import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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

    await expect.element(screen.getByText("1 live")).toBeVisible();
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

    await expect.element(screen.getByRole("button", { name: "Kill cargo" })).toBeVisible();
    expect(screen.getByText("View only").elements()).toHaveLength(0);
  });
});

const GiB = 1024 ** 3;

function localJob(
  id: string,
  title: string,
  state: JobSummary["state"],
  extra: Partial<JobSummary> = {},
): JobSummary {
  return {
    id,
    revision: 1,
    source: "background",
    kind: "command",
    title,
    phaseLabel: state,
    state,
    binding: { host: "host-a" },
    timing: { startedAt: "2026-11-25T07:00:00Z" },
    cancellable: state === "running",
    ...extra,
  };
}

const busyHost = makeHost({
  id: "host-a",
  shortName: "host-a",
  probeHostName: "host-a",
  isLocal: true,
  ssh: null,
  telemetry: { name: "host-a", cpus: 16, mem: { used: 40 * GiB, total: 64 * GiB } },
});

describe("FleetJobsAndProcsPanel load and stop", () => {
  it("shows each live job's CPU and memory as a share of the host, heaviest first, and hides finished jobs until asked", async () => {
    await using screen = await render(
      <FleetJobsAndProcsPanel
        host={busyHost}
        hostJobs={[
          localJob("bg:light", "Light job", "running", {
            load: { cpuPct: 80, memBytes: 1 * GiB, processCount: 1 },
          }),
          localJob("bg:heavy", "Heavy build", "running", {
            load: { cpuPct: 1360, memBytes: 6 * GiB, processCount: 12 },
          }),
          localJob("bg:old", "Finished build", "done", {
            timing: { startedAt: "2026-11-25T06:00:00Z", endedAt: "2026-11-25T06:30:00Z" },
          }),
        ]}
        nowMs={NOW_MS}
        busyKeys={new Set()}
        onInspectJob={noop}
        onCancelJob={noop}
        onCloseSession={noop}
      />,
    );

    await expect.element(screen.getByText("Heavy build")).toBeVisible();
    const titles = () =>
      Array.from(
        screen.container.querySelectorAll(
          '[data-testid="fleet-job-row"] button span span:first-child',
        ),
      ).map((el) => el.textContent);
    expect(titles()).toEqual(["Heavy build", "Light job"]);
    // 13.6 cores of 16 is 85% of the host; 6 GiB of 64 GiB is 9%.
    await expect.element(screen.getByText("85%")).toBeVisible();
    await expect.element(screen.getByText("6.0 GiB")).toBeVisible();
    expect(screen.container.textContent).not.toContain("Finished build");

    await userEvent.click(screen.getByRole("button", { name: "Show 1 finished" }));
    await expect.element(screen.getByText("Finished build")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Hide 1 finished" }));
    expect(screen.container.textContent).not.toContain("Finished build");
  });

  it("stops a job only after the owner confirms", async () => {
    const onCancelJob = vi.fn();
    await using screen = await render(
      <FleetJobsAndProcsPanel
        host={busyHost}
        hostJobs={[
          localJob("bg:heavy", "Heavy build", "running", {
            load: { cpuPct: 1360, memBytes: 6 * GiB, processCount: 12 },
          }),
        ]}
        nowMs={NOW_MS}
        busyKeys={new Set()}
        onInspectJob={noop}
        onCancelJob={onCancelJob}
        onCloseSession={noop}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: "Stop thread for Heavy build" }));
    expect(onCancelJob).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.getByRole("button", { name: "Confirm stop" }).elements()).toHaveLength(0);

    await userEvent.click(screen.getByRole("button", { name: "Stop thread for Heavy build" }));
    await userEvent.click(screen.getByRole("button", { name: "Confirm stop" }));
    expect(onCancelJob).toHaveBeenCalledWith("bg:heavy");
  });
});
