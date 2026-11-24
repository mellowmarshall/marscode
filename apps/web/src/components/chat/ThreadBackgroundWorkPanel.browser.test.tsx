import "~/index.css";

import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type CernoLiveRun,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { CernoRunAssessment } from "../jobs/CernoRunAssessment";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadBackgroundWorkPanel } from "./ThreadBackgroundWorkPanel";

const mockState = vi.hoisted(() => ({
  canReadDiagnostics: true,
  cernoRuns: [] as ReadonlyArray<CernoLiveRun>,
  cernoQueryRequests: 0,
}));

vi.mock("./CommandOutputPanel", () => ({
  CommandOutputPanel: () => <div>Command output stream</div>,
  useCommandOutputStreaming: () => true,
}));

vi.mock("../../state/session", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/session")>();
  return {
    ...actual,
    useEnvironmentScope: (_environmentId: unknown, scope: string) =>
      scope === "diagnostics:read" ? mockState.canReadDiagnostics : true,
  };
});

vi.mock("../../state/server", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/server")>();
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      cernoRuns: (args: unknown) => ({ __mockCernoRuns: true, args }),
    },
  };
});

vi.mock("../../state/query", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../state/query")>();
  return {
    ...actual,
    useEnvironmentQuery: (atom: unknown) => {
      if (atom && typeof atom === "object" && "__mockCernoRuns" in atom) {
        mockState.cernoQueryRequests += 1;
        return {
          data: { sampledAt: 1_795_458_330_000, runs: mockState.cernoRuns },
          dataUpdatedAt: 1_795_458_330_000,
          isLoading: false,
        };
      }
      return actual.useEnvironmentQuery(atom as never);
    },
  };
});

const environmentId = EnvironmentId.make("env-1");
const threadId = ThreadId.make("thread-1");
const childThreadId = ThreadId.make("thread-subagent-1");
const runId = RunId.make("run-1");
const trainItemId = TurnItemId.make("item-train-1");

const trainOutput = [
  "step=10 loss=1.420 lr=0.0010",
  "step=20 loss=0.910 lr=0.0009",
  "step=30 loss=0.615 lr=0.0008",
  "Training 60%|██████    | 30/50 [00:15<00:10, 2.00it/s] ETA 0:10",
].join("\n");

const turnItems: ThreadStructure["turnItems"] = [
  {
    id: trainItemId,
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 0,
    type: "command_execution",
    status: "running",
    title: null,
    input: "python train.py --epochs 10",
    output: trainOutput,
    startedAt: DateTime.makeUnsafe("2026-11-23T09:00:00.000Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-23T09:00:15.000Z"),
  },
];

const twoTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
  {
    kind: "command",
    taskId: "task-train",
    itemId: trainItemId,
    awaited: true,
    command: "python train.py --epochs 10",
  },
  {
    kind: "subagent",
    taskId: "task-agent",
    description: "Inspect fixtures",
    childThreadId,
  },
];

const fourTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
  ...twoTasks,
  {
    kind: "monitor",
    taskId: "task-mon",
    awaited: true,
    description: "Tail training logs",
  },
  {
    kind: "background_task",
    taskId: "task-eval",
    description: "Eval checkpoint",
  },
];

const sampleCernoRun: CernoLiveRun = {
  schemaVersion: 1,
  pid: 951254,
  childPid: 951256,
  startedAtMs: 1_795_457_112_000,
  updatedAtMs: 1_795_458_325_000,
  elapsedSec: 1213,
  mode: "watch-monitor",
  engine: "cernibundus_c11_avx2_int8",
  cwd: "/data/Dev/private-repo/worktrees/pass4-aaa",
  command: "ssh dev-host-x Build.sh",
  logPath: "/data/Dev/private-repo/logs/pass9_loop1_build.log",
  state: "RUNNING",
  confidence: 0.96,
  margin: 4.8,
  stateProbs: {
    RUNNING: 0.96,
    SUCCEEDED: 0,
    FAILED: 0.01,
    NEEDS_INPUT: 0.01,
    STUCK_LOOP: 0.02,
  },
  outcome: "IN_PROGRESS",
  pFail: 0.04,
  failMargin: -3.1,
  cutoffs: { suspThresh: 0.55, suspMargin: 0.5, confThresh: 0.82, confMargin: 1.8 },
  prompt: false,
  hangLoop: false,
  serverReady: false,
  authRequired: false,
  resourceKill: "NORMAL",
  gitConflict: "NORMAL",
  wchan: "poll_schedule_timeout",
  cpuActive: false,
  hasRemoteSocket: true,
  hasListenSocket: false,
  hasExtFileLock: false,
  silenceSec: 14,
  stallTimeoutSec: 180,
  bytesStdout: 20450,
  bytesStderr: 0,
  alert: null,
  tail: "[416/2554] Compile Module.Engine.12.cpp",
  logTail:
    "[415/2554] Compile Module.MaterialEditor.2.cpp\n[416/2554] Compile Module.Engine.12.cpp",
};

