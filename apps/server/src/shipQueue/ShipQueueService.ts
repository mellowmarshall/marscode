// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Ref-counted fs.watch and bounded subprocess orchestration for Ship Queue.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import {
  ShipQueueSnapshot,
  type ShipQueueActionResult,
  type ShipQueueCancelInput,
  type ShipQueueDecideDepsInput,
  type ShipQueueDepRepo,
  type ShipQueueJob,
  type ShipQueueScanDepsInput,
} from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as PubSub from "effect/PubSub";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

const encodeSnapshotJson = Schema.encodeSync(Schema.fromJsonString(ShipQueueSnapshot));

import * as HostGuardBroker from "../hostGuard/HostGuardBroker.ts";
import {
  buildSafeToolEnv,
  cancelShipQueueJob,
  execShipQueueStatus,
  resolveShipQueueBinary,
  type RawShipQueueStatusResult,
} from "./shipQueueCli.ts";
import {
  decideShipQueueDeps,
  readShipQueueDeps,
  resolveShipQueueRoot,
  scanShipQueueDeps,
} from "./shipQueueDeps.ts";

const DEBOUNCE_MS = 150;
const ACTIVE_FALLBACK_POLL_MS = 5_000;
const MAX_SUBDIR_WATCHERS = 64;

const EMPTY_SNAPSHOT: ShipQueueSnapshot = {
  available: false,
  daemonRunning: false,
  daemonPid: null,
  openCount: 0,
  totalCount: 0,
  jobs: [],
  deps: [],
};

export interface ShipQueueServiceOptions {
  readonly queueRoot?: string | undefined;
  readonly binPath?: string | null | undefined;
  readonly readDeps?:
    | ((queueRoot: string, nowMs: number) => ReadonlyArray<ShipQueueDepRepo>)
    | undefined;
  readonly execStatus?:
    | ((
        bin: string,
        queueRoot: string,
        env: NodeJS.ProcessEnv,
      ) => Promise<RawShipQueueStatusResult>)
    | undefined;
  readonly cancelJob?:
    | ((
        bin: string | null,
        jobId: string,
        env: NodeJS.ProcessEnv,
      ) => Promise<ShipQueueActionResult>)
    | undefined;
  readonly decideDeps?: typeof decideShipQueueDeps | undefined;
  readonly scanDeps?: typeof scanShipQueueDeps | undefined;
}

/** Effect service exposing live Ship Queue jobs, dependency holds, and human-authorized actions. */
export class ShipQueueService extends Context.Service<
  ShipQueueService,
  {
    readonly snapshot: Effect.Effect<ShipQueueSnapshot>;
    readonly snapshotStream: Stream.Stream<ShipQueueSnapshot>;
    readonly cancelJob: (input: ShipQueueCancelInput) => Effect.Effect<ShipQueueActionResult>;
    readonly decideDeps: (
      input: ShipQueueDecideDepsInput & { readonly approvedVia: string },
    ) => Effect.Effect<ShipQueueActionResult>;
    readonly scanDeps: (input: ShipQueueScanDepsInput) => Effect.Effect<ShipQueueActionResult>;
  }
>()("t3/shipQueue/ShipQueueService") {}

function isJobLive(job: ShipQueueJob): boolean {
  const s = job.state.toLowerCase();
  return !(
    s === "done" ||
    s === "merged" ||
    s === "cancelled" ||
    s === "failed" ||
    s.includes("fail")
  );
}

function hasActiveWork(snap: ShipQueueSnapshot): boolean {
  return snap.jobs.some(isJobLive) || snap.deps.some((dep) => dep.holding);
}

