#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off - Standalone post-merge runner executes from extracted base tree without Effect/node_modules.
// Unified MarsCode post-merge & manual local deploy runner:
// reuses one locked warm worktree and diff-gates all 7 local binaries + MarsCode-main.AppImage.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { parseCliArgs, type SyncCliOptions } from "./marscode-sync-cli.ts";
import {
  acquireSyncLock,
  installNodeClis,
  ensureWarmWorktree,
  findBuiltAppImage,
  findCommandOnPath,
  readSyncState,
  runChecked,
  runCmd,
  saveSyncState,
  stageShipQueueVersion,
  validateAndSwapAppImage,
} from "./marscode-sync-install.ts";
import { DESIGN_SCAN, designScanSource, installDesignScan } from "./marscode-sync-design-scan.ts";
import { parityFingerprint } from "./marscode-sync-parity.ts";
import {
  APP_IMAGE_TARGET_ID,
  SYNC_BINARY_TARGETS,
  buildDesktopArtifactEnv,
  parseGlibcVersionFromLdd,
  planSync,
  prependPathDirs,
  recordParitySkips,
  type DesktopHostStatus,
} from "./marscode-sync-plan.ts";
import { readFleetConfig, runFleetSync } from "./marscode-sync-fleet.ts";
import type { FleetHostSyncRecord } from "./marscode-sync-fleet-config.ts";

const DEFAULT_APP_IMAGE_NAME = "MarsCode-main.AppImage";

function log(message: string): void {
  process.stdout.write(`${message}\n`);
}

function logErr(message: string): void {
  process.stderr.write(`${message}\n`);
}

function detectHostGlibcVersion(): string | null {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone post-merge script runs from extracted base tree with no Effect runtime.
  if (NodeOS.platform() !== "linux") return null;
  try {
    const res = NodeChildProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" });
    return parseGlibcVersionFromLdd(`${res.stdout ?? ""}\n${res.stderr ?? ""}`);
  } catch {
    return null;
  }
}

function checkDesktopHost(appDir: string, envPath: string): DesktopHostStatus {
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone post-merge script runs from extracted base tree with no Effect runtime.
  const platform = NodeOS.platform();
  // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone post-merge script runs from extracted base tree with no Effect runtime.
  const arch = NodeOS.arch();
  if (platform !== "linux" || arch !== "x64") {
    return { eligible: false, reason: `unsupported platform ${platform}/${arch}` };
  }
  if (!NodeFS.existsSync(appDir)) {
    return { eligible: false, reason: `app dir missing (${appDir})` };
  }
  try {
    NodeFS.accessSync(appDir, NodeFS.constants.W_OK);
  } catch {
    return { eligible: false, reason: `app dir not writable (${appDir})` };
  }
  if (!findCommandOnPath("cargo", envPath)) {
    return { eligible: false, reason: "cargo not found on PATH" };
  }
  return { eligible: true };
}

function parseRemoteBranch(baseRef: string): { readonly remote: string; readonly branch: string } {
  if (baseRef.startsWith("refs/remotes/")) {
    const rest = baseRef.slice("refs/remotes/".length);
    const slash = rest.indexOf("/");
    if (slash > 0) return { remote: rest.slice(0, slash), branch: rest.slice(slash + 1) };
  }
  if (baseRef.startsWith("refs/heads/")) {
    return { remote: "origin", branch: baseRef.slice("refs/heads/".length) };
  }
  const slash = baseRef.indexOf("/");
  if (slash > 0) return { remote: baseRef.slice(0, slash), branch: baseRef.slice(slash + 1) };
  return { remote: "origin", branch: baseRef || "main" };
}

function resolveHeadSha(options: SyncCliOptions): string {
  if (options.explicitTargetSha && options.targetSha) {
    return runChecked("git", ["-C", options.primary, "rev-parse", options.targetSha], {
      cwd: options.primary,
    }).trim();
  }
  let targetRef = options.targetSha ?? "HEAD";
  if (!options.dryRun) {
    const { remote, branch } = parseRemoteBranch(options.baseRef);
    const fetched = runCmd("git", ["-C", options.primary, "fetch", "--quiet", remote, branch], {
      cwd: options.primary,
    });
    if (fetched.status === 0) {
      const rev = runCmd(
        "git",
        ["-C", options.primary, "rev-parse", "--verify", `${remote}/${branch}^{commit}`],
        { cwd: options.primary },
      );
      const fetchedSha = rev.status === 0 ? rev.stdout.trim() : "";
      if (fetchedSha) {
        if (
          !options.targetSha ||
          runCmd(
            "git",
            ["-C", options.primary, "merge-base", "--is-ancestor", options.targetSha, fetchedSha],
            {
              cwd: options.primary,
            },
          ).status === 0
        ) {
          targetRef = fetchedSha;
        }
      }
    }
  }
  return runChecked("git", ["-C", options.primary, "rev-parse", targetRef], {
    cwd: options.primary,
  }).trim();
}

