import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  RunId,
  ThreadId,
  TurnItemId,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  isShipQueueBackgroundTask,
  isShipQueueCommand,
  selectVisibleBackgroundWorkTasks,
} from "./shipQueueBackgroundFilter";

const threadId = ThreadId.make("thread-sq-filter");
const runId = RunId.make("run-sq-filter");

function makeCommandTurnItem(
  id: string,
  input: string,
  title: string | null = null,
): ThreadStructure["turnItems"][number] {
  return {
    id: TurnItemId.make(id),
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
    title,
    input,
    output: "",
    startedAt: DateTime.makeUnsafe("2026-11-23T09:00:00.000Z"),
    completedAt: null,
    updatedAt: DateTime.makeUnsafe("2026-11-23T09:00:15.000Z"),
  };
}

describe("isShipQueueCommand", () => {
  it("matches direct binaries, wrappers, subshells, cerno wrappers, and job log viewers", () => {
    const positives = [
      "ship-queue watch 10987",
      'ship-queue.sh submit /data/wt feat "title" body.md',
      "/home/dev/.local/bin/ship-queue --timeout 60 watch 10987",
      "ship-queue deps decide r1 approve",
      "ship-queue logs 10987",
      "cd /data/wt && FOO=1 ship-queue watch 10987",
      "nohup timeout 300 ship-queue watch 10987",
      "bash -lc 'cd /wt && ship-queue watch 10987'",
      "bash /home/dev/.local/bin/ship-queue.sh watch 10987",
      'job=$(ship-queue submit /data/wt feat "t" b.md)',
      "cerno watch --monitor --log /tmp/sq.log -- ship-queue watch 10987",
      "cerno ship-watch 10987",
      "cerno tail --monitor -F /data/Dev/.ship-queue/jobs/10987/log",
      "tail -F /data/Dev/.ship-queue/jobs/10987/log",
      "ship-queue \\\n watch 10987",
    ];
    for (const cmd of positives) {
      expect(isShipQueueCommand(cmd), cmd).toBe(true);
    }
  });

  it("ignores tests, searches, echoes, and non-ship workloads", () => {
    const negatives = [
      "cargo test",
      "cargo test ship-queue",
      "pnpm vitest run ShipQueueSteps",
      "pytest tests/test_ship_queue.py",
      "rg ship-queue src/",
      'echo "ship-queue watch 10987"',
      "cerno watch --monitor --log /tmp/build.log -- cargo test",
      "python train.py --epochs 10",
    ];
    for (const cmd of negatives) {
      expect(isShipQueueCommand(cmd), cmd).toBe(false);
    }
  });
});

describe("isShipQueueBackgroundTask", () => {
  it("matches command tasks, turn-item inputs, and empty-command ship-queue monitors", () => {
    const turnItem = makeCommandTurnItem("item-sq", "cerno watch -- ship-queue watch 10987");
    const taskFromItem: OrchestrationV2PendingBackgroundTask = {
      kind: "monitor",
      taskId: "task-sq-item",
      itemId: TurnItemId.make("item-sq"),
      awaited: true,
    };
    expect(isShipQueueBackgroundTask(taskFromItem, [turnItem])).toBe(true);

    const directTask: OrchestrationV2PendingBackgroundTask = {
      kind: "command",
      taskId: "task-sq-cmd",
      awaited: true,
      command: "ship-queue watch 10987",
    };
    expect(isShipQueueBackgroundTask(directTask)).toBe(true);

    const monitorPayloads = [
      "ship-queue 10987 (#111)",
      "ship queue job 10987 (#111)",
      "SQ job 10987",
      "ship-queue.sh watch 10987",
      "Watching ship-queue 10987",
    ];
    for (const description of monitorPayloads) {
      expect(
        isShipQueueBackgroundTask({
          kind: "monitor",
          taskId: `mon-${description}`,
          awaited: true,
          description,
        }),
        description,
      ).toBe(true);
    }

    expect(
      isShipQueueBackgroundTask(
        {
          kind: "monitor",
          taskId: "mon-known-id",
          awaited: true,
          description: "Watch job 10987",
        },
        undefined,
        new Set(["10987"]),
      ),
    ).toBe(true);
  });

  it("preserves subagents, non-ship commands whose descriptions mention ship-queue, and unmatched watches", () => {
    expect(
      isShipQueueBackgroundTask({
        kind: "subagent",
        taskId: "sub-sq",
        description: "ship-queue review helper",
        childThreadId: ThreadId.make("child-sq"),
      }),
    ).toBe(false);

    expect(
      isShipQueueBackgroundTask({
        kind: "command",
        taskId: "cargo-fix",
        awaited: true,
        command: "cargo test",
        description: "Fix ship-queue watcher bug and run tests",
      }),
    ).toBe(false);

    expect(
      isShipQueueBackgroundTask({
        kind: "monitor",
        taskId: "train-watch",
        awaited: true,
        description: "Watch training epoch 10987",
      }),
    ).toBe(false);
  });
});

describe("selectVisibleBackgroundWorkTasks", () => {
  it("excludes ship-queue tasks and foreground ship-queue cerno turn items only when excludeShipQueue is true", () => {
    const tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
      {
        kind: "command",
        taskId: "task-sq",
        awaited: true,
        command: "ship-queue watch 10987",
      },
      {
        kind: "command",
        taskId: "task-train",
        awaited: true,
        command: "python train.py --epochs 10",
      },
    ];
    const turnItems = [
      makeCommandTurnItem(
        "item-cerno-sq",
        "cerno watch --monitor --log /tmp/sq.log -- ship-queue watch 10987",
      ),
    ];

    const filtered = selectVisibleBackgroundWorkTasks({
      tasks,
      turnItems,
      excludeShipQueue: true,
    });
    expect(filtered.map((task) => task.taskId)).toEqual(["task-train"]);

    const unfiltered = selectVisibleBackgroundWorkTasks({
      tasks,
      turnItems,
      excludeShipQueue: false,
    });
    expect(unfiltered.map((task) => task.taskId)).toEqual([
      "task-sq",
      "task-train",
      "cerno-item:item-cerno-sq",
    ]);
  });
});
