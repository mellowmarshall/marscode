// @effect-diagnostics nodeBuiltinImport:off - Native host reaper: in-process scan snapshots, sweeps, Cargo and Docker steps.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Semaphore from "effect/Semaphore";

import * as ServerConfig from "../../config.ts";
import * as Scheduler from "../../scheduling/Scheduler.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as ReaperPolicy from "../ReaperPolicy.ts";
import * as StorageManifest from "../StorageManifest.ts";
import { defaultCargoRoots, reapCargo } from "./ReaperCargo.ts";
import { readReaperCargoRootsSync } from "./ReaperCargoPolicy.ts";
import { isCheckoutDeleted, isPidDead, reapDocker } from "./ReaperDocker.ts";
import { readReaperDockerRulesSync } from "./ReaperDockerPolicy.ts";
import { sweepHost, TMP_MAX_AGE_HOURS } from "./ReaperHostSweep.ts";
import { findOrphans, signalVerified, type OrphanTarget } from "./ReaperOrphans.ts";
import { manifestHistoryRoots, PathGuard } from "./ReaperPathGuard.ts";
import { scanProcessPaths } from "./ReaperProcPaths.ts";
import { collectHostScan } from "./ReaperScanSnapshot.ts";
import { sweepTmpRoots, tmpCandidateRoots, type SweepContext } from "./ReaperTempSweep.ts";
import type {
  ReaperCargoResult,
  ReaperHostScan,
  ReaperRunSummary,
  ReaperStatus,
} from "./ReaperTypes.ts";

const HOUR_MS = 3_600_000;
const SCAN_INTERVAL_MS = 15 * 60_000;
const RUN_INTERVAL_MS = 4 * HOUR_MS;
const CARGO_INTERVAL_MS = 24 * HOUR_MS;

export class ReaperService extends Context.Service<
  ReaperService,
  {
    /** Read-only: what the next pass would protect, signal and remove. */
    readonly status: Effect.Effect<ReaperStatus>;
    readonly cargo: (dryRun: boolean) => Effect.Effect<ReaperCargoResult>;
    /** One pass now; `cargoOnly` runs just the Cargo step without its daily gate. */
    readonly run: (options: {
      readonly cargoOnly: boolean;
    }) => Effect.Effect<ReaperRunSummary | ReaperCargoResult>;
    readonly refreshScan: Effect.Effect<ReaperHostScan>;
    readonly latestScan: Effect.Effect<ReaperHostScan | null>;
  }
>()("t3/devtools/reaper/ReaperService") {}

async function stampAge(stampPath: string, nowMs: number) {
  const st = await NodeFSP.lstat(stampPath).catch(() => null);
  if (st === null || !st.isFile()) return { text: null, ageS: null, mtimeMs: null };
  const text = (await NodeFSP.readFile(stampPath, "utf8").catch(() => "")).slice(0, 128).trim();
  return {
    text: text || null,
    ageS: Math.max(0, Math.round((nowMs - st.mtimeMs) / 100) / 10),
    mtimeMs: st.mtimeMs,
  };
}

async function writeStamp(stampPath: string, iso: string): Promise<void> {
  await NodeFSP.mkdir(NodePath.dirname(stampPath), { recursive: true });
  await NodeFSP.writeFile(stampPath, `${iso}\n`, "utf8");
}

