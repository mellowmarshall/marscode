// @effect-diagnostics nodeBuiltinImport:off - Comprehensive unit & integration tests for native T3 Background Jobs + Ship Queue bridge.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  AuthDiagnosticsReadScope,
  AuthOrchestrationReadScope,
  AuthTerminalOperateScope,
  type AuthEnvironmentScope,
  EventId,
  MessageId,
  NonNegativeInt,
  PositiveInt,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderThreadId,
  RunId,
  ThreadId,
  TrimmedNonEmptyString,
  TurnItemId,
  type OrchestrationV2CommandOutputFrame,
  type OrchestrationV2DomainEvent,
  type OrchestrationV2PendingBackgroundTask,
  type OrchestrationV2Run,
  type OrchestrationV2ThreadShellSnapshot,
} from "@t3tools/contracts";
import { T3_CODE_ORCHESTRATION_INSTRUCTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { runShipQueueCli } from "@t3tools/ship-queue/cli";
import * as ShipQueueJobStore from "@t3tools/ship-queue/jobStore";
import { derivePendingBackgroundWork } from "@t3tools/shared/orchestrationV2PendingBackgroundWork";
import { afterEach, describe, expect, it, vi } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Stream from "effect/Stream";
import { HttpServerRequest } from "effect/http";

import * as EnvironmentAuth from "../../auth/EnvironmentAuth.ts";
import * as SessionStore from "../../auth/SessionStore.ts";
import { GrokOrchestratorReplayHarness } from "../../orchestration-v2/Adapters/GrokAdapterV2.testkit.ts";
import {
  findReplayFixture,
  runReplayFixture,
} from "../../orchestration-v2/testkit/ProviderReplayFixtures.ts";
import { classifyCliError, stripHostGuardBanner } from "../DevtoolsErrors.ts";
import * as DevtoolsHttp from "../DevtoolsHttp.ts";
import { GuardGrantBroker } from "../GuardGrantBroker.ts";
import { ingestCommandOutputFrame } from "./BackgroundJobOutput.ts";
import type { CommandExecutionTurnItem } from "./BackgroundTaskLifecycle.ts";
import {
  classifyCommandTracking,
  deriveCommandTitle,
  extractCommandLogPath,
  inferCommandJobKind,
  makeBackgroundJobId,
  resolveCommandTerminalOutcome,
} from "./commandJobParser.ts";
import { inferTargetHost, parseFleetHostsConfig } from "./fleetHostInference.ts";
import {
  appendMetricPoint,
  compileTemplate,
  extractJsonlLine,
  extractKvLine,
  matchCompiledTemplate,
  splitLogLines,
  stripAnsi,
} from "./extractors.ts";
import {
  formatRedactedCommand,
  isNoiseMetricKey,
  isPlottableMetricPoints,
  mapLogOpenFailureKind,
  resolveJobLogState,
} from "./jobMetricFilter.ts";
import { makeJobRegistry } from "./JobRegistry.ts";
import { isSensitiveLogPath, openValidatedLogFile, redactLogLine } from "./logFileGuard.ts";
import {
  buildJobDetail,
  buildJobSummary,
  createManagedJobRecord,
  stripJobSummaryCmdline,
} from "./managedJobHelpers.ts";
import { extractGenericProgress } from "./progressExtractor.ts";
import { adaptShipQueueJob, readShipJobLogFacts } from "./ShipQueueBridge.ts";
import { statShipJobLog } from "./shipQueueJobLogFile.ts";
import {
  parseDevdeckLogStageInfo,
  parseDevdeckStageFromLogText,
  readShipJobLogInfo,
} from "./shipQueueLogParser.ts";

const cleanupDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join("/tmp", prefix));
  NodeFS.chmodSync(dir, 0o700);
  cleanupDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (cleanupDirs.length > 0) {
    NodeFS.rmSync(cleanupDirs.pop()!, { recursive: true, force: true });
  }
});

const SAMPLE_CI_HOSTS = {
  hosts: [
    { name: "host-a", ssh: null, note: "this host: the queue's own" },
    { name: "host-b", ssh: "host-b", note: "remote GPU worker" },
    {
      name: "host-c",
      ssh: "host-c-wsl",
      note: "Ubuntu 24.04 in WSL 2 with RTX 1234 GPU",
    },
    {
      name: "host-d-linux",
      ssh: "host-d-linux",
      on: "host-d",
      note: "Linux VM on host-d",
    },
  ],
};

function makeProviderThreadUpdatedEvent(input: {
  readonly id: string;
  readonly threadId: string;
  readonly providerThreadId?: string;
  readonly status?: "not_loaded" | "idle" | "active" | "archived" | "closed" | "error";
  readonly tasks: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}): OrchestrationV2DomainEvent {
  const now = DateTime.nowUnsafe();
  const tid = ThreadId.make(input.threadId);
  return {
    id: EventId.make(input.id),
    threadId: tid,
    occurredAt: now,
    type: "provider-thread.updated",
    payload: {
      id: ProviderThreadId.make(input.providerThreadId ?? "pt-1"),
      driver: ProviderDriverKind.make("claudeAgent"),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      providerSessionId: null,
      appThreadId: tid,
      ownerNodeId: null,
      nativeThreadRef: null,
      nativeConversationHeadRef: null,
      status: input.status ?? "active",
      firstRunOrdinal: null,
      lastRunOrdinal: null,
      handoffIds: [],
      forkedFrom: null,
      pendingBackgroundTasks: [...input.tasks],
      contextUsage: null,
      nativeMetadata: null,
      goal: null,
      createdAt: now,
      updatedAt: now,
    },
  };
}

function makeCommandTurnItem(input: {
  readonly id: string;
  readonly threadId: string;
  readonly runId?: string | null;
  readonly status: CommandExecutionTurnItem["status"];
  readonly command: string;
  readonly title?: string | null;
  readonly nativeId?: string;
  readonly exitCode?: number;
  readonly output?: string;
}): CommandExecutionTurnItem {
  const now = DateTime.nowUnsafe();
  return {
    id: TurnItemId.make(input.id),
    threadId: ThreadId.make(input.threadId),
    runId: input.runId ? RunId.make(input.runId) : null,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: input.nativeId
      ? {
          driver: ProviderDriverKind.make("claudeAgent"),
          nativeId: input.nativeId,
          strength: "strong",
        }
      : null,
    parentItemId: null,
    ordinal: 1,
    status: input.status,
    title: input.title ?? null,
    startedAt: now,
    updatedAt: now,
    completedAt: input.status === "running" || input.status === "waiting" ? null : now,
    type: "command_execution",
    input: input.command,
    ...(input.output !== undefined ? { output: input.output } : {}),
    ...(input.exitCode !== undefined ? { exitCode: input.exitCode } : {}),
  };
}

function makeCommandEvent(id: string, item: CommandExecutionTurnItem): OrchestrationV2DomainEvent {
  return {
    id: EventId.make(id),
    threadId: item.threadId,
    occurredAt: DateTime.nowUnsafe(),
    type: "turn-item.updated",
    payload: item,
  };
}

function makeRunUpdatedEvent(input: {
  readonly eventId: string;
  readonly runId: string;
  readonly threadId: string;
  readonly status: OrchestrationV2Run["status"];
  readonly providerThreadId?: string | null;
}): OrchestrationV2DomainEvent {
  const now = DateTime.nowUnsafe();
  const tid = ThreadId.make(input.threadId);
  return {
    id: EventId.make(input.eventId),
    threadId: tid,
    occurredAt: now,
    type: "run.updated",
    payload: {
      id: RunId.make(input.runId),
      threadId: tid,
      ordinal: PositiveInt.make(1),
      providerInstanceId: ProviderInstanceId.make("claudeAgent"),
      modelSelection: {
        instanceId: ProviderInstanceId.make("claudeAgent"),
        model: "claude-opus-4-6",
      },
      providerThreadId: input.providerThreadId
        ? ProviderThreadId.make(input.providerThreadId)
        : null,
      userMessageId: MessageId.make("msg-1"),
      rootNodeId: null,
      activeAttemptId: null,
      status: input.status,
      requestedAt: now,
      startedAt: now,
      completedAt:
        input.status === "completed" ||
        input.status === "failed" ||
        input.status === "interrupted" ||
        input.status === "cancelled" ||
        input.status === "rolled_back"
          ? now
          : null,
      checkpointId: null,
      contextHandoffId: null,
    },
  };
}

function makeThreadShell(input: {
  readonly id: string;
  readonly status: OrchestrationV2ThreadShellSnapshot["threads"][number]["status"];
  readonly activityRunStatus?: "preparing" | "starting" | "running" | "waiting" | null;
  readonly activeRunId?: string | null;
  readonly activeProviderThreadId?: string | null;
  readonly pendingBackgroundTasks?: ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
}): OrchestrationV2ThreadShellSnapshot["threads"][number] {
  const now = DateTime.nowUnsafe();
  return {
    createdBy: "user",
    creationSource: "web",
    id: ThreadId.make(input.id),
    projectId: ProjectId.make("proj-1"),
    title: "Test thread",
    providerInstanceId: ProviderInstanceId.make("claudeAgent"),
    modelSelection: {
      instanceId: ProviderInstanceId.make("claudeAgent"),
      model: "claude-opus-4-6",
    },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: TrimmedNonEmptyString.make("main"),
    worktreePath: null,
    lineage: {
      rootThreadId: ThreadId.make(input.id),
      parentThreadId: null,
      relationshipToParent: null,
    },
    forkedFrom: null,
    activeProviderThreadId: input.activeProviderThreadId
      ? ProviderThreadId.make(input.activeProviderThreadId)
      : null,
    latestRunId: input.activeRunId ? RunId.make(input.activeRunId) : null,
    latestRunStartedAt: now,
    activeRunId: input.activeRunId ? RunId.make(input.activeRunId) : null,
    activityRunStatus: input.activityRunStatus ?? null,
    status: input.status,
    pendingRuntimeRequest: null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [...(input.pendingBackgroundTasks ?? [])],
    providerInstanceHistory: [ProviderInstanceId.make("claudeAgent")],
    itemCount: NonNegativeInt.make(0),
    visibleItemCount: NonNegativeInt.make(0),
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    deletedAt: null,
  };
}

describe("Bounded Jobs extractors & generic progress", () => {
  it("parses real training log lines with typed templates and flexible spaces", () => {
    const tpl = compileTemplate(
      "[Ep {epoch:int}/{total_epochs:int} step {step:int}/{total_steps:int}] qa={qa:float} ... comp={comp:float} | {rate:float} it/s | peak_vram={peak_vram:float} GiB",
    );
    expect(tpl).not.toBeNull();

    const line =
      "[Ep 2/2 step  300/1953] qa=4.6928 ref=0.0000 nll=0.3120 comp=0.3984 | 1.95 it/s | peak_vram=7.89 GiB";
    const rec = matchCompiledTemplate(tpl!, line);
    expect(rec).not.toBeNull();
    expect(rec?.fields.get("epoch")?.value).toBe(2);
    expect(rec?.fields.get("step")?.value).toBe(300);
    expect(rec?.fields.get("qa")?.value).toBeCloseTo(4.6928, 4);
  });

  it("parses kv/jsonl lines with Python NaN/Infinity anomalies and splits tqdm CR frames", () => {
    const line =
      '\u001b[32m[Epoch 1 DONE]\u001b[0m val={"mrr": 0.9047, "loss": NaN, "grad": -Infinity}';
    const rec = extractKvLine(line);
    expect(rec?.fields.get("val/mrr")?.value).toBeCloseTo(0.9047, 4);
    expect(rec?.fields.get("val/loss")).toEqual({ value: null, anomaly: "nan" });
    expect(rec?.fields.get("val/grad")).toEqual({ value: null, anomaly: "inf" });

    const j = extractJsonlLine('{"step": 10, "loss": NaN, "note": "ok"}');
    expect(j?.fields.get("loss")).toEqual({ value: null, anomaly: "nan" });
    expect(j?.strings.get("note")).toBe("ok");

    const split = splitLogLines("", "10%|# | 1/10\r20%|##| 2/10\npart");
    expect(split.lines).toEqual(["10%|# | 1/10", "20%|##| 2/10"]);
    expect(split.remainder).toBe("part");
    expect(stripAnsi("\u001b[31merr\u001b[0m")).toBe("err");
  });

  it("extracts real ML/tqdm progress while rejecting transient headers and dates", () => {
    expect(extractGenericProgress("    19200/40458 (215.1s)")).toEqual({
      current: 19200,
      total: 40458,
    });
    expect(extractGenericProgress("  ep 2/6 step 600/2442 (85s) | nce=1.105 sim=0.8450")).toEqual({
      current: 600,
      total: 2442,
      unit: "steps",
      outerCurrent: 2,
      outerTotal: 6,
      outerUnit: "Ep",
    });
    expect(
      extractGenericProgress(
        "Loading weights: 100%|██████████| 391/391 [00:00<00:00, 1246.49it/s]",
      ),
    ).toBeNull();
    expect(extractGenericProgress("2026/11/22 GPU 1.5/16.0 GiB")).toBeNull();

    const pts: Array<{ t: number; v: number | null; anomaly?: "nan" | "inf" }> = [];
    for (let i = 0; i < 650; i += 1) {
      appendMetricPoint(pts, i === 120 ? { t: i, v: null, anomaly: "nan" } : { t: i, v: i }, 200);
    }
    expect(pts.length).toBeLessThanOrEqual(200);
    expect(pts.some((p) => p.anomaly === "nan")).toBe(true);
  });
});

