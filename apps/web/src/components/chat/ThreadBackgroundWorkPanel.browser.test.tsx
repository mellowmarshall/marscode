import "~/index.css";

import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  EnvironmentId,
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it, vi } from "vite-plus/test";
import { page } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { TooltipProvider } from "../ui/tooltip";
import { ThreadBackgroundWorkPanel } from "./ThreadBackgroundWorkPanel";

vi.mock("./CommandOutputPanel", () => ({
  CommandOutputPanel: () => <div>Command output stream</div>,
  useCommandOutputStreaming: () => true,
}));

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

describe("ThreadBackgroundWorkPanel", () => {
  it("renders sparse inline rows in full density with <= 3 tasks and opens the inspector cleanly", async () => {
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
});
