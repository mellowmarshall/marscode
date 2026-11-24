import {
  EnvironmentId,
  ProjectId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
  type ScopedThreadRef,
  type ShipQueueJob,
  type ThreadPullRequestLink,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { AsyncResult, Atom } from "effect/reactivity";
import type { ComponentProps } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

const SCRATCH_ROOT = "/home/user/.t3/scratch";
const FIXED_NOW_ISO = "2026-11-23T18:00:00.000Z";
const FIXED_NOW_MS = Date.parse(FIXED_NOW_ISO);

const state = vi.hoisted(() => ({
  workspaceRoot: "",
  folder: "",
  pullRequests: [] as unknown[],
  configLoaded: true,
  shipQueue: false,
  shipJobs: [] as ShipQueueJob[],
}));

vi.mock(import("~/hooks/useNowSecond"), () => ({
  useNowSecond: () => FIXED_NOW_MS,
}));

vi.mock(import("~/hooks/useNowMinute"), () => ({
  useNowMinute: () => FIXED_NOW_ISO,
}));

vi.mock(import("@tanstack/react-router"), async (importOriginal) => ({
  ...(await importOriginal()),
  useNavigate: () => vi.fn(),
}));

vi.mock(import("~/state/shipQueue"), async (importOriginal) => ({
  ...(await importOriginal()),
  useShipQueueSnapshot: () =>
    state.shipQueue
      ? {
          available: true,
          daemonRunning: true,
          daemonPid: 777,
          openCount: state.shipJobs.length,
          totalCount: state.shipJobs.length,
          jobs: state.shipJobs,
          deps: [],
        }
      : {
          available: false,
          daemonRunning: false,
          daemonPid: null,
          openCount: 0,
          totalCount: 0,
          jobs: [],
          deps: [],
        },
  useThreadShipJobs: () => (state.shipQueue ? state.shipJobs : []),
}));

vi.mock(import("~/state/entities"), async (importOriginal) => ({
  ...(await importOriginal()),
  useProject: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "project",
          environmentId: "environment",
          title: state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain",
          workspaceRoot: state.workspaceRoot,
          scripts: [],
        }) as never,
  useProjects: (() => []) as never,
  useQuietThreadShell: ((ref: unknown) =>
    ref === null
      ? null
      : {
          id: "thread",
          environmentId: "environment",
          projectId: "project",
          worktreePath: state.folder,
          branch: null,
          pullRequests: state.pullRequests,
        }) as never,
  useServerConfigs: (() =>
    new Map(
      state.configLoaded
        ? [
            [
              EnvironmentId.make("environment"),
              {
                scratchWorkspaceRoot: SCRATCH_ROOT,
                environment: {
                  capabilities: {
                    pullRequests: true,
                    shipQueue: state.shipQueue,
                  },
                },
              },
            ],
          ]
        : [],
    )) as never,
}));
// Neither folder is a repository, which is what the server reports for both.
vi.mock(import("~/state/vcs"), async (importOriginal) => {
  const actual = await importOriginal();
  const notARepo = Atom.make(
    AsyncResult.success({
      isRepo: false,
      hasPrimaryRemote: false,
      isDefaultRef: false,
      refName: null,
      hasWorkingTreeChanges: false,
      workingTree: { files: [], insertions: 0, deletions: 0 },
      hasUpstream: false,
      aheadCount: 0,
      behindCount: 0,
      aheadOfDefaultCount: 0,
      pr: null,
    }),
  );
  return {
    ...actual,
    vcsEnvironment: { ...actual.vcsEnvironment, status: (() => notARepo) as never },
  };
});

import { render } from "../../../test/render";
import { useRightPanelStore } from "../../rightPanelStore";
import { PopoverCreateHandle } from "../ui/popover";
import { TooltipProvider } from "../ui/tooltip";
import { ChatCanvasContext } from "./ChatCanvasContext";
import { resolveChatCanvasLayout } from "./chatCanvasLayout";
import { ThreadDetailsPanel } from "./ThreadDetailsPanel";

const threadRef: ScopedThreadRef = {
  environmentId: EnvironmentId.make("environment"),
  threadId: ThreadId.make("thread"),
};
const container = { width: 1200, height: 800 };
const placement = { x: 908, y: 0, right: 12, width: 280, height: 400 } as const;
const linkedPullRequest: ThreadPullRequestLink = {
  host: "github.com",
  repository: "pingdotgg/t3code",
  number: 27513,
  url: "https://github.com/pingdotgg/t3code/pull/27513",
  source: "manual",
  linkedAt: "2026-10-30T00:00:00.000Z",
  snapshot: null,
  stack: null,
};

