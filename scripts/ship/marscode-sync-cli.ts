// @effect-diagnostics nodeBuiltinImport:off - Standalone post-merge CLI runs from extracted base tree without Effect/node_modules.
// CLI argument parsing and safe path/env resolution for marscode-sync.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface SyncCliOptions {
  readonly dryRun: boolean;
  readonly force: boolean;
  readonly skipBuild: boolean;
  readonly skipStage: boolean;
  readonly skipApp: boolean;
  readonly skipFleet: boolean;
  readonly fleetConfigPath: string;
  readonly only: ReadonlySet<string> | undefined;
  readonly primary: string;
  readonly dataRoot: string;
  readonly targetSha: string | undefined;
  readonly explicitTargetSha: boolean;
  readonly baseRef: string;
  readonly prefix: string;
  readonly binDir: string;
  readonly libDir: string;
  readonly guardLibDir: string;
  readonly queueRoot: string;
  readonly appDir: string;
  readonly jobsBehind: number;
}

export function formatUsage(): string {
  return [
    "marscode-sync.ts — Sync MarsCode local binaries and MarsCode-main.AppImage from main.",
    "",
    "Usage:",
    "  node scripts/ship/marscode-sync.ts [options]",
    "",
    "Options:",
    "  --dry-run             Plan and print actions without mutating worktree or targets",
    "  --force               Rebuild all eligible targets even if unchanged",
    "  --skip-build          Skip vp pack for prebuilt CLI bundles",
    "  --skip-stage          Skip ship-queue version stage/prune",
    "  --skip-app            Skip desktop AppImage target",
    "  --skip-fleet          Skip fleet rollout to configured SSH hosts",
    "  --fleet-config FILE   Path to local fleet-deploy.json (default: <prefix>/lib/marscode/fleet-deploy.json)",
    "  --only CSV            Comma-separated target IDs (e.g. ship-queue,app,fleet)",
    "  --primary DIR         Primary git repository path",
    "  --data-root DIR       Persistent data/worktree root for sync-worktree, state, and lock",
    "  --target-sha SHA      Git commit or ref to sync (defaults to SHIP_QUEUE_BASE_SHA or HEAD)",
    "  --prefix DIR          Install prefix (default: $HOME/.local)",
    "  --bin-dir DIR         Binary install dir (default: <prefix>/bin)",
    "  --lib-dir DIR         CLI bundle lib dir (default: <prefix>/lib/marscode-tools)",
    "  --queue-root DIR      ship-queue root (default: $HOME/.local/share/ship-queue)",
    "  --app-dir DIR         AppImage install dir (default: <data-root>/app)",
  ].join("\n");
}

function requireValue(argv: ReadonlyArray<string>, index: number, flag: string): string {
  const value = argv[index + 1];
  if (!value) {
    throw new Error(`marscode-sync: ${flag} requires an argument`);
  }
  return value;
}

function resolveDefaultPrimary(cwd: string): string {
  const fromEnv = process.env.SHIP_QUEUE_PRIMARY?.trim();
  if (fromEnv) return NodePath.resolve(fromEnv);
  const res = NodeChildProcess.spawnSync("git", ["rev-parse", "--show-toplevel"], {
    cwd,
    encoding: "utf8",
  });
  if (res.status === 0 && res.stdout.trim()) return NodePath.resolve(res.stdout.trim());
  return NodePath.resolve(cwd);
}

function readDeclaredWorktreeRoot(primary: string): string | undefined {
  try {
    const raw = NodeFS.readFileSync(NodePath.join(primary, ".tree-guard.conf"), "utf8");
    const match = /^\s*ship_worktree_root\s*=\s*(.+?)\s*$/m.exec(raw);
    return match?.[1]?.trim() || undefined;
  } catch {
    return undefined;
  }
}

export function resolveSafeDataRoot(primary: string, explicit?: string): string {
  const primaryReal = NodeFS.existsSync(primary)
    ? NodeFS.realpathSync(primary)
    : NodePath.resolve(primary);
  if (explicit) {
    const resolved = NodePath.resolve(explicit);
    if (!NodeFS.existsSync(resolved)) {
      throw new Error(`marscode-sync: --data-root does not exist: ${resolved}`);
    }
    const real = NodeFS.realpathSync(resolved);
    if (real === primaryReal || real.startsWith(`${primaryReal}${NodePath.sep}`)) {
      throw new Error(
        `marscode-sync: --data-root must be outside primary checkout (${primaryReal})`,
      );
    }
    NodeFS.accessSync(real, NodeFS.constants.W_OK);
    return real;
  }
  const candidates = [
    process.env.SHIP_QUEUE_WORKTREE_ROOT?.trim(),
    process.env.SHIP_QUEUE_DATA_ROOT?.trim(),
    readDeclaredWorktreeRoot(primary),
    NodeOS.tmpdir(),
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    const resolved = NodePath.resolve(candidate);
    if (!NodeFS.existsSync(resolved)) continue;
    const real = NodeFS.realpathSync(resolved);
    if (real === primaryReal || real.startsWith(`${primaryReal}${NodePath.sep}`)) continue;
    try {
      NodeFS.accessSync(real, NodeFS.constants.W_OK);
      return real;
    } catch {
      continue;
    }
  }
  return NodeOS.tmpdir();
}

