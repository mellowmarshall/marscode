// @effect-diagnostics nodeBuiltinImport:off - Tests create isolated temp directories, executables, and ship-queue state fixtures.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { describe, expect, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";

import * as HostGuardBroker from "../hostGuard/HostGuardBroker.ts";
import { parseShipQueueLogStageInfo } from "./shipQueueLogParser.ts";
import { normalizeShipQueueJob, resolveShipQueueBinary } from "./shipQueueCli.ts";
import { readShipQueueDeps } from "./shipQueueDeps.ts";
import * as ShipQueueService from "./ShipQueueService.ts";

function makeTempFixtureDir() {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-sq-test-"));
  NodeFS.chmodSync(dir, 0o700);
  return {
    dir,
    cleanup: () => {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    },
  };
}

describe("shipQueue unit helpers", () => {
  it("parses column-0 stage markers and keeps POST_MERGE deploy across watcher noise", () => {
    const logText = [
      "QUEUED job=11000 at=2026-11-23T10:00:00",
      "STARTED job=11000 at=2026-11-23T10:00:02",
      "  PR=999 indented noise line",
      "REBASED abcdef123456 at=2026-11-23T10:00:10",
      "MERGE_EXIT=0 at=2026-11-23T10:01:00",
      "POST_MERGE job=11000 at=2026-11-23T10:01:02",
      "WATCHER_LOST pid=42",
      "WATCHER_BACK pid=43",
    ].join("\n");

    expect(parseShipQueueLogStageInfo(logText)).toEqual({
      stage: "deploy",
      hasPostMerge: true,
    });
  });

  it("normalizes ship-queue status records and promotes POST_MERGE to deploying", () => {
    const tmp = makeTempFixtureDir();
    try {
      const jobsRoot = NodePath.join(tmp.dir, "jobs");
      NodeFS.mkdirSync(NodePath.join(jobsRoot, "11050"), { recursive: true });
      NodeFS.writeFileSync(
        NodePath.join(jobsRoot, "11050", "log"),
        "QUEUED job=11050\nMERGE_EXIT=0\nPOST_MERGE job=11050\n",
      );

      const job = normalizeShipQueueJob(
        {
          id: "11050",
          key: "1795472000-j11050",
          repo: "t3code",
          branch: "feat/slice6",
          title: "Slice 6 verification (#123)",
          state: "running",
          display_state: "running",
          pr: 124,
          pr_repo: "private-repo",
          ci_done: "1",
          push_exit: "0",
          merge_exit: 0,
          thread_id: "thread-123",
          route: { host: "host-x", local: false },
          needs_root: { request: "req_1", hosts: ["host-x"] },
        },
        jobsRoot,
      );

      expect(job).toMatchObject({
        id: "11050",
        repo: "t3code",
        branch: "feat/slice6",
        state: "running",
        displayState: "deploying",
        stage: "deploy",
        postMerge: true,
        pr: "124",
        prRepo: "private-repo",
        ciDone: true,
        pushExit: 0,
        mergeExit: 0,
        threadId: "thread-123",
        routeHost: "host-x",
        routeLocal: false,
        needsRootRequest: "req_1",
        needsRootHosts: ["host-x"],
      });
    } finally {
      tmp.cleanup();
    }
  });

  it("reads dependency holds with 24h freshness, superseded attempts, and active attempts", () => {
    const tmp = makeTempFixtureDir();
    try {
      const nowMs = 1_800_000_000_000;
      const nowSec = nowMs / 1000;
      const depsRoot = NodePath.join(tmp.dir, "dependencies");
      NodeFS.mkdirSync(NodePath.join(depsRoot, "repo-holding"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(depsRoot, "repo-superseded"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(depsRoot, "repo-rejected"), { recursive: true });

      NodeFS.writeFileSync(
        NodePath.join(depsRoot, "repo-holding", "state.json"),
        JSON.stringify({
          holding: true,
          report: {
            id: "repo-holding:r1",
            status: "pending",
            created: nowSec - 60,
            updates: [
              {
                packageFile: "package.json",
                depName: "effect",
                currentValue: "4.0.0-beta.40",
                newValue: "4.0.0-beta.47",
                releaseTimestamp: "2026-11-23T12:00:00Z",
              },
            ],
          },
        }),
      );

      NodeFS.writeFileSync(
        NodePath.join(depsRoot, "repo-superseded", "state.json"),
        JSON.stringify({
          holding: true,
          report: {
            id: "repo-superseded:r1",
            status: "pending",
            created: nowSec - 60,
            updates: [
              { packageFile: "package.json", depName: "zod", currentValue: "1", newValue: "2" },
            ],
          },
          attempt: { id: "a1", status: "merged", report: { id: "repo-superseded:r1" } },
          decision: { kind: "approve", until: nowSec + 3600 },
        }),
      );

      NodeFS.writeFileSync(
        NodePath.join(depsRoot, "repo-rejected", "state.json"),
        JSON.stringify({
          holding: true,
          report: { id: "repo-rejected:r2", status: "pending", created: nowSec - 60, updates: [] },
          decision: { kind: "reject", until: nowSec + 7200 },
        }),
      );

      const deps = readShipQueueDeps(tmp.dir, nowMs);
      expect(deps).toHaveLength(3);
      const holding = deps.find((d) => d.repo === "repo-holding");
      expect(holding).toMatchObject({
        holding: true,
        reportId: "repo-holding:r1",
        status: "pending",
        pendingCount: 1,
      });
      expect(holding?.updates[0]).toMatchObject({
        depName: "effect",
        currentValue: "4.0.0-beta.40",
        newValue: "4.0.0-beta.47",
      });

      const superseded = deps.find((d) => d.repo === "repo-superseded");
      expect(superseded).toMatchObject({
        holding: false,
        status: "superseded",
        pendingCount: 0,
        updates: [],
      });

      const rejected = deps.find((d) => d.repo === "repo-rejected");
      expect(rejected).toMatchObject({
        holding: false,
        decisionKind: "reject",
      });
    } finally {
      tmp.cleanup();
    }
  });

  it("honors T3_SHIP_QUEUE_BIN only when T3_GUARD_GRANT_TEST_MODE=1", () => {
    const tmp = makeTempFixtureDir();
    try {
      const fakeBin = NodePath.join(tmp.dir, "ship-queue");
      NodeFS.writeFileSync(fakeBin, "#!/bin/sh\nexit 0\n");
      NodeFS.chmodSync(fakeBin, 0o755);
      const emptyHome = NodePath.join(tmp.dir, "home");
      NodeFS.mkdirSync(emptyHome);

      expect(
        resolveShipQueueBinary(emptyHome, { PATH: "", T3_SHIP_QUEUE_BIN: fakeBin }, 1000),
      ).toBeNull();
      expect(
        resolveShipQueueBinary(
          emptyHome,
          { PATH: "", T3_GUARD_GRANT_TEST_MODE: "1", T3_SHIP_QUEUE_BIN: fakeBin },
          1000,
        ),
      ).toBe(fakeBin);
    } finally {
      tmp.cleanup();
    }
  });
});

describe("ShipQueueService Effect layer", () => {
  it.effect("degrades silently when ship-queue binary is missing", () => {
    const tmp = makeTempFixtureDir();
    const layer = ShipQueueService.layerWithOptions({
      queueRoot: tmp.dir,
      binPath: null,
    }).pipe(
      Layer.provide(
        Layer.mock(HostGuardBroker.HostGuardBroker)({
          state: Effect.succeed({ listening: false, pending: [] }),
          preapprove: () => ({ ok: false, error: "unused" }),
        }),
      ),
    );
    return Effect.gen(function* () {
      const svc = yield* ShipQueueService.ShipQueueService;
      const snap = yield* svc.snapshot;
      expect(snap).toEqual({
        available: false,
        daemonRunning: false,
        daemonPid: null,
        openCount: 0,
        totalCount: 0,
        jobs: [],
        deps: [],
      });
      const cancelRes = yield* svc.cancelJob({ jobId: "123" });
      expect(cancelRes.ok).toBe(false);
    }).pipe(
      Effect.provide(layer),
      Effect.ensuring(Effect.sync(() => tmp.cleanup())),
      Effect.scoped,
    );
  });

  it.live(
    "streams fs.watch updates on live queue state and preapproves human dep decisions",
    () => {
      const tmp = makeTempFixtureDir();
      NodeFS.mkdirSync(NodePath.join(tmp.dir, "jobs"), { recursive: true });
      NodeFS.mkdirSync(NodePath.join(tmp.dir, "dependencies", "demo"), { recursive: true });

      let phase = 1;
      const preapproveCalls: Array<Record<string, unknown>> = [];
      const decideEnvs: Array<Record<string, string | undefined>> = [];

      const serviceLayer = ShipQueueService.layerWithOptions({
        queueRoot: tmp.dir,
        binPath: "/mock/ship-queue",
        execStatus: async () => ({
          ok: true,
          daemonRunning: true,
          daemonPid: 4242,
          openCount: phase,
          totalCount: phase,
          jobs: [
            {
              id: "9001",
              repo: "demo",
              branch: "feat/s6",
              title: "Ship item (#1)",
              state: "running",
              threadId: "thread-s6",
            },
            ...(phase > 1
              ? [
                  {
                    id: "9002",
                    repo: "demo",
                    branch: "feat/s6-next",
                    title: "Ship next (#2)",
                    state: "queued",
                  },
                ]
              : []),
          ],
        }),
        decideDeps: async (input) => {
          decideEnvs.push({ T3CODE_THREAD_ID: input.env.T3CODE_THREAD_ID });
          return { ok: true, output: `Approved ${input.reportId}`, started: true };
        },
      }).pipe(
        Layer.provide(
          Layer.mock(HostGuardBroker.HostGuardBroker)({
            state: Effect.succeed({ listening: true, pending: [] }),
            preapprove: (input) => {
              preapproveCalls.push(input as unknown as Record<string, unknown>);
              return {
                ok: true,
                grantId: "t3g_preapproved",
                expiresAt: "2026-11-23T23:59:59.000Z",
              };
            },
          }),
        ),
      );

      return Effect.gen(function* () {
        const svc = yield* ShipQueueService.ShipQueueService;
        const firstEmissionDone = yield* Deferred.make<void>();
        const collector = yield* svc.snapshotStream.pipe(
          Stream.tap(() => Deferred.succeed(firstEmissionDone, undefined)),
          Stream.take(2),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* Deferred.await(firstEmissionDone);
        phase = 2;
        NodeFS.writeFileSync(NodePath.join(tmp.dir, "jobs", "marker"), "changed");

        const snapshots = yield* Fiber.join(collector);
        expect(snapshots).toHaveLength(2);
        expect(snapshots[0]!.jobs).toHaveLength(1);
        expect(snapshots[1]!.jobs).toHaveLength(2);

        const decideRes = yield* svc.decideDeps({
          reportId: "demo:r_99",
          decision: "approve",
          reason: "Reviewed package lock",
          approvedVia: "browser-session-cookie:owner",
        });
        expect(decideRes).toMatchObject({ ok: true, started: true });
        expect(preapproveCalls).toHaveLength(1);
        expect(preapproveCalls[0]).toMatchObject({
          guard: "owner-check",
          command: ["ship-queue", "deps", "decide", "demo:r_99", "approve"],
          reason: "Reviewed package lock",
          approvedVia: "browser-session-cookie:owner",
        });
        expect(decideEnvs[0]?.T3CODE_THREAD_ID).toBe(preapproveCalls[0]?.threadId);
      }).pipe(
        Effect.provide(serviceLayer),
        Effect.ensuring(Effect.sync(() => tmp.cleanup())),
        Effect.scoped,
      );
    },
  );
});