function setup(input: {
  workspaceRoot: string;
  folder: string;
  pullRequests?: ThreadPullRequestLink[];
  configLoaded?: boolean;
  shipQueue?: boolean;
  shipJobs?: ShipQueueJob[];
}) {
  state.configLoaded = input.configLoaded ?? true;
  state.workspaceRoot = input.workspaceRoot;
  state.folder = input.folder;
  state.pullRequests = input.pullRequests ?? [];
  state.shipQueue = input.shipQueue ?? false;
  state.shipJobs = input.shipJobs ?? [];
  useRightPanelStore.setState({ threadPanelVisibilityByThreadKey: {} });
  const anchor = document.createElement("div");
  document.body.append(anchor);
  return {
    anchor: { current: anchor },
    handle: PopoverCreateHandle(),
    [Symbol.dispose]: () => anchor.remove(),
  };
}

const machines = (["This Mac", "Server"] as const).map((label, index) => ({
  environmentId: EnvironmentId.make(index === 0 ? "environment" : "other"),
  projectId: ProjectId.make("project"),
  label,
  isPrimary: index === 0,
  machine: "server" as const,
}));

function Panel({
  fixture,
  draftEnvMode,
  onMachines = false,
  backgroundWork,
  cardHeight = placement.height,
}: {
  fixture: ReturnType<typeof setup>;
  /** Renders an unsent draft in this mode instead of a started thread. */
  draftEnvMode?: "local" | "worktree";
  onMachines?: boolean;
  backgroundWork?: ComponentProps<typeof ThreadDetailsPanel>["backgroundWork"];
  cardHeight?: number;
}) {
  const noop = () => {};
  const scriptResult = async () => ({ ok: true }) as never;
  const cardPlacement = { ...placement, height: cardHeight };
  return (
    <TooltipProvider>
      <ChatCanvasContext
        value={{
          container,
          lane: { padding: 48, minChatWidth: 640 },
          layout: resolveChatCanvasLayout({ container, preview: null }),
          previewKey: null,
          registerTimeline: noop,
          measureDetailsCard: noop,
          detailsCardTopInset: 0,
          preferredDetailsCard: cardPlacement,
          detailsCardPlacement: cardPlacement,
        }}
      >
        <ThreadDetailsPanel
          anchor={fixture.anchor}
          handle={fixture.handle}
          environmentId={threadRef.environmentId}
          threadId={threadRef.threadId}
          projectId={ProjectId.make("project")}
          composerDraftTarget={threadRef}
          worktreePath={draftEnvMode === undefined ? state.folder : null}
          isServerThread={draftEnvMode === undefined}
          activeProjectName={state.workspaceRoot === SCRATCH_ROOT ? "No project" : "plain"}
          activeProjectScripts={undefined}
          preferredScriptId={null}
          keybindings={[]}
          availableEditors={[]}
          showOpenInPicker={false}
          openInShortcutEnabled={false}
          gitCwd={state.folder}
          workspaceMutationId={null}
          isGitRepo={false}
          offersWorkspaceModes={false}
          envLocked={draftEnvMode === undefined}
          availableEnvironments={onMachines ? machines : []}
          {...(onMachines ? { onEnvironmentChange: noop } : {})}
          onEnvModeChange={noop}
          envMode={draftEnvMode ?? "local"}
          startFromOrigin={false}
          onStartFromOriginChange={noop}
          onComposerFocusRequest={noop}
          onRunProjectScript={noop}
          onAddProjectScript={scriptResult}
          onUpdateProjectScript={scriptResult}
          onDeleteProjectScript={scriptResult}
          {...(backgroundWork ? { backgroundWork } : {})}
          usage={{} as never}
        />
      </ChatCanvasContext>
    </TooltipProvider>
  );
}

it("offers no git controls in a No project thread, but shows its linked pull request", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("shows Current checkout where no worktree can come from, even when New worktree is the default", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(<Panel fixture={fixture} draftEnvMode="worktree" />);
  await expect.element(page.getByLabelText("Run context: Current checkout")).toBeVisible();
  await expect.element(page.getByRole("button", { name: /Run context/ })).not.toBeInTheDocument();
});

it("offers only machines where no worktree can come from and several machines exist", async () => {
  using fixture = setup({ workspaceRoot: SCRATCH_ROOT, folder: SCRATCH_ROOT });
  await using _screen = await render(
    <Panel fixture={fixture} draftEnvMode="worktree" onMachines />,
  );
  await page.getByRole("button", { name: "Run context: This Mac, Current checkout" }).click();
  await expect.element(page.getByText("Run on")).toBeVisible();
  await expect.element(page.getByText("New worktree")).not.toBeInTheDocument();
});