describe("commandJobParser & logFileGuard", () => {
  it("infers remote fleet hosts dynamically from ci-hosts.json, SSH commands, wrapper scripts, and GPU hints", () => {
    const fleet = parseFleetHostsConfig(SAMPLE_CI_HOSTS, "host-a");

    expect(
      inferTargetHost(
        "cd /data/Dev/tools/render-job && rm -f logs/render_a.log && cerno watch --monitor --log logs/render_a.log -- scripts/remote.sh wsl render_scene.py",
        "Render test A",
        "host-a",
        fleet,
      ),
    ).toBe("host-c");

    expect(
      inferTargetHost(
        "cd /data/Dev/tools/render-job && cerno watch --monitor --log logs/render_b.log -- scripts/remote.sh host-b render_scene.py",
        "Render test B",
        "host-a",
        fleet,
      ),
    ).toBe("host-b");

    expect(
      inferTargetHost(
        "ssh -o BatchMode=yes -p 2222 dev@host-d-linux 'cargo test'",
        undefined,
        "host-a",
        fleet,
      ),
    ).toBe("host-d");

    expect(inferTargetHost("python3 train_stage2.py --epochs 6", "Stage 2", "host-a", fleet)).toBe(
      "host-a",
    );

    // Paths or comments mentioning a remote hostname must NOT falsely route a local command
    expect(
      inferTargetHost(
        "cp -r /srv/backup/host-c/run1 /tmp/out # compare vs host-c",
        "Copy local backup",
        "host-a",
        fleet,
      ),
    ).toBe("host-a");
  });

  it("classifies Ship Queue commands as skip, extracts log paths, infers kinds, and produces URL-safe job IDs", () => {
    expect(classifyCommandTracking("ship-queue watch 10962")).toBe("skip");
    expect(classifyCommandTracking("ship-queue.sh submit /data/wt feat 'title' body.md")).toBe(
      "skip",
    );
    expect(classifyCommandTracking("ship-queue logs 10962")).toBe("skip");
    expect(classifyCommandTracking("ship-queue list --open")).toBe("skip");
    expect(classifyCommandTracking("ship-queue deps decide r1 approve")).toBe("skip");
    expect(classifyCommandTracking("/home/dev/.local/bin/ship-queue --root /data status")).toBe(
      "skip",
    );
    expect(
      classifyCommandTracking("nohup bash -lc 'ship-queue retry 9102 && ship-queue watch 9102'"),
    ).toBe("skip");
    expect(classifyCommandTracking("JOB=$(ship-queue submit /wt branch title body.md)")).toBe(
      "skip",
    );
    expect(
      classifyCommandTracking("cerno watch --monitor --log /tmp/sq.log -- ship-queue watch 9102"),
    ).toBe("skip");
    expect(
      classifyCommandTracking("cerno tail --monitor -F /data/Dev/.ship-queue/jobs/9102/job.log"),
    ).toBe("skip");
    expect(classifyCommandTracking("tail -n 50 /data/Dev/.ship-queue/jobs/9102/job.log")).toBe(
      "skip",
    );
    expect(classifyCommandTracking("", "ship-queue watch")).toBe("skip");
    expect(classifyCommandTracking("", "Watch job 9102", (id) => id === "9102")).toBe("skip");
    expect(
      classifyCommandTracking(
        "cerno tail --monitor -F --pid 2117164 /data/logs/stage2_v3_wide6l_ep6_resume.log",
      ),
    ).toBe("immediate");
    expect(
      extractCommandLogPath(
        "cerno tail --monitor -F --pid 2117164 /data/logs/stage2_v3_wide6l_ep6_resume.log",
        null,
      ),
    ).toBe("/data/logs/stage2_v3_wide6l_ep6_resume.log");
    expect(classifyCommandTracking("cerno watch --monitor --log /tmp/a.log -- cargo test")).toBe(
      "immediate",
    );
    expect(classifyCommandTracking("git status --short")).toBe("debounced");

    expect(
      extractCommandLogPath(
        "cd /data/Dev/tools/render-job && cerno watch --monitor --log logs/render_a.log -- scripts/remote.sh wsl",
        null,
      ),
    ).toBe("/data/Dev/tools/render-job/logs/render_a.log");
    expect(extractCommandLogPath("cerno tail --monitor -F --pid 123 /tmp/run.log", null)).toBe(
      "/tmp/run.log",
    );
    expect(
      extractCommandLogPath("python3 train.py 2>&1 | tee train.log", "/data/Dev/project-d"),
    ).toBe("/data/Dev/project-d/train.log");

    expect(inferCommandJobKind("blender -b -P scene.py", "Render test on 1234")).toBe("render");
    expect(inferCommandJobKind("python3 train_f6.py", undefined)).toBe("train");
    expect(inferCommandJobKind("cargo test --workspace", undefined)).toBe("test");
    expect(inferCommandJobKind("pnpm vitest run src/render.test.ts", undefined)).toBe("test");
    expect(inferCommandJobKind("python3 train.py --compile=False", undefined)).toBe("train");
    expect(inferCommandJobKind('eval "$(ssh-agent -s)" && ssh host ls', undefined)).toBe("command");
    expect(
      deriveCommandTitle(
        undefined,
        "cd /data/Dev/project-c && cerno watch --monitor --log /tmp/a.log -- cargo test -p core",
      ),
    ).toBe("cargo test -p core");

    // Antigravity placeholder title ("Ran command") must be ignored in favor of readable script payload
    const multilineMlScript = [
      "mkdir -p /data/cache/models/logs",
      'LOG="/data/cache/models/logs/v5_export_and_dev.log"',
      ': > "$LOG"',
      "(",
      "  set -euo pipefail",
      "  cd /home/dev/Dev/project-d/model",
      '  echo "=== [1/4] Re-exporting ModelReader-v5 ==="',
      "  uv run export.py",
      ') > "$LOG" 2>&1 &',
      'cerno tail --monitor -F --pid $! "$LOG"',
    ].join("\n");
    expect(deriveCommandTitle("Ran command", multilineMlScript)).toBe(
      "[1/4] Re-exporting ModelReader-v5",
    );
    expect(extractCommandLogPath(multilineMlScript, null)).toBe(
      "/data/cache/models/logs/v5_export_and_dev.log",
    );
    expect(
      resolveCommandTerminalOutcome({
        status: "failed",
        output: "stderr line 1\nfatal: connection refused\n",
        wasCancelling: false,
      }),
    ).toEqual({ state: "failed", summary: "fatal: connection refused" });
    expect(
      stripHostGuardBanner(
        "!!!!!!!!!!!!!!!!!!!! host-guard OVERRIDE (owner-check): reason recorded in /tmp/overrides.log !!!!!!!!!!!!!!!!!!!! dependencies: report dependency files differ from current main; scan again before deciding",
      ),
    ).toBe(
      "dependencies: report dependency files differ from current main; scan again before deciding",
    );

    const id = makeBackgroundJobId(
      "c05c7b71-c315-450d-98fc-ea9e8400c5b1",
      "turn-item:provider:claudeAgent:native-item:toolu_01SbPQ7c5WonRyLDRBYegwns",
    );
    expect(id).toMatch(/^bg:[0-9a-f]{16}$/);
  });

  it("enforces logFileGuard path security and secret redaction", async () => {
    expect(isSensitiveLogPath("/etc/passwd")).toBe(true);
    expect(isSensitiveLogPath("/home/dev/.ssh/id_ed25519")).toBe(true);
    expect(isSensitiveLogPath("/home/dev/.t3/userdata/statev2.sqlite")).toBe(true);
    expect(isSensitiveLogPath("/data/Dev/proj/.env.local")).toBe(true);

    const dir = mkTempDir("t3-log-guard-");
    const envFile = NodePath.join(dir, ".env");
    NodeFS.writeFileSync(envFile, "SECRET=1\n", "utf8");
    const blocked = await openValidatedLogFile({
      explicitPath: envFile,
      isWorkspaceAllowed: async () => true,
    });
    expect(blocked.ok).toBe(false);

    expect(redactLogLine("Authorization: Bearer supersecrettoken12345")).toBe(
      "Authorization: Bearer [REDACTED]",
    );
    expect(redactLogLine("https://user:pass123@example.com/hook")).toBe(
      "https://user:[REDACTED]@example.com/hook",
    );
    expect(redactLogLine("HF_TOKEN=hf_1234567890abcdefgh python t.py")).toBe(
      "HF_TOKEN=[REDACTED] python t.py",
    );
    expect(redactLogLine("OPENAI_API_KEY=abc123")).toBe("OPENAI_API_KEY=[REDACTED]");
    expect(redactLogLine("python t.py --token abc123")).toBe("python t.py --token [REDACTED]");
    expect(redactLogLine("GITHUB_TOKEN: xyz")).toBe("GITHUB_TOKEN: [REDACTED]");
    // Derived titles from raw commands must also redact secrets
    expect(
      deriveCommandTitle(undefined, "HF_TOKEN=hf_1234567890abcdefgh python t.py --token xyz"),
    ).toBe("HF_TOKEN=[REDACTED] python t.py --token [REDACTED]");
  });
});

