import { EnvironmentId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../../test/render";
import { TooltipProvider } from "../../components/ui/tooltip";
import { _resetJobsStoreForTests, applyJobsStreamEvent, useSharedJobs } from "./jobsStore";
import { ThreadManagedJobCard } from "./ThreadManagedJobCard";

function useJobsStoreReset(): Disposable {
  return {
    [Symbol.dispose]: () => {
      _resetJobsStoreForTests();
    },
  };
}

function StoreJobCard(props: { readonly envId: EnvironmentId; readonly jobId: string }) {
  const job = useSharedJobs(props.envId).jobsById.get(props.jobId);
  if (!job) return null;
  return (
    <ThreadManagedJobCard
      job={job}
      nowMs={Date.parse("2026-11-28T07:00:00.000Z")}
      cancelling={false}
      onCancel={() => {}}
      onInspect={() => {}}
    />
  );
}

/** The upsert frame the server streams for an agent's command that hides its live cerno watch. */
const bgUpsert = (cerno: Record<string, unknown>) => ({
  id: "bg:c8fc49c1efb09e01",
  revision: 3,
  source: "background",
  kind: "command",
  title: "./run-suite.sh",
  phaseLabel: "Running",
  state: "running",
  binding: { threadId: "thread-delegate-health", host: "host-a" },
  timing: { startedAt: "2026-11-28T06:56:30.704Z" },
  cancellable: true,
  cerno: { checkedAt: "2026-11-28T06:56:37.731Z", outcome: "unknown", ...cerno },
});

describe("ThreadManagedJobCard cerno health", () => {
  it("shows the health bar a background job carries from its cerno process, and follows it", async () => {
    using _cleanup = useJobsStoreReset();
    const envId = EnvironmentId.make("local-cerno-health");
    applyJobsStreamEvent(
      envId,
      "upsert",
      bgUpsert({ state: "RUNNING", confidence: 1, tone: "info", pips: 4, label: "Healthy" }),
    );

    await using _screen = await render(
      <TooltipProvider delay={0}>
        <div style={{ width: "220px" }}>
          <StoreJobCard envId={envId} jobId="bg:c8fc49c1efb09e01" />
        </div>
      </TooltipProvider>,
    );

    const bars = page.getByTestId("cerno-signal-bars");
    await expect.element(bars).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "Inspect job: ./run-suite.sh (Healthy 100%)" }))
      .toBeVisible();
    expect(bars.element().querySelectorAll(".bg-info")).toHaveLength(4);

    applyJobsStreamEvent(
      envId,
      "upsert",
      bgUpsert({
        state: "STUCK_LOOP",
        confidence: 0.6,
        tone: "destructive",
        pips: 2,
        label: "Stalled",
        hangLoop: true,
      }),
    );
    await expect
      .element(page.getByRole("button", { name: "Inspect job: ./run-suite.sh (Stalled 60%)" }))
      .toBeVisible();
    expect(bars.element().querySelectorAll(".bg-destructive")).toHaveLength(2);
  });
});
