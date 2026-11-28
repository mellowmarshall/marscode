import type { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import type { ShipQueueJob } from "./devtoolsClient";
import type { JobSummary } from "./jobs/jobTypes";

// The owner's default desktop window (`DEFAULT_MAIN_WINDOW_SIZE`), less the 16rem thread sidebar
// and the page gutters: the width the Ship Queue table gets by default.
const WINDOW = { width: 1100, height: 780 };
const PANEL_WIDTH = 796;

const LOG_TAIL = [
  "QUEUED job=1001 branch=fix/sample-sync at=2026-01-02T10:00:00.000Z",
  "STARTED job=1001 branch=fix/sample-sync at=2026-01-02T10:00:04.000Z",
  ...Array.from({ length: 40 }, (_, i) => `  build output line ${i}`),
  "PUSH_EXIT=0",
  "PR=63",
  "MERGE_EXIT=0",
  "POST_MERGE job=1001",
  "  install.sh: unknown argument: --bin-dir",
  "  post-merge sync exited 64 (PR #63 remains merged)",
  "SYNC_EXIT=64",
  "DONE job=1001 pr=63 at=2026-01-02T10:00:42.000Z",
];

const JOBS: ReadonlyArray<ShipQueueJob> = [
  {
    id: "1000",
    repo: "acme-fixture/sample-repo",
    branch: "fix/sample-old",
    title: "fix: the oldest recent job",
    state: "failed",
    reason: "ci step=ship_ci exit=1",
    submitted_at: "2026-01-02T09:00:00.000Z",
    steps: [
      { name: "ship_body_check", host: "local", exit: 0, ms: 410 },
      { name: "ship_ci", host: "ci-host-builder-01", exit: 1, ms: 61_200 },
    ],
  },
  {
    id: "1001",
    repo: "acme-fixture/sample-repo",
    branch: "fix/sample-sync",
    title: "fix: a merged job with a broken post-merge hook",
    state: "done",
    submitted_at: "2026-01-02T10:00:00.000Z",
    push_exit: 0,
    pr: 63,
    merge_exit: 0,
    sync_exit: 64,
    sync_reason: "install.sh: unknown argument: --bin-dir",
    post_merge: true,
    stage: "deployed",
    last_marker: "DONE job=1001 pr=63 at=2026-01-02T10:00:42.000Z",
    rebased_onto: "92ff0541b17cbfde606650a8207a1d067f4917aa",
    pushed_sha: "b58f67ee6a40f6c18deeb05f651e990b20cea4ab",
    steps: [
      { name: "ship_body_check", host: "local", exit: 0, ms: 420 },
      { name: "ship_install", host: "ci-host-builder-01", exit: 0, ms: 2767 },
      { name: "ship_ci", host: "ci-host-builder-01", exit: 0, ms: 38_897 },
      { name: "ship_merge", host: "local", exit: 0, ms: 3464 },
    ],
    challenge_override: {
      reason: "The finding covers a fixed trust path that is intended.",
      at: "2026-01-02T10:00:30.000Z",
    },
  },
  {
    id: "1002",
    repo: "acme-fixture/other-repo",
    branch: "feat/sample-new",
    title: "feat: the newest recent job",
    state: "done",
    submitted_at: "2026-01-02T11:00:00.000Z",
    pr: 64,
    merge_exit: 0,
  },
];

const summaries: ReadonlyArray<JobSummary> = JOBS.map((job) => ({
  id: `ship:${job.id}`,
  revision: 1,
  source: "ship-queue",
  kind: "ship",
  title: job.title ?? "",
  phaseLabel: "Shipping",
  state: job.state === "failed" ? "failed" : "done",
  binding: { host: "queue-host" },
  timing: { startedAt: job.submitted_at ?? "" },
  cancellable: false,
  shipJob: job,
}));

vi.mock("./devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./devtoolsClient")>();
  return {
    ...actual,
    fetchDevtoolsJson: () => Promise.resolve({ ok: true, status: 200, data: { repos: [] } }),
  };
});

vi.mock("./jobs/jobsStore", async (importOriginal) => {
  const actual = await importOriginal<typeof import("./jobs/jobsStore")>();
  return {
    ...actual,
    useSharedJobs: () => ({
      jobs: summaries,
      jobsById: new Map(summaries.map((s) => [s.id, s])),
      queueMeta: {},
      live: true,
      error: null,
      unsupported: false,
      legacyFallback: false,
      status: "ready" as const,
    }),
    useJobDetail: (_env: unknown, jobId: string | null) => ({
      detail: jobId ? { id: jobId, revision: 1, series: [], logTail: LOG_TAIL } : null,
      loading: false,
      error: null,
      status: "ready" as const,
      retry: () => {},
    }),
  };
});

import "~/index.css";
import { render } from "../../test/render";
import { TooltipProvider } from "../components/ui/tooltip";
import { ShipQueueJobDetails } from "./ShipQueueJobDetails";
import { ShipQueuePanel } from "./ShipQueuePanel";