function listChangedFilesBetween(
  primary: string,
  fromSha: string,
  toSha: string,
): ReadonlyArray<string> | null {
  const verify = runCmd("git", ["-C", primary, "cat-file", "-e", `${fromSha}^{commit}`], {
    cwd: primary,
  });
  if (verify.status !== 0) return null;
  const diff = runCmd("git", ["-C", primary, "diff", "--name-only", `${fromSha}..${toSha}`], {
    cwd: primary,
  });
  if (diff.status !== 0) return null;
  return diff.stdout
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);
}

export function runSync(options: SyncCliOptions): void {
  const homeDir = NodeOS.homedir();
  const nodeBin = NodeFS.realpathSync(process.execPath);
  const headSha = resolveHeadSha(options);
  const statePath = NodePath.join(options.dataRoot, ".sync-state.json");
  const lockPath = NodePath.join(options.dataRoot, ".sync.lock");
  const syncWorktree = NodePath.join(options.dataRoot, "sync-worktree");
  const appImagePath = NodePath.join(options.appDir, DEFAULT_APP_IMAGE_NAME);
  const appShaPath = NodePath.join(options.appDir, `.${DEFAULT_APP_IMAGE_NAME}.sha`);

  const toolPath = prependPathDirs(process.env.PATH, [
    NodePath.join(homeDir, ".local", "share", "ship-queue-ci", "bin"),
    NodePath.join(homeDir, ".local", "share", "vite-plus", "bin"),
    NodePath.join(homeDir, ".vite-plus", "bin"),
    NodePath.join(homeDir, ".cargo", "bin"),
  ]);
  const toolEnv: Record<string, string> = {
    ...(process.env as Record<string, string>),
    PATH: toolPath,
    VP_GIT_HOOKS: "0",
  };

  // Every sync: a missing design scan comes back, and an older one of ours is replaced, from a
  // bundle that outlives the worktree's clean (built when there is none).
  const syncDesignScan = (): void => {
    try {
      const src = designScanSource(
        { worktree: syncWorktree, dataRoot: options.dataRoot, libDir: options.libDir },
        () => {
          ensureWarmWorktree(options.primary, syncWorktree, headSha);
          runChecked("vp", ["run", "--filter", "@t3tools/playbook", "build:bundle"], {
            cwd: syncWorktree,
            env: toolEnv,
            inheritStdio: true,
          });
        },
      );
      if (src === null) {
        logErr(`marscode-sync: warning: skipped ${DESIGN_SCAN}: no built bundle to install`);
        return;
      }
      installDesignScan(src, {
        dir: NodePath.join(options.prefix, "lib", "playbook"),
        log,
        warn: logErr,
      });
    } catch (err) {
      logErr(`marscode-sync: warning: skipped ${DESIGN_SCAN}: ${String(err)}`);
    }
  };

  const execute = (): void => {
    const state = readSyncState(statePath);
    const existingAppSha = NodeFS.existsSync(appShaPath)
      ? NodeFS.readFileSync(appShaPath, "utf8").trim() || undefined
      : undefined;
    const existingBinaries = new Set<string>();
    for (const target of SYNC_BINARY_TARGETS) {
      if (NodeFS.existsSync(NodePath.join(options.binDir, target.binName))) {
        existingBinaries.add(target.binName);
      }
    }

    const fleetHosts = readFleetConfig(options.fleetConfigPath);
    const plan = planSync({
      headSha,
      state,
      existingAppSha,
      existingBinaries,
      appImageExists: NodeFS.existsSync(appImagePath),
      hasNodeModules: NodeFS.existsSync(NodePath.join(syncWorktree, "node_modules")),
      jobsBehind: options.jobsBehind,
      force: options.force,
      skipApp: options.skipApp,
      skipFleet: options.skipFleet,
      fleetHosts,
      only: options.only,
      desktopHost: checkDesktopHost(options.appDir, toolPath),
      listChangedFiles: (fromSha) => listChangedFilesBetween(options.primary, fromSha, headSha),
      parityFingerprint,
    });

    if (options.dryRun) {
      log(
        `[dry-run] head=${headSha.slice(0, 10)} syncWorktree=${syncWorktree} install=${plan.needsInstall}`,
      );
      for (const item of plan.binaries) {
        const d = item.decision;
        const status = d.action === "build" ? `build (${d.reason})` : `skip (${d.reason})`;
        log(`[dry-run] ${item.target.binName} (${item.target.pkgRel}): ${status}`);
      }
      const appDesc =
        plan.appImage.action === "build"
          ? `build (${plan.appImage.reason}) -> ${appImagePath}`
          : `skip (${plan.appImage.reason}${plan.appImage.detail ? `: ${plan.appImage.detail}` : ""})`;
      log(`[dry-run] ${APP_IMAGE_TARGET_ID}: ${appDesc}`);
      for (const entry of plan.fleet.hosts) {
        const d = entry.decision;
        const desc =
          d.action === "build"
            ? `sync (${d.reason})`
            : `skip (${d.reason}${d.detail ? `: ${d.detail}` : ""})`;
        log(`[dry-run] fleet ${entry.host.name} (${entry.host.kind}): ${desc}`);
      }
      return;
    }

    if (!plan.needsWorktreeUpdate && !plan.fleet.anyHostToSync) {
      const detail =
        plan.appImage.action === "skip" && plan.appImage.detail ? ` (${plan.appImage.detail})` : "";
      log(`marscode-sync: nothing to rebuild at ${headSha.slice(0, 10)}${detail}`);
      syncDesignScan();
      return;
    }

    const nextTargets: Record<string, string> = { ...state.targets };
    const nextParitySkips: Record<string, string> = { ...state.paritySkips };
    let nextInstallSha = state.installSha;
    let nextFleetArtifact = state.fleetArtifact;
    const nextFleetHosts: Record<string, FleetHostSyncRecord> = { ...state.fleetHosts };
    const persist = (): void => {
      saveSyncState(statePath, {
        version: 1,
        installSha: nextInstallSha,
        targets: nextTargets,
        ...(Object.keys(nextParitySkips).length > 0 ? { paritySkips: nextParitySkips } : {}),
        ...(nextFleetArtifact ? { fleetArtifact: nextFleetArtifact } : {}),
        ...(Object.keys(nextFleetHosts).length > 0 ? { fleetHosts: nextFleetHosts } : {}),
      });
    };

    if (plan.needsWorktreeUpdate) {
      ensureWarmWorktree(options.primary, syncWorktree, headSha);
    }

    if (plan.needsInstall) {
      if (!findCommandOnPath("vp", toolPath)) {
        throw new Error(`marscode-sync: vp (Vite+) not found on PATH (${toolPath})`);
      }
      runChecked("vp", ["install", "--frozen-lockfile", "--ignore-scripts"], {
        cwd: syncWorktree,
        env: toolEnv,
        inheritStdio: true,
      });
      nextInstallSha = headSha;
      persist();
    }

    const dirtyClis = plan.binaries.filter(
      (b) => b.decision.action === "build" && b.target.kind === "vp-pack-cli",
    );
    if (dirtyClis.length > 0) {
      if (!options.skipBuild) {
        const filterArgs = dirtyClis.flatMap((item) => ["--filter", item.target.pkgName]);
        runChecked("vp", ["run", ...filterArgs, "build:bundle"], {
          cwd: syncWorktree,
          env: toolEnv,
          inheritStdio: true,
        });
      }
      const skipped = installNodeClis(
        syncWorktree,
        dirtyClis.map((item) => item.target),
        {
          binDir: options.binDir,
          libDir: options.libDir,
          nodeBin,
          log,
          warn: logErr,
          onInstalled: (target) => {
            if (target.stageShipQueue && !options.skipStage) {
              stageShipQueueVersion(headSha, {
                binDir: options.binDir,
                libDir: options.libDir,
                queueRoot: options.queueRoot,
              });
            }
            nextTargets[target.id] = headSha;
            delete nextParitySkips[target.id];
            persist();
          },
        },
      );
      const records = { targets: nextTargets, paritySkips: nextParitySkips };
      if (recordParitySkips(records, skipped, headSha, parityFingerprint)) persist();
    }

    syncDesignScan();

    const guardItem = plan.binaries.find((b) => b.target.kind === "guard-protocol")!;
    if (guardItem.decision.action === "build") {
      const guardInstaller = NodePath.join(
        syncWorktree,
        "packages/guard-protocol/scripts/install-guards.sh",
      );
      runChecked(
        "bash",
        [guardInstaller, "--bin-dir", options.binDir, "--lib-dir", options.guardLibDir],
        { cwd: syncWorktree, env: toolEnv, inheritStdio: true },
      );
      nextTargets[guardItem.target.id] = headSha;
      persist();
    }

    const hostGuardItem = plan.binaries.find((b) => b.target.kind === "host-guards")!;
    if (hostGuardItem.decision.action === "build") {
      if (!options.skipBuild) {
        runChecked("vp", ["run", "--filter", "@t3tools/host-guards", "build"], {
          cwd: syncWorktree,
          env: toolEnv,
          inheritStdio: true,
        });
      }
      const hostGuardInstaller = NodePath.join(
        syncWorktree,
        "packages/host-guards/scripts/install.sh",
      );
      runChecked("bash", [hostGuardInstaller, "--no-hooks", "--prefix", options.prefix], {
        cwd: syncWorktree,
        env: toolEnv,
        inheritStdio: true,
      });
      nextTargets[hostGuardItem.target.id] = headSha;
      persist();
    }

    if (plan.appImage.action === "build") {
      const tmpDir = NodePath.join(options.dataRoot, ".tmp");
      NodeFS.mkdirSync(tmpDir, { recursive: true });
      try {
        const desktopEnv = buildDesktopArtifactEnv(toolEnv, {
          homeDir,
          tmpDir,
          hostGlibcVersion: detectHostGlibcVersion(),
        });
        runChecked("vp", ["run", "dist:desktop:linux"], {
          cwd: syncWorktree,
          env: desktopEnv,
          inheritStdio: true,
        });
        const builtArtifact = findBuiltAppImage(syncWorktree);
        validateAndSwapAppImage({
          sourcePath: builtArtifact,
          destPath: appImagePath,
          shaPath: appShaPath,
          sha: headSha,
        });
        nextTargets[APP_IMAGE_TARGET_ID] = headSha;
        persist();
        log(`marscode-sync: installed ${appImagePath} at ${headSha.slice(0, 10)}`);
      } finally {
        NodeFS.rmSync(tmpDir, { recursive: true, force: true });
      }
    } else if (plan.appImage.reason === "burst-coalesced") {
      log(`marscode-sync: deferred AppImage rebuild (${plan.appImage.detail})`);
    } else if (plan.appImage.reason === "non-desktop-host") {
      log(`marscode-sync: skipped AppImage (${plan.appImage.detail})`);
    }

    if (plan.fleet.anyHostToSync) {
      const fleetTmp = NodePath.join(options.dataRoot, ".tmp");
      NodeFS.mkdirSync(fleetTmp, { recursive: true });
      try {
        runFleetSync({
          planned: plan.fleet.hosts,
          needsLinuxBuild: plan.fleet.needsLinuxBuild,
          primary: options.primary,
          worktree: syncWorktree,
          dataRoot: options.dataRoot,
          headSha,
          previousArtifact: nextFleetArtifact,
          env: buildDesktopArtifactEnv(toolEnv, {
            homeDir,
            tmpDir: fleetTmp,
            hostGlibcVersion: detectHostGlibcVersion(),
          }),
          log,
          warn: logErr,
          onArtifactBuilt: (artifact) => {
            nextFleetArtifact = artifact;
            persist();
          },
          onHostSynced: (hostName, record) => {
            nextFleetHosts[hostName] = record;
            persist();
          },
        });
      } finally {
        NodeFS.rmSync(fleetTmp, { recursive: true, force: true });
      }
    }

    let advanced = false;
    for (const item of plan.binaries) {
      if (item.decision.action === "skip" && item.decision.reason === "unchanged") {
        nextTargets[item.target.id] = headSha;
        advanced = true;
      }
    }
    if (plan.appImage.action === "skip" && plan.appImage.reason === "unchanged") {
      nextTargets[APP_IMAGE_TARGET_ID] = headSha;
      advanced = true;
    }
    for (const entry of plan.fleet.hosts) {
      const existing = nextFleetHosts[entry.host.name];
      if (entry.decision.action === "skip" && entry.decision.reason === "unchanged" && existing) {
        nextFleetHosts[entry.host.name] = { ...existing, sha: headSha };
        advanced = true;
      }
    }
    if (advanced) persist();
  };

  if (options.dryRun) {
    execute();
    return;
  }

  const release = acquireSyncLock(lockPath);
  try {
    execute();
  } finally {
    release();
  }
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  NodePath.resolve(process.argv[1]) === NodePath.resolve(NodeURL.fileURLToPath(import.meta.url));

if (isEntrypoint) {
  try {
    runSync(parseCliArgs(process.argv.slice(2)));
  } catch (err) {
    logErr(err instanceof Error ? err.message : String(err));
    process.exit(1);
  }
}
