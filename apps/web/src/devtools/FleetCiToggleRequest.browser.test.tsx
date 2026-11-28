import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const posts: Array<{ readonly path: string; readonly body: unknown }> = [];

vi.mock("./devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./devtoolsClient")>();
  return {
    ...actual,
    // The Fleet view sends every host action through this; record what it would POST.
    runTrackedDevdeckAction: (_envId: string, path: string, body?: unknown) => {
      posts.push({ path, body });
      return Promise.resolve({ ok: true });
    },
  };
});

import "~/index.css";
import "./fleetDeck.css";
import { render } from "../../test/render";
import { TooltipProvider } from "../components/ui/tooltip";
import { mergeFleetHosts } from "./devdeckTypes";
import { FleetMachinesView } from "./FleetMachinesView";

const OFF_AT = "2026-11-28T11:00:00.000Z";
const VERSION = "3f2a9c0d4b5e6f708192a3b4c5d6e7f8";

const hosts = mergeFleetHosts({
  localHost: { name: "host-a", cpu_pct: 12 },
  localServers: [],
  localSessions: [],
  localAlerts: [],
  localWorktrees: null,
  nodes: { "host-b": { status: "online", host: { name: "host-b", cpu_pct: 40 } } },
  hostsReport: {
    report: {
      hosts: [
        { name: "host-a", ssh: null, ci_off: false },
        {
          name: "host-b",
          ssh: "host-b",
          ci_off: true,
          ci_off_at: OFF_AT,
          ci_off_version: VERSION,
          ci_off_by: "owner",
          ci_off_reason: "runs a long simulation; keep CI off",
        },
      ],
    },
  },
  shipPanel: null,
});

describe("Fleet CI toggle requests", () => {
  it("sends a turn-off as one unconfirmed request, and a confirmed turn-on with the shown marker time", async () => {
    posts.length = 0;
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={EnvironmentId.make("env-local")}
          hosts={hosts}
          selectedHost={hosts[0] ?? null}
          hostJobs={[]}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );

    await page.getByRole("switch", { name: "Disable CI on host-a" }).click();
    await expect
      .poll(() => posts)
      .toContainEqual({
        path: "/hosts/host-a/ci",
        body: { on: false, confirm: false, client: "fleet-console" },
      });

    await page.getByRole("switch", { name: "Enable CI on host-b" }).click();
    expect(posts.filter((p) => p.path === "/hosts/host-b/ci")).toEqual([]);
    await page.getByRole("button", { name: "Turn CI on" }).click();
    await expect
      .poll(() => posts)
      .toContainEqual({
        path: "/hosts/host-b/ci",
        body: { on: true, confirm: true, confirm_version: VERSION, client: "fleet-console" },
      });
  });
});