async function renderPanel(options: { width?: number; theme?: "light" | "dark" } = {}) {
  const previous = { width: window.innerWidth, height: window.innerHeight };
  await page.viewport(WINDOW.width, WINDOW.height);
  const dark = options.theme === "dark";
  document.documentElement.classList.toggle("dark", dark);
  const screen = await render(
    <TooltipProvider delay={0}>
      <div style={{ width: options.width ?? PANEL_WIDTH }}>
        <ShipQueuePanel environmentId={"env-local" as EnvironmentId} />
      </div>
    </TooltipProvider>,
  );
  return {
    [Symbol.asyncDispose]: async () => {
      await screen[Symbol.asyncDispose]();
      document.documentElement.classList.remove("dark");
      await page.viewport(previous.width, previous.height);
    },
  };
}

function rowFor(id: string): HTMLElement {
  const row = Array.from(
    document.querySelectorAll<HTMLElement>('[data-testid="ship-queue-row"]'),
  ).find((el) => el.textContent?.includes(`#${id}`));
  if (!row) throw new Error(`No row for #${id}`);
  return row;
}

function headerCell(label: string): HTMLElement {
  const header = page.getByText("Queue #", { exact: true }).element().parentElement!;
  const cell = Array.from(header.children).find((el) => el.textContent === label);
  if (!cell) throw new Error(`No header cell ${label}`);
  return cell as HTMLElement;
}

function fitsInBox(el: Element): boolean {
  return el.scrollWidth <= el.clientWidth + 1;
}

