import { EnvironmentId, ProjectId, ThreadId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import "~/index.css";
import { render } from "../../test/render";
import { SortableThreadRow } from "../components/sidebar/SidebarThreadRow";
import { TooltipProvider } from "../components/ui/tooltip";
import { makeThreadFixture } from "../test-fixtures";
import { _resetJobsStoreForTests, applyJobsStreamEvent } from "./jobs/jobsStore";

function useJobsStoreReset(): Disposable {
  return {
    [Symbol.dispose]: () => {
      _resetJobsStoreForTests();
    },
  };
}

describe("SidebarThreadRow with active bounded job", () => {
  it("keeps the thread title visible at normal width and on hover when a running job has a long phaseLabel", async () => {
    using _cleanup = useJobsStoreReset();
    const envId = EnvironmentId.make("local-sidebar-job");
    const threadId = ThreadId.make("thread-project-d-1");
    const projectId = ProjectId.make("proj-project-d");

    applyJobsStreamEvent(envId, "upsert", {
      id: "bg:ba297b8f-e84",
      revision: 1,
      source: "background",
      kind: "train",
      title: "MicroCortex-F6-6L Distillation & DEV Eval",
      phaseLabel: "Stage 1: Teacher Cache + F6-6L G",
      state: "running",
      binding: { threadId, host: "host-a" },
      timing: { startedAt: "2026-11-22T11:18:10.366Z" },
      progress: { current: 19200, total: 40458, fraction: 19200 / 40458 },
      cancellable: true,
    });

    const thread = makeThreadFixture({
      id: threadId,
      environmentId: envId,
      projectId,
      title: "MicroCortex F6 Distillation",
      branch: "master",
    });

    await using _screen = await render(
      <TooltipProvider delay={0}>
        <ul style={{ width: "240px", padding: "8px", listStyle: "none" }}>
          <SortableThreadRow
            sortableId="thread-project-d-1"
            sortableDisabled
            contextDrag={false}
            thread={thread}
            variant="folder-multiline"
            variantAction="settle"
            settlementSupported
            snoozeSupported={false}
            pinningSupported={false}
            isPinned={false}
            dropVerb={null}
            dragOverPinned={false}
            sweepAction={null}
            snoozeWakeLabelText={null}
            wokeAt={null}
            isActive
            isRouteThread
            readOpensPullRequestsInRightPanel={() => false}
            jumpLabel={null}
            environmentLabel={null}
            environmentMachine="linux"
            project={null}
            projectDisplayName="Project D"
            providerEntryByInstanceId={new Map()}
            timestampFormat="locale"
            onThreadClick={() => {}}
            onThreadActivate={() => {}}
            onStartRename={() => {}}
            onRenameTitleChange={() => {}}
            onCommitRename={() => {}}
            onCancelRename={() => {}}
            isRenaming={false}
            renamingTitle=""
            onContextMenu={() => {}}
            onSettle={() => {}}
            onActionSweepStart={() => {}}
            onUnsettle={() => {}}
            onSnooze={() => {}}
            onUnsnooze={() => {}}
            onUnpin={() => {}}
            onAcknowledgeWoke={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );

    const row = page.getByTestId("sidebar-row-folder");
    const titleEl = row.getByText("MicroCortex F6 Distillation", { exact: true });
    await expect.element(row).toBeVisible();
    await expect.element(titleEl).toBeVisible();

    // Compact status shows "Train" and "47%", never the 32-char raw phaseLabel
    await expect.element(row.getByText("Train", { exact: true })).toBeVisible();
    await expect.element(row.getByText("47%", { exact: true })).toBeVisible();
    expect(row.element().textContent).not.toContain("Stage 1:");

    // Title must NOT be crushed to 0px width by the job status pill
    const rowRect = row.element().getBoundingClientRect();
    const titleRect = titleEl.element().getBoundingClientRect();
    const pctRect = row.getByText("47%", { exact: true }).element().getBoundingClientRect();
    expect(titleRect.width).toBeGreaterThan(75);
    expect(pctRect.right).toBeLessThanOrEqual(rowRect.right + 1);

    // Hovering the thread row must NOT make the thread title disappear
    await row.hover();
    const titleRectHovered = titleEl.element().getBoundingClientRect();
    const titleOpacityHovered = window.getComputedStyle(titleEl.element()).opacity;
    expect(titleRectHovered.width).toBeGreaterThan(75);
    expect(Number.parseFloat(titleOpacityHovered)).toBeGreaterThan(0.9);
  });

  it("keeps project name and title visible in card variant with an active bounded job", async () => {
    using _cleanup = useJobsStoreReset();
    const envId = EnvironmentId.make("local-sidebar-job-card");
    const threadId = ThreadId.make("thread-project-d-card");
    const projectId = ProjectId.make("proj-project-d");

    applyJobsStreamEvent(envId, "upsert", {
      id: "bg:card-job-1",
      revision: 1,
      source: "background",
      kind: "train",
      title: "MicroCortex-F6-6L Distillation & DEV Eval",
      phaseLabel: "Stage 1: Teacher Cache + F6-6L G",
      state: "running",
      binding: { threadId, host: "host-a" },
      timing: { startedAt: "2026-11-22T11:18:10.366Z" },
      progress: { current: 19200, total: 40458, fraction: 19200 / 40458 },
      cancellable: true,
    });

    const thread = makeThreadFixture({
      id: threadId,
      environmentId: envId,
      projectId,
      title: "MicroCortex F6 Distillation",
      branch: "master",
    });

    await using _screen = await render(
      <TooltipProvider delay={0}>
        <ul style={{ width: "240px", padding: "8px", listStyle: "none" }}>
          <SortableThreadRow
            sortableId="thread-project-d-card"
            sortableDisabled
            contextDrag={false}
            thread={thread}
            variant="card"
            variantAction="settle"
            settlementSupported
            snoozeSupported={false}
            pinningSupported={false}
            isPinned={false}
            dropVerb={null}
            dragOverPinned={false}
            sweepAction={null}
            snoozeWakeLabelText={null}
            wokeAt={null}
            isActive
            isRouteThread
            readOpensPullRequestsInRightPanel={() => false}
            jumpLabel={null}
            environmentLabel={null}
            environmentMachine="linux"
            project={null}
            projectDisplayName="Project D"
            providerEntryByInstanceId={new Map()}
            timestampFormat="locale"
            onThreadClick={() => {}}
            onThreadActivate={() => {}}
            onStartRename={() => {}}
            onRenameTitleChange={() => {}}
            onCommitRename={() => {}}
            onCancelRename={() => {}}
            isRenaming={false}
            renamingTitle=""
            onContextMenu={() => {}}
            onSettle={() => {}}
            onActionSweepStart={() => {}}
            onUnsettle={() => {}}
            onSnooze={() => {}}
            onUnsnooze={() => {}}
            onUnpin={() => {}}
            onAcknowledgeWoke={() => {}}
          />
        </ul>
      </TooltipProvider>,
    );

    const row = page.getByTestId("sidebar-row-card");
    const projectEl = row.getByText("Project D", { exact: true });
    const titleEl = row.getByText("MicroCortex F6 Distillation", { exact: true });
    await expect.element(row).toBeVisible();
    await expect.element(projectEl).toBeVisible();
    await expect.element(titleEl).toBeVisible();
    await expect.element(row.getByText("Train", { exact: true })).toBeVisible();
    await expect.element(row.getByText("47%", { exact: true })).toBeVisible();
    expect(row.element().textContent).not.toContain("Stage 1:");

    expect(projectEl.element().getBoundingClientRect().width).toBeGreaterThan(35);
    expect(titleEl.element().getBoundingClientRect().width).toBeGreaterThan(100);

    await row.hover();
    expect(titleEl.element().getBoundingClientRect().width).toBeGreaterThan(100);
    expect(Number.parseFloat(window.getComputedStyle(titleEl.element()).opacity)).toBeGreaterThan(
      0.9,
    );
  });
});