function withResetCernoMock() {
  mockState.canReadDiagnostics = true;
  mockState.cernoRuns = [];
  mockState.cernoQueryRequests = 0;
  return {
    [Symbol.dispose]() {
      mockState.canReadDiagnostics = true;
      mockState.cernoRuns = [];
      mockState.cernoQueryRequests = 0;
    },
  };
}

describe("ThreadBackgroundWorkPanel", () => {
  it("renders sparse inline rows in full density with <= 3 tasks and opens the inspector cleanly", async () => {
    using _mock = withResetCernoMock();
    const dateNowSpy = vi
      .spyOn(Date, "now")
      .mockReturnValue(Date.parse("2026-11-23T09:00:17.000Z"));
    using _realClock = { [Symbol.dispose]: () => dateNowSpy.mockRestore() };

    const onOpenThread = vi.fn();
    const onStop = vi.fn(async () => {});

    await using screen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={twoTasks}
            turnItems={turnItems}
            branch="feat/jobs"
            stopDisabled={false}
            stopping={false}
            onStop={onStop}
            onOpenThread={onOpenThread}
          />
        </div>
      </TooltipProvider>,
    );

    // Non-cerno tasks must not poll serverListCernoRuns
    expect(mockState.cernoQueryRequests).toBe(0);
    expect(screen.container.querySelector("[data-thread-details-background-work]")).not.toBeNull();
    await expect.element(page.getByText("python train.py")).toBeVisible();
    await expect.element(page.getByText("60%")).toBeVisible();
    await expect.element(page.getByText("Inspect fixtures")).toBeVisible();
    expect(page.getByRole("button", { name: /Background work/i }).query()).toBeNull();

    await page.getByRole("button", { name: /python train\.py/i }).click();
    const dialog = page.getByRole("dialog");
    await expect.element(dialog).toBeVisible();
    await expect.element(dialog.getByText("Command output stream")).toBeVisible();
    await expect.element(dialog.getByText(/ETA 0:10/i)).toBeVisible();
    await expect.element(dialog.getByText("loss").first()).toBeVisible();
    await expect.element(dialog.getByText("0.615").first()).toBeVisible();
    expect(document.querySelector('svg[role="img"]')).not.toBeNull();

    await dialog.getByRole("button", { name: "Close" }).click();
    await expect.element(page.getByRole("dialog")).not.toBeInTheDocument();
    await page
      .getByRole("region", { name: "Background work" })
      .getByRole("button", { name: /Inspect fixtures/i })
      .click();
    await expect.element(page.getByRole("button", { name: "Open subagent" })).toBeVisible();
    await page.getByRole("button", { name: "Open subagent" }).click();
    expect(onOpenThread).toHaveBeenCalledWith(childThreadId);
  });

  it("collapses to a single summary row when density is compact or > 3 tasks are active", async () => {
    await using compactScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="compact"
            environmentId={environmentId}
            threadId={threadId}
            tasks={twoTasks}
            turnItems={turnItems}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );

    await expect.element(page.getByRole("button", { name: /Background work/i })).toBeVisible();
    expect(compactScreen.container.textContent).not.toContain("python train.py");
    expect(compactScreen.container.textContent).toContain("2");

    await using denseScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={fourTasks}
            turnItems={turnItems}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );

    expect(denseScreen.container.textContent).toContain("Background work");
    expect(denseScreen.container.textContent).toContain("4");
  });

  it("renders nothing when there are no active tasks", async () => {
    await using emptyScreen = await render(
      <TooltipProvider>
        <ThreadBackgroundWorkPanel
          density="full"
          environmentId={environmentId}
          threadId={threadId}
          tasks={[]}
          turnItems={[]}
          stopDisabled={false}
          stopping={false}
          onStop={async () => {}}
          onOpenThread={() => {}}
        />
      </TooltipProvider>,
    );

    expect(emptyScreen.container.querySelector("[data-thread-details-background-work]")).toBeNull();
  });

  it("gates cerno polling on diagnostics scope, matches cerno runs inline, and shows summary verdicts", async () => {
    using _mock = withResetCernoMock();
    const cernoTask: OrchestrationV2PendingBackgroundTask = {
      kind: "monitor",
      taskId: "task-cerno-build",
      awaited: true,
      command:
        "cerno watch --monitor --log /data/Dev/private-repo/logs/pass9_loop1_build.log -- ssh dev-host-x Build.sh",
    };

    // Without diagnostics:read scope, panel must not poll cernoRuns even for cerno tasks
    mockState.canReadDiagnostics = false;
    mockState.cernoRuns = [sampleCernoRun];
    await using deniedScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={[cernoTask]}
            turnItems={[]}
            cwd={sampleCernoRun.cwd}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    expect(mockState.cernoQueryRequests).toBe(0);
    expect(deniedScreen.container.textContent).not.toContain("Healthy");

    // With diagnostics:read scope, panel polls cernoRuns and renders inline verdict + logTail progress
    mockState.canReadDiagnostics = true;
    await using liveScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={[cernoTask]}
            turnItems={[]}
            cwd={sampleCernoRun.cwd}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );

    expect(mockState.cernoQueryRequests).toBeGreaterThan(0);
    expect(liveScreen.container.textContent).toContain("ssh dev-host-x");
    expect(liveScreen.container.textContent).toContain("Healthy");
    expect(liveScreen.container.textContent).toContain("96%");
    expect(liveScreen.container.textContent).toContain("14s ago");
    expect(liveScreen.container.textContent).toContain("16% · 416/2554");

    // Compact summary row surfaces the worst matched cerno verdict
    await using compactCernoScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="compact"
            environmentId={environmentId}
            threadId={threadId}
            tasks={[cernoTask]}
            turnItems={[]}
            cwd={sampleCernoRun.cwd}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    expect(compactCernoScreen.container.textContent).toContain("1 · Healthy");
  });

  it("renders operator cerno assessment with collapsed model internals that expand on demand", async () => {
    await using screen = await render(<CernoRunAssessment run={sampleCernoRun} />);

    await expect.element(page.getByText("Healthy")).toBeVisible();
    await expect.element(page.getByText(/High certainty \(96%\)/i)).toBeVisible();
    await expect
      .element(page.getByText(/\[416\/2554\] Compile Module\.Engine\.12\.cpp/))
      .toBeVisible();
    expect(screen.container.textContent).not.toContain("poll_schedule_timeout");

    await page.getByRole("button", { name: /Model internals/i }).click();
    await expect.element(page.getByText(/poll_schedule_timeout/)).toBeVisible();
  });

  it("hides ship-queue background tasks and suppresses cerno polling when excludeShipQueue is enabled", async () => {
    using _mock = withResetCernoMock();
    const shipTasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
      {
        kind: "command",
        taskId: "task-sq-watch",
        awaited: true,
        command: "ship-queue watch 10987",
      },
      {
        kind: "monitor",
        taskId: "task-sq-cerno",
        awaited: true,
        command: "cerno watch --monitor --log /tmp/sq.log -- ship-queue watch 10987",
      },
      {
        kind: "monitor",
        taskId: "task-sq-desc",
        awaited: true,
        description: "Watch job 10987",
      },
    ];
    const shipTurnItems: ThreadStructure["turnItems"] = [
      ...turnItems,
      {
        id: TurnItemId.make("item-sq-fg"),
        threadId,
        runId,
        nodeId: null,
        providerThreadId: null,
        providerTurnId: null,
        nativeItemRef: null,
        parentItemId: null,
        ordinal: 1,
        type: "command_execution",
        status: "running",
        title: null,
        input:
          "cerno watch --monitor --log /tmp/sq-fg.log -- ship-queue submit /data/wt feat t b.md",
        output: "",
        startedAt: DateTime.makeUnsafe("2026-11-23T09:00:00.000Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-23T09:00:15.000Z"),
      },
    ];

    await using onlyShipScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={shipTasks}
            turnItems={shipTurnItems}
            excludeShipQueue
            knownShipJobIds={new Set(["10987"])}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    expect(
      onlyShipScreen.container.querySelector("[data-thread-details-background-work]"),
    ).toBeNull();
    expect(mockState.cernoQueryRequests).toBe(0);

    await using mixedScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={[...shipTasks, twoTasks[0]!]}
            turnItems={shipTurnItems}
            excludeShipQueue
            knownShipJobIds={new Set(["10987"])}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    expect(
      mixedScreen.container.querySelector("[data-thread-details-background-work]"),
    ).not.toBeNull();
    expect(mixedScreen.container.textContent).toContain("python train.py");
    expect(mixedScreen.container.textContent).not.toContain("ship-queue");

    await using unfilteredScreen = await render(
      <TooltipProvider>
        <div style={{ width: 280 }}>
          <ThreadBackgroundWorkPanel
            density="full"
            environmentId={environmentId}
            threadId={threadId}
            tasks={[shipTasks[0]!]}
            turnItems={[]}
            excludeShipQueue={false}
            stopDisabled={false}
            stopping={false}
            onStop={async () => {}}
            onOpenThread={() => {}}
          />
        </div>
      </TooltipProvider>,
    );
    expect(unfilteredScreen.container.textContent).toContain("ship-queue watch");
  });
});