describe("ShipQueuePanel at the default window size", () => {
  it("shows the repo name and the CI host in full, and links the PR of a job without pr_repo", async () => {
    await using _screen = await renderPanel();
    await expect.element(page.getByText("#1001", { exact: true })).toBeVisible();

    const row = rowFor("1001");
    expect(row.textContent).toContain("sample-repo");
    expect(row.textContent).not.toContain("acme-fixture");
    const host = row.querySelector<HTMLElement>('[data-testid="ship-queue-ci-host"]')!;
    expect(host.textContent).toBe("ci-host-builder-01");
    expect(fitsInBox(host)).toBe(true);

    const prLink = Array.from(row.querySelectorAll("a")).find((a) => a.textContent === "#63");
    expect(prLink?.getAttribute("href")).toBe(
      "https://github.com/acme-fixture/sample-repo/pull/63",
    );
  });

  it("lists recent jobs newest first", async () => {
    await using _screen = await renderPanel();
    await expect.element(page.getByText("#1002", { exact: true })).toBeVisible();
    const ids = Array.from(
      document.querySelectorAll<HTMLElement>('[data-testid="ship-queue-row"]'),
    ).map((row) => /#(\d+)/.exec(row.textContent ?? "")?.[1]);
    expect(ids).toEqual(["1002", "1001", "1000"]);
  });

  it("shows a done job's failed post-merge sync as a warning with its reason, not as a failure", async () => {
    await using _screen = await renderPanel();
    await expect.element(page.getByText("#1001", { exact: true })).toBeVisible();
    const row = rowFor("1001");
    expect(row.textContent).toContain("done");
    expect(row.textContent).not.toContain("failed");
    expect(row.textContent).toContain(
      "post-merge sync exit 64: install.sh: unknown argument: --bin-dir",
    );
    expect(row.querySelector(".text-destructive")).toBeNull();
    // Elapsed reads the DONE marker's millisecond UTC stamp, not a zone-shifted local time.
    expect(row.textContent).toContain("42s");

    await userEvent.click(page.getByRole("button", { name: "Expand job details" }).nth(1));
    const sync = row.querySelector<HTMLElement>('[data-testid="ship-job-sync"]')!;
    expect(sync.textContent).toContain("exit 64: install.sh: unknown argument: --bin-dir");
    expect(sync.textContent).toContain("PR #63 stays merged");
    expect(sync.className).toContain("text-warning");
  });

  it("expands to step hosts and timings, the challenge override, and a capped log excerpt", async () => {
    await using _screen = await renderPanel();
    await expect.element(page.getByText("#1001", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Expand job details" }).nth(1));

    const details = rowFor("1001").querySelector<HTMLElement>('[data-testid="ship-job-details"]')!;
    // The pipeline steps stay in the collapsed row; the expansion does not list them again.
    expect(details.textContent).not.toContain("CI & Checks");
    expect(details.textContent).not.toContain("Merge Gate");

    const table = page.getByRole("table", { name: "Step timings" });
    await expect.element(table).toBeVisible();
    const cells = Array.from(table.element().querySelectorAll("tbody tr")).map((tr) =>
      Array.from(tr.querySelectorAll("td")).map((td) => td.textContent),
    );
    expect(cells).toContainEqual(["ship_ci", "ci-host-builder-01", "38.9s", "0"]);
    expect(cells).toContainEqual(["ship_body_check", "local", "420ms", "0"]);

    expect(details.textContent).toContain("Challenged; overridden at");
    expect(details.textContent).toContain("The finding covers a fixed trust path");
    expect(details.textContent).toContain("onto 92ff054");
    expect(details.textContent).toContain("pushed b58f67e");

    const log = page.getByRole("log", { name: "Job log excerpt" });
    await expect.element(log).toBeVisible();
    const logEl = log.element() as HTMLElement;
    const collapsedHeight = logEl.getBoundingClientRect().height;
    expect(collapsedHeight).toBeLessThanOrEqual(WINDOW.height * 0.16);
    expect(logEl.scrollHeight).toBeGreaterThan(logEl.clientHeight);
    // The excerpt opens on the newest lines.
    const lastLine = Array.from(logEl.querySelectorAll("div > div")).at(-1)!;
    expect(lastLine.textContent).toBe("DONE job=1001 pr=63 at=2026-01-02T10:00:42.000Z");
    const logBox = logEl.getBoundingClientRect();
    const lastBox = lastLine.getBoundingClientRect();
    expect(lastBox.bottom).toBeLessThanOrEqual(logBox.bottom + 1);
    expect(lastBox.top).toBeGreaterThanOrEqual(logBox.top - 1);

    const toggle = page.getByRole("button", { name: "Expand log" });
    await userEvent.click(toggle);
    await expect
      .element(page.getByRole("button", { name: "Collapse log" }))
      .toHaveAttribute("aria-expanded", "true");
    expect(logEl.getBoundingClientRect().height).toBeGreaterThan(collapsedHeight * 2);
  });

  it("shows a failed job's reason and the host of its failing step", async () => {
    await using _screen = await renderPanel();
    await expect.element(page.getByText("#1000", { exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "Expand job details" }).nth(2));
    const details = rowFor("1000").querySelector<HTMLElement>('[data-testid="ship-job-details"]')!;
    expect(details.textContent).toContain("ci step=ship_ci exit=1");
    const ciRow = Array.from(details.querySelectorAll("tbody tr")).find((tr) =>
      tr.textContent?.startsWith("ship_ci"),
    )!;
    expect(ciRow.textContent).toContain("ci-host-builder-01");
    expect(ciRow.textContent).toContain("1m 01s");
  });

  it.each(["light", "dark"] as const)(
    "keeps the Title column wide in a narrow panel, with PR and When under the title (%s)",
    async (theme) => {
      await using _screen = await renderPanel({ width: 560, theme });
      await expect.element(page.getByText("#1001", { exact: true })).toBeVisible();
      expect(document.documentElement.classList.contains("dark")).toBe(theme === "dark");

      const row = rowFor("1001");
      const title = Array.from(row.querySelectorAll("button")).find((b) =>
        b.textContent?.startsWith("fix: a merged job"),
      )!;
      // The full eight-column grid leaves the Title column about 20px here; the narrow grid ~186px.
      const titleCell = title.closest(".space-y-1")!;
      expect(titleCell.getBoundingClientRect().width).toBeGreaterThan(160);
      expect(title.getBoundingClientRect().width).toBeGreaterThan(150);

      const narrowMeta = row.querySelector<HTMLElement>('[data-testid="ship-queue-narrow-meta"]')!;
      expect(getComputedStyle(narrowMeta).display).toBe("flex");
      const prLink = Array.from(narrowMeta.querySelectorAll("a")).find(
        (a) => a.textContent === "#63",
      );
      expect(prLink?.getAttribute("href")).toBe(
        "https://github.com/acme-fixture/sample-repo/pull/63",
      );
      expect(headerCell("PR").getBoundingClientRect().width).toBe(0);
      expect(headerCell("When").getBoundingClientRect().width).toBe(0);
      // Nothing in the row spills past its edge.
      const rowBox = row.getBoundingClientRect();
      for (const el of Array.from(row.querySelectorAll<HTMLElement>("*"))) {
        const box = el.getBoundingClientRect();
        if (box.width === 0) continue;
        expect(box.right).toBeLessThanOrEqual(rowBox.right + 1);
      }
    },
  );

  it("keeps PR and When in their own columns at the default width", async () => {
    await using _screen = await renderPanel();
    await expect.element(page.getByText("#1001", { exact: true })).toBeVisible();
    const narrowMeta = rowFor("1001").querySelector<HTMLElement>(
      '[data-testid="ship-queue-narrow-meta"]',
    )!;
    expect(getComputedStyle(narrowMeta).display).toBe("none");
    expect(headerCell("PR").getBoundingClientRect().width).toBeGreaterThan(0);
    expect(headerCell("When").getBoundingClientRect().width).toBeGreaterThan(0);
  });

  it("shows what a waiting job waits on from the queue's waiting_for", async () => {
    const waitingJob = (waitingFor: string): ShipQueueJob => ({
      id: "1003",
      state: "waiting",
      waiting_for: waitingFor,
      ci_wait: { reason: "no CI host has room" },
    });
    {
      await using _screen = await render(
        <ShipQueueJobDetails job={waitingJob("action")} environmentId={null} revision={0} />,
      );
      await expect
        .element(page.getByText("the owner's approval · no CI host has room", { exact: true }))
        .toBeVisible();
    }
    await using _screen = await render(
      <ShipQueueJobDetails job={waitingJob("challenge")} environmentId={null} revision={0} />,
    );
    await expect
      .element(
        page.getByText("a fix or an override of the challenged review · no CI host has room", {
          exact: true,
        }),
      )
      .toBeVisible();
  });
});
