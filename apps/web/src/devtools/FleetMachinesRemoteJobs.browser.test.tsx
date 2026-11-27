import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const fetchCalls: Array<{
  readonly envId: string;
  readonly path: string;
  readonly method: string;
}> = [];

vi.mock("./devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./devtoolsClient")>();
  return {
    ...actual,
    fetchDevtoolsJson: (envId: string, path: string, opts?: { readonly method?: string }) => {
      fetchCalls.push({ envId, path, method: opts?.method ?? "GET" });
      if (path.startsWith("/jobs/") && !path.endsWith("/cancel")) {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: { id: "bg:same", revision: 1, logState: "no_output", logTail: [] },
          error: null,
        });
      }
      return Promise.resolve({ ok: true, status: 200, data: { ok: true }, error: null });
    },
  };
});

import "~/index.css";
import "./fleetDeck.css";
import { render } from "../../test/render";
import { TooltipProvider } from "../components/ui/tooltip";
import { mergeFleetHosts } from "./devdeckTypes";
import { mergeRemoteEnvironmentJobs } from "./fleetHostEnvironment";
import { FleetMachinesView } from "./FleetMachinesView";
import type { JobSummary } from "./jobs/jobTypes";

const LOCAL_ENV = EnvironmentId.make("env-local");
const REMOTE_ENV = EnvironmentId.make("env-host-c");

function job(title: string, host: string, threadId: string): JobSummary {
  return {
    id: "bg:same",
    revision: 1,
    source: "background",
    kind: "train",
    title,
    phaseLabel: "Training",
    state: "running",
    binding: { host, threadId },
    timing: { startedAt: "2026-11-25T07:00:00Z" },
    cancellable: true,
  };
}

const hosts = mergeFleetHosts({
  localHost: { name: "host-a", cpu_pct: 12 },
  localServers: [],
  localSessions: [],
  localAlerts: [],
  localWorktrees: null,
  nodes: { "host-c": { status: "online", host: { name: "host-c", cpu_pct: 40 } } },
  hostsReport: null,
  shipPanel: null,
});
const localHost = hosts.find((h) => h.isLocal)!;
const hostC = hosts.find((h) => h.id === "host-c")!;

// The same job id exists in both environments.
const merged = mergeRemoteEnvironmentJobs({
  activeEnvironmentId: LOCAL_ENV,
  localJobs: [job("Local same-id job", "host-a", "thread-local")],
  remoteEnvironmentId: REMOTE_ENV,
  remoteJobs: [job("Remote same-id job", "", "thread-remote")],
  remoteHost: hostC,
});
const remoteKey = merged.jobs.find((j) => j.title === "Remote same-id job")!.id;

function view(selectedHost: typeof localHost, selectedJobId: string | null) {
  return (
    <TooltipProvider delay={0}>
      <FleetMachinesView
        environmentId={LOCAL_ENV}
        hosts={hosts}
        selectedHost={selectedHost}
        hostJobs={merged.jobs}
        jobTargets={merged.targets}
        selectedJobId={selectedJobId}
        onFeedback={() => {}}
      />
    </TooltipProvider>
  );
}

describe("FleetMachinesView remote environment jobs", () => {
  it("shows same-id local and remote jobs on their own hosts and cancels each in its own environment", async () => {
    fetchCalls.length = 0;
    await using screen = await render(view(hostC, null));
    await expect.element(page.getByText("Remote same-id job")).toBeVisible();
    expect(document.body.textContent).not.toContain("Local same-id job");

    await userEvent.click(page.getByRole("button", { name: "Stop thread for Remote same-id job" }));
    await userEvent.click(page.getByRole("button", { name: "Confirm stop" }));
    await expect
      .poll(() => fetchCalls.filter((c) => c.method === "POST"))
      .toContainEqual({ envId: REMOTE_ENV, path: "/jobs/bg%3Asame/cancel", method: "POST" });

    await screen.rerender(view(localHost, null));
    await expect.element(page.getByText("Local same-id job")).toBeVisible();
    expect(document.body.textContent).not.toContain("Remote same-id job");
    fetchCalls.length = 0;
    await userEvent.click(page.getByRole("button", { name: "Stop thread for Local same-id job" }));
    await userEvent.click(page.getByRole("button", { name: "Confirm stop" }));
    await expect
      .poll(() => fetchCalls.filter((c) => c.method === "POST"))
      .toContainEqual({ envId: LOCAL_ENV, path: "/jobs/bg%3Asame/cancel", method: "POST" });
  });

  it("inspects a remote job and opens its thread in the remote environment", async () => {
    fetchCalls.length = 0;
    await using screen = await render(view(hostC, remoteKey));
    const drawer = page.getByTestId("job-inspector-drawer");
    await expect.element(drawer).toBeVisible();
    await expect
      .poll(() => fetchCalls.some((c) => c.envId === REMOTE_ENV && c.path === "/jobs/bg%3Asame"))
      .toBe(true);
    expect(fetchCalls.some((c) => c.envId === LOCAL_ENV && c.path.startsWith("/jobs/"))).toBe(
      false,
    );

    await userEvent.click(drawer.getByRole("button", { name: "Open thread" }));
    await expect
      .poll(() => screen.router?.state.location.pathname)
      .toBe(`/${REMOTE_ENV}/thread-remote`);
  });
});