export const layerWithOptions = (options: ShipQueueServiceOptions = {}) =>
  Layer.effect(
    ShipQueueService,
    Effect.gen(function* () {
      const homeDir = yield* HostProcess.HomeDirectory;
      const baseEnv = yield* HostProcess.Environment;
      const serverCwd = yield* HostProcess.WorkingDirectory;
      const hostGuardBroker = yield* HostGuardBroker.HostGuardBroker;
      const services = yield* Effect.context<never>();
      const changesPubSub = yield* PubSub.unbounded<ShipQueueSnapshot>();

      const queueRoot = options.queueRoot ?? resolveShipQueueRoot(homeDir, baseEnv);
      const getBin = () =>
        options.binPath !== undefined ? options.binPath : resolveShipQueueBinary(homeDir, baseEnv);
      const readDepsImpl = options.readDeps ?? readShipQueueDeps;
      const execStatusImpl = options.execStatus ?? execShipQueueStatus;
      const cancelJobImpl = options.cancelJob ?? cancelShipQueueJob;
      const decideDepsImpl = options.decideDeps ?? decideShipQueueDeps;
      const scanDepsImpl = options.scanDeps ?? scanShipQueueDeps;

      const watchers = new Map<string, NodeFS.FSWatcher>();
      let subscriberCount = 0;
      let closed = false;
      let depsSeq = 0;
      let lastSerialized = "";
      let latestSnapshot: ShipQueueSnapshot = EMPTY_SNAPSHOT;
      let debounceTimer: ReturnType<typeof setTimeout> | null = null;
      let fallbackTimer: ReturnType<typeof setInterval> | null = null;

      const closeWatchers = () => {
        for (const watcher of watchers.values()) {
          try {
            watcher.close();
          } catch {
            // ignore close failure
          }
        }
        watchers.clear();
      };

      const stopTimers = () => {
        if (debounceTimer) {
          clearTimeout(debounceTimer);
          debounceTimer = null;
        }
        if (fallbackTimer) {
          clearInterval(fallbackTimer);
          fallbackTimer = null;
        }
      };

      const ensureWatchDir = (dirPath: string) => {
        if (closed || subscriberCount <= 0 || watchers.has(dirPath)) return;
        try {
          if (!NodeFS.statSync(dirPath).isDirectory()) return;
          const watcher = NodeFS.watch(dirPath, () => {
            if (closed || subscriberCount <= 0) return;
            if (debounceTimer) clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
              debounceTimer = null;
              void refreshAndPublish();
            }, DEBOUNCE_MS);
            debounceTimer.unref?.();
          });
          watcher.on("error", () => {
            watcher.close();
            watchers.delete(dirPath);
          });
          watchers.set(dirPath, watcher);
        } catch {
          // Directory may not exist yet; root/deps dir watch covers future creation.
        }
      };

      const syncSubdirWatches = (snap: ShipQueueSnapshot) => {
        if (closed || subscriberCount <= 0 || !snap.available) {
          closeWatchers();
          return;
        }
        const jobsRoot = NodePath.join(queueRoot, "jobs");
        const depsRoot = NodePath.join(queueRoot, "dependencies");
        const desired = new Set<string>([jobsRoot, depsRoot]);
        for (const job of snap.jobs) {
          if (!isJobLive(job)) continue;
          if (/^[0-9A-Za-z._-]{1,64}$/.test(job.id)) {
            desired.add(NodePath.join(jobsRoot, job.id));
          }
          if (desired.size >= MAX_SUBDIR_WATCHERS) break;
        }
        for (const dep of snap.deps) {
          if (desired.size >= MAX_SUBDIR_WATCHERS) break;
          desired.add(NodePath.join(depsRoot, dep.repo));
        }
        for (const [watchedPath, watcher] of watchers) {
          if (!desired.has(watchedPath)) {
            watcher.close();
            watchers.delete(watchedPath);
          }
        }
        for (const dirPath of desired) {
          ensureWatchDir(dirPath);
        }
      };

      const syncFallbackTimer = (snap: ShipQueueSnapshot) => {
        if (closed || subscriberCount <= 0 || !snap.available || !hasActiveWork(snap)) {
          if (fallbackTimer) {
            clearInterval(fallbackTimer);
            fallbackTimer = null;
          }
          return;
        }
        if (!fallbackTimer) {
          fallbackTimer = setInterval(() => {
            void refreshAndPublish();
          }, ACTIVE_FALLBACK_POLL_MS);
          fallbackTimer.unref?.();
        }
      };

      const readCurrentSnapshot = async (nowMs: number): Promise<ShipQueueSnapshot> => {
        const bin = getBin();
        if (!bin) return EMPTY_SNAPSHOT;
        const toolEnv = buildSafeToolEnv(baseEnv, { SHIP_QUEUE_ROOT: queueRoot });
        const [statusRes, deps] = await Promise.all([
          execStatusImpl(bin, queueRoot, toolEnv),
          Promise.resolve(readDepsImpl(queueRoot, nowMs)),
        ]);
        return {
          available: true,
          daemonRunning: statusRes.daemonRunning,
          daemonPid: statusRes.daemonPid,
          openCount: statusRes.openCount,
          totalCount: statusRes.totalCount,
          jobs: statusRes.jobs,
          deps: [...deps],
        };
      };

      const refreshAndPublish = async (): Promise<ShipQueueSnapshot> => {
        if (closed) return latestSnapshot;
        const snap = await readCurrentSnapshot(Date.now());
        latestSnapshot = snap;
        syncSubdirWatches(snap);
        syncFallbackTimer(snap);
        const serialized = encodeSnapshotJson(snap);
        if (serialized !== lastSerialized) {
          lastSerialized = serialized;
          Effect.runSyncWith(services)(PubSub.publish(changesPubSub, snap));
        }
        return snap;
      };

      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          closed = true;
          subscriberCount = 0;
          stopTimers();
          closeWatchers();
        }).pipe(Effect.andThen(PubSub.shutdown(changesPubSub))),
      );

      return ShipQueueService.of({
        snapshot: Clock.currentTimeMillis.pipe(
          Effect.flatMap((nowMs) => Effect.promise(() => readCurrentSnapshot(nowMs))),
        ),
        snapshotStream: Stream.unwrap(
          Effect.gen(function* () {
            const subscription = yield* Effect.acquireRelease(
              Effect.gen(function* () {
                const sub = yield* PubSub.subscribe(changesPubSub);
                subscriberCount += 1;
                return sub;
              }),
              () =>
                Effect.sync(() => {
                  subscriberCount = Math.max(0, subscriberCount - 1);
                  if (subscriberCount === 0) {
                    stopTimers();
                    closeWatchers();
                  }
                }),
            );
            const initial = yield* Effect.promise(() => refreshAndPublish());
            let prevSerialized = encodeSnapshotJson(initial);
            const liveUpdates = Stream.fromSubscription(subscription).pipe(
              Stream.filter((snap) => {
                const nextSerialized = encodeSnapshotJson(snap);
                if (nextSerialized === prevSerialized) return false;
                prevSerialized = nextSerialized;
                return true;
              }),
            );
            return Stream.concat(Stream.make(initial), liveUpdates);
          }),
        ).pipe(Stream.scoped),
        cancelJob: Effect.fn("ShipQueueService.cancelJob")(function* (input: ShipQueueCancelInput) {
          const bin = getBin();
          const toolEnv = buildSafeToolEnv(baseEnv, { SHIP_QUEUE_ROOT: queueRoot });
          const res = yield* Effect.promise(() => cancelJobImpl(bin, input.jobId.trim(), toolEnv));
          if (res.ok) {
            yield* Effect.promise(() => refreshAndPublish());
          }
          return res;
        }),
        decideDeps: Effect.fn("ShipQueueService.decideDeps")(function* (
          input: ShipQueueDecideDepsInput & { readonly approvedVia: string },
        ) {
          const brokerState = yield* hostGuardBroker.state;
          if (!brokerState.listening) {
            return { ok: false, error: "guard grant broker is not listening" };
          }
          const reportId = input.reportId.trim();
          const threadId = `t3-ship-deps-${NodeCrypto.randomBytes(4).toString("hex")}-${(depsSeq += 1)}`;
          const reason =
            input.reason?.trim() ||
            `Dependency decision via T3 Code (${input.decision} ${reportId})`;
          const grant = hostGuardBroker.preapprove({
            guard: "owner-check",
            command: ["ship-queue", "deps", "decide", reportId, input.decision],
            cwd: serverCwd,
            reason,
            threadId,
            ttlMs: 30_000,
            approvedVia: input.approvedVia,
          });
          if (!grant.ok) {
            return { ok: false, error: grant.error };
          }
          const nowMs = yield* Clock.currentTimeMillis;
          const bin = getBin();
          const toolEnv = buildSafeToolEnv(baseEnv, {
            SHIP_QUEUE_ROOT: queueRoot,
            T3CODE_THREAD_ID: threadId,
          });
          const res = yield* Effect.promise(() =>
            decideDepsImpl({
              bin,
              queueRoot,
              reportId,
              decision: input.decision,
              cwd: serverCwd,
              env: toolEnv,
              nowMs,
            }),
          );
          yield* Effect.promise(() => refreshAndPublish());
          return res;
        }),
        scanDeps: Effect.fn("ShipQueueService.scanDeps")(function* (input: ShipQueueScanDepsInput) {
          const bin = getBin();
          const toolEnv = buildSafeToolEnv(baseEnv, { SHIP_QUEUE_ROOT: queueRoot });
          const res = yield* Effect.sync(() =>
            scanDepsImpl({ bin, queueRoot, repo: input.repo.trim(), env: toolEnv }),
          );
          yield* Effect.promise(() => refreshAndPublish());
          return res;
        }),
      });
    }),
  );

export const layer = layerWithOptions();
