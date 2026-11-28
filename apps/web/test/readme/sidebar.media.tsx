import { EnvironmentId, ProjectId, ThreadId, type RuntimeRequestId } from "@t3tools/contracts";
import { afterEach, describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

vi.mock("../../src/devtools/devtoolsClient", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/devtools/devtoolsClient")>();
  // No server: every DevTools read and action answers "not found".
  return {
    ...actual,
    fetchDevtoolsJson: () =>
      Promise.resolve({ ok: false, status: 404, data: null, error: "Not found" }),
  };
});

import "~/index.css";
import type { TimelineRowSharedState } from "../../src/components/chat/timelineRowContext";
import { TimelineRowCtx } from "../../src/components/chat/timelineRowContext";
import { TimelinePendingApprovalRow } from "../../src/components/chat/TimelinePendingApprovalRow";
import { SortableThreadRow } from "../../src/components/sidebar/SidebarThreadRow";
import { SidebarMenu, SidebarProvider } from "../../src/components/ui/sidebar";
import { TooltipProvider } from "../../src/components/ui/tooltip";
import { DevtoolsSidebarItems } from "../../src/devtools/DevtoolsEntry";
import { applyGuardBrokerEvent, clearPendingGuardsForEnv } from "../../src/devtools/devtoolsStore";
import { FleetIcon } from "../../src/devtools/FleetIcon";
import { _resetJobsStoreForTests, applyJobsStreamEvent } from "../../src/devtools/jobs/jobsStore";
import { deriveThreadDevtoolsApprovals } from "../../src/devtools/threadApprovals";
import { ThreadDevtoolsPanel } from "../../src/devtools/ThreadDevtoolsPanel";
import { makeThreadFixture } from "../../src/test-fixtures";
import { render } from "../render";
import { captureMedia, holdAnimationsAt, MediaFrame } from "./readmeMediaCapture";
import {
  cernoHealthStages,
  planGuardRequest,
  sidebarJobs,
  sidebarThreads,
  threadKeyGrants,
} from "./readmeMediaFixtures";

const ENV = EnvironmentId.make("env-local");
const NOW = Date.now();
// One cycle of `approval-row-glow` in index.css.
const GLOW_CYCLE_S = 1.6;
const GLOW_FRAMES = 8;

afterEach(() => {
  _resetJobsStoreForTests();
  clearPendingGuardsForEnv(ENV);
});

function seedStores(stage = cernoHealthStages[0]!) {
  applyJobsStreamEvent(ENV, "snapshot", { jobs: sidebarJobs(NOW, stage) });
  applyGuardBrokerEvent(ENV, "Local", {
    type: "snapshot",
    pending: [planGuardRequest(NOW)],
    grants: threadKeyGrants(NOW),
  });
}

function ThreadRow({
  thread,
}: {
  readonly thread: { readonly id: string; readonly title: string };
}) {
  return (
    <SortableThreadRow
      sortableId={thread.id}
      sortableDisabled
      contextDrag={false}
      thread={makeThreadFixture({
        id: ThreadId.make(thread.id),
        environmentId: ENV,
        projectId: ProjectId.make("project-a"),
        title: thread.title,
        branch: null,
      })}
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
      isActive={false}
      isRouteThread={false}
      readOpensPullRequestsInRightPanel={() => false}
      jumpLabel={null}
      environmentLabel={null}
      environmentMachine="linux"
      project={null}
      projectDisplayName="example-repo"
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
  );
}

function SidebarColumn({
  name,
  threads,
  paddingTop,
}: {
  readonly name: string;
  readonly threads: ReadonlyArray<{ readonly id: string; readonly title: string }>;
  readonly paddingTop?: number;
}) {
  return (
    <TooltipProvider delay={0}>
      <MediaFrame name={name} width={320}>
        <ul
          className="m-0 list-none space-y-1 rounded-lg bg-sidebar p-2"
          style={{ marginTop: paddingTop }}
        >
          {threads.map((thread) => (
            <ThreadRow key={thread.id} thread={thread} />
          ))}
        </ul>
      </MediaFrame>
    </TooltipProvider>
  );
}

const sidebarOrder = [sidebarThreads.approval, sidebarThreads.shipping, sidebarThreads.job];