export function parseCliArgs(argv: ReadonlyArray<string>, cwd = process.cwd()): SyncCliOptions {
  const home = NodeOS.homedir();
  let dryRun = false;
  let force = false;
  let skipBuild = false;
  let skipStage = false;
  let skipApp = false;
  let skipFleet = false;
  let fleetConfigArg = process.env.MARSCODE_FLEET_CONFIG?.trim() || undefined;
  let only: Set<string> | undefined;
  let primaryArg: string | undefined;
  let dataRootArg: string | undefined;
  let explicitTargetSha = false;
  let targetSha = process.env.SHIP_QUEUE_BASE_SHA?.trim() || undefined;
  const baseRef = process.env.SHIP_QUEUE_BASE_REF?.trim() || "origin/main";
  let prefixArg: string | undefined;
  let binDir: string | undefined;
  let libDir: string | undefined;
  let queueRoot =
    process.env.SHIP_QUEUE_ROOT?.trim() || NodePath.join(home, ".local", "share", "ship-queue");
  let appDir: string | undefined;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    switch (arg) {
      case "--dry-run":
        dryRun = true;
        break;
      case "--force":
        force = true;
        break;
      case "--skip-build":
        skipBuild = true;
        break;
      case "--skip-stage":
        skipStage = true;
        break;
      case "--skip-app":
        skipApp = true;
        break;
      case "--skip-fleet":
        skipFleet = true;
        break;
      case "--fleet-config":
        fleetConfigArg = NodePath.resolve(requireValue(argv, i, "--fleet-config"));
        i += 1;
        break;
      case "--only": {
        const raw = requireValue(argv, i, "--only");
        i += 1;
        only = new Set(
          raw
            .split(",")
            .map((s) => s.trim())
            .filter(Boolean),
        );
        break;
      }
      case "--primary":
        primaryArg = requireValue(argv, i, "--primary");
        i += 1;
        break;
      case "--data-root":
        dataRootArg = requireValue(argv, i, "--data-root");
        i += 1;
        break;
      case "--target-sha":
        targetSha = requireValue(argv, i, "--target-sha");
        explicitTargetSha = true;
        i += 1;
        break;
      case "--prefix":
        prefixArg = NodePath.resolve(requireValue(argv, i, "--prefix"));
        i += 1;
        break;
      case "--bin-dir":
        binDir = NodePath.resolve(requireValue(argv, i, "--bin-dir"));
        i += 1;
        break;
      case "--lib-dir":
        libDir = NodePath.resolve(requireValue(argv, i, "--lib-dir"));
        i += 1;
        break;
      case "--queue-root":
        queueRoot = NodePath.resolve(requireValue(argv, i, "--queue-root"));
        i += 1;
        break;
      case "--app-dir":
        appDir = NodePath.resolve(requireValue(argv, i, "--app-dir"));
        i += 1;
        break;
      case "-h":
      case "--help":
        process.stdout.write(`${formatUsage()}\n`);
        process.exit(0);
      default:
        throw new Error(`marscode-sync: unknown argument: ${arg}`);
    }
  }

  const primary = primaryArg ? NodePath.resolve(primaryArg) : resolveDefaultPrimary(cwd);
  const dataRoot = resolveSafeDataRoot(primary, dataRootArg);
  const prefix =
    prefixArg ??
    (binDir && NodePath.basename(binDir) === "bin"
      ? NodePath.dirname(binDir)
      : NodePath.join(home, ".local"));
  const resolvedBinDir = binDir ?? NodePath.join(prefix, "bin");
  if (binDir && resolvedBinDir !== NodePath.join(prefix, "bin")) {
    throw new Error(
      `marscode-sync: --bin-dir (${resolvedBinDir}) must equal <prefix>/bin (${NodePath.join(prefix, "bin")}) so host-guards installs into the same bin dir`,
    );
  }
  const resolvedLibDir = libDir ?? NodePath.join(prefix, "lib", "marscode-tools");
  const guardLibDir = libDir ?? NodePath.join(prefix, "lib");
  const resolvedAppDir = appDir ?? NodePath.join(dataRoot, "app");
  const resolvedFleetConfigPath =
    fleetConfigArg ?? NodePath.join(prefix, "lib", "marscode", "fleet-deploy.json");
  const rawBehind = Number.parseInt(process.env.SHIP_QUEUE_JOBS_BEHIND ?? "0", 10);
  const jobsBehind = Number.isFinite(rawBehind) && rawBehind > 0 ? rawBehind : 0;

  return {
    dryRun,
    force,
    skipBuild,
    skipStage,
    skipApp,
    skipFleet,
    fleetConfigPath: resolvedFleetConfigPath,
    only,
    primary,
    dataRoot,
    targetSha,
    explicitTargetSha,
    baseRef,
    prefix,
    binDir: resolvedBinDir,
    libDir: resolvedLibDir,
    guardLibDir,
    queueRoot,
    appDir: resolvedAppDir,
    jobsBehind,
  };
}
