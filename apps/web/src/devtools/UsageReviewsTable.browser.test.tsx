import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import type { ReviewStatsGroupRow, ReviewStatsPayload } from "./devtoolsClient";
import { UsageReviewsTable } from "./UsageReviewsTable";

function row(model: string, effort: string, reviews: number): ReviewStatsGroupRow {
  return {
    key: `${model} (${effort})`,
    model,
    effort,
    family: "Family A",
    reviews,
    passed: reviews - 1,
    flagged: 1,
    passRatePct: (100 * (reviews - 1)) / reviews,
    avgIssues: 1.5,
    bypasses: 0,
    friction: 0,
    fallbacks: 0,
    breaking: 1,
    critical: 2,
    high: 3,
    medium: 4,
    low: 5,
    info: 0,
    total: 15,
  };
}

const LONG_MODEL = `model-${"a".repeat(80)}`;

const stats: ReviewStatsPayload = {
  side: "reviewer",
  by: "model",
  totals: row("all", "", 30),
  groups: [
    row("model-a", "xhigh", 12),
    row("model-a", "high", 8),
    row("model-b", "medium", 6),
    row(LONG_MODEL, "low", 4),
  ],
  recent: [],
  highlights: { topBugSubmitter: null, topBugCatcher: null },
  facets: { repos: [], labs: [], families: [], hosts: ["host-a"] },
};

async function renderAt(width: number) {
  const container = document.createElement("div");
  container.style.width = `${width}px`;
  document.body.append(container);
  const screen = await render(<UsageReviewsTable stats={stats} side="reviewer" loading={false} />, {
    container,
  });
  await expect.element(page.getByRole("button", { name: "model-a" })).toBeVisible();
  return { screen, container };
}

describe("UsageReviewsTable", () => {
  it("shows one collapsed row per model and expands efforts on demand", async () => {
    const { screen } = await renderAt(976);
    await using _screen = screen;

    const toggle = page.getByRole("button", { name: "model-a" });
    await expect.element(toggle).toHaveAttribute("aria-expanded", "false");
    const effortsId = toggle.element().getAttribute("aria-controls");
    const efforts = effortsId ? document.getElementById(effortsId) : null;
    expect(efforts?.textContent).toContain("xhigh");
    await expect.element(page.getByText("xhigh", { exact: true })).not.toBeVisible();
    expect(document.body.textContent).not.toContain("Family A");
    await expect.element(page.getByText("3 models")).toBeVisible();

    await toggle.click();
    await expect.element(toggle).toHaveAttribute("aria-expanded", "true");
    await expect.element(page.getByText("xhigh", { exact: true })).toBeVisible();
    await expect.element(page.getByText("high", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Family A")).toBeVisible();
    await expect.element(page.getByText("medium", { exact: true })).not.toBeVisible();

    await toggle.click();
    await expect.element(page.getByText("xhigh", { exact: true })).not.toBeVisible();
  });

  it.each([976, 432])(
    "never scrolls sideways at %ipx, wrapping long model names",
    async (width) => {
      const { screen, container } = await renderAt(width);
      await using _screen = screen;
      const table = container.querySelector("table");
      expect(table).not.toBeNull();
      expect(table!.scrollWidth).toBeLessThanOrEqual(container.clientWidth);
      for (const scroller of container.querySelectorAll<HTMLElement>("*")) {
        expect(scroller.scrollWidth, scroller.className).toBeLessThanOrEqual(
          scroller.clientWidth + 1,
        );
      }
      const severityHeader = page.getByRole("columnheader", { name: "Brk" });
      if (width < 576) {
        await expect.element(severityHeader).not.toBeInTheDocument();
      } else {
        await expect.element(severityHeader).toBeVisible();
      }
    },
  );
});
