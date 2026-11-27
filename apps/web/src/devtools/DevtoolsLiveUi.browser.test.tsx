import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

const fetchSpy = vi.fn();

vi.mock("./devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./devtoolsClient")>();
  return {
    ...actual,
    fetchDevtoolsJson: (...args: unknown[]) => fetchSpy(...args),
  };
});

vi.mock("./jobs/jobsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jobs/jobsStore")>();
  return {
    ...actual,
    useSharedJobs: (envId: string | null) =>
      envId === "unsupported-host"
        ? {
            jobs: [],
            jobsById: new Map(),
            queueMeta: {},
            live: false,
            error: null,
            unsupported: true,
            legacyFallback: false,
            status: "unconfigured" as const,
          }
        : {
            jobs: [],
            jobsById: new Map(),
            queueMeta: {},
            live: true,
            error: null,
            unsupported: false,
            legacyFallback: false,
            status: "ready" as const,
          },
  };
});

import "~/index.css";
import "./fleetDeck.css";
import { render } from "../../test/render";
import { ComposerPendingApprovalActions } from "../components/chat/ComposerPendingApprovalActions";
import { TooltipProvider } from "../components/ui/tooltip";
import { DeckHeaderStrip } from "./DeckHeaderStrip";
import { mergeFleetHosts } from "./devdeckTypes";
import { DevtoolsErrorBoundary } from "./DevtoolsErrorBoundary";
import { FleetMachinesView } from "./FleetMachinesView";
import { FleetReaperTab } from "./FleetReaperTab";
import { ShipQueuePanel } from "./ShipQueuePanel";
import { ShipQueueVerticalTracker } from "./ShipQueueVerticalTracker";
import { ThreadManagedJobCard } from "./jobs/ThreadManagedJobCard";
import { UsageReviewsPanel } from "./UsageReviewsPanel";

function defaultMockFetch(
  envId: string,
  subPath: string,
  options?: {
    readonly method?: string;
    readonly body?: unknown;
    readonly query?: Record<string, string>;
  },
) {
  if (envId === "remote-unpatched") {
    return Promise.resolve({
      ok: false,
      status: 404,
      data: null,
      error: "Devtools API is not supported on this host",
    });
  }
  if (envId === "remote-500") {
    return Promise.resolve({
      ok: false,
      status: 500,
      data: null,
      error: "Internal Server Error",
    });
  }
  if (subPath === "/reaper/status") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        ok: true,
        exitCode: 0,
        data: {
          protected: { sessions: 91, worktrees: 211, paths: 2245 },
          orphan_candidates: [],
          stale_tmp: { max_age_hours: 24, roots: ["/tmp"], dirs: 0, files: 1 },
          cargo_last_run: { last_run: "2026-11-21T08:16:32-0500", age_s: 60307.5 },
        },
      },
    });
  }
  if (subPath === "/reaper/cargo-dry-run") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        ok: true,
        exitCode: 0,
        data: {
          dry_run: true,
          build_dirs: 9,
          removed: 0,
          removed_bytes: 0,
          incremental: 31,
          incremental_bytes: 545_243_136,
          skipped_in_use: 0,
          aborted_reason: null,
        },
      },
    });
  }
  if (subPath === "/storage/scan" || subPath === "/storage/scan/refresh") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        manifest: null,
        storageCleanupReport: null,
        hostScan: {
          host: "dev-host-x",
          scanned_at: "2026-11-22T01:03:43-0500",
          high_pressure: false,
          mounts: [
            { mount: "/", used_pct: 45.5, avail_bytes: 492_261_240_832 },
            { mount: "/data", used_pct: 73.4, avail_bytes: 218_425_163_776 },
          ],
        },
      },
    });
  }
  if (subPath === "/storage/review") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        ok: true,
        launched: false,
        prompt: `Review ${(options?.body as { host?: string })?.host}`,
      },
    });
  }
  if (subPath === "/reaper/policy") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        policyPath: "/home/dev/.config/reaper/policy.toml",
        rules: [{ path: "/data/private-repo/results", maxAgeDays: 14, keepLatest: 3, enabled: false }],
        protectedHistoryRoots: ["/home/dev/.t3/userdata/statev2.sqlite"],
      },
    });
  }
  if (subPath === "/review-stats") {
    const isMac = envId === "remote-mac";
    const hostFilter = options?.query?.host;
    const myHost = isMac ? "mac-studio" : "dev-host-x";
    const matches = !hostFilter || hostFilter === myHost;
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        side: options?.query?.side ?? "reviewer",
        by: "model",
        totals: {
          key: "all",
          reviews: matches ? (isMac ? 4 : 10) : 0,
          passed: matches ? (isMac ? 3 : 7) : 0,
          flagged: matches ? (isMac ? 1 : 3) : 0,
          bypasses: 0,
          friction: 0,
          fallbacks: 0,
          breaking: matches && !isMac ? 1 : 0,
          critical: 0,
          high: matches ? (isMac ? 1 : 2) : 0,
          medium: matches ? 1 : 0,
          low: 0,
          info: 0,
          total: matches ? (isMac ? 2 : 4) : 0,
          passRatePct: matches ? (isMac ? 75 : 70) : 0,
          avgIssues: matches ? (isMac ? 0.5 : 0.4) : 0,
        },
        groups: matches
          ? [
              {
                key: isMac ? "gpt-5.4 (high)" : "claude-opus-5-5 (high)",
                model: isMac ? "gpt-5.4" : "claude-opus-5-5",
                effort: "high",
                family: isMac ? "GPT" : "Claude Opus",
                reviews: isMac ? 4 : 10,
                passed: isMac ? 3 : 7,
                flagged: isMac ? 1 : 3,
                bypasses: 0,
                friction: 0,
                fallbacks: 0,
                breaking: isMac ? 0 : 1,
                critical: 0,
                high: isMac ? 1 : 2,
                medium: 1,
                low: 0,
                info: 0,
                total: isMac ? 2 : 4,
                passRatePct: isMac ? 75 : 70,
                avgIssues: isMac ? 0.5 : 0.4,
              },
            ]
          : [],
        recent: [],
        highlights: {
          topBugSubmitter: null,
          topBugCatcher: matches
            ? {
                label: isMac ? "gpt-5.4 (high)" : "claude-opus-5-5 (high)",
                reviews: isMac ? 4 : 10,
                totalIssues: isMac ? 2 : 4,
                avgIssues: isMac ? 0.5 : 0.4,
                breaking: isMac ? 0 : 1,
                critical: 0,
                high: isMac ? 1 : 2,
              }
            : null,
        },
        facets: {
          repos: ["devtools"],
          labs: [isMac ? "OpenAI" : "Anthropic"],
          families: [isMac ? "GPT" : "Claude Opus"],
          hosts: [myHost],
        },
      },
    });
  }
  if (subPath === "/stats/cerno") {
    return Promise.resolve({
      ok: true,
      status: 200,
      data: {
        enabled: true,
        host: envId === "remote-mac" ? "mac-studio" : "dev-host-x",
        configPath: "/home/dev/.config/cerno/telemetry.json",
        captureDir: "/home/dev/.local/share/cerno",
        localCapture: true,
        shareOptIn: false,
        totals: {
          key: "all",
          captures: 5,
          complete: 5,
          pass: 4,
          fail: 1,
          alerts: 2,
          disagreements: 1,
          streamBytes: 8192,
        },
        byHarness: [
          {
            key: "claude",
            captures: 5,
            complete: 5,
            pass: 4,
            fail: 1,
            alerts: 2,
            disagreements: 1,
            streamBytes: 8192,
          },
        ],
        byMode: [],
        recentFindings: [],
        facets: {
          hosts: [envId === "remote-mac" ? "mac-studio" : "dev-host-x"],
          harnesses: ["claude"],
        },
      },
    });
  }
  return Promise.resolve({ ok: false, status: 404, data: null, error: "Not found" });
}