it("shows a linked pull request in a folder that is not a git repository", async () => {
  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    pullRequests: [linkedPullRequest],
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect.element(page.getByText("#27513")).toBeVisible();
  await expect.element(page.getByRole("button", { name: "Initialize Git" })).toBeVisible();
});

it("offers no Initialize Git before the server config says where No project lives", async () => {
  using fixture = setup({
    workspaceRoot: SCRATCH_ROOT,
    folder: `${SCRATCH_ROOT}/thread`,
    configLoaded: false,
  });
  await using _screen = await render(<Panel fixture={fixture} />);
  await expect.element(page.getByRole("region", { name: "Workspace" })).toBeVisible();
  await expect
    .element(page.getByRole("button", { name: "Initialize Git" }))
    .not.toBeInTheDocument();
});

it("deduplicates ship-queue tasks from the right rail while keeping unrelated background work", async () => {
  const liveJob: ShipQueueJob = {
    id: "10987",
    repo: "devtools",
    branch: "feat/s6",
    title: "Ship S6 (#88)",
    state: "running",
    stage: "push",
    pr: "88",
    prRepo: "private-repo",
    threadId: threadRef.threadId,
    submittedAt: "2026-11-23T17:58:00.000Z",
    lastMarker: "PUSHING job=10987",
  };
  const shipOnlyTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
    {
      kind: "command",
      taskId: "sq-watch",
      awaited: true,
      command: "ship-queue watch 10987",
    },
    {
      kind: "monitor",
      taskId: "sq-cerno",
      awaited: true,
      command: "cerno watch --monitor --log /tmp/sq.log -- ship-queue submit /data/wt feat t b.md",
    },
    {
      kind: "monitor",
      taskId: "sq-empty",
      awaited: true,
      description: "ship-queue 10987 (#111)",
    },
  ];
  const trainTask: OrchestrationV2PendingBackgroundTask = {
    kind: "command",
    taskId: "train-cmd",
    awaited: true,
    command: "python train.py --epochs 10",
  };
  const emptyTurnItems = [
    {
      id: TurnItemId.make("item-train"),
      threadId: threadRef.threadId,
      runId: RunId.make("run-1"),
      nodeId: null,
      providerThreadId: null,
      providerTurnId: null,
      nativeItemRef: null,
      parentItemId: null,
      ordinal: 0,
      type: "command_execution" as const,
      status: "running" as const,
      title: null,
      input: "python train.py --epochs 10",
      output: "",
      startedAt: DateTime.makeUnsafe("2026-11-23T17:59:00.000Z"),
      completedAt: null,
      updatedAt: DateTime.makeUnsafe("2026-11-23T17:59:10.000Z"),
    },
  ];
  const baseBackgroundWork = {
    tasks: shipOnlyTasks,
    turnItems: emptyTurnItems,
    branch: "feat/s6",
    stopDisabled: false,
    stopping: false,
    onStop: async () => {},
    onOpenThread: () => {},
  };

  using fixture = setup({
    workspaceRoot: "/work/plain",
    folder: "/work/plain",
    shipQueue: true,
    shipJobs: [liveJob],
  });

  {
    await using shipOnlyScreen = await render(
      <Panel fixture={fixture} backgroundWork={baseBackgroundWork} cardHeight={700} />,
    );
    await expect.element(page.getByRole("region", { name: "Ship Queue" })).toBeVisible();
    await expect.element(page.getByText("Shipping")).toBeVisible();
    await expect.element(page.getByText("Merge", { exact: true })).toBeVisible();
    await expect.element(page.getByText("#88")).toBeVisible();
    expect(
      shipOnlyScreen.container.querySelector("[data-thread-details-background-work]"),
    ).toBeNull();
  }

  {
    await using mixedScreen = await render(
      <Panel
        fixture={fixture}
        cardHeight={700}
        backgroundWork={{
          ...baseBackgroundWork,
          tasks: [...shipOnlyTasks, trainTask],
        }}
      />,
    );
    await expect.element(page.getByRole("region", { name: "Ship Queue" })).toBeVisible();
    await expect.element(page.getByText("python train.py")).toBeVisible();
    const bgContainer = mixedScreen.container.querySelector(
      "[data-thread-details-background-work]",
    );
    expect(bgContainer).not.toBeNull();
    expect(bgContainer?.textContent).toContain("python train.py");
    expect(bgContainer?.textContent).not.toContain("ship-queue");
  }
});
