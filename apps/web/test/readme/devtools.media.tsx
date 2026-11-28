import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import type { JobSummary } from "../../src/devtools/jobs/jobTypes";

const shipState = vi.hoisted(() => ({ jobs: [] as ReadonlyArray<JobSummary> }));

vi.mock("../../src/devtools/devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/devtools/devtoolsClient")>();
  return { ...actual, fetchDevtoolsJson: (_env: string, path: string) => mockFetch(path) };
});

vi.mock("../../src/devtools/jobs/jobsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/devtools/jobs/jobsStore")>();
  return {
    ...actual,
    useSharedJobs: () => ({
      jobs: shipState.jobs,
      jobsById: new Map(shipState.jobs.map((j) => [j.id, j])),
      queueMeta: {},
      live: true,
      error: null,
      unsupported: false,
      legacyFallback: false,
      status: "ready" as const,
    }),
  };
});

vi.mock("../../src/state/environments", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/state/environments")>();
  return { ...actual, usePrimaryEnvironmentId: () => "env-local" };
});

import "~/index.css";
import "../../src/devtools/fleetDeck.css";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { FleetMachinesView } from "../../src/devtools/FleetMachinesView";
import { FleetReaperTab } from "../../src/devtools/FleetReaperTab";
import { SecuritySettingsPanel } from "../../src/devtools/SecuritySettingsPanel";
import { ShipQueueJobDetails } from "../../src/devtools/ShipQueueJobDetails";
import { ShipQueuePanel } from "../../src/devtools/ShipQueuePanel";
import { UsageReviewsPanel } from "../../src/devtools/UsageReviewsPanel";
import { render } from "../render";
import { captureMedia, MediaFrame } from "./readmeMediaCapture";
import {
  fleetHosts,
  fleetJobs,
  jobFromShip,
  securityGrants,
  shipJobStages,
  shipJobWithSteps,
  shipQueueHistory,
} from "./readmeMediaFixtures";

const ENV = EnvironmentId.make("env-local");
const NOW = Date.now();

function ok(data: unknown) {
  return Promise.resolve({ ok: true, status: 200, data, error: null });
}

const reviewTotals = {
  bypasses: 0,
  friction: 0,
  fallbacks: 0,
  breaking: 1,
  critical: 0,
  high: 3,
  medium: 4,
  low: 2,
  info: 0,
};

function mockFetch(path: string) {
  switch (path) {
    case "/reaper/status":
      return ok({
        ok: true,
        exitCode: 0,
        data: {
          protected: { sessions: 24, worktrees: 12, paths: 310 },
          orphan_candidates: [],
          stale_tmp: { max_age_hours: 24, roots: ["/tmp"], dirs: 2, files: 9 },
          cargo_last_run: { last_run: new Date(NOW - 6 * 3_600_000).toISOString(), age_s: 21600 },
        },
      });
    case "/reaper/policy":
      return ok({
        policyPath: "/home/dev/.config/reaper/policy.toml",
        rules: [{ path: "/srv/results", maxAgeDays: 14, keepLatest: 3, enabled: true }],
        protectedHistoryRoots: [],
      });
    case "/storage/scan":
      return ok({
        manifest: null,
        storageCleanupReport: null,
        hostScan: {
          host: "host-a",
          scanned_at: new Date(NOW - 600_000).toISOString(),
          high_pressure: false,
          mounts: [
            { mount: "/", used_pct: 38, avail_bytes: 620 * 1024 ** 3 },
            { mount: "/srv", used_pct: 61, avail_bytes: 780 * 1024 ** 3 },
          ],
        },
      });
    case "/review-stats":
      return ok({
        side: "reviewer",
        by: "model",
        totals: {
          key: "all",
          reviews: 18,
          passed: 13,
          flagged: 5,
          total: 10,
          passRatePct: 72,
          avgIssues: 0.6,
          ...reviewTotals,
        },
        groups: [
          {
            key: "model-a (high)",
            model: "model-a",
            effort: "high",
            family: "Family A",
            reviews: 11,
            passed: 8,
            flagged: 3,
            total: 6,
            passRatePct: 73,
            avgIssues: 0.5,
            ...reviewTotals,
          },
          {
            key: "model-b (medium)",
            model: "model-b",
            effort: "medium",
            family: "Family B",
            reviews: 7,
            passed: 5,
            flagged: 2,
            total: 4,
            passRatePct: 71,
            avgIssues: 0.6,
            ...reviewTotals,
            breaking: 0,
          },
        ],
        recent: [],
        highlights: { topBugSubmitter: null, topBugCatcher: null },
        facets: {
          repos: ["example-repo"],
          labs: ["Lab A"],
          families: ["Family A", "Family B"],
          hosts: ["host-a"],
        },
      });
    case "/guards/grants":
      return ok({ grants: securityGrants(NOW) });
    case "/guards/audit?limit=40":
      return ok({
        entries: [
          {
            ts: new Date(NOW - 5 * 60_000).toISOString(),
            eventType: "grant_used",
            guard: "protected-paths",
            scope: "example-org/example-repo",
            summary: "CI workflow and lockfile change for #42",
          },
          {
            ts: new Date(NOW - 20 * 60_000).toISOString(),
            eventType: "grant_approved",
            guard: "protected-paths",
            scope: "example-org/example-repo",
            summary: "Approved once from the review modal",
          },
        ],
      });
    case "/jobs/ship%3A1043":
      return ok({
        id: "ship:1043",
        revision: 1,
        series: [],
        logTail: [
          "CHALLENGED job=1043 report=review.md",
          "OVERRIDDEN job=1043 reason=The flagged file is generated",
          "PUSH_EXIT=0",
          "PR=88",
          "MERGE_EXIT=0",
          "SYNC_EXIT=0",
        ],
      });
    case "/guards/exceptions":
      return ok({ path: null, entries: null, waivers: [] });
    default:
      return Promise.resolve({ ok: false, status: 404, data: null, error: "Not found" });
  }
}