describe("README media: thread sidebar", () => {
  it("rows for approval, shipping with a granted key, and a job", async () => {
    seedStores();
    await using _screen = await render(
      <SidebarColumn name="sidebar-threads" threads={sidebarOrder} />,
    );
    await expect.element(page.getByText("Shipping", { exact: true })).toBeVisible();
    await expect.element(page.getByText("Approval", { exact: true })).toBeVisible();
    await expect.element(page.getByTestId("thread-grant-key-badge")).toBeVisible();
    const frame = document.querySelector('[data-media="sidebar-threads"]')!;
    // The still shows the glow at its brightest; the GIF below shows it pulse.
    holdAnimationsAt(frame, GLOW_CYCLE_S / 2);
    await captureMedia("sidebar-threads", "sidebar-threads", "allow");
  });

  it("the pending-approval glow, one frame per phase", async () => {
    seedStores();
    await using _screen = await render(
      <SidebarColumn
        name="approval-glow"
        threads={[sidebarThreads.approval, sidebarThreads.shipping]}
      />,
    );
    await expect.element(page.getByText("Approval", { exact: true })).toBeVisible();
    const frame = document.querySelector('[data-media="approval-glow"]')!;
    for (let i = 0; i < GLOW_FRAMES; i++) {
      holdAnimationsAt(frame, (GLOW_CYCLE_S * i) / GLOW_FRAMES);
      await captureMedia(
        `frames/approval-glow/${String(i).padStart(2, "0")}`,
        "approval-glow",
        "allow",
      );
    }
  });

  it("the key badge lists a thread's live grants", async () => {
    seedStores();
    await using _screen = await render(
      <SidebarColumn name="permission-key" threads={[sidebarThreads.shipping]} paddingTop={150} />,
    );
    const key = page.getByTestId("thread-grant-key-badge");
    await expect.element(key).toBeVisible();
    await key.hover();
    await expect.element(page.getByText("Package registry token")).toBeVisible();
    await captureMedia("permission-key");
  });

  it("the Fleet icon in the sidebar", async () => {
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="fleet-icon" width={440}>
          <SidebarProvider className="min-h-0">
            <div className="flex w-full items-end gap-20 pt-12 pl-2">
              <FleetIcon className="size-16 text-foreground" />
              <div className="ml-12 rounded-lg bg-sidebar p-1">
                <SidebarMenu className="flex-row">
                  <DevtoolsSidebarItems />
                </SidebarMenu>
              </div>
            </div>
          </SidebarProvider>
        </MediaFrame>
      </TooltipProvider>,
    );
    const button = page.getByRole("button", { name: "Fleet Console" });
    await button.hover();
    await expect.element(page.getByText("Fleet Console (Machines · Reaper)")).toBeVisible();
    await captureMedia("fleet-icon");
  });
});

describe("README media: thread rail jobs", () => {
  const rail = () => (
    <TooltipProvider delay={0}>
      <MediaFrame name="thread-jobs" width={300}>
        <div className="rounded-lg border border-border/60 bg-card/40 py-2">
          <ThreadDevtoolsPanel
            environmentId={ENV}
            threadId={ThreadId.make(sidebarThreads.job.id)}
            gitCwd={null}
            worktreePath={null}
          />
        </div>
      </MediaFrame>
    </TooltipProvider>
  );

  it("background jobs with cerno health, and the health changing", async () => {
    seedStores();
    await using screen = await render(rail());
    await expect.element(page.getByText("Ranker training")).toBeVisible();
    await captureMedia("thread-jobs");
    for (const [i, stage] of cernoHealthStages.entries()) {
      applyJobsStreamEvent(ENV, "snapshot", { jobs: sidebarJobs(NOW, stage) });
      await screen.rerender(rail());
      const pct = `${Math.round(stage.fraction * 100)}%`;
      await expect.element(page.getByText(pct, { exact: true })).toBeVisible();
      await captureMedia(`frames/job-health/${String(i).padStart(2, "0")}`, "thread-jobs");
    }
  });
});

describe("README media: owner approval for a plan", () => {
  it("one approval covers a list of commands", async () => {
    const entry = deriveThreadDevtoolsApprovals({
      threadId: sidebarThreads.approval.id,
      pendingGuards: [planGuardRequest(NOW)],
      shipJobs: [],
      depsRepos: [],
      nowMs: NOW,
    })[0]!;
    const ctx = {
      respondingRequestIds: [] as ReadonlyArray<RuntimeRequestId>,
      canOperateThread: true,
      onRespondToApproval: () => Promise.resolve(),
    } as unknown as TimelineRowSharedState;
    await using _screen = await render(
      <TooltipProvider delay={0}>
        <MediaFrame name="approval-plan" width={860}>
          <TimelineRowCtx value={ctx}>
            <TimelinePendingApprovalRow approval={entry.approval} />
          </TimelineRowCtx>
        </MediaFrame>
      </TooltipProvider>,
    );
    await expect.element(page.getByRole("button", { name: "Approve all listed" })).toBeVisible();
    await captureMedia("approval-plan");
  });
});