const make = Effect.gen(function* () {
  const platform = yield* HostProcess.Platform;
  const homeDir = yield* HostProcess.HomeDirectory;
  const env = yield* HostProcess.Environment;
  const host = (yield* HostProcess.Hostname).split(".")[0] ?? "localhost";
  const config = yield* ServerConfig.ServerConfig;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const scheduler = yield* Scheduler.Scheduler;
  const uid = typeof process.getuid === "function" ? process.getuid() : -1;
  const supported = (platform === "linux" || platform === "darwin") && uid >= 0;
  const stampDir = NodePath.join(config.stateDir, "reaper");
  const cargoStamp = NodePath.join(stampDir, "cargo-last-run");
  const runStamp = NodePath.join(stampDir, "last-run");
  const latest = yield* Ref.make<ReaperHostScan | null>(null);
  const lastScanAt = yield* Ref.make(0);
  const permit = yield* Semaphore.make(1);
  const runFork = Effect.runForkWith(yield* Effect.context<never>());
  const log = (message: string) => void runFork(Effect.logInfo(`[reaper] ${message}`));

  const context = Effect.gen(function* () {
    const settings = yield* settingsService.getSettings.pipe(
      Effect.orElseSucceed(() => ({ providerInstances: {} })),
    );
    const manifest = StorageManifest.buildStorageManifestFromSettings(config, settings);
    const historyRoots = yield* Effect.promise(() => manifestHistoryRoots(manifest));
    const nowMs = yield* Clock.currentTimeMillis;
    return { manifest, historyRoots, nowMs, iso: DateTime.formatIso(DateTime.makeUnsafe(nowMs)) };
  });

  const liveScan = Effect.promise(() => scanProcessPaths({ uid, platform }));

  const refreshScan = Effect.gen(function* () {
    const ctx = yield* context;
    const policy = ReaperPolicy.readReaperPolicySync(ctx.historyRoots);
    const scan = yield* Effect.promise(() =>
      collectHostScan({ platform, host, scannedAt: ctx.iso, manifest: ctx.manifest, policy }),
    );
    yield* Ref.set(latest, scan);
    yield* Ref.set(lastScanAt, ctx.nowMs);
    return scan;
  });

  const cargo = Effect.fn("ReaperService.cargoStep")(function* (dryRun: boolean) {
    const ctx = yield* context;
    const roots = yield* Effect.promise(() =>
      defaultCargoRoots(homeDir, env, readReaperCargoRootsSync()),
    );
    const result = yield* Effect.promise(() =>
      reapCargo({ roots, uid, platform, homeDir, env, nowMs: ctx.nowMs, dryRun, log }),
    );
    // A blind or failed scan removed nothing, so the daily gate stays open for the next pass.
    if (!dryRun && result.aborted_reason === null) {
      yield* Effect.promise(() => writeStamp(cargoStamp, ctx.iso));
    }
    return result;
  });

  const terminateOrphans = Effect.gen(function* () {
    const targets = yield* Effect.promise(() => findOrphans(platform));
    const signalled: OrphanTarget[] = [];
    for (const target of targets) {
      if (yield* Effect.promise(() => signalVerified(target, "SIGTERM", platform))) {
        log(
          `Sent SIGTERM to orphan PID ${target.pid} (${Math.round(target.ageS / 60)}m): ${target.cmd}`,
        );
        signalled.push(target);
      }
    }
    if (signalled.length === 0) return 0;
    yield* Effect.sleep("3 seconds");
    for (const target of signalled) {
      if (yield* Effect.promise(() => signalVerified(target, "SIGKILL", platform))) {
        log(`Sent SIGKILL to orphan PID ${target.pid}`);
      }
    }
    return signalled.length;
  });

  const fullPass = Effect.gen(function* () {
    const orphans = yield* terminateOrphans;
    const ctx = yield* context;
    const scan = yield* liveScan;
    const policy = ReaperPolicy.readReaperPolicySync(ctx.historyRoots);
    const summary = yield* Effect.promise(async () => {
      const swept = await sweepHost({
        scan,
        historyRoots: ctx.historyRoots,
        manifest: ctx.manifest,
        policyRules: policy.rules,
        tmpRoots: await tmpCandidateRoots(platform, env),
        devRoots: ["/data/Dev", NodePath.join(homeDir, "Dev-data")],
        uid,
        nowMs: ctx.nowMs,
        homeDir,
        log,
      });
      const selfPidNs = await NodeFSP.readlink("/proc/self/ns/pid").catch(() => "");
      const docker = await reapDocker(
        {
          nowMs: ctx.nowMs,
          selfHost: host,
          selfPidNs,
          pidDead: isPidDead,
          checkoutDeleted: isCheckoutDeleted,
          rules: readReaperDockerRulesSync(),
        },
        { dryRun: false, log },
      ).catch(() => ({ containers: 0, networks: 0 }));
      return { swept, docker };
    });
    const cargoAge = yield* Effect.promise(() => stampAge(cargoStamp, ctx.nowMs));
    const cargoResult =
      cargoAge.mtimeMs === null || ctx.nowMs - cargoAge.mtimeMs >= CARGO_INTERVAL_MS
        ? yield* cargo(false)
        : null;
    yield* Effect.promise(() => writeStamp(runStamp, ctx.iso));
    yield* refreshScan;
    return {
      orphans_terminated: orphans,
      sweeps_refused: summary.swept.refused,
      tmp: summary.swept.tmp,
      exhaust_removed: summary.swept.exhaust,
      ephemeral_removed: summary.swept.ephemeral,
      approved_removed: summary.swept.approved,
      docker: summary.docker,
      cargo: cargoResult,
    } satisfies ReaperRunSummary;
  });

  const status = Effect.gen(function* () {
    const ctx = yield* context;
    const scan = yield* liveScan;
    const guard = new PathGuard([...(scan?.paths ?? []), ...ctx.historyRoots]);
    const livePaths = scan?.paths.size ?? 0;
    return yield* Effect.promise(async (): Promise<ReaperStatus> => {
      const orphans = await findOrphans(platform);
      const sweep: SweepContext = { uid, nowMs: ctx.nowMs, guard, dryRun: true, log };
      const tmp = await sweepTmpRoots(
        await tmpCandidateRoots(platform, env),
        sweep,
        TMP_MAX_AGE_HOURS,
      );
      const stamp = await stampAge(cargoStamp, ctx.nowMs);
      const worktrees = await NodeFSP.readdir(ctx.manifest.worktreesDir).catch(
        () => [] as string[],
      );
      return {
        protected: {
          sessions: ctx.historyRoots.length,
          worktrees: worktrees.length,
          paths: livePaths,
        },
        orphan_candidates: orphans.map((o) => ({ pid: o.pid, cmd: o.cmd, age_s: o.ageS })),
        stale_tmp: {
          max_age_hours: TMP_MAX_AGE_HOURS,
          roots: tmp.roots,
          dirs: tmp.dirs,
          files: tmp.files,
          skipped_active: tmp.skippedActive,
        },
        cargo_last_run: { stamp_path: cargoStamp, last_run: stamp.text, age_s: stamp.ageS },
      };
    });
  });

  const exclusive = <A>(effect: Effect.Effect<A>) => permit.withPermits(1)(effect);
  const unsupportedCargo: ReaperCargoResult = {
    dry_run: true,
    build_dirs: 0,
    removed: 0,
    removed_bytes: 0,
    incremental: 0,
    incremental_bytes: 0,
    skipped_in_use: 0,
    aborted_reason: `the reaper does not run on ${platform}`,
    items: [],
  };

  const unsupportedStatus: ReaperStatus = {
    protected: { sessions: 0, worktrees: 0, paths: 0 },
    orphan_candidates: [],
    stale_tmp: {
      max_age_hours: TMP_MAX_AGE_HOURS,
      roots: [],
      dirs: 0,
      files: 0,
      skipped_active: 0,
    },
    cargo_last_run: { stamp_path: cargoStamp, last_run: null, age_s: null },
  };

  const dueWork = Effect.gen(function* () {
    const nowMs = yield* Clock.currentTimeMillis;
    if (nowMs - (yield* Ref.get(lastScanAt)) >= SCAN_INTERVAL_MS) yield* refreshScan;
    if (!supported) return;
    const settings = yield* settingsService.getSettings.pipe(Effect.orElseSucceed(() => null));
    if (settings?.storageCleanup.hostReaperEnabled !== true) return;
    const last = yield* Effect.promise(() => stampAge(runStamp, nowMs));
    if (last.mtimeMs !== null && nowMs - last.mtimeMs < RUN_INTERVAL_MS) return;
    yield* exclusive(fullPass);
  });
  yield* scheduler.register("host-reaper", dueWork);

  const runCargo = Effect.fn("ReaperService.cargo")(function* (dryRun: boolean) {
    return supported ? yield* exclusive(cargo(dryRun)) : unsupportedCargo;
  });
  const run = Effect.fn("ReaperService.run")(function* (options: { readonly cargoOnly: boolean }) {
    if (!supported) return unsupportedCargo as ReaperRunSummary | ReaperCargoResult;
    return yield* exclusive<ReaperRunSummary | ReaperCargoResult>(
      options.cargoOnly ? cargo(false) : fullPass,
    );
  });

  return ReaperService.of({
    status: supported ? status : Effect.succeed(unsupportedStatus),
    cargo: runCargo,
    run,
    refreshScan,
    latestScan: Ref.get(latest),
  });
});

export const layer = Layer.effect(ReaperService, make);