describe("README media: DevTools", () => {
  it("fleet console", async () => {
    const hostA = fleetHosts.find((h) => h.isLocal)!;
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="fleet-console" width={1100}>
          <FleetMachinesView
            environmentId={ENV}
            hosts={fleetHosts}
            selectedHost={hostA}
            hostJobs={fleetJobs(NOW)}
            selectedJobId={null}
            onFeedback={() => {}}
          />
        </MediaFrame>
      </TooltipProvider>,
    );
    await expect.element(page.getByText("Model fine-tune run").first()).toBeVisible();
    await captureMedia("fleet-console");
  });

  it("ship queue, with a job moving through every step", async () => {
    const stages = shipJobStages(NOW);
    const history = shipQueueHistory(NOW).map(jobFromShip);
    const view = (stage: number) => {
      shipState.jobs = [jobFromShip(stages[stage]!), ...history];
      return (
        <TooltipProvider delay={0}>
          <MediaFrame name="ship-queue" width={900} minHeight={336}>
            <ShipQueuePanel environmentId={ENV} />
          </MediaFrame>
        </TooltipProvider>
      );
    };
    await using screen = await render(view(1));
    await expect.element(page.getByText("feat(web): add search filters")).toBeVisible();
    for (const [stage] of stages.entries()) {
      await screen.rerender(view(stage));
      await captureMedia(`frames/ship-queue/${String(stage).padStart(2, "0")}`, "ship-queue");
    }
    await screen.rerender(view(3));
    await captureMedia("ship-queue");
  });

  it("ship job steps with per-step timing", async () => {
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="ship-steps" width={900}>
          <ShipQueueJobDetails job={shipJobWithSteps(NOW)} environmentId={ENV} revision={1} />
        </MediaFrame>
      </TooltipProvider>,
    );
    await expect.element(page.getByText("ship_ci", { exact: true })).toBeVisible();
    await expect.element(page.getByText("SYNC_EXIT=0")).toBeVisible();
    await captureMedia("ship-steps");
  });

  it("reaper", async () => {
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="reaper" width={1000}>
          <FleetReaperTab
            environmentId={ENV}
            localHostName="host-a"
            mergedWorktreesCount={3}
            onFeedback={() => {}}
          />
        </MediaFrame>
      </TooltipProvider>,
    );
    await expect.element(page.getByLabelText("Cleanup directory path")).toHaveValue("/srv/results");
    await captureMedia("reaper");
  });

  it("reviews", async () => {
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="reviews" width={1000}>
          <UsageReviewsPanel environmentIds={[ENV]} windowDays={30} />
        </MediaFrame>
      </TooltipProvider>,
    );
    await expect.element(page.getByText("model-a", { exact: true })).toBeVisible();
    await captureMedia("reviews");
  });

  it("security", async () => {
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="security" width={900}>
          <SecuritySettingsPanel />
        </MediaFrame>
      </TooltipProvider>,
    );
    await expect.element(page.getByText("Deploy key for project-a")).toBeVisible();
    await captureMedia("security");
  });
});