describe("BackgroundTaskBridge & JobRegistry native orchestration surfacing", () => {
  it.effect(
    "surfaces Claude pendingBackgroundTasks on their target GPU hosts, deduplicates against command_execution, streams output, and cancels via thread.stop",
    () =>
      Effect.gen(function* () {
        const dir = mkTempDir("t3-bg-bridge-");
        const ciHostsPath = NodePath.join(dir, "ci-hosts.json");
        NodeFS.writeFileSync(ciHostsPath, JSON.stringify(SAMPLE_CI_HOSTS), "utf8");
        const logPath = NodePath.join(dir, "render_a.log");

        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const outputFrames = yield* PubSub.unbounded<OrchestrationV2CommandOutputFrame>();
        const stoppedThreads: Array<{ threadId: string; reason: string }> = [];

        const registry = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            ciHostsPath,
            commandDebounceMs: 60,
            getShellSnapshot: async (): Promise<OrchestrationV2ThreadShellSnapshot> => ({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => [],
            streamDomainEvents: Stream.fromPubSub(domainEvents),
            subscribeCommandOutput: () => Stream.fromPubSub(outputFrames),
            stopThread: async (threadId, reason) => {
              stoppedThreads.push({ threadId, reason });
              return { ok: true };
            },
            isWorkspaceAllowed: async (p) => p.startsWith(dir),
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));

        const threadId = "c05c7b71-c315-450d-98fc-ea9e8400c5b1";
        const itemId = "turn-item:provider:claudeAgent:native-item:toolu_render_a";

        // 1. Simulate Claude's `Bash(run_in_background: true)` tool call completing right before
        //    `provider-thread.updated` registers the pending background task — must NOT leave a duplicate!
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-cmd-start",
            makeCommandTurnItem({
              id: itemId,
              threadId,
              status: "running",
              title: "Render test A",
              command: `cerno watch --monitor --log ${logPath} -- scripts/remote.sh wsl render_scene.py`,
              nativeId: "toolu_render_a",
            }),
          ),
        );
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-cmd-done",
            makeCommandTurnItem({
              id: itemId,
              threadId,
              status: "completed",
              title: "Render test A",
              command: `cerno watch --monitor --log ${logPath} -- scripts/remote.sh wsl render_scene.py`,
              nativeId: "toolu_render_a",
              exitCode: 0,
            }),
          ),
        );

        // 2. Now `provider-thread.updated` publishes BOTH remote GPU jobs + a subagent (must be skipped!)
        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({
            id: "ev-pt-1",
            threadId,
            tasks: [
              {
                taskId: "boynqyqvz",
                kind: "command",
                description: "Render test A",
                command: `cerno watch --monitor --log ${logPath} -- scripts/remote.sh wsl render_scene.py`,
                itemId: TurnItemId.make(itemId),
                nativeItemId: "toolu_render_a",
                sourceThreadId: ThreadId.make(threadId),
                awaited: true,
              },
              {
                taskId: "b82lo44kw",
                kind: "command",
                description: "Render test B",
                command:
                  "cerno watch --monitor --log logs/render_b.log -- scripts/remote.sh host-b render_scene.py",
                sourceThreadId: ThreadId.make(threadId),
                awaited: true,
              },
              {
                taskId: "sub-1",
                kind: "subagent",
                description: "Helper subagent (should be ignored)",
              },
              {
                taskId: "pull-request-watch:github:org/repo#1",
                kind: "monitor",
                description: "PR watch (should be ignored)",
              },
            ],
          }),
        );

        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId })).length, { timeout: 2_000 })
            .toBe(2),
        );

        const jobs = yield* Effect.promise(() => registry.listJobs({ threadId }));
        const jobA = jobs.find((j) => j.title === "Render test A")!;
        const jobB = jobs.find((j) => j.title === "Render test B")!;
        expect(jobA.source).toBe("background");
        expect(jobA.binding.host).toBe("host-c");
        expect(jobA.kind).toBe("render");
        expect(jobA.state).toBe("running");

        expect(jobB.source).toBe("background");
        expect(jobB.binding.host).toBe("host-b");
        expect(jobB.kind).toBe("render");

        // 3. Live CommandOutputHub chunk updates progress, KPIs, and redacted tail
        const outputChunk: OrchestrationV2CommandOutputFrame = {
          kind: "append",
          text: "step=25/100 loss=0.412 Authorization: Bearer supersecret999\n",
          truncated: false,
          running: true,
        };
        yield* PubSub.publish(outputFrames, outputChunk);
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId })).find((j) => j.id === jobA.id)?.progress
                  ?.current,
              { timeout: 2_000 },
            )
            .toBe(25),
        );
        const updatedA = (yield* Effect.promise(() => registry.listJobs({ threadId }))).find(
          (j) => j.id === jobA.id,
        )!;
        expect(updatedA.kpis?.some((k) => k.key === "loss")).toBe(true);
        expect(updatedA.recentTail?.[0]).toContain("Authorization: Bearer [REDACTED]");

        // 4. Cancel marks target AND sibling jobs in the owning thread cancelling -> cancelled
        const cancelRes = yield* Effect.promise(() => registry.cancelJob(jobA.id));
        expect(cancelRes.ok).toBe(true);
        expect(stoppedThreads).toHaveLength(1);
        expect(stoppedThreads[0]?.threadId).toBe(threadId);
        const midCancelJobs = yield* Effect.promise(() => registry.listJobs({ threadId }));
        expect(midCancelJobs.every((j) => j.state === "cancelling")).toBe(true);

        // 5. Removing tasks from `pendingBackgroundTasks` transitions both jobs to `cancelled`
        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({
            id: "ev-pt-2",
            threadId,
            tasks: [],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId })).every(
                  (j) => j.state !== "running" && j.state !== "cancelling",
                ),
              { timeout: 2_000 },
            )
            .toBe(true),
        );
        const finalJobs = yield* Effect.promise(() => registry.listJobs({ threadId }));
        expect(finalJobs.find((j) => j.id === jobA.id)?.state).toBe("cancelled");
        expect(finalJobs.find((j) => j.id === jobB.id)?.state).toBe("cancelled");
      }),
  );

  it.effect(
    "tracks long-running Antigravity command_execution items, debounces short commands, and ignores Ship Queue watches",
    () =>
      Effect.gen(function* () {
        const dir = mkTempDir("t3-bg-cmd-");
        const logPath = NodePath.join(dir, "train.log");
        NodeFS.writeFileSync(logPath, "  ep 1/4 step 200/800 | loss=1.25\n", "utf8");
        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();

        const registry = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            ciHostsPath: null,
            commandDebounceMs: 60,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 0,
              threads: [],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => [],
            streamDomainEvents: Stream.fromPubSub(domainEvents),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async (p) => p.startsWith(dir),
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));

        const tid = "fc431aea-12ea-46c5-8d40-feb17dea75ca";

        // Short `git status` completes before debounce -> NEVER creates a job
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-short-1",
            makeCommandTurnItem({
              id: "item-short",
              threadId: tid,
              status: "running",
              command: "git status",
            }),
          ),
        );
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-short-2",
            makeCommandTurnItem({
              id: "item-short",
              threadId: tid,
              status: "completed",
              command: "git status",
              exitCode: 0,
            }),
          ),
        );

        // `ship-queue watch` is skipped (already tracked by ShipQueueBridge)
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-ship-1",
            makeCommandTurnItem({
              id: "item-ship",
              threadId: tid,
              status: "running",
              command: "ship-queue watch 10962",
            }),
          ),
        );

        // Long-running training command with `--log` promotes immediately and tails log progress
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-train-1",
            makeCommandTurnItem({
              id: "item-train",
              threadId: tid,
              status: "running",
              title: "Train MicroCortex F6",
              command: `cerno watch --monitor --log ${logPath} -- python3 train_f6.py`,
            }),
          ),
        );

        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: tid }))[0]?.progress?.current, {
              timeout: 3_000,
            })
            .toBe(200),
        );

        const active = yield* Effect.promise(() => registry.listJobs({ threadId: tid }));
        expect(active).toHaveLength(1);
        expect(active[0]?.title).toBe("Train MicroCortex F6");
        expect(active[0]?.kind).toBe("train");
        expect(active[0]?.progress?.total).toBe(800);
        expect(active[0]?.progress?.stageLabel).toBe("Ep 1/4");

        // Fails with non-zero exit code -> transitions cleanly to `failed`
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-train-2",
            makeCommandTurnItem({
              id: "item-train",
              threadId: tid,
              status: "completed",
              title: "Train MicroCortex F6",
              command: `cerno watch --monitor --log ${logPath} -- python3 train_f6.py`,
              exitCode: 137,
            }),
          ),
        );
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: tid }))[0]?.state, {
              timeout: 2_000,
            })
            .toBe("failed"),
        );
        const failed = yield* Effect.promise(() => registry.listJobs({ threadId: tid }));
        expect(failed[0]?.summary).toBe("Exited with code 137");
      }),
  );

  it.effect(
    "removes the redundant t3_job MCP tool and system instruction while preserving DevtoolsHttp /jobs/* auth",
    () =>
      Effect.gen(function* () {
        expect(T3_CODE_ORCHESTRATION_INSTRUCTIONS).not.toContain("t3_job");
        expect(
          NodeFS.existsSync(
            NodePath.resolve(import.meta.dirname, "../../mcp/toolkits/jobs/tools.ts"),
          ),
        ).toBe(false);

        const broker = new GuardGrantBroker({ socketPath: "/tmp/unused-jobs-test.sock" });
        const registry = makeJobRegistry({ enableShipBridge: false });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));

        const runRoute = (
          method: "GET" | "POST",
          path: string,
          scopes: ReadonlyArray<AuthEnvironmentScope>,
        ) => {
          const req = HttpServerRequest.fromWeb(
            new Request(`http://127.0.0.1:3773${path}`, { method }),
          );
          const session = Effect.succeed({
            sessionId: "sess-1",
            subject: "owner",
            method: "bearer-session-token" as const,
            scopes,
            issuedAt: "2026-01-01T00:00:00.000Z",
            expiresAt: "2099-01-01T00:00:00.000Z",
          });
          const authLayer = Layer.succeed(EnvironmentAuth.EnvironmentAuth, {
            authenticateHttpRequest: () => session,
            authenticateWebSocketUpgrade: () => session,
          } as unknown as typeof EnvironmentAuth.EnvironmentAuth.Service);
          const sessionLayer = Layer.succeed(SessionStore.SessionStore, {
            cookieName: "t3_session",
            legacyCookieName: undefined,
            awaitInvalidation: () => Effect.never,
          } as unknown as typeof SessionStore.SessionStore.Service);

          return DevtoolsHttp.makeHandler(broker, registry).pipe(
            Effect.provideService(HttpServerRequest.HttpServerRequest, req),
            Effect.provide(
              Layer.mergeAll(
                authLayer,
                sessionLayer,
                Path.layer,
                Layer.succeed(HostProcess.Platform, "linux"),
              ),
            ),
            Effect.map((resp) => ({
              status: resp.status,
              body: resp.body._tag === "Uint8Array" ? new TextDecoder().decode(resp.body.body) : "",
            })),
            Effect.catchCause(() => Effect.succeed({ status: 403, body: "" })),
          );
        };

        const listOk = yield* runRoute("GET", "/api/devtools/jobs", [
          AuthOrchestrationReadScope,
          AuthDiagnosticsReadScope,
        ]);
        expect(listOk.status).toBe(200);
        expect(JSON.parse(listOk.body)).toMatchObject({ jobs: [] });

        const cancelDenied = yield* runRoute(
          "POST",
          "/api/devtools/jobs/bg:1234567890abcdef/cancel",
          [AuthOrchestrationReadScope],
        );
        expect(cancelDenied.status).toBe(403);

        const cancelMissing = yield* runRoute(
          "POST",
          "/api/devtools/jobs/bg:1234567890abcdef/cancel",
          [AuthOrchestrationReadScope, AuthTerminalOperateScope],
        );
        expect(cancelMissing.status).toBe(400);
      }),
  );

  it("preserves Ship Queue adapter stage parity and only sets post_merge when POST_MERGE actually ran", () => {
    expect(parseDevdeckStageFromLogText("POST_MERGE job=1\n")).toBe("deploy");
    expect(
      parseDevdeckLogStageInfo("MERGE_EXIT=0\nCLEANED worktree=/tmp/wt\nDONE job=10984\n"),
    ).toEqual({
      stage: "",
      hasPostMerge: false,
    });
    expect(
      parseDevdeckLogStageInfo("MERGE_EXIT=0\nPOST_MERGE job=10985\nFAILED reason=timeout\n"),
    ).toEqual({
      stage: "",
      hasPostMerge: true,
    });
    const jobsRoot = mkTempDir("t3-sq-stage-");
    NodeFS.mkdirSync(NodePath.join(jobsRoot, "10984"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(jobsRoot, "10984", "log"),
      "MERGE_EXIT=0\nCLEANED worktree=/tmp/wt\nDONE job=10984\n",
      "utf8",
    );
    const doneNoDeployRaw = { id: "10984", repo: "tools", state: "done", merge_exit: "0" };
    const doneNoDeploy = adaptShipQueueJob(
      doneNoDeployRaw,
      "host-a",
      1,
      readShipJobLogFacts(doneNoDeployRaw, jobsRoot),
    );
    expect(
      (doneNoDeploy?.shipJob as { post_merge?: unknown } | undefined)?.post_merge,
    ).toBeUndefined();

    const adaptedRaw = {
      id: "10962",
      repo: "devtools",
      branch: "fix/sync",
      state: "running",
      stage: "ci",
      title: "Fix host sync",
    };
    const adapted = adaptShipQueueJob(
      adaptedRaw,
      "host-a",
      1,
      readShipJobLogFacts(adaptedRaw, jobsRoot),
    );
    expect(adapted?.source).toBe("ship-queue");
    expect(adapted?.phaseLabel).toBe("Shipping");

    const heldRaw = {
      id: "10963",
      repo: "devtools",
      branch: "fix/hold",
      state: "waiting",
      waiting_for: "challenge",
      challenged_tip: "abcdef1234567890",
      title: "Fix on hold",
    };
    const held = adaptShipQueueJob(heldRaw, "host-a", 1, readShipJobLogFacts(heldRaw, jobsRoot));
    expect(held?.state).toBe("waiting");
    expect(held?.phaseLabel).toBe("On hold");
  });

  it("adapts the headless ship-queue's own status --json records", async () => {
    const root = mkTempDir("t3-sq-status-");
    const clock = { now: () => "2026-01-01T00:00:00.000Z" };
    const base = {
      repo: "acme-fixture/sample-repo",
      primary: "/work/sample-repo",
      base_branch: "main",
      remote: "origin",
      head_sha: "0".repeat(40),
    };
    const queued = ShipQueueJobStore.createJob(
      root,
      {
        ...base,
        worktree: "/work/wt-a",
        branch: "feat/1-a",
        title: "Ship A",
        thread_id: "thread-a",
      },
      "Closes #1\n",
      clock,
    );
    ShipQueueJobStore.mark(root, queued.id, `QUEUED job=${queued.id} branch=feat/1-a`);
    const landed = ShipQueueJobStore.createJob(
      root,
      { ...base, worktree: "/work/wt-b", branch: "feat/2-b", title: "Ship B" },
      "Closes #2\n",
      clock,
    );
    ShipQueueJobStore.updateJob(root, landed.id, { state: "running", pr: 7 });
    ShipQueueJobStore.mark(root, landed.id, "PR=7");
    const out: string[] = [];
    expect(
      await runShipQueueCli(["status", "--json"], {
        deps: { root },
        io: { stdout: (t) => out.push(t), env: {} },
      }),
    ).toBe(0);
    const status = JSON.parse(out.join("")) as { jobs: Array<Record<string, unknown>> };
    const jobsRoot = NodePath.join(root, "jobs");
    const [a, b] = status.jobs.map((raw) =>
      adaptShipQueueJob(raw, "fixture-host", 1, readShipJobLogFacts(raw, jobsRoot)),
    );

    expect(a).toMatchObject({
      id: `ship:${queued.id}`,
      state: "queued",
      title: "Ship A",
      subtitle: "feat/1-a",
      cancellable: true,
      binding: {
        threadId: "thread-a",
        repo: "acme-fixture/sample-repo",
        branch: "feat/1-a",
        worktreePath: "/work/wt-a",
        host: "fixture-host",
      },
      timing: { startedAt: "2026-01-01T00:00:00.000Z" },
    });
    expect(a?.shipJob).toMatchObject({ stage: "queued" });
    expect(b).toMatchObject({ id: `ship:${landed.id}`, state: "running", phaseLabel: "Shipping" });
    expect(b?.shipJob).toMatchObject({ stage: "github" });
  });

  it("gives a finished ship job its end time from ended_at, else from the zoned DONE marker", async () => {
    // Job 1112's record shape after a merge and a clean post-merge sync (repo names neutral).
    const root = mkTempDir("t3-sq-ended-");
    const clock = { now: () => "2026-11-28T08:45:46.388Z" };
    const init = {
      repo: "acme-fixture/sample-repo",
      primary: "/work/sample-repo",
      worktree: "/work/wt-148",
      branch: "fix/148-sample",
      base_branch: "main",
      remote: "origin",
      title: "fix(sample): hosts check (#148)",
      head_sha: "1".repeat(40),
      thread_id: "thread-ship",
    };
    const finish = (endedAt: string | undefined) => {
      const { id } = ShipQueueJobStore.createJob(root, init, "Closes #148\n", clock);
      ShipQueueJobStore.updateJob(root, id, {
        state: "done",
        pr: 154,
        push_exit: 0,
        merge_exit: 0,
        sync_exit: 0,
        ...(endedAt ? { ended_at: endedAt } : {}),
      });
      for (const line of [
        "MERGE_EXIT=0",
        `POST_MERGE job=${id}`,
        "SYNC_EXIT=0",
        `DONE job=${id} pr=154 at=2026-11-28T08:50:37.370Z`,
      ]) {
        ShipQueueJobStore.mark(root, id, line);
      }
      return id;
    };
    const withEnd = finish("2026-11-28T08:50:37.370Z");
    const markerOnly = finish(undefined);
    const out: string[] = [];
    expect(
      await runShipQueueCli(["status", "--json"], {
        deps: { root },
        io: { stdout: (t) => out.push(t), env: {} },
      }),
    ).toBe(0);
    const status = JSON.parse(out.join("")) as { jobs: Array<Record<string, unknown>> };
    const jobsRoot = NodePath.join(root, "jobs");
    const byId = new Map(
      status.jobs.map((raw) => [
        raw.id,
        adaptShipQueueJob(raw, "fixture-host", 1, readShipJobLogFacts(raw, jobsRoot)),
      ]),
    );
    for (const id of [withEnd, markerOnly]) {
      expect(byId.get(id)).toMatchObject({
        state: "done",
        phaseLabel: "Shipping",
        cancellable: false,
        timing: { startedAt: "2026-11-28T08:45:46.388Z", endedAt: "2026-11-28T08:50:37.370Z" },
      });
    }
  });

  it.effect(
    "classifies cancelled vs unknown-exit pending tasks (M1), skips remote local log tailing (M3), prevents terminal resurrection (M2), routes subagent cancel to owning app thread + cancel timeout (H2/M5), dedups nativeItemId debounce (L3), and reconnects dropped event streams (M4)",
    () =>
      Effect.gen(function* () {
        const dir = mkTempDir("t3-bg-edge-");
        const ciHostsPath = NodePath.join(dir, "ci-hosts.json");
        NodeFS.writeFileSync(ciHostsPath, JSON.stringify(SAMPLE_CI_HOSTS), "utf8");
        const fakeRemoteLog = NodePath.join(dir, "stale-local.log");
        NodeFS.writeFileSync(fakeRemoteLog, "step=99/100 loss=0.001\n", "utf8");

        const domainEvents = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const stoppedThreads: string[] = [];
        let streamStarts = 0;
        let snapshotCalls = 0;

        const registry = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            ciHostsPath,
            commandDebounceMs: 40,
            pendingFinishGraceMs: 40,
            cancelTimeoutMs: 60,
            streamReconnectDelayMs: 25,
            getShellSnapshot: async () => {
              snapshotCalls += 1;
              return {
                schemaVersion: 1,
                snapshotSequence: snapshotCalls,
                threads: [],
                archivedThreads: [],
              };
            },
            getRunningCommandsForThread: async () => [],
            streamDomainEvents: Stream.suspend(() => {
              streamStarts += 1;
              if (streamStarts === 1) return Stream.empty;
              return Stream.fromPubSub(domainEvents);
            }),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async (tid) => {
              stoppedThreads.push(tid);
              return { ok: true };
            },
            isWorkspaceAllowed: async (p) => p.startsWith(dir),
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));

        // M4: first stream ends immediately -> bridge reconnects and re-hydrates automatically
        yield* Effect.promise(() =>
          expect.poll(() => streamStarts, { timeout: 2_000 }).toBeGreaterThanOrEqual(2),
        );
        expect(snapshotCalls).toBeGreaterThanOrEqual(2);

        const appTid = "app-thread-1";
        const subTid = "sub-thread-1";

        // M1(a): provider-thread.updated([]) followed immediately by run.background-work-cancelled -> cancelled
        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({
            id: "ev-m1-1",
            threadId: appTid,
            tasks: [
              {
                taskId: "t-cancel-race",
                kind: "command",
                description: "Long run on 1234",
                command: `cerno watch --monitor --log ${fakeRemoteLog} -- scripts/remote.sh wsl train.py`,
              },
            ],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: appTid })).length, {
              timeout: 2_000,
            })
            .toBe(1),
        );
        // M3: remote host job must NOT tail local fakeRemoteLog (progress stays undefined)
        const remoteJob = (yield* Effect.promise(() =>
          registry.listJobs({ threadId: appTid }),
        ))[0]!;
        expect(remoteJob.binding.host).toBe("host-c");
        expect(remoteJob.progress).toBeUndefined();

        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({ id: "ev-m1-2", threadId: appTid, tasks: [] }),
        );
        yield* PubSub.publish(domainEvents, {
          id: EventId.make("ev-m1-cancel"),
          type: "run.background-work-cancelled",
          threadId: ThreadId.make(appTid),
          occurredAt: DateTime.nowUnsafe(),
          payload: {
            runId: RunId.make("run-1"),
            restartCancelledBackgroundWork: [],
          },
        });
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: appTid }))[0]?.state, {
              timeout: 2_000,
            })
            .toBe("cancelled"),
        );

        // M2(b): stale task re-announcement must NOT resurrect a terminal pending-task job
        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({
            id: "ev-m2-stale",
            threadId: appTid,
            tasks: [
              {
                taskId: "t-cancel-race",
                kind: "command",
                description: "Long run on 1234",
                command: "scripts/remote.sh wsl train.py",
              },
              {
                taskId: "t-unknown",
                kind: "command",
                description: "Mystery task",
                command: "sleep 1",
              },
            ],
          }),
        );
        // Wait until the same event's new task `t-unknown` is materialized, proving `ev-m2-stale` was processed
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: appTid })).length, {
              timeout: 2_000,
            })
            .toBe(2),
        );
        expect(
          (yield* Effect.promise(() => registry.listJobs({ threadId: appTid }))).find(
            (j) => j.id === remoteJob.id,
          )?.state,
        ).toBe("cancelled");

        // M1(b): task removed without cancellation finishes as `exited` (unknown outcome), NOT `done`
        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({ id: "ev-m1-unknown-2", threadId: appTid, tasks: [] }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId: appTid })).find(
                  (j) => j.title === "Mystery task",
                )?.state,
              { timeout: 2_000 },
            )
            .toBe("exited"),
        );

        // L3 + M5 + H2 timeout: debounced command + pending task with ONLY nativeItemId (no itemId)
        // produces 1 job (no duplicate), routes cancel to owning appTid (not subTid), and auto-cancels on timeout
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-l3-cmd",
            makeCommandTurnItem({
              id: "item-sub-1",
              threadId: subTid,
              status: "running",
              title: "Subagent render",
              command: "sleep 60",
              nativeId: "native-sub-1",
            }),
          ),
        );
        yield* PubSub.publish(
          domainEvents,
          makeProviderThreadUpdatedEvent({
            id: "ev-l3-pt",
            threadId: appTid,
            tasks: [
              {
                taskId: "t-sub-1",
                kind: "command",
                description: "Subagent render",
                command: "sleep 60",
                nativeItemId: "native-sub-1",
                sourceThreadId: ThreadId.make(subTid),
              },
            ],
          }),
        );
        // Also publish a second debounced command on `subTid` so waiting for it to materialize proves
        // the `commandDebounceMs` (40ms) timer elapsed without creating a duplicate for `item-sub-1`
        yield* PubSub.publish(
          domainEvents,
          makeCommandEvent(
            "ev-l3-probe",
            makeCommandTurnItem({
              id: "item-sub-probe",
              threadId: subTid,
              status: "running",
              title: "Debounce probe",
              command: "sleep 5",
            }),
          ),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId: subTid })).some(
                  (j) => j.title === "Debounce probe",
                ),
              { timeout: 2_000 },
            )
            .toBe(true),
        );
        const subJobs = yield* Effect.promise(() => registry.listJobs({ threadId: subTid }));
        const subRenderJobs = subJobs.filter((j) => j.title === "Subagent render");
        expect(subRenderJobs).toHaveLength(1);
        const subJob = subRenderJobs[0]!;

        const stopRes = yield* Effect.promise(() => registry.cancelJob(subJob.id));
        expect(stopRes.ok).toBe(true);
        expect(stoppedThreads).toEqual([appTid]);
        // No follow-up event -> cancelTimeoutMs transitions `cancelling` -> `cancelled` cleanly
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId: subTid })).find((j) => j.id === subJob.id)
                  ?.state,
              { timeout: 2_000 },
            )
            .toBe("cancelled"),
        );
      }),
  );

  it("classifies CLI errors centrally, redacts commands, filters noise metrics, and uses typed log-open failure kinds", async () => {
    const stale = classifyCliError({
      toolName: "ship-queue",
      exitCode: 1,
      stderr:
        "!!!!!!!!!!!!!!!!!!!! host-guard OVERRIDE (owner-check): reason !!!!!!!!!!!!!!!!!!!! dependencies: report dependency files differ from current main; scan again before deciding",
    });
    expect(stale.code).toBe("stale_state");
    expect(stale.message).toBe(
      "dependencies: report dependency files differ from current main; scan again before deciding",
    );

    // M4: approved override banner must NOT misclassify a real downstream failure as `guard_denied`
    const overrideThenFail = classifyCliError({
      toolName: "ship-queue",
      exitCode: 1,
      stderr:
        "!!!!!!!!!!!!!!!!!!!! host-guard OVERRIDE (owner-check): approved !!!!!!!!!!!!!!!!!!!! fatal: could not resolve git ref",
    });
    expect(overrideThenFail.code).toBe("command_failed");
    expect(overrideThenFail.message).toBe("fatal: could not resolve git ref");

    // M4: ENOENT inside command stderr (missing report file) is NOT `tool_missing`
    const missingReport = classifyCliError({
      toolName: "ship-queue",
      exitCode: 1,
      stderr: "ENOENT: no such file or directory, open '/tmp/report.json'",
    });
    expect(missingReport.code).toBe("command_failed");

    expect(
      classifyCliError({
        toolName: "devdeck",
        exitCode: 127,
        rawError: "devdeck not found in PATH",
      }).code,
    ).toBe("tool_missing");
    expect(
      classifyCliError({
        toolName: "ship-queue",
        exitCode: 124,
        rawError: "ship-queue timed out after 15000ms",
      }).code,
    ).toBe("timeout");
    expect(
      classifyCliError({
        toolName: "devdeck",
        exitCode: 1,
        stderr: "connect ECONNREFUSED 127.0.0.1:3210",
      }).code,
    ).toBe("daemon_stopped");

    // L1: bare control/exit tokens suppressed, namespaced & real ML metrics preserved
    expect(isNoiseMetricKey("dirty")).toBe(true);
    expect(isNoiseMetricKey("playbook_rc")).toBe(true);
    expect(isNoiseMetricKey("check_rc")).toBe(true);
    expect(isNoiseMetricKey("unittest_rc")).toBe(true);
    expect(isNoiseMetricKey("from_head")).toBe(true);
    expect(isNoiseMetricKey("gitleaks")).toBe(true);
    expect(isNoiseMetricKey("seed")).toBe(true);
    expect(isNoiseMetricKey("status")).toBe(true);
    expect(isNoiseMetricKey("job_id")).toBe(true);
    expect(isNoiseMetricKey("pr")).toBe(true);
    expect(isNoiseMetricKey("loss")).toBe(false);
    expect(isNoiseMetricKey("eval/mrr")).toBe(false);
    expect(isNoiseMetricKey("acc/clean")).toBe(false);
    expect(isNoiseMetricKey("eval/code")).toBe(false);
    expect(isNoiseMetricKey("retries")).toBe(false);

    // M3: redacts compound flags, backslash line continuations, non-HTTP URLs, *_KEY env vars, curl -u, sshpass/mysql -p
    const complexCmd = [
      "OPENAI_KEY=oa_live_111 STRIPE_KEY=st_live_222 python train.py \\",
      "  --client-secret cs_secret_333 \\",
      "  --hf-token hf_tok_444 \\",
      "  --token \\",
      "  tok_nextline_555 \\",
      "  --db postgres://admin:pg_pw_666@db.local/app \\",
      "  --mongo mongodb+srv://root:mongo_pw_777@cluster.example/db &&",
      "curl -u ops:curl_pw_888 https://api.example.com &&",
      "sshpass -p ssh_pw_999 ssh box &&",
      "mysql -pmysql_pw_000 appdb",
    ].join("\n");
    const redactedCmd = formatRedactedCommand(complexCmd) ?? "";
    for (const secret of [
      "oa_live_111",
      "st_live_222",
      "cs_secret_333",
      "hf_tok_444",
      "tok_nextline_555",
      "pg_pw_666",
      "mongo_pw_777",
      "curl_pw_888",
      "ssh_pw_999",
      "mysql_pw_000",
    ]) {
      expect(redactedCmd).not.toContain(secret);
    }

    const record = createManagedJobRecord({
      id: "bg:noise-filter-test",
      threadId: "t-noise",
      backing: "command-item",
      command: complexCmd,
      kind: "test",
      title: "Run checks",
      host: "host-a",
      startedAtIso: "2026-11-22T15:00:00Z",
    });
    ingestCommandOutputFrame(
      record,
      {
        kind: "append",
        text: "dirty=0 playbook_rc=0 check_rc=0 unittest_rc=0 from_head=1 gitleaks=0 seed=42\nstep=1/3 loss=1.42 acc/clean=0.81\nstep=2/3 loss=1.18 acc/clean=0.87\n",
      },
      1_700_000_000_000,
    );
    expect([...record.series.keys()]).toEqual(["loss", "acc/clean"]);
    expect(isPlottableMetricPoints(record.series.get("loss")!.points)).toBe(true);
    expect(
      isPlottableMetricPoints([
        { t: 1, v: 0 },
        { t: 2, v: 0 },
      ]),
    ).toBe(false);
    const detail = buildJobDetail(record);
    expect(detail.command).not.toContain("tok_nextline_555");
    expect(detail.logState).toBe("stream_only");

    // M5: stripJobSummaryCmdline removes logStateReason alongside cmdline and recentTail
    record.logState = "restricted";
    record.logStateReason = "log path must be inside the thread workspace";
    const stripped = stripJobSummaryCmdline(buildJobSummary(record));
    expect(stripped.logStateReason).toBeUndefined();
    expect(stripped.recentTail).toBeUndefined();

    // H1: real `openValidatedLogFile` rejections return typed `kind` without regex guessing
    const relRes = await openValidatedLogFile({
      explicitPath: "relative/run.log",
      isWorkspaceAllowed: async () => false,
      configuredRoots: [],
    });
    expect(relRes.ok).toBe(false);
    if (!relRes.ok) {
      expect(relRes.kind).toBe("restricted");
      expect(mapLogOpenFailureKind(relRes.kind)).toEqual({
        state: "restricted",
        retryable: false,
      });
    }

    const etcRes = await openValidatedLogFile({
      explicitPath: "/etc/hosts",
      isWorkspaceAllowed: async () => true,
      configuredRoots: ["/etc"],
    });
    expect(etcRes.ok).toBe(false);
    if (!etcRes.ok) {
      expect(etcRes.kind).toBe("restricted");
    }

    const outsideDir = mkTempDir("t3-outside-log-");
    const outsideLog = NodePath.join(outsideDir, "run.log");
    NodeFS.writeFileSync(outsideLog, "loss=1.0\n");
    const outsideRes = await openValidatedLogFile({
      explicitPath: outsideLog,
      isWorkspaceAllowed: async () => false,
      configuredRoots: [],
    });
    expect(outsideRes.ok).toBe(false);
    if (!outsideRes.ok) {
      expect(outsideRes.kind).toBe("restricted");
      expect(mapLogOpenFailureKind(outsideRes.kind)).toEqual({
        state: "restricted",
        retryable: false,
      });
    }

    const missingRes = await openValidatedLogFile({
      explicitPath: NodePath.join(outsideDir, "does-not-exist.log"),
      isWorkspaceAllowed: async () => true,
      configuredRoots: [outsideDir],
    });
    expect(missingRes.ok).toBe(false);
    if (!missingRes.ok) {
      expect(missingRes.kind).toBe("missing");
      expect(mapLogOpenFailureKind(missingRes.kind)).toEqual({
        state: "pending_file",
        retryable: true,
      });
    }

    expect(
      resolveJobLogState({
        hasAttachedTailer: false,
        hasPersistedLogPath: false,
        hasTailLines: false,
        explicitState: "restricted",
        explicitReason: "log path points to a protected location",
      }),
    ).toEqual({
      logState: "restricted",
      logStateReason: "log path points to a protected location",
    });
  });

  it.effect(
    "reconciles ghost jobs on reconnect, protects tasks arriving mid-snapshot, cleans terminal run.updated commands without killing pending-tasks, handles providerThreadId drift, and reconciles stalls without closing failed command lookups",
    () =>
      Effect.gen(function* () {
        const tid = "c05c7b71-c315-450d-98fc-ea9e8400c5b1";
        let currentSnapshot: OrchestrationV2ThreadShellSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: [],
          archivedThreads: [],
        };
        let failCommandLookup = false;
        let runningCommands: ReadonlyArray<CommandExecutionTurnItem> = [];
        const snapshotControl: {
          holdNext: boolean;
          release: (() => void) | null;
          onEntered: (() => void) | null;
        } = { holdNext: false, release: null, onEntered: null };
        let snapshotCalls = 0;

        let streamAttempt = 0;
        let activeSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const streamControl: { endStreamNow: (() => void) | null } = { endStreamNow: null };

        const streamDomainEvents = Stream.suspend(() => {
          streamAttempt += 1;
          const myPubSub = activeSub;
          let closed = false;
          streamControl.endStreamNow = () => {
            closed = true;
          };
          return Stream.fromPubSub(myPubSub).pipe(Stream.takeWhile(() => !closed));
        });

        const registry = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 10,
            pendingFinishGraceMs: 10,
            streamReconnectDelayMs: 20,
            stallCheckIntervalMs: 25,
            stallReconcileCooldownMs: 60_000,
            getShellSnapshot: async () => {
              snapshotCalls += 1;
              if (snapshotControl.holdNext) {
                snapshotControl.holdNext = false;
                const gate = new Promise<void>((resolve) => {
                  snapshotControl.release = resolve;
                });
                const notify = snapshotControl.onEntered;
                snapshotControl.onEntered = null;
                notify?.();
                await gate;
                snapshotControl.release = null;
              } else if (snapshotControl.onEntered) {
                const notify = snapshotControl.onEntered;
                snapshotControl.onEntered = null;
                notify();
              }
              return currentSnapshot;
            },
            getRunningCommandsForThread: async () => {
              if (failCommandLookup) {
                throw new Error("RPC timeout reading running commands");
              }
              return runningCommands;
            },
            streamDomainEvents,
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));

        // Wait for initial hydration to complete
        yield* Effect.promise(() => expect.poll(() => snapshotCalls, { timeout: 2_000 }).toBe(1));

        // 1. Seed a pending-task (`bdlqpgt27`), a duplicate Monitor ship-queue task (must be skipped!),
        //    a ghost command-item on `run-1`, a persistent monitor on `run-1` (stays running after run-1 ends!),
        //    AND a debounced short command on `run-1` (must not resurrect after run-1 ends).
        const persistentMonitorItem = makeCommandTurnItem({
          id: "item-monitor-persist",
          threadId: tid,
          runId: "run-1",
          status: "running",
          title: "Persistent monitor across run end",
          command: "cerno watch --log logs/mon.log -- ./watch.sh",
        });
        runningCommands = [persistentMonitorItem];
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-ghost-pt",
            threadId: tid,
            providerThreadId: "pt-old",
            tasks: [
              {
                taskId: "bdlqpgt27",
                kind: "command",
                description: "Remote comp rc16",
                command:
                  "cerno watch --monitor --log logs/comp_rc16.log -- scripts/remote_comp.sh rc16",
                sourceThreadId: ThreadId.make(tid),
              },
              {
                // Exact production Claude Monitor payload for `ship-queue watch 10987` (no `command` field!)
                taskId: "bnzitflc3",
                kind: "command",
                description: "ship queue job 10987 (#111)",
                sourceThreadId: ThreadId.make(tid),
              },
            ],
          }),
        );
        yield* PubSub.publish(
          activeSub,
          makeCommandEvent(
            "ev-ghost-cmd",
            makeCommandTurnItem({
              id: "item-run1-cmd",
              threadId: tid,
              runId: "run-1",
              status: "running",
              title: "Long run-1 check",
              command: "cerno watch --log logs/check.log -- ./ci-local.sh",
            }),
          ),
        );
        yield* PubSub.publish(
          activeSub,
          makeCommandEvent("ev-monitor-start", persistentMonitorItem),
        );
        // Debounced short command on run-1 started right before run-1 completes
        yield* PubSub.publish(
          activeSub,
          makeCommandEvent(
            "ev-debounced-run1",
            makeCommandTurnItem({
              id: "item-debounced-run1",
              threadId: tid,
              runId: "run-1",
              status: "running",
              title: "Short debounced step",
              command: "sleep 1",
            }),
          ),
        );

        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: tid })).length, {
              timeout: 2_000,
            })
            .toBe(3),
        );
        // Monitor `ship queue job 10987 (#111)` must never create a duplicate Jobs card
        const seededJobs = yield* Effect.promise(() => registry.listJobs({ threadId: tid }));
        expect(seededJobs.some((j) => j.title.includes("10987"))).toBe(false);

        // 2. Terminal `run.updated` checks `getRunningCommandsForThread`: closes dead ghost,
        //    blocks debounced resurrection, keeps persistent monitor running, preserves pending-task.
        yield* PubSub.publish(
          activeSub,
          makeRunUpdatedEvent({
            eventId: "ev-run1-done",
            runId: "run-1",
            threadId: tid,
            status: "completed",
            providerThreadId: "pt-old",
          }),
        );

        yield* Effect.promise(() =>
          expect
            .poll(
              async () => {
                const list = await registry.listJobs({ threadId: tid });
                return {
                  cmd: list.find((j) => j.title === "Long run-1 check")?.state,
                  monitor: list.find((j) => j.title === "Persistent monitor across run end")?.state,
                  task: list.find((j) => j.title === "Remote comp rc16")?.state,
                  debounced:
                    list.find((j) => j.title === "Short debounced step")?.state ?? "absent",
                };
              },
              { timeout: 2_000 },
            )
            .toEqual({ cmd: "exited", monitor: "running", task: "running", debounced: "absent" }),
        );

        // Persistent monitor receives later tick and completion event even though run-1 is terminal!
        yield* PubSub.publish(
          activeSub,
          makeCommandEvent("ev-monitor-complete", {
            ...persistentMonitorItem,
            status: "completed",
            exitCode: 0,
            output: "tick-1\ntick-2\n",
          }),
        );
        runningCommands = [];
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId: tid })).find(
                  (j) => j.title === "Persistent monitor across run end",
                )?.state,
              { timeout: 2_000 },
            )
            .toBe("done"),
        );

        // 3. `providerThreadId` drift & M1: active provider thread (`pt-new`) replaces `pt-old` and closes stale `pt-old` task;
        //    later, an empty update from non-active `pt-old` (status: "idle") MUST NOT close `pt-new`'s live task!
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-pt-reattach",
            threadId: tid,
            providerThreadId: "pt-new",
            status: "active",
            tasks: [],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId: tid })).find(
                  (j) => j.title === "Remote comp rc16",
                )?.state,
              { timeout: 2_000 },
            )
            .toBe("exited"),
        );

        // 4. Reconnect reconciliation + H1 active-run protection + M1 non-active provider thread protection
        //    + monotonic mid-snapshot newborn protection (L9) + failed `getRunningCommandsForThread` non-closure
        const tidActiveRun = "a1111111-1111-4111-8111-111111111111";
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-reconnect-seed",
            threadId: tid,
            providerThreadId: "pt-new",
            status: "active",
            tasks: [
              {
                taskId: "task-ghost-vanished",
                kind: "command",
                description: "Vanished during disconnect",
                command: "cerno watch --log logs/vanished.log -- sleep 5",
                sourceThreadId: ThreadId.make(tid),
              },
            ],
          }),
        );
        // M1: stale non-active provider thread (`pt-old`, idle, empty tasks) MUST NOT close `pt-new`'s task!
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-pt-old-idle-empty",
            threadId: tid,
            providerThreadId: "pt-old",
            status: "idle",
            tasks: [],
          }),
        );
        // H1: thread with an ACTIVE run has `pendingBackgroundTasks: []` in real projections; its live pending-task must survive!
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-active-run-seed",
            threadId: tidActiveRun,
            providerThreadId: "pt-active",
            status: "active",
            tasks: [
              {
                taskId: "task-must-survive-active-run",
                kind: "command",
                description: "Must survive active run",
                command: "cerno watch --log logs/build.log -- cargo build",
                sourceThreadId: ThreadId.make(tidActiveRun),
              },
            ],
          }),
        );
        yield* PubSub.publish(
          activeSub,
          makeCommandEvent(
            "ev-cmd-rpc-fail",
            makeCommandTurnItem({
              id: "item-keep-alive",
              threadId: tidActiveRun,
              runId: "run-2",
              status: "running",
              title: "Must survive RPC failure",
              command: "cerno watch --log logs/keep.log -- sleep 30",
            }),
          ),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () => (await registry.listJobs()).filter((j) => j.state === "running").length,
              { timeout: 2_000 },
            )
            .toBe(3),
        );

        // Snapshot shows:
        // - `tid` is settled (`activeRunId: null, status: "completed"`) with `pendingBackgroundTasks: []` -> authoritative, closes ghost!
        // - `tidActiveRun` has an ACTIVE run (`activeRunId: "run-2", status: "running"`) with `pendingBackgroundTasks: []`
        //   AND `getRunningCommandsForThread` fails -> BOTH `pending-task` and `command-item` survive!
        failCommandLookup = true;
        currentSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 2,
          threads: [
            makeThreadShell({
              id: tid,
              status: "completed",
              activityRunStatus: null,
              activeRunId: null,
              activeProviderThreadId: "pt-new",
              pendingBackgroundTasks: [],
            }),
            makeThreadShell({
              id: tidActiveRun,
              status: "running",
              activityRunStatus: "running",
              activeRunId: "run-2",
              activeProviderThreadId: "pt-active",
              pendingBackgroundTasks: [],
            }),
          ],
          archivedThreads: [],
        };

        // Hold the reconnect snapshot in flight so we can inject a brand-new task AFTER `snapshotStartMs`
        const snapshotEntered = new Promise<void>((resolve) => {
          snapshotControl.onEntered = resolve;
        });
        snapshotControl.holdNext = true;

        // Swap to a new PubSub and end the old stream to trigger reconnect
        const prevPubSub = activeSub;
        activeSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        streamControl.endStreamNow?.();
        yield* PubSub.publish(
          prevPubSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-flush",
            threadId: tid,
            providerThreadId: "pt-old",
            status: "idle",
            tasks: [],
          }),
        );

        // Wait until reconnect snapshot has started (so monotonic `snapshotStartMs` is captured)
        yield* Effect.promise(() => snapshotEntered);

        // Advance monotonic clock past `snapshotStartMs` (L9, no wall-clock sleep) then inject newborn task
        const baseMono = performance.now.bind(performance);
        const midSnapshotMonoSpy = vi
          .spyOn(performance, "now")
          .mockImplementation(() => baseMono() + 50);
        try {
          yield* PubSub.publish(
            activeSub,
            makeProviderThreadUpdatedEvent({
              id: "ev-mid-snapshot-new",
              threadId: tid,
              providerThreadId: "pt-new",
              status: "active",
              tasks: [
                {
                  taskId: "task-born-mid-snapshot",
                  kind: "command",
                  description: "Born mid-snapshot",
                  command: "cerno watch --log logs/new.log -- sleep 10",
                  sourceThreadId: ThreadId.make(tid),
                },
              ],
            }),
          );
          yield* Effect.promise(() =>
            expect
              .poll(
                async () =>
                  (await registry.listJobs({ threadId: tid })).some(
                    (j) => j.title === "Born mid-snapshot" && j.state === "running",
                  ),
                { timeout: 2_000 },
              )
              .toBe(true),
          );
        } finally {
          midSnapshotMonoSpy.mockRestore();
        }

        // Release the stale snapshot
        snapshotControl.release?.();

        yield* Effect.promise(() =>
          expect
            .poll(
              async () => {
                const list = await registry.listJobs();
                return {
                  ghost: list.find((j) => j.title === "Vanished during disconnect")?.state,
                  newborn: list.find((j) => j.title === "Born mid-snapshot")?.state,
                  activeRunTask: list.find((j) => j.title === "Must survive active run")?.state,
                  cmdOnFailedRpc: list.find((j) => j.title === "Must survive RPC failure")?.state,
                };
              },
              { timeout: 2_000 },
            )
            .toEqual({
              ghost: "exited",
              newborn: "running",
              activeRunTask: "running",
              cmdOnFailedRpc: "running",
            }),
        );
        expect(streamAttempt).toBeGreaterThanOrEqual(2);

        // 5. Stall-triggered reconciliation fires ONCE per stall episode (M3) and closes vanished jobs
        failCommandLookup = false;
        runningCommands = [];
        currentSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 3,
          threads: [],
          archivedThreads: [],
        };
        const callsBeforeStall = snapshotCalls;
        const realNow = Date.now.bind(Date);
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + 20 * 60_000);
        try {
          yield* Effect.promise(() =>
            expect
              .poll(
                async () => {
                  const list = await registry.listJobs();
                  return {
                    newborn: list.find((j) => j.title === "Born mid-snapshot")?.state,
                    activeRunTask: list.find((j) => j.title === "Must survive active run")?.state,
                    cmd: list.find((j) => j.title === "Must survive RPC failure")?.state,
                  };
                },
                { timeout: 2_000 },
              )
              .toEqual({ newborn: "exited", activeRunTask: "exited", cmd: "exited" }),
          );
          expect(snapshotCalls).toBe(callsBeforeStall + 1);
        } finally {
          nowSpy.mockRestore();
        }
      }),
  );

  it.effect(
    "retries failed post-initial reconnect reconcile with backoff, defers second stall during cooldown, handles ship-queue dedup without false positives, and scans >2MiB POST_MERGE logs",
    () =>
      Effect.gen(function* () {
        // M3: non-empty legitimate commands MUST NOT be skipped based on description text!
        expect(
          classifyCommandTracking("cargo test", "Fix ship-queue watcher bug and run tests"),
        ).toBe("immediate");
        expect(
          classifyCommandTracking(
            "pnpm vitest run ShipQueueSteps",
            "Test ship queue deploy step parity",
          ),
        ).toBe("immediate");
        // Owner #1 + L3: empty-command Monitor descriptions + known ship job IDs ARE skipped
        const liveShipIds = (id: string) => id === "10987";
        expect(classifyCommandTracking("", "ship queue job 10987 (#111)")).toBe("skip");
        expect(classifyCommandTracking("", "ship-queue 10987 (#111)")).toBe("skip");
        expect(classifyCommandTracking("", "SQ job 10987")).toBe("skip");
        expect(classifyCommandTracking("", "ship-queue.sh watch 10987")).toBe("skip");
        expect(classifyCommandTracking("", "Watch job 10987", liveShipIds)).toBe("skip");
        expect(classifyCommandTracking("", "Watch training epoch 10987")).toBe("debounced");
        expect(classifyCommandTracking("cerno ship-watch 10987")).toBe("skip");
        expect(classifyCommandTracking("tail -F /data/Dev/.ship-queue/jobs/10987/log")).toBe(
          "skip",
        );

        // L4 + F3: chunked log reader detects POST_MERGE after >2.5 MiB AND scans complete lines
        // BEFORE a trailing >256-char partial POST_MERGE line straddling a chunk boundary.
        const bigLogRoot = mkTempDir("t3-big-ship-log-");
        NodeFS.mkdirSync(NodePath.join(bigLogRoot, "10999"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(bigLogRoot, "10999", "log"),
          `QUEUED job=10999\nMERGE_EXIT=0\nCLEANED worktree=/tmp/wt\nPOST_MERGE job=10999\n${"  deploy line\n".repeat(200_000)}`,
          "utf8",
        );
        expect(readShipJobLogInfo(statShipJobLog(bigLogRoot, "10999"))).toEqual({
          stage: "deploy",
          hasPostMerge: true,
        });
        NodeFS.mkdirSync(NodePath.join(bigLogRoot, "10998"), { recursive: true });
        NodeFS.writeFileSync(
          NodePath.join(bigLogRoot, "10998", "log"),
          `QUEUED job=10998\nCLEANED worktree=/tmp/wt\nPOST_MERGE job=10998 ${"x".repeat(400)}`,
          "utf8",
        );
        expect(readShipJobLogInfo(statShipJobLog(bigLogRoot, "10998"))).toEqual({
          stage: "deploy",
          hasPostMerge: true,
        });

        const tid = "b2222222-2222-4222-8222-222222222222";
        let snapshotCalls = 0;
        let failNextSnapshot = false;
        let currentSnapshot: OrchestrationV2ThreadShellSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 1,
          threads: [],
          archivedThreads: [],
        };
        let activeSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const streamControl: { endStreamNow: (() => void) | null } = { endStreamNow: null };
        const streamDomainEvents = Stream.suspend(() => {
          const myPubSub = activeSub;
          let closed = false;
          streamControl.endStreamNow = () => {
            closed = true;
          };
          return Stream.fromPubSub(myPubSub).pipe(Stream.takeWhile(() => !closed));
        });

        const registry = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            streamReconnectDelayMs: 15,
            reconcileRetryBaseMs: 25,
            stallCheckIntervalMs: 20,
            stallReconcileCooldownMs: 80,
            getShellSnapshot: async () => {
              snapshotCalls += 1;
              if (failNextSnapshot) {
                failNextSnapshot = false;
                throw new Error("transient snapshot RPC error");
              }
              return currentSnapshot;
            },
            getRunningCommandsForThread: async () => [],
            streamDomainEvents,
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
        yield* Effect.promise(() => expect.poll(() => snapshotCalls, { timeout: 2_000 }).toBe(1));

        // Seed a ghost task on old provider thread `pt-old`, then fail first reconnect snapshot ->
        // retry must recover and close it (also covers L2: settled snapshot with `pt-new` closes `pt-old` ghost!)
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-m2-seed",
            threadId: tid,
            providerThreadId: "pt-old",
            status: "active",
            tasks: [
              {
                taskId: "task-m2-ghost",
                kind: "command",
                description: "Ghost waiting for retry",
                command: "cerno watch --log logs/m2.log -- sleep 5",
                sourceThreadId: ThreadId.make(tid),
              },
            ],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: tid })).length, {
              timeout: 2_000,
            })
            .toBe(1),
        );

        failNextSnapshot = true;
        currentSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 2,
          threads: [
            makeThreadShell({
              id: tid,
              status: "completed",
              activityRunStatus: null,
              activeRunId: null,
              activeProviderThreadId: "pt-new",
              pendingBackgroundTasks: [],
            }),
          ],
          archivedThreads: [],
        };
        const prevPubSub = activeSub;
        activeSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        streamControl.endStreamNow?.();
        yield* PubSub.publish(
          prevPubSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-m2-flush",
            threadId: tid,
            providerThreadId: "pt-other",
            status: "idle",
            tasks: [],
          }),
        );

        yield* Effect.promise(() =>
          expect
            .poll(async () => (await registry.listJobs({ threadId: tid }))[0]?.state, {
              timeout: 2_000,
            })
            .toBe("exited"),
        );
        expect(snapshotCalls).toBeGreaterThanOrEqual(3);

        // M1: Job A stalls and triggers stall reconcile (entering cooldown); Job B stalls DURING
        // cooldown -> deferred timer MUST run reconcile once cooldown expires and close Job B!
        currentSnapshot = {
          schemaVersion: 1,
          snapshotSequence: 3,
          threads: [
            makeThreadShell({
              id: tid,
              status: "completed",
              activityRunStatus: null,
              activeRunId: null,
              activeProviderThreadId: "pt-new",
              pendingBackgroundTasks: [
                {
                  taskId: "task-stall-a",
                  kind: "command",
                  description: "Stall job A",
                  command: "cerno watch --log logs/a.log -- sleep 5",
                  sourceThreadId: ThreadId.make(tid),
                },
              ],
            }),
          ],
          archivedThreads: [],
        };
        yield* PubSub.publish(
          activeSub,
          makeProviderThreadUpdatedEvent({
            id: "ev-stall-a",
            threadId: tid,
            providerThreadId: "pt-new",
            status: "active",
            tasks: [
              {
                taskId: "task-stall-a",
                kind: "command",
                description: "Stall job A",
                command: "cerno watch --log logs/a.log -- sleep 5",
                sourceThreadId: ThreadId.make(tid),
              },
            ],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await registry.listJobs({ threadId: tid })).some(
                  (j) => j.title === "Stall job A" && j.state === "running",
                ),
              { timeout: 2_000 },
            )
            .toBe(true),
        );

        const realNow = Date.now.bind(Date);
        let wallOffsetMs = 20 * 60_000;
        const nowSpy = vi.spyOn(Date, "now").mockImplementation(() => realNow() + wallOffsetMs);
        try {
          const beforeA = snapshotCalls;
          // Wait for Job A's stall reconcile to fire (starts 80ms cooldown)
          yield* Effect.promise(() =>
            expect.poll(() => snapshotCalls, { timeout: 2_000 }).toBeGreaterThan(beforeA),
          );

          // Now seed Job B (ghost, absent from snapshot) DURING Job A's stall cooldown and advance wall clock
          const afterA = snapshotCalls;
          currentSnapshot = {
            schemaVersion: 1,
            snapshotSequence: 4,
            threads: [],
            archivedThreads: [],
          };
          yield* PubSub.publish(
            activeSub,
            makeProviderThreadUpdatedEvent({
              id: "ev-stall-b",
              threadId: tid,
              providerThreadId: "pt-new",
              status: "active",
              tasks: [
                {
                  taskId: "task-stall-a",
                  kind: "command",
                  description: "Stall job A",
                  command: "cerno watch --log logs/a.log -- sleep 5",
                  sourceThreadId: ThreadId.make(tid),
                },
                {
                  taskId: "task-stall-b",
                  kind: "command",
                  description: "Stall job B",
                  command: "cerno watch --log logs/b.log -- sleep 5",
                  sourceThreadId: ThreadId.make(tid),
                },
              ],
            }),
          );
          wallOffsetMs = 40 * 60_000;
          // Deferred cooldown timer must fire and close Stall job B!
          yield* Effect.promise(() =>
            expect
              .poll(
                async () =>
                  (await registry.listJobs({ threadId: tid })).find(
                    (j) => j.title === "Stall job B",
                  )?.state,
                { timeout: 2_000 },
              )
              .toBe("exited"),
          );
          expect(snapshotCalls).toBeGreaterThan(afterA);
        } finally {
          nowSpy.mockRestore();
        }
      }),
  );

  it.effect(
    "streams real grok_monitor OrchestratorV2 replay events in recorded order with zero duplicate or stuck cards",
    () =>
      Effect.gen(function* () {
        const fixture = findReplayFixture("grok_monitor");
        expect(fixture).toBeDefined();
        const grokProvider = fixture!.providers.find((p) => p.driver === "grok");
        expect(grokProvider).toBeDefined();

        const replayResult = yield* runReplayFixture({
          fixtureName: fixture!.name,
          buildInput: fixture!.buildInput,
          driver: grokProvider!,
          harness: GrokOrchestratorReplayHarness,
        });

        const monitorRunningItem = replayResult.domainEvents.find(
          (e): e is Extract<OrchestrationV2DomainEvent, { readonly type: "turn-item.updated" }> =>
            e.type === "turn-item.updated" &&
            e.payload.type === "command_execution" &&
            e.payload.status === "running",
        )?.payload;
        expect(monitorRunningItem).toBeDefined();
        const monitorThreadId = monitorRunningItem!.threadId;

        const activeCmds = new Map<string, CommandExecutionTurnItem>();
        const eventsPubSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const registry = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 0,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async (tid) =>
              [...activeCmds.values()].filter((c) => c.threadId === tid),
            streamDomainEvents: Stream.fromPubSub(eventsPubSub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
        yield* Effect.promise(() => registry.listJobs());

        // Stream EVERY recorded domain event in its exact replay order!
        let sawRunning = false;
        for (const ev of replayResult.domainEvents) {
          if (ev.type === "turn-item.updated" && ev.payload.type === "command_execution") {
            if (ev.payload.status === "running" || ev.payload.status === "waiting") {
              activeCmds.set(ev.payload.id, ev.payload);
            } else {
              activeCmds.delete(ev.payload.id);
            }
          }
          yield* PubSub.publish(eventsPubSub, ev);
          if (
            !sawRunning &&
            ev.type === "turn-item.updated" &&
            ev.payload.type === "command_execution" &&
            ev.payload.status === "running"
          ) {
            yield* Effect.promise(() =>
              expect
                .poll(
                  async () => {
                    const list = await registry.listJobs({ threadId: monitorThreadId });
                    return list.length === 1 && list[0]?.state === "running";
                  },
                  { timeout: 2_000 },
                )
                .toBe(true),
            );
            sawRunning = true;
          }
        }

        expect(sawRunning).toBe(true);
        yield* Effect.promise(() =>
          expect
            .poll(
              async () => {
                const list = await registry.listJobs({ threadId: monitorThreadId });
                return list.map((j) => j.state);
              },
              { timeout: 2_000 },
            )
            .toEqual(["done"]),
        );
      }),
  );

  it.effect(
    "deduplicates projection-derived persistent monitors across reconnect/startup (N1) and promotes debounced live monitors after run completion (N2)",
    () =>
      Effect.gen(function* () {
        const tid = "c3333333-3333-4333-8333-333333333333";
        const completedRun = makeRunUpdatedEvent({
          eventId: "ev-n1-run",
          runId: "run-n1",
          threadId: tid,
          status: "completed",
        });
        if (completedRun.type !== "run.updated") throw new Error("unreachable");

        // N1a (with nativeId) & N1b (without nativeId): reconnect snapshot uses REAL derivePendingBackgroundWork!
        for (const variant of [
          { label: "with-native", itemId: "item-mon-native", nativeId: "grok-mon-native-1" },
          { label: "no-native", itemId: "item-mon-nonative", nativeId: undefined },
        ] as const) {
          const monitorItem: CommandExecutionTurnItem = {
            ...makeCommandTurnItem({
              id: variant.itemId,
              threadId: tid,
              runId: "run-n1",
              status: "running",
              title: `Persistent ${variant.label}`,
              command: "for i in 1 2 3; do echo tick; sleep 1; done",
              ...(variant.nativeId ? { nativeId: variant.nativeId } : {}),
            }),
            monitor: true,
          };

          const derivedPending = derivePendingBackgroundWork({
            latestRun: completedRun.payload,
            providerThreads: [],
            turnItems: [monitorItem],
          }) as ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
          expect(derivedPending).toHaveLength(1);
          expect(derivedPending[0]!.kind).toBe("monitor");

          let runningNow: ReadonlyArray<CommandExecutionTurnItem> = [monitorItem];
          let currentSnapshot: OrchestrationV2ThreadShellSnapshot = {
            schemaVersion: 1,
            snapshotSequence: 1,
            threads: [],
            archivedThreads: [],
          };
          let snapshotCalls = 0;
          let activeSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
          const streamCtrl: { end: (() => void) | null } = { end: null };
          const streamDomainEvents = Stream.suspend(() => {
            const sub = activeSub;
            let closed = false;
            streamCtrl.end = () => {
              closed = true;
            };
            return Stream.fromPubSub(sub).pipe(Stream.takeWhile(() => !closed));
          });

          const registry = makeJobRegistry({
            enableShipBridge: false,
            backgroundBridge: {
              localHostname: "host-a",
              commandDebounceMs: 0,
              streamReconnectDelayMs: 15,
              getShellSnapshot: async () => {
                snapshotCalls += 1;
                return currentSnapshot;
              },
              getRunningCommandsForThread: async () => runningNow,
              streamDomainEvents,
              subscribeCommandOutput: () => Stream.empty,
              stopThread: async () => ({ ok: true }),
              isWorkspaceAllowed: async () => true,
            },
          });
          yield* Effect.addFinalizer(() => Effect.promise(() => registry.dispose()));
          yield* Effect.promise(() => expect.poll(() => snapshotCalls, { timeout: 2_000 }).toBe(1));

          yield* PubSub.publish(
            activeSub,
            makeCommandEvent(`ev-start-${variant.label}`, monitorItem),
          );
          yield* Effect.promise(() =>
            expect
              .poll(async () => (await registry.listJobs({ threadId: tid })).map((j) => j.state), {
                timeout: 2_000,
              })
              .toEqual(["running"]),
          );

          // Reconnect with REAL projection-derived settled shell containing the monitor in pendingBackgroundTasks
          currentSnapshot = {
            schemaVersion: 1,
            snapshotSequence: 2,
            threads: [
              makeThreadShell({
                id: tid,
                status: "completed",
                activeRunId: null,
                pendingBackgroundTasks: derivedPending,
              }),
            ],
            archivedThreads: [],
          };
          const callsBeforeReconnect = snapshotCalls;
          const prevSub = activeSub;
          activeSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
          streamCtrl.end?.();
          yield* PubSub.publish(
            prevSub,
            makeProviderThreadUpdatedEvent({
              id: `ev-flush-${variant.label}`,
              threadId: tid,
              status: "idle",
              tasks: [],
            }),
          );
          yield* Effect.promise(() =>
            expect
              .poll(() => snapshotCalls, { timeout: 2_000 })
              .toBeGreaterThan(callsBeforeReconnect),
          );

          // Must STILL be exactly 1 running card (no duplicate!)
          const afterReconnect = yield* Effect.promise(() => registry.listJobs({ threadId: tid }));
          expect(afterReconnect.map((j) => j.state)).toEqual(["running"]);

          // Real monitor completion MUST transition that 1 card to `done` (no ghost!)
          runningNow = [];
          yield* PubSub.publish(
            activeSub,
            makeCommandEvent(`ev-done-${variant.label}`, {
              ...monitorItem,
              status: "completed",
              exitCode: 0,
              output: "done\n",
            }),
          );
          yield* Effect.promise(() =>
            expect
              .poll(async () => (await registry.listJobs({ threadId: tid })).map((j) => j.state), {
                timeout: 2_000,
              })
              .toEqual(["done"]),
          );
          yield* Effect.promise(() => registry.dispose());
        }

        // N1c: Server startup hydration with monitor ALREADY running in REAL derived pendingBackgroundTasks
        const startupMonitor: CommandExecutionTurnItem = {
          ...makeCommandTurnItem({
            id: "item-startup-mon",
            threadId: tid,
            runId: "run-n1",
            status: "running",
            title: "Startup monitor",
            command: "for i in 1 2 3; do echo tick; sleep 1; done",
            nativeId: "grok-startup-1",
          }),
          monitor: true,
        };
        const startupPending = derivePendingBackgroundWork({
          latestRun: completedRun.payload,
          providerThreads: [],
          turnItems: [startupMonitor],
        }) as ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
        const startupSub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const startupReg = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 40,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [
                makeThreadShell({
                  id: tid,
                  status: "completed",
                  activeRunId: null,
                  pendingBackgroundTasks: startupPending,
                }),
              ],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => [startupMonitor],
            streamDomainEvents: Stream.fromPubSub(startupSub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => startupReg.dispose()));
        const startupList = yield* Effect.promise(() => startupReg.listJobs({ threadId: tid }));
        expect(startupList.map((j) => j.state)).toEqual(["running"]);
        // First live tick must update the SAME single card, then completion marks it `done`
        yield* PubSub.publish(
          startupSub,
          makeCommandEvent("ev-startup-tick", { ...startupMonitor, output: "tick-1\n" }),
        );
        yield* PubSub.publish(
          startupSub,
          makeCommandEvent("ev-startup-done", {
            ...startupMonitor,
            status: "completed",
            exitCode: 0,
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await startupReg.listJobs({ threadId: tid })).map((j) => j.state), {
              timeout: 2_000,
            })
            .toEqual(["done"]),
        );

        // N2: Debounced live monitor whose launch run completes INSIDE the debounce window MUST still promote,
        // while a sibling dead debounced command on the same run must NOT appear!
        const tidN2 = "d4444444-4444-4444-8444-444444444444";
        const debouncedLive: CommandExecutionTurnItem = {
          ...makeCommandTurnItem({
            id: "item-n2-live",
            threadId: tidN2,
            runId: "run-n2",
            status: "running",
            title: "Quiet debounced monitor",
            command: "for i in 1 2 3; do echo tick; sleep 1; done",
          }),
          monitor: true,
        };
        const debouncedDead = makeCommandTurnItem({
          id: "item-n2-dead",
          threadId: tidN2,
          runId: "run-n2",
          status: "running",
          title: "Dead short command",
          command: "sleep 1",
        });
        const n2Sub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        const n2Reg = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 40,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => [debouncedLive],
            streamDomainEvents: Stream.fromPubSub(n2Sub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => n2Reg.dispose()));
        yield* Effect.promise(() => n2Reg.listJobs());

        yield* PubSub.publish(n2Sub, makeCommandEvent("ev-n2-live", debouncedLive));
        yield* PubSub.publish(n2Sub, makeCommandEvent("ev-n2-dead", debouncedDead));
        // Run ends IMMEDIATELY inside the 40ms debounce window while `debouncedLive` is still running
        yield* PubSub.publish(
          n2Sub,
          makeRunUpdatedEvent({
            eventId: "ev-n2-run-done",
            runId: "run-n2",
            threadId: tidN2,
            status: "completed",
          }),
        );
        // After debounce elapses, live monitor MUST promote and dead sibling MUST stay absent!
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await n2Reg.listJobs({ threadId: tidN2 })).map((j) => [j.title, j.state]),
              { timeout: 2_000 },
            )
            .toEqual([["Quiet debounced monitor", "running"]]),
        );

        // F1: a live tick arriving inside the debounce window AFTER run.updated(completed) must NOT drop the card!
        const tidF1 = "e5555555-5555-4555-8555-555555555555";
        const f1Live: CommandExecutionTurnItem = {
          ...makeCommandTurnItem({
            id: "item-f1-live",
            threadId: tidF1,
            runId: "run-f1",
            status: "running",
            title: "Ticked debounced monitor",
            command: "for i in 1 2 3; do echo tick; sleep 1; done",
          }),
          monitor: true,
        };
        const f1Sub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        let f1Checks = 0;
        const f1Reg = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 80,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => {
              f1Checks += 1;
              return [f1Live];
            },
            streamDomainEvents: Stream.fromPubSub(f1Sub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => f1Reg.dispose()));
        yield* Effect.promise(() => f1Reg.listJobs());

        yield* PubSub.publish(f1Sub, makeCommandEvent("ev-f1-start", f1Live));
        yield* PubSub.publish(
          f1Sub,
          makeRunUpdatedEvent({
            eventId: "ev-f1-run-done",
            runId: "run-f1",
            threadId: tidF1,
            status: "completed",
          }),
        );
        yield* Effect.promise(() =>
          expect.poll(() => f1Checks, { timeout: 2_000 }).toBeGreaterThanOrEqual(1),
        );
        // Early tick arrives inside the 80ms debounce window after run-f1 settled
        yield* PubSub.publish(
          f1Sub,
          makeCommandEvent("ev-f1-tick", { ...f1Live, output: "tick-1\n" }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await f1Reg.listJobs({ threadId: tidF1 })).map((j) => [j.title, j.state]),
              { timeout: 2_000 },
            )
            .toEqual([["Ticked debounced monitor", "running"]]),
        );

        // F2: startup with transiently failed getRunningCommandsForThread hydrates a shadow pending-task;
        // a routine provider-thread.updated(idle, tasks: []) MUST NOT close it before ticks/recovery arrive!
        const tidF2 = "f6666666-6666-4666-8666-666666666666";
        const f2Monitor: CommandExecutionTurnItem = {
          ...makeCommandTurnItem({
            id: "item-f2-mon",
            threadId: tidF2,
            runId: "run-f2",
            status: "running",
            title: "Degraded startup monitor",
            command: "for i in 1 2 3; do echo tick; sleep 1; done",
            nativeId: "grok-f2-1",
          }),
          monitor: true,
        };
        const f2Pending = derivePendingBackgroundWork({
          latestRun: completedRun.payload,
          providerThreads: [],
          turnItems: [f2Monitor],
        }) as ReadonlyArray<OrchestrationV2PendingBackgroundTask>;
        const f2Sub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        let f2FailLookup = true;
        const f2Reg = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 40,
            pendingFinishGraceMs: 10,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [
                makeThreadShell({
                  id: tidF2,
                  status: "completed",
                  activeRunId: null,
                  activeProviderThreadId: "pt-f2",
                  pendingBackgroundTasks: f2Pending,
                }),
              ],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => {
              if (f2FailLookup) throw new Error("startup command lookup failed");
              return [f2Monitor];
            },
            streamDomainEvents: Stream.fromPubSub(f2Sub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => f2Reg.dispose()));
        const f2Initial = yield* Effect.promise(() => f2Reg.listJobs({ threadId: tidF2 }));
        expect(f2Initial.map((j) => j.state)).toEqual(["running"]);

        // Seed a normal provider task alongside the unverified shadow, then publish empty provider-thread update.
        // Once the normal task closes past pendingFinishGraceMs, the unverified shadow MUST STILL be running!
        yield* PubSub.publish(
          f2Sub,
          makeProviderThreadUpdatedEvent({
            id: "ev-f2-normal",
            threadId: tidF2,
            providerThreadId: "pt-f2",
            status: "active",
            tasks: [
              {
                taskId: "bg-f2-normal",
                kind: "command",
                description: "Normal provider task",
                command: "cerno watch --log logs/f2.log -- sleep 5",
                sourceThreadId: ThreadId.make(tidF2),
              },
            ],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await f2Reg.listJobs({ threadId: tidF2 })).length, {
              timeout: 2_000,
            })
            .toBe(2),
        );
        yield* PubSub.publish(
          f2Sub,
          makeProviderThreadUpdatedEvent({
            id: "ev-f2-pt-empty",
            threadId: tidF2,
            providerThreadId: "pt-f2",
            status: "idle",
            tasks: [],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () => {
                const list = await f2Reg.listJobs({ threadId: tidF2 });
                return {
                  normal: list.find((j) => j.title === "Normal provider task")?.state,
                  shadow: list.find((j) => j.title === "Degraded startup monitor")?.state,
                };
              },
              { timeout: 2_000 },
            )
            .toEqual({ normal: "exited", shadow: "running" }),
        );
        // Live tick promotes shadow -> command-item and stays running, then completion marks it `done`
        f2FailLookup = false;
        yield* PubSub.publish(
          f2Sub,
          makeCommandEvent("ev-f2-tick", { ...f2Monitor, output: "tick-1\n" }),
        );
        yield* PubSub.publish(
          f2Sub,
          makeCommandEvent("ev-f2-done", { ...f2Monitor, status: "completed", exitCode: 0 }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await f2Reg.listJobs({ threadId: tidF2 })).find(
                  (j) => j.title === "Degraded startup monitor",
                )?.state,
              { timeout: 2_000 },
            )
            .toBe("done"),
        );
        // R5-1: provider-shaped task (`taskId` + `kind` + `description` only, e.g. opencode/muse)
        // hydrated while startup `getRunningCommandsForThread` fails, then finished via
        // `provider-thread.updated(idle, tasks: [])` MUST close to `exited` via partial-hydration retry!
        const tidR51 = "17777777-7777-4777-8777-777777777777";
        const r51Sub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        let r51FailLookup = true;
        let r51Pending: ReadonlyArray<OrchestrationV2PendingBackgroundTask> = [
          {
            taskId: "opencode-bg-1",
            kind: "command",
            description: "OpenCode background shell",
          },
        ];
        let r51Snapshots = 0;
        const r51Reg = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            reconcileRetryBaseMs: 25,
            pendingFinishGraceMs: 10,
            getShellSnapshot: async () => {
              r51Snapshots += 1;
              return {
                schemaVersion: 1,
                snapshotSequence: r51Snapshots,
                threads: [
                  makeThreadShell({
                    id: tidR51,
                    status: "completed",
                    activeRunId: null,
                    activeProviderThreadId: "pt-r51",
                    pendingBackgroundTasks: r51Pending,
                  }),
                ],
                archivedThreads: [],
              };
            },
            getRunningCommandsForThread: async () => {
              if (r51FailLookup) {
                r51FailLookup = false;
                throw new Error("transient startup command lookup failure");
              }
              return [];
            },
            streamDomainEvents: Stream.fromPubSub(r51Sub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => r51Reg.dispose()));
        const r51Initial = yield* Effect.promise(() => r51Reg.listJobs({ threadId: tidR51 }));
        expect(r51Initial.map((j) => j.state)).toEqual(["running"]);

        // Provider drops the finished task right after degraded startup; partial-hydration retry resolves it!
        r51Pending = [];
        yield* PubSub.publish(
          r51Sub,
          makeProviderThreadUpdatedEvent({
            id: "ev-r51-done",
            threadId: tidR51,
            providerThreadId: "pt-r51",
            status: "idle",
            tasks: [],
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(async () => (await r51Reg.listJobs({ threadId: tidR51 })).map((j) => j.state), {
              timeout: 2_000,
            })
            .toEqual(["exited"]),
        );

        // R5-2: quiet live debounced monitor whose run-end `getRunningCommandsForThread` throws once
        // MUST recover and promote via automatic partial retry instead of staying dropped.
        const tidR52 = "28888888-8888-4888-8888-888888888888";
        const r52Live: CommandExecutionTurnItem = {
          ...makeCommandTurnItem({
            id: "item-r52-quiet",
            threadId: tidR52,
            runId: "run-r52",
            status: "running",
            title: "Quiet monitor after RPC glitch",
            command: "for i in 1 2 3; do echo tick; sleep 1; done",
          }),
          monitor: true,
        };
        const r52Sub = yield* PubSub.unbounded<OrchestrationV2DomainEvent>();
        let r52FailOnce = true;
        const r52Reg = makeJobRegistry({
          enableShipBridge: false,
          backgroundBridge: {
            localHostname: "host-a",
            commandDebounceMs: 20,
            reconcileRetryBaseMs: 35,
            getShellSnapshot: async () => ({
              schemaVersion: 1,
              snapshotSequence: 1,
              threads: [],
              archivedThreads: [],
            }),
            getRunningCommandsForThread: async () => {
              if (r52FailOnce) {
                r52FailOnce = false;
                throw new Error("transient run-end RPC failure");
              }
              return [r52Live];
            },
            streamDomainEvents: Stream.fromPubSub(r52Sub),
            subscribeCommandOutput: () => Stream.empty,
            stopThread: async () => ({ ok: true }),
            isWorkspaceAllowed: async () => true,
          },
        });
        yield* Effect.addFinalizer(() => Effect.promise(() => r52Reg.dispose()));
        yield* Effect.promise(() => r52Reg.listJobs());

        yield* PubSub.publish(r52Sub, makeCommandEvent("ev-r52-start", r52Live));
        yield* PubSub.publish(
          r52Sub,
          makeRunUpdatedEvent({
            eventId: "ev-r52-run-done",
            runId: "run-r52",
            threadId: tidR52,
            status: "completed",
          }),
        );
        yield* Effect.promise(() =>
          expect
            .poll(
              async () =>
                (await r52Reg.listJobs({ threadId: tidR52 })).map((j) => [j.title, j.state]),
              { timeout: 2_000 },
            )
            .toEqual([["Quiet monitor after RPC glitch", "running"]]),
        );
      }),
  );
});
