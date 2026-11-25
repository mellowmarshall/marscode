import type { ThreadStructure } from "@t3tools/client-runtime/state/shell";
import {
  RunId,
  ThreadId,
  TurnItemId,
  type CernoLiveRun,
  type OrchestrationV2PendingBackgroundTask,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { describe, expect, it } from "vite-plus/test";

import {
  formatCernoElapsed,
  matchCernoRunForTask,
  matchCernoRunsToTasks,
  mergeRunningCernoTurnTasks,
  mergeStandaloneThreadCernoTasks,
  presentCernoRun,
} from "./cernoRunPresentation";

function makeRun(overrides: Partial<CernoLiveRun> = {}): CernoLiveRun {
  return {
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
    cutoffs: {
      suspThresh: 0.55,
      suspMargin: 0.5,
      confThresh: 0.82,
      confMargin: 1.8,
    },
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
    ...overrides,
  };
}

describe("cernoRunPresentation", () => {
  it("maps healthy, uncertain, succeeded, fail-warning, needs-input, stall, lock-wait, and server-ready states", () => {
    const healthy = presentCernoRun(makeRun());
    expect(healthy.verdict).toBe("Healthy");
    expect(healthy.tone).toBe("info");
    expect(healthy.pips).toBe(4);
    expect(healthy.certaintyLabel).toBe("High");
    expect(healthy.confidencePct).toBe(96);
    expect(healthy.liveness).toBe("14s ago");

    const uncertain = presentCernoRun(makeRun({ confidence: 0.34 }));
    expect(uncertain.verdict).toBe("Uncertain");
    expect(uncertain.tone).toBe("neutral");
    expect(uncertain.pips).toBe(1);
    expect(uncertain.certaintyLabel).toBe("Low");
    expect(uncertain.confidencePct).toBe(34);

    const succeeded = presentCernoRun(makeRun({ state: "SUCCEEDED", confidence: 0.93 }));
    expect(succeeded.verdict).toBe("Succeeded");
    expect(succeeded.tone).toBe("success");
    expect(succeeded.confidencePct).toBe(93);

    const failing = presentCernoRun(
      makeRun({
        pFail: 0.78,
        alert: "mid_stream_fail:suspicion",
        silenceSec: 2,
      }),
    );
    expect(failing.verdict).toBe("Likely failing");
    expect(failing.tone).toBe("warning");
    expect(failing.certaintyLabel).toBe("Medium");
    expect(failing.confidencePct).toBe(78);

    const needsInput = presentCernoRun(
      makeRun({
        state: "NEEDS_INPUT",
        prompt: true,
        authRequired: true,
        confidence: 0.91,
      }),
    );
    expect(needsInput.verdict).toBe("Needs input");
    expect(needsInput.tone).toBe("destructive");
    expect(needsInput.confidencePct).toBe(91);
    expect(needsInput.liveness).toBe("stdin blocked");

    // When state is RUNNING (0.96) but prompt/hangLoop flag fires, never borrow RUNNING's 96%
    const promptWhileRunning = presentCernoRun(
      makeRun({
        state: "RUNNING",
        confidence: 0.96,
        prompt: true,
        stateProbs: {
          RUNNING: 0.96,
          SUCCEEDED: 0,
          FAILED: 0.01,
          NEEDS_INPUT: 0.22,
          STUCK_LOOP: 0.02,
        },
      }),
    );
    expect(promptWhileRunning.verdict).toBe("Needs input");
    expect(promptWhileRunning.confidencePct).toBe(22);
    expect(promptWhileRunning.certaintyLabel).toBe("Low");

    const stalledWhileRunning = presentCernoRun(
      makeRun({
        state: "RUNNING",
        confidence: 0.96,
        hangLoop: true,
        silenceSec: 185,
        stateProbs: {
          RUNNING: 0.96,
          SUCCEEDED: 0,
          FAILED: 0.01,
          NEEDS_INPUT: 0.01,
          STUCK_LOOP: 0.35,
        },
      }),
    );
    expect(stalledWhileRunning.verdict).toBe("Stalled");
    expect(stalledWhileRunning.confidencePct).toBe(35);
    expect(stalledWhileRunning.liveness).toBe("3m silent");

    const lockWait = presentCernoRun(makeRun({ hasExtFileLock: true, silenceSec: 42 }));
    expect(lockWait.verdict).toBe("Waiting on lock");
    expect(lockWait.tone).toBe("info");
    expect(lockWait.liveness).toBe("flock · 42s");

    const serverReady = presentCernoRun(makeRun({ serverReady: true, hasListenSocket: true }));
    expect(serverReady.verdict).toBe("Server ready");
    expect(serverReady.tone).toBe("success");
    expect(serverReady.liveness).toBe("listening");

    expect(formatCernoElapsed(makeRun({ elapsedSec: 1213 }))).toBe("20m");
    expect(formatCernoElapsed(makeRun({ startedAtMs: 1_000_000, elapsedSec: 10 }), 1_045_000)).toBe(
      "45s",
    );
  });

  it("matches live cerno runs strictly one-to-one without cross-task or non-cerno false positives", () => {
    const run = makeRun();
    const cmd =
      "cerno watch --monitor --log /data/Dev/private-repo/logs/pass9_loop1_build.log -- \\\n ssh dev-host-x Build.sh";
    expect(matchCernoRunForTask([run], cmd, null)?.pid).toBe(951254);
    expect(
      matchCernoRunForTask([run], "cerno watch -- ssh dev-host-x Build.sh", null)?.pid,
    ).toBe(951254);

    // Negative: plain non-cerno task running the same command never receives a cerno run
    expect(matchCernoRunForTask([run], "ssh dev-host-x Build.sh", run.cwd)).toBeNull();

    // Negative: prefix-similar commands (`pnpm test` vs `pnpm test:e2e`) do not cross-match
    const testRun = makeRun({
      pid: 100,
      command: "pnpm test",
      logPath: null,
      cwd: "/repo/wt-a",
    });
    expect(
      matchCernoRunForTask([testRun], "cerno watch -- pnpm test:e2e", "/repo/wt-a"),
    ).toBeNull();
    expect(matchCernoRunForTask([testRun], "cerno watch -- pnpm test", "/repo/wt-a")?.pid).toBe(
      100,
    );

    // Negative: same command in a different worktree cwd does not steal another worktree's run
    expect(matchCernoRunForTask([testRun], "cerno watch -- pnpm test", "/repo/wt-b")).toBeNull();

    // Disambiguate two runs with the same command in two cwds
    const testRunB = makeRun({
      pid: 200,
      command: "pnpm test",
      logPath: null,
      cwd: "/repo/wt-b",
    });
    expect(
      matchCernoRunForTask([testRun, testRunB], "cerno watch -- pnpm test", "/repo/wt-b")?.pid,
    ).toBe(200);

    // One-to-one: a single run is never assigned to two tasks
    const assigned = matchCernoRunsToTasks(
      [
        { taskId: "t1", command: "cerno watch -- pnpm test" },
        { taskId: "t2", command: "cerno watch -- pnpm test" },
      ],
      [testRun],
      "/repo/wt-a",
    );
    expect(assigned.get("t1")?.pid).toBe(100);
    expect(assigned.get("t2")).toBeNull();

    const threadId = ThreadId.make("thread-1");
    const runId = RunId.make("run-1");
    const itemId = TurnItemId.make("item-cerno-1");
    const turnItems: ThreadStructure["turnItems"] = [
      {
        id: itemId,
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
        input: cmd,
        output: "",
        startedAt: DateTime.makeUnsafe("2026-11-23T13:05:00.000Z"),
        completedAt: null,
        updatedAt: DateTime.makeUnsafe("2026-11-23T13:25:00.000Z"),
      },
    ];

    const merged = mergeRunningCernoTurnTasks([], turnItems);
    expect(merged).toHaveLength(1);
    expect(merged[0]?.itemId).toBe(itemId);
    expect(merged[0]?.kind).toBe("monitor");
  });

  it("matches relative --log paths and keeps standalone thread-attributed cerno runs visible after postSettleCommandHold", () => {
    const threadA = ThreadId.make("thread-a");
    const threadB = ThreadId.make("thread-b");

    const relRun = makeRun({
      pid: 301,
      cwd: "/repo/wt-a",
      command: "python3 train.py",
      logPath: "/repo/wt-a/logs/train.log",
      threadId: threadA,
    });
    const otherThreadRun = makeRun({
      pid: 302,
      cwd: "/repo/wt-b",
      command: "cargo test",
      logPath: "/repo/wt-b/logs/test.log",
      threadId: threadB,
    });
    const shipRun = makeRun({
      pid: 303,
      cwd: "/repo/wt-a",
      command: "ship-queue watch 11139",
      logPath: "/tmp/sq.log",
      threadId: threadA,
    });

    // Relative --log path in task command deduplicates cleanly against canonical run.logPath
    const relTask: OrchestrationV2PendingBackgroundTask = {
      taskId: "task-rel",
      kind: "command",
      command: "cerno watch --monitor --log logs/train.log -- python3 train.py",
      awaited: true,
    };
    const matched = matchCernoRunsToTasks(
      [{ taskId: relTask.taskId, command: relTask.command }],
      [relRun, otherThreadRun, shipRun],
      "/repo/wt-a",
    );
    expect(matched.get("task-rel")?.pid).toBe(301);

    const deduped = mergeStandaloneThreadCernoTasks(
      [relTask],
      matched,
      [relRun, otherThreadRun, shipRun],
      threadA,
      { excludeShipQueue: true },
    );
    expect(deduped.tasks).toHaveLength(1);

    // Once postSettleCommandHold empties pendingBackgroundTasks, standalone live thread-bound cerno run stays visible
    const standalone = mergeStandaloneThreadCernoTasks(
      [],
      new Map(),
      [relRun, otherThreadRun, shipRun],
      threadA,
      { excludeShipQueue: true },
    );
    expect(standalone.tasks).toHaveLength(1);
    expect(standalone.tasks[0]?.taskId).toBe("cerno-run:301");
    expect(standalone.matchedByTaskId.get("cerno-run:301")?.pid).toBe(301);

    // Subdirectory `cd sub && cerno watch --log run.log` matches run.logPath using run.cwd even without thread cwd
    const subRun = makeRun({
      pid: 304,
      cwd: "/repo/wt-a/sub",
      command: "pytest",
      logPath: "/repo/wt-a/sub/run.log",
      threadId: threadA,
    });
    const subMatch = matchCernoRunsToTasks(
      [{ taskId: "task-sub", command: "cd sub && cerno watch --log run.log -- pytest" }],
      [subRun],
      "/repo/wt-a",
    );
    expect(subMatch.get("task-sub")?.pid).toBe(304);

    // matchCernoRunsToTasks matches synthetic cerno-run:<pid> directly (used by BackgroundWorkInspectorDialog)
    const inspectorMatch = matchCernoRunsToTasks(
      standalone.tasks.map((t) => ({ taskId: t.taskId, command: t.command })),
      [relRun, otherThreadRun, shipRun],
    );
    expect(inspectorMatch.get("cerno-run:301")?.pid).toBe(301);
  });
});
