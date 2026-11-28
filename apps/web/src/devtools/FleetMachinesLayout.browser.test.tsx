import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import "./fleetDeck.css";
import { render } from "../../test/render";
import { TooltipProvider } from "../components/ui/tooltip";
import { mergeFleetHosts, type DevdeckHostsPanel } from "./devdeckTypes";
import { FleetMachinesView } from "./FleetMachinesView";
import type { JobSummary } from "./jobs/jobTypes";

const ENV = EnvironmentId.make("env-local");
const GiB = 1024 ** 3;

// The server lists manifest hosts with only their CI state before the first hosts check.
const unprobedReport: DevdeckHostsPanel = {
  report: {
    hosts: [
      { name: "host-a", ssh: null, ci_off: false },
      { name: "host-b", ssh: "host-b", ci_off: true, ci_off_reason: "turned off in T3 Code" },
    ],
  },
};

const hosts = mergeFleetHosts({
  localHost: { name: "host-a", cpus: 16, cpu_pct: 90, mem: { used: 50 * GiB, total: 64 * GiB } },
  localServers: Array.from({ length: 4 }, (_, i) => ({
    id: `srv-${i}`,
    kind: "dev",
    service: `service ${i}`,
    port: 5000 + i,
    state: "running",
  })),
  localSessions: [],
  localAlerts: [],
  localWorktrees: null,
  nodes: { "host-b": { status: "online", host: { name: "host-b", cpus: 8, cpu_pct: 4 } } },
  hostsReport: unprobedReport,
  shipPanel: null,
});

const manyJobs: ReadonlyArray<JobSummary> = Array.from({ length: 30 }, (_, i) => ({
  id: `bg:${i}`,
  revision: 1,
  source: "background",
  kind: "command",
  title: `job ${i}`,
  phaseLabel: "Running",
  state: "running",
  binding: { host: "host-a", worktreePath: "/home/dev/project-a" },
  timing: { startedAt: "2026-11-25T07:00:00Z" },
  load: { cpuPct: 50 + i, memBytes: GiB, processCount: 1 },
  cancellable: true,
}));

describe("FleetMachinesView layout", () => {
  it("puts host load and localhosts side by side and scrolls rows inside the panels, not the console", async () => {
    await page.viewport(1440, 900);
    const hostA = hosts.find((h) => h.id === "host-a")!;
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div data-fd="root" className="flex flex-col" style={{ width: 1440, height: 852 }}>
          <FleetMachinesView
            environmentId={ENV}
            hosts={hosts}
            selectedHost={hostA}
            hostJobs={manyJobs}
            selectedJobId={null}
            onFeedback={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    await expect.element(screen.getByText("job 0", { exact: true })).toBeInTheDocument();

    const load = document.querySelector<HTMLElement>('[data-testid="fleet-load-panel"]')!;
    const localhosts = document.querySelector<HTMLElement>(
      '[data-testid="fleet-localhosts-panel"]',
    )!;
    const loadBox = load.getBoundingClientRect();
    const localBox = localhosts.getBoundingClientRect();
    expect(localBox.top).toBe(loadBox.top);
    expect(loadBox.right).toBeLessThanOrEqual(localBox.left);

    const body = document.querySelector<HTMLElement>('[data-testid="fleet-machines-body"]')!;
    expect(body.scrollHeight).toBeLessThanOrEqual(body.clientHeight + 1);
    const rows = load.querySelector<HTMLElement>('[data-testid="fleet-job-row"]')!.parentElement!;
    expect(rows.scrollHeight).toBeGreaterThan(rows.clientHeight);

    expect(screen.container.textContent).not.toContain("Threads");
  });

  it("shows the CI switch on every manifest host before any hosts check", async () => {
    const hostB = hosts.find((h) => h.id === "host-b")!;
    await using screen = await render(
      <TooltipProvider delay={0}>
        <div data-fd="root">
          <FleetMachinesView
            environmentId={ENV}
            hosts={hosts}
            selectedHost={hostB}
            hostJobs={[]}
            selectedJobId={null}
            onFeedback={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    await expect
      .element(screen.getByRole("switch", { name: "Disable CI on host-a" }))
      .toHaveAttribute("aria-checked", "true");
    await expect
      .element(screen.getByRole("switch", { name: "Enable CI on host-b" }))
      .toHaveAttribute("aria-checked", "false");
  });
});