function resetDefaultFetch() {
  fetchSpy.mockReset();
  fetchSpy.mockImplementation(defaultMockFetch);
}

describe("Devtools live browser UI", () => {
  it("renders FleetReaperTab with ExecJsonResult envelopes, preserves dirty edits across refresh, and allows decimal maxAgeDays", async () => {
    resetDefaultFetch();
    const feedback = vi.fn();
    await using _screen = await render(
      <FleetReaperTab
        environmentId={EnvironmentId.make("local-host")}
        localHostName="dev-host-x"
        mergedWorktreesCount={3}
        onFeedback={feedback}
      />,
    );

    await expect.element(page.getByText("0 dirs · 1 files")).toBeVisible();
    await expect.element(page.getByText("91 sessions · 211 worktrees")).toBeVisible();
    await expect.element(page.getByText("/data", { exact: true })).toBeVisible();
    const pathInput = page.getByLabelText("Cleanup directory path");
    await expect.element(pathInput).toHaveValue("/data/private-repo/results");

    // Edit rule path & max days (decimal 1.5), then click Refresh scan — unsaved edits must stay intact!
    await pathInput.fill("/data/private-repo/results-edited");
    await page.getByLabelText("Max days").fill("1.5");
    await page.getByRole("button", { name: "Refresh scan" }).click();
    await expect.element(pathInput).toHaveValue("/data/private-repo/results-edited");
    await expect.element(page.getByLabelText("Max days")).toHaveValue("1.5");

    // Cargo dry-run renders reclaimed bytes cleanly
    await page.getByRole("button", { name: "Cargo dry-run" }).click();
    await expect.element(page.getByText("520 MiB")).toBeVisible();
  });

  it("warns and disables local reaper actions when a remote host is selected, while targeting remote host on Agent cleanup review", async () => {
    resetDefaultFetch();
    const feedback = vi.fn();
    await using _screen = await render(
      <FleetReaperTab
        environmentId={EnvironmentId.make("local-host")}
        localHostName="dev-host-x"
        selectedHostName="mac-studio"
        isSelectedHostLocal={false}
        mergedWorktreesCount={3}
        onFeedback={feedback}
      />,
    );

    await expect.element(page.getByText(/run only on local host/)).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Run reaper" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Cargo dry-run" })).toBeDisabled();
    await expect.element(page.getByRole("button", { name: "Save rules" })).toBeDisabled();

    await page.getByRole("button", { name: "Agent cleanup review" }).click();
    expect(fetchSpy).toHaveBeenCalledWith(
      "local-host",
      "/storage/review",
      expect.objectContaining({ method: "POST", body: { host: "mac-studio" } }),
    );
  });

  it("queries multiple environments in parallel in UsageReviewsPanel, skips 500+404 hosts, merges multi-host data, and only sends refresh=1 on manual Refresh", async () => {
    resetDefaultFetch();
    await using _screen = await render(
      <UsageReviewsPanel
        environmentIds={[
          EnvironmentId.make("remote-500"),
          EnvironmentId.make("remote-unpatched"),
          EnvironmentId.make("local-host"),
          EnvironmentId.make("remote-mac"),
        ]}
        windowDays={30}
      />,
    );

    await expect.element(page.getByText("claude-opus-5-5", { exact: true })).toBeVisible();
    await expect.element(page.getByText("gpt-5.4", { exact: true })).toBeVisible();
    await expect.element(page.getByText(/Cerno Stream Findings/)).toBeVisible();
    expect(document.body.textContent).not.toContain("Devtools API is not supported on this host");

    // Switching side must NOT send refresh=1
    fetchSpy.mockClear();
    await page.getByRole("button", { name: "Submitter", exact: true }).click();
    await expect.element(page.getByText("claude-opus-5-5", { exact: true })).toBeVisible();
    const sideCalls = fetchSpy.mock.calls.filter((c) => c[1] === "/review-stats");
    expect(sideCalls.length).toBeGreaterThan(0);
    for (const call of sideCalls) {
      expect((call[2] as { query?: Record<string, string> })?.query?.refresh).toBeUndefined();
    }

    // Manual Refresh MUST send refresh=1
    fetchSpy.mockClear();
    await page.getByRole("button", { name: "Refresh" }).click();
    await expect.element(page.getByText("claude-opus-5-5", { exact: true })).toBeVisible();
    const refreshCalls = fetchSpy.mock.calls.filter((c) => c[1] === "/review-stats");
    expect(refreshCalls.length).toBeGreaterThan(0);
    for (const call of refreshCalls) {
      expect((call[2] as { query?: Record<string, string> })?.query?.refresh).toBe("1");
    }
  });

  it("shows explicit unsupported message in ShipQueuePanel instead of empty filter text", async () => {
    resetDefaultFetch();
    await using _screen = await render(
      <ShipQueuePanel environmentId={EnvironmentId.make("unsupported-host")} />,
    );

    await expect
      .element(page.getByText("Devtools API is not supported on this host."))
      .toBeVisible();
  });

  it("renders full-width Fleet cards with visible load, hides routine update tags, expands monitor gauges, and shows matching-color problem banner for real issues", async () => {
    resetDefaultFetch();
    const hosts = mergeFleetHosts({
      localHost: {
        name: "dev-host-x",
        uptime_s: 3_134_249,
        load1: 2.22,
        cpus: 16,
        cpu_pct: 48,
        cpu_hist: [10, 22, 48],
        mem: { used: 16 * 1024 ** 3, total: 64 * 1024 ** 3 },
        gpu: {
          busy_pct: 12,
          busy_hist: [0, 8, 12],
          vram_used: 2 * 1024 ** 3,
          vram_total: 24 * 1024 ** 3,
        },
        disks: [
          { mount: "/", label: "root", used: 400 * 1024 ** 3, total: 1000 * 1024 ** 3 },
          { mount: "/data", label: "data", used: 700 * 1024 ** 3, total: 1000 * 1024 ** 3 },
        ],
      },
      localServers: [],
      localSessions: [],
      localAlerts: [],
      nodes: {
        host-x: {
          status: "online",
          host: { name: "host-x", uptime_s: 470_897, load1: 0.15, cpus: 20, cpu_pct: 5 },
        },
        "host-x": {
          status: "online",
          host: { name: "host-x", uptime_s: 289_660, load1: 0.9, cpus: 10, cpu_pct: 9 },
        },
        "dev-host-x": {
          status: "online",
          host: { name: "dev-host-x", uptime_s: 481_290, load1: 0.09, cpus: 8, cpu_pct: 93 },
        },
      },
      hostsReport: {
        report: {
          hosts: [
            {
              name: "dev-host-x",
              reached: true,
              drift: [
                { text: "lacks ship-queue current files (host-config.json)", state: "update" },
              ],
            },
            { name: "host-x", reached: true, drift: [] },
            { name: "host-x", reached: true, drift: [] },
            {
              name: "dev-host-x",
              reached: true,
              drift: [],
              grant_error: "sudo grant expired for docker-ce",
            },
          ],
        },
      },
      shipPanel: null,
    });

    // Routine drift on host-x must NOT produce an "updates" tag or problem banner
    const localHost = hosts[0]!;
    expect(localHost.problem).toBeNull();
    await using screen = await render(
      <div data-fd="root" style={{ width: "1200px" }}>
        <DeckHeaderStrip
          hosts={hosts}
          selectedHost={localHost}
          busyKeys={new Set()}
          onSelectHost={() => {}}
          onToggleCi={() => {}}
          onCheckHosts={() => {}}
          onRunStorageReport={() => {}}
          onStartCleanupReview={() => {}}
        />
      </div>,
    );

    await expect.element(page.getByText("host-x", { exact: true })).toBeVisible();
    await expect.element(page.getByText("host-x", { exact: true })).toBeVisible();
    await expect.element(page.getByText("2.22", { exact: true })).toBeVisible();
    await expect.element(page.getByText("0.15", { exact: true })).toBeVisible();
    await expect.element(page.getByText("0.90", { exact: true })).toBeVisible();
    await expect.element(page.getByText("0.09", { exact: true })).toBeVisible();
    expect(document.body.textContent?.toLowerCase()).not.toContain("1 updates");

    // Verify full-width layout: 4 cards and monitor gauges fill >85% of the 1200px header
    const cards = Array.from(document.querySelectorAll('[data-fd="host-badge"]'));
    expect(cards).toHaveLength(4);
    const totalCardWidth = cards.reduce((s, el) => s + el.getBoundingClientRect().width, 0);
    expect(totalCardWidth).toBeGreaterThan(1000);
    const gauges = Array.from(document.querySelectorAll('[data-fd="gauge"]'));
    const totalGaugeWidth = gauges.reduce((s, el) => s + el.getBoundingClientRect().width, 0);
    expect(totalGaugeWidth).toBeGreaterThan(1000);

    // Real needs-root problem on host-x shows matching badge on card AND problem banner on its tab
    const problemHost = hosts.find((h) => h.id === "dev-host-x")!;
    expect(problemHost.problem?.kind).toBe("needs-root");
    await screen.rerender(
      <div data-fd="root" style={{ width: "1200px" }}>
        <FleetMachinesView
          environmentId={EnvironmentId.make("local-host")}
          hosts={hosts}
          selectedHost={problemHost}
          hostJobs={[]}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </div>,
    );
    await expect.element(page.getByTestId("host-problem-banner")).toBeVisible();
    await expect.element(page.getByText("sudo grant expired for docker-ce")).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Provision host" })).toBeVisible();
  });

  it("shows a tooltip with full text on mouseover when Ship Queue step detail is truncated, and hides it when text fits", async () => {
    const fullWaiting =
      "a quiet host, or a CI host with room below 9 cores before starting heavy suite";
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: "200px" }}>
          <ShipQueueVerticalTracker
            compact
            job={{
              id: "10962",
              state: "running",
              watchers: 1,
              waiting: fullWaiting,
              last_marker: "STARTED job=10962",
            }}
          />
        </div>
      </TooltipProvider>,
    );

    const truncatedDetail = page.getByText(fullWaiting, { exact: true });
    await expect.element(truncatedDetail).toBeVisible();
    const detailEl = truncatedDetail.element();
    expect(detailEl.scrollWidth).toBeGreaterThan(detailEl.clientWidth);

    // Hovering truncated text opens the tooltip popup with full text
    await truncatedDetail.hover();
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-positioner"]')?.textContent ?? "")
      .toContain(fullWaiting);

    // Moving to non-truncated short detail ("1 active") closes tooltip and does not open a redundant one
    const shortDetail = page.getByText("1 active", { exact: true });
    await shortDetail.hover();
    await expect.poll(() => document.querySelector('[data-slot="tooltip-positioner"]')).toBeNull();

    // Keyboard Tab focus (:focus-visible) on truncated text opens the tooltip (tabIndex=0 only when overflowing)
    expect(detailEl.getAttribute("tabindex")).toBe("0");
    expect(shortDetail.element().getAttribute("tabindex")).toBeNull();
    await userEvent.tab();
    expect(document.activeElement).toBe(detailEl);
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-positioner"]')?.textContent ?? "")
      .toContain(fullWaiting);
  });

  it("shows a tooltip on mouseover for truncated job titles and omits inline log tails", async () => {
    const longTitle =
      "SeamPackedReader-L6-v4.2-Extended-Multi-Domain-Curriculum-Pretraining-And-Validation-Run-Checkpoint";
    const longTailLine =
      "epoch=14/20 step=18400/25000 loss=0.4123 val_acc=0.9482 grad_norm=0.812 throughput=41820 tok/s";
    let inspectCalls = 0;
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: "180px" }}>
          <ThreadManagedJobCard
            job={{
              id: "bg:tail-test",
              revision: 1,
              source: "background",
              kind: "train",
              title: longTitle,
              phaseLabel: "Running",
              state: "running",
              cancellable: true,
              binding: { host: "dev-host-x" },
              timing: { startedAt: "2026-11-22T03:00:00Z" },
              recentTail: [longTailLine],
            }}
            nowMs={Date.parse("2026-11-22T03:05:00Z")}
            cancelling={false}
            onInspect={() => {
              inspectCalls += 1;
            }}
            onCancel={() => {}}
          />
        </div>
      </TooltipProvider>,
    );

    const truncatedTitle = page.getByText(longTitle, { exact: true });
    await expect.element(truncatedTitle).toBeVisible();
    const titleEl = truncatedTitle.element();
    expect(titleEl.scrollWidth).toBeGreaterThan(titleEl.clientWidth);
    await truncatedTitle.hover();
    await expect
      .poll(() => document.querySelector('[data-slot="tooltip-positioner"]')?.textContent ?? "")
      .toContain(longTitle);

    // Inline tail boxes are excluded from the ultra-compact right rail (live logs live in the slide-over inspector).
    expect(document.body.textContent).not.toContain("epoch=14/20");
    await page.getByRole("button", { name: `Inspect job: ${longTitle}` }).click();
    expect(inspectCalls).toBe(1);
  });

  it("renders ultra-compact ThreadManagedJobCard with elapsed time, %, blue progress bar, and omits verbose subtitle/GPU dumps", async () => {
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: "220px" }}>
          <ThreadManagedJobCard
            job={{
              id: "bg:f6-run",
              revision: 2,
              source: "background",
              kind: "train",
              title: "MicroCortex-F6-6L Distillation & DEV Eval",
              subtitle:
                "6L x d256, max_len=256, Block AttnRes + PLE + Bigram private-repo + Q8 (pure Rust)",
              phaseLabel: "Stage 1: Teacher Cache + F6-6L G",
              state: "running",
              cancellable: true,
              binding: { host: "dev-host-x" },
              timing: { startedAt: "2026-11-22T03:00:00Z", etaSeconds: 185 },
              progress: {
                current: 19200,
                total: 40458,
                fraction: 19200 / 40458,
                stageLabel: "Ep 1/6",
              },
              recentTail: ["19200/40458 (215.1s)"],
            }}
            nowMs={Date.parse("2026-11-22T03:04:13Z")}
            cancelling={false}
            onInspect={() => {}}
            onCancel={() => {}}
          />
        </div>
      </TooltipProvider>,
    );

    await expect.element(page.getByTestId("job-elapsed")).toHaveTextContent("4m 13s");
    await expect.element(page.getByTestId("job-progress-pct")).toHaveTextContent("47%");
    // Compact right-rail card uses T3 info blue for active progress and omits verbose dumps
    expect(document.querySelector(".bg-info")).not.toBeNull();
    expect(document.body.textContent).not.toContain("Block AttnRes");
    expect(document.body.textContent).not.toContain("Stage 1: Teacher Cache");
    expect(document.body.textContent).not.toContain("19,200/40,458");
  });

  it("requires two-step Stop thread confirmation without triggering card inspect", async () => {
    let cancelCalls = 0;
    let inspectCalls = 0;
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: "220px" }}>
          <ThreadManagedJobCard
            job={{
              id: "bg:abcdef0123456789",
              revision: 1,
              source: "background",
              kind: "render",
              title: "Rise test v2 on 3080",
              phaseLabel: "Rendering",
              state: "running",
              cancellable: true,
              binding: { host: "host-x" },
              timing: { startedAt: "2026-11-22T03:00:00Z" },
            }}
            nowMs={Date.parse("2026-11-22T03:02:00Z")}
            cancelling={false}
            onInspect={() => {
              inspectCalls += 1;
            }}
            onCancel={() => {
              cancelCalls += 1;
            }}
          />
        </div>
      </TooltipProvider>,
    );

    await expect.element(page.getByText("Rise test v2 on 3080", { exact: true })).toBeVisible();
    await expect.element(page.getByTestId("job-elapsed")).toHaveTextContent("2m");

    // First click arms thread-stop confirmation instead of stopping sibling jobs immediately
    await page.getByRole("button", { name: /Stop thread/i }).click();
    expect(cancelCalls).toBe(0);
    expect(inspectCalls).toBe(0);
    await expect.element(page.getByText("Stop thread?")).toBeVisible();
    await page.getByRole("button", { name: "Stop", exact: true }).click();
    expect(cancelCalls).toBe(1);
    expect(inspectCalls).toBe(0);

    // L11: stall anomaly renders in amber warning tone (not destructive red) and outer card is not a nested button
    await _screen.rerender(
      <TooltipProvider delay={0}>
        <div style={{ width: "220px" }}>
          <ThreadManagedJobCard
            job={{
              id: "bg:abcdef0123456789",
              revision: 2,
              source: "background",
              kind: "render",
              title: "Rise test v2 on 3080",
              phaseLabel: "Rendering",
              state: "running",
              anomaly: "No output for 16m",
              cancellable: true,
              binding: { host: "host-x" },
              timing: { startedAt: "2026-11-22T03:00:00Z" },
            }}
            nowMs={Date.parse("2026-11-22T03:18:00Z")}
            cancelling={false}
            onInspect={() => {}}
            onCancel={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    const stallEl = page.getByText("No output for 16m", { exact: true });
    await expect.element(stallEl).toBeVisible();
    expect(stallEl.element().className).toContain("text-warning-foreground");
    expect(document.querySelectorAll("button button").length).toBe(0);
  });

  it("shows remote native background jobs on their target Fleet Console host tab, kicks DevDeck nodes, and skips kick for probe-only hosts", async () => {
    const kickedPaths: string[] = [];
    fetchSpy.mockImplementation((envId: string, subPath: string, opts?: { method?: string }) => {
      if (subPath.endsWith("/kick") && opts?.method === "POST") {
        kickedPaths.push(subPath);
        return Promise.resolve({ ok: true, status: 200, data: { status: "kicked" }, error: null });
      }
      return defaultMockFetch(envId, subPath, opts);
    });

    const hosts = mergeFleetHosts({
      localHost: { name: "dev-host-x", cpu_pct: 12 },
      localServers: [],
      localSessions: [],
      localAlerts: [],
      localWorktrees: null,
      nodes: {
        host-x: {
          status: "online",
          host: {
            name: "host-x",
            cpu_pct: 45,
            gpu: { busy_pct: 99, vram_used: 5.4e9, vram_total: 10e9, busy_hist: [10, 99] },
          },
        },
        "dev-host-x": {
          status: "online",
          host: {
            name: "dev-host-x",
            cpu_pct: 24,
            gpu: { busy_pct: 88, vram_used: 4.1e9, vram_total: 16e9, busy_hist: [5, 88] },
          },
        },
      },
      hostsReport: {
        report: {
          hosts: [{ name: "probe-only-box", ssh: "probe-only", reached: true }],
        },
      },
      shipPanel: null,
    });
    const msiHost = hosts.find((h) => h.id === "host-x")!;
    const probeOnlyHost = hosts.find((h) => h.id === "probe-only-box")!;
    expect(msiHost.hasDevdeckNode).toBe(true);
    expect(probeOnlyHost.hasDevdeckNode).toBe(false);

    const sampleJobs = [
      {
        id: "bg:1111111111111111",
        revision: 1,
        source: "background" as const,
        kind: "render",
        title: "Rise test v2 on 3080",
        phaseLabel: "Rendering",
        state: "running" as const,
        cancellable: true,
        binding: { host: "host-x" },
        timing: { startedAt: "2026-11-22T03:00:00Z" },
      },
      {
        id: "bg:2222222222222222",
        revision: 1,
        source: "background" as const,
        kind: "render",
        title: "Rise test v2 on 6800 XT",
        phaseLabel: "Rendering",
        state: "running" as const,
        cancellable: true,
        binding: { host: "dev-host-x" },
        timing: { startedAt: "2026-11-22T03:00:00Z" },
      },
    ];

    await using screen = await render(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={hosts}
          selectedHost={msiHost}
          hostJobs={sampleJobs}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );

    await expect.element(page.getByText("Rise test v2 on 3080")).toBeVisible();
    expect(document.body.textContent).not.toContain("Rise test v2 on 6800 XT");
    await expect.poll(() => kickedPaths).toContain("/devdeck/nodes/host-x/kick");

    // Switching to a probe-only host must NOT fire /kick (avoids 404 spam)
    kickedPaths.length = 0;
    await screen.rerender(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={hosts}
          selectedHost={probeOnlyHost}
          hostJobs={sampleJobs}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );
    await expect.element(page.getByText("probe-only-box")).toBeVisible();
    expect(kickedPaths).toEqual([]);
  });

  it("shows fleet telemetry offline error and tracked T3 jobs without a legacy Start DevDeck action (both empty and cached host states)", async () => {
    await using screen = await render(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={[]}
          selectedHost={null}
          devdeckError="Fleet telemetry is offline on this host"
          hostJobs={[
            {
              id: "bg:3333333333333333",
              revision: 1,
              source: "background",
              kind: "eval",
              title: "[1/4] Re-exporting SeamPackedReader-v5-68m",
              phaseLabel: "Evaluating",
              state: "running",
              cancellable: true,
              binding: { host: "dev-host-x" },
              timing: { startedAt: "2026-11-22T03:00:00Z" },
            },
          ]}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );

    await expect.element(page.getByTestId("fleet-telemetry-offline")).toBeVisible();
    await expect.element(page.getByText("Fleet telemetry is offline on this host")).toBeVisible();
    await expect
      .element(page.getByText("[1/4] Re-exporting SeamPackedReader-v5-68m"))
      .toBeVisible();
    expect(page.getByRole("button", { name: "Start DevDeck" }).elements()).toHaveLength(0);

    // Offline banner still appears above host grid when DevDeck stops after hosts already loaded
    const cachedHosts = mergeFleetHosts({
      localHost: { name: "dev-host-x", cpu_pct: 12 },
      localServers: [],
      localSessions: [],
      localAlerts: [],
      localWorktrees: null,
      nodes: {},
      hostsReport: null,
      shipPanel: null,
    });
    await screen.rerender(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={cachedHosts}
          selectedHost={cachedHosts[0] ?? null}
          devdeckError="Fleet telemetry is offline on this host"
          hostJobs={[]}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );
    await expect.element(page.getByTestId("fleet-telemetry-offline")).toBeVisible();
    expect(page.getByRole("button", { name: "Start DevDeck" }).elements()).toHaveLength(0);
  });

  it("routes blocking dependency holds out of ShipQueuePanel (no buried box) and shows Approval + Open thread on held rows", async () => {
    const freshScannedAtSec = Math.floor(Date.parse("2099-01-01T00:00:00Z") / 1000);
    fetchSpy.mockImplementation((envId: string, subPath: string) => {
      if (subPath === "/ship-queue/deps") {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            repos: [
              {
                repo: "devtools",
                reportId: "devtools:b101db77d7f1c942",
                status: "unknown",
                scannedAt: freshScannedAtSec,
                active: true,
                holding: true,
                pendingCount: 0,
                waitingCount: 0,
                heldCount: 0,
                failedCount: 0,
                attemptId: null,
                attemptStatus: null,
                decisionKind: null,
                decisionUntil: null,
                error: "git ls-remote origin HEAD exited 128",
                updates: [],
              },
            ],
          },
        });
      }
      return defaultMockFetch(envId, subPath);
    });

    await using _screen = await render(
      <TooltipProvider delay={0}>
        <ShipQueuePanel environmentId={"env-local" as EnvironmentId} />
      </TooltipProvider>,
    );

    // No buried Blocking dependency holds box in the Ship Queue tab
    expect(document.body.textContent).not.toContain("Blocking dependency holds");

    // Verify DevDeck exact probe thresholds on DeckHeaderStrip:
    // CPU 84% normal, GPU 85% warn, Mem 80% warn, Disk 95% bad
    const probeHosts = mergeFleetHosts({
      localHost: {
        name: "dev-host-x",
        cpu_pct: 84,
        mem: { used: 80, total: 100 },
        gpu: { busy_pct: 85, vram_used: 79, vram_total: 100, busy_hist: [40, 85] },
        disks: [
          { mount: "/data", used: 72, total: 100 },
          { mount: "/", used: 95, total: 100 },
        ],
      },
      localServers: [],
      localSessions: [],
      localAlerts: [],
      localWorktrees: null,
      nodes: {},
      hostsReport: null,
      shipPanel: null,
    });
    await using _probeScreen = await render(
      <TooltipProvider delay={0}>
        <DeckHeaderStrip
          hosts={probeHosts}
          selectedHost={probeHosts[0] ?? null}
          busyKeys={new Set()}
          onSelectHost={() => {}}
          onToggleCi={() => {}}
          onCheckHosts={() => {}}
          onRunStorageReport={() => {}}
          onStartCleanupReview={() => {}}
        />
      </TooltipProvider>,
    );

    const gauges = Array.from(document.querySelectorAll<HTMLElement>('[data-fd="gauge"]'));
    const toneByLabel = Object.fromEntries(
      gauges.map((g) => [
        g.querySelector('[data-fd="gauge-lbl"]')?.textContent?.trim() ?? "",
        g.getAttribute("data-tone"),
      ]),
    );
    expect(toneByLabel.CPU).toBeNull();
    expect(toneByLabel.Mem).toBe("warn");
    expect(toneByLabel.GPU).toBe("warn");
    expect(toneByLabel.VRAM).toBeNull();
    expect(toneByLabel.Root).toBe("bad");
    // L11: screen-reader warning/critical text accompanies visual ▲ indicator
    expect(document.body.textContent).toContain("Warning:");
    expect(document.body.textContent).toContain("Critical:");

    // M8: DevTools approval options render custom labels verbatim and lock during submission
    const decisions: string[] = [];
    await using _approvalScreen = await render(
      <TooltipProvider delay={0}>
        <ComposerPendingApprovalActions
          presentation="inline"
          requestId={"devtools:dep:devtools:abc123" as never}
          isResponding={false}
          canRespond
          disabled={false}
          options={[
            { decision: "decline", label: "Reject (24h)" },
            { decision: "accept", label: "Approve" },
            { decision: "cancel", label: "Rescan" },
          ]}
          onRespondToApproval={async (_id, decision) => {
            decisions.push(decision);
          }}
        />
      </TooltipProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Reject (24h)" })).toBeVisible();
    await expect.element(page.getByRole("button", { name: "Approve" })).toBeVisible();
    await page.getByRole("button", { name: "Reject (24h)" }).click();
    expect(decisions).toEqual(["decline"]);
  });

  it("opens Job Inspector in a slide-over drawer with log output up front and suppresses flat/1-point chart boxes", async () => {
    fetchSpy.mockImplementation((envId: string, subPath: string) => {
      if (subPath === "/jobs/bg%3Adrawer-1") {
        return Promise.resolve({
          ok: true,
          status: 200,
          data: {
            id: "bg:drawer-1",
            revision: 3,
            command: "python scripts/train_v5.py --epochs 3",
            logState: "attached",
            logPath: "/data/cache/private-repo/logs/v5.log",
            linesParsed: 12,
            logTail: ["step=1/3 loss=1.42", "step=2/3 loss=1.18", "step=3/3 loss=0.95"],
            series: [
              {
                key: "playbook_rc",
                label: "playbook rc",
                points: [{ t: 1, v: 0 }],
              },
              {
                key: "dirty",
                label: "dirty",
                points: [
                  { t: 1, v: 0 },
                  { t: 2, v: 0 },
                ],
              },
              {
                key: "loss",
                label: "loss",
                points: [
                  { t: 1, v: 1.42 },
                  { t: 2, v: 1.18 },
                  { t: 3, v: 0.95 },
                ],
              },
            ],
          },
        });
      }
      return defaultMockFetch(envId, subPath);
    });

    const hosts = mergeFleetHosts({
      localHost: { name: "dev-host-x", cpu_pct: 20 },
      localServers: [],
      localSessions: [],
      localAlerts: [],
      localWorktrees: null,
      nodes: {},
      hostsReport: null,
      shipPanel: null,
    });
    const job = {
      id: "bg:drawer-1",
      revision: 3,
      source: "background" as const,
      kind: "train",
      title: "Train SeamReader v5",
      phaseLabel: "Training",
      state: "running" as const,
      binding: {
        host: "dev-host-x",
        threadId: "thread-ml-1",
        worktreePath: "/data/Dev/private-repo",
      },
      timing: { startedAt: "2026-11-22T15:00:00Z" },
      cancellable: true,
    };

    await using _screen = await render(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={hosts}
          selectedHost={hosts[0] ?? null}
          hostJobs={[job]}
          selectedJobId="bg:drawer-1"
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );

    const drawer = page.getByTestId("job-inspector-drawer");
    await expect.element(drawer, { timeout: 2_000 }).toBeVisible();
    await expect
      .element(drawer.getByRole("button", { name: "Open thread" }), { timeout: 2_000 })
      .toBeVisible();
    await expect
      .element(drawer.getByTestId("job-inspector-log-section"), { timeout: 2_000 })
      .toBeVisible();
    await expect
      .poll(() => drawer.element().textContent ?? "", { timeout: 2_000 })
      .toContain("step=3/3 loss=0.95");
    await expect
      .element(drawer.getByText("python scripts/train_v5.py --epochs 3"), { timeout: 2_000 })
      .toBeVisible();
    await expect
      .element(drawer.getByText("loss", { exact: true }), { timeout: 2_000 })
      .toBeVisible();
    expect(document.body.textContent).not.toContain("playbook rc");
    expect(document.body.textContent).not.toContain("min 0 max 0");

    // L2: Escape closes the Sheet drawer first (popup stays mounted during close while role=dialog
    // blocks Fleet Console's Escape handler), and M2/L6c: error-free degraded reconnect does not
    // flash an offline banner when hosts are loaded, while missing host still shows waiting banner.
    let escapeReachedWindow = false;
    const onEsc = (ev: KeyboardEvent) => {
      if (ev.key === "Escape" && !document.querySelector("[role='dialog']")) {
        escapeReachedWindow = true;
      }
    };
    window.addEventListener("keydown", onEsc);
    try {
      await userEvent.keyboard("{Escape}");
      expect(escapeReachedWindow).toBe(false);
    } finally {
      window.removeEventListener("keydown", onEsc);
    }

    await _screen.rerender(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={hosts}
          selectedHost={hosts[0] ?? null}
          devdeckStatus="degraded"
          devdeckError={null}
          hostJobs={[job]}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );
    expect(document.querySelector("[data-testid='fleet-telemetry-offline']")).toBeNull();

    await _screen.rerender(
      <TooltipProvider delay={0}>
        <FleetMachinesView
          environmentId={"env-local" as EnvironmentId}
          hosts={[]}
          selectedHost={null}
          devdeckStatus="ready"
          devdeckError={null}
          hostJobs={[]}
          selectedJobId={null}
          onFeedback={() => {}}
        />
      </TooltipProvider>,
    );
    await expect.element(page.getByTestId("fleet-telemetry-offline")).toBeVisible();
  });

  it("isolates render throws inside DevtoolsErrorBoundary and recovers on Reset panel", async () => {
    let shouldCrash = true;
    function UnstablePanel() {
      if (shouldCrash) throw new Error("Simulated malformed telemetry payload");
      return <div>Recovered DevTools content</div>;
    }

    const consoleErrSpy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await using _screen = await render(
        <DevtoolsErrorBoundary panelName="Fleet Machines">
          <UnstablePanel />
        </DevtoolsErrorBoundary>,
      );

      await expect.element(page.getByTestId("devtools-error-boundary")).toBeVisible();
      await expect.element(page.getByText("Simulated malformed telemetry payload")).toBeVisible();

      shouldCrash = false;
      await page.getByRole("button", { name: "Reset panel" }).click();
      await expect.element(page.getByText("Recovered DevTools content")).toBeVisible();
    } finally {
      consoleErrSpy.mockRestore();
    }
  });
});
