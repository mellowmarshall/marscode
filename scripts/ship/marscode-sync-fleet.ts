// Builds the shared linux-x64 server archive once and rolls out MarsCode to configured SSH hosts.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodePath from "node:path";

import {
  chooseFleetVersion,
  parseFleetConfig,
  type FleetArtifactRecord,
  type FleetHostConfig,
  type FleetHostPlan,
  type FleetHostSyncRecord,
} from "./marscode-sync-fleet-config.ts";
import {
  assertValidSha,
  assertValidVersion,
  buildLinuxActivateScript,
  buildMacDeployScript,
  remotePathExpr,
  shellSingleQuote,
} from "./marscode-sync-fleet-scripts.ts";
import { runChecked, runCmd } from "./marscode-sync-install.ts";

const RESOURCE_MONITOR_TARGET = "x86_64-unknown-linux-gnu";
const SSH_COMMON_ARGS = ["-o", "BatchMode=yes", "-o", "ConnectTimeout=5"] as const;
const RELEASE_PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

export type FleetHostOutcome =
  | { readonly status: "updated"; readonly version: string }
  | { readonly status: "deferred"; readonly reason: string }
  | { readonly status: "unreachable"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string };

export interface CommandRunner {
  readonly runCmd: typeof runCmd;
  readonly runChecked: typeof runChecked;
}

const DEFAULT_RUNNER: CommandRunner = { runCmd, runChecked };

/** Reads local fleet-deploy.json. Missing file is normal (returns []); bad JSON throws. */
export function readFleetConfig(configPath: string): ReadonlyArray<FleetHostConfig> {
  if (!NodeFS.existsSync(configPath)) return [];
  return parseFleetConfig(NodeFS.readFileSync(configPath, "utf8"));
}

function utcDate(): string {
  // @effect-diagnostics-next-line globalDate:off -- standalone post-merge script has no Effect clock (#81).
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

function readDesktopVersion(worktree: string): string {
  const manifestPath = NodePath.join(worktree, "apps/desktop/package.json");
  return (JSON.parse(NodeFS.readFileSync(manifestPath, "utf8")) as { version: string }).version;
}

/**
 * Builds and smoke-tests the linux-x64 standalone t3 archive once per commit and caches it under
 * `<dataRoot>/fleet-artifacts/<headSha>/` so deferred or offline hosts do not trigger rebuilds.
 */
export function ensureLinuxServerArchive(input: {
  readonly worktree: string;
  readonly dataRoot: string;
  readonly headSha: string;
  readonly previousArtifact?: FleetArtifactRecord | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
  readonly date?: string | undefined;
  readonly runner?: CommandRunner | undefined;
}): FleetArtifactRecord {
  const runner = input.runner ?? DEFAULT_RUNNER;
  const sha = assertValidSha(input.headSha);
  if (
    input.previousArtifact?.sha === sha &&
    NodeFS.existsSync(input.previousArtifact.archivePath)
  ) {
    input.log(
      `marscode-sync: reusing cached linux-x64 archive ${input.previousArtifact.version} at ${sha.slice(0, 10)}`,
    );
    return input.previousArtifact;
  }

  const version = assertValidVersion(
    chooseFleetVersion({
      desktopVersion: readDesktopVersion(input.worktree),
      previousVersion: input.previousArtifact?.version,
      date: input.date ?? utcDate(),
    }),
  );

  const artifactsRoot = NodePath.join(input.dataRoot, "fleet-artifacts");
  const outDir = NodePath.join(artifactsRoot, sha);
  const stagingDir = NodePath.join(artifactsRoot, `.staging-${sha}-${process.pid}`);
  NodeFS.mkdirSync(stagingDir, { recursive: true });

  const runInWorktree = (command: string, args: ReadonlyArray<string>) =>
    runner.runChecked(command, args, { cwd: input.worktree, env: input.env, inheritStdio: true });

  try {
    try {
      runInWorktree("node", ["scripts/update-release-package-versions.ts", version]);
      runInWorktree("vp", ["run", "--filter", "t3", "build"]);
      runInWorktree("node", [
        "scripts/apply-web-brand-assets.ts",
        "nightly",
        "apps/server/dist/client",
      ]);
      runInWorktree("node", ["apps/server/scripts/cli.ts", "build-exe"]);
      runInWorktree("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        "native/resource-monitor/Cargo.toml",
        "--target",
        RESOURCE_MONITOR_TARGET,
      ]);
      const monitorDir = NodePath.join(stagingDir, "resource-monitor");
      NodeFS.mkdirSync(monitorDir, { recursive: true });
      NodeFS.copyFileSync(
        NodePath.join(
          input.worktree,
          "native/resource-monitor/target",
          RESOURCE_MONITOR_TARGET,
          "release/t3-resource-monitor",
        ),
        NodePath.join(monitorDir, "t3-resource-monitor"),
      );
      runInWorktree("node", [
        "scripts/build-cli-archive.ts",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        version,
        "--output-dir",
        stagingDir,
        "--resource-monitor-dir",
        monitorDir,
      ]);
    } finally {
      runner.runCmd("git", ["-C", input.worktree, "checkout", "--", ...RELEASE_PACKAGE_FILES], {
        cwd: input.worktree,
      });
    }

    const archiveName = `t3-${version}-linux-x64.tar.gz`;
    const stagedArchive = NodePath.join(stagingDir, archiveName);
    if (!NodeFS.existsSync(stagedArchive)) {
      throw new Error(`marscode-sync: built archive missing at ${stagedArchive}`);
    }
    runInWorktree("node", [
      "scripts/smoke-cli-archive.ts",
      "--archive",
      stagedArchive,
      "--expect-version",
      version,
    ]);

    NodeFS.rmSync(outDir, { recursive: true, force: true });
    NodeFS.mkdirSync(outDir, { recursive: true });
    const finalArchive = NodePath.join(outDir, archiveName);
    NodeFS.renameSync(stagedArchive, finalArchive);

    // Keep only the current commit's archive so fleet-artifacts never grows unbounded.
    for (const entry of NodeFS.readdirSync(artifactsRoot)) {
      if (entry !== sha && !entry.startsWith(".staging-")) {
        NodeFS.rmSync(NodePath.join(artifactsRoot, entry), { recursive: true, force: true });
      }
    }

    return { sha, version, archivePath: finalArchive };
  } finally {
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
  }
}

function parseRemoteOutcome(
  res: { readonly status: number; readonly stdout: string; readonly stderr: string },
  version: string,
): FleetHostOutcome {
  if (res.status === 255) {
    return { status: "unreachable", detail: res.stderr.trim() || "ssh connection failed" };
  }
  const lines = res.stdout.split(/\r?\n/).map((line) => line.trim());
  const deferred = lines.find((line) => line.startsWith("DEFERRED "));
  if (res.status === 0 && deferred) {
    return { status: "deferred", reason: deferred.slice("DEFERRED ".length) };
  }
  if (res.status === 0 && lines.some((line) => line.startsWith("ACTIVATED "))) {
    return { status: "updated", version };
  }
  return {
    status: "failed",
    detail: `${res.stderr}\n${res.stdout}`.trim() || `remote script exited ${res.status}`,
  };
}

/** Stages a prebuilt linux-x64 archive over SSH/rsync and activates it if the host is idle. */
export function deployLinuxServerHost(input: {
  readonly host: FleetHostConfig;
  readonly artifact: FleetArtifactRecord;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly runner?: CommandRunner | undefined;
}): FleetHostOutcome {
  const runner = input.runner ?? DEFAULT_RUNNER;
  const t3Home = input.host.t3Home ?? "~/.t3";
  const version = assertValidVersion(input.artifact.version);
  const probeScript = [
    `T3_HOME=${remotePathExpr(t3Home)}`,
    `TARGET="$T3_HOME/runtime/versions"/${shellSingleQuote(version)}`,
    `if [ -x "$TARGET/t3" ] && [ "$(cat "$TARGET/.install-complete" 2>/dev/null || true)" = ${shellSingleQuote(version)} ]; then echo STAGED; else echo NEED_STAGE; fi`,
  ].join("; ");

  const probe = runner.runCmd("ssh", [...SSH_COMMON_ARGS, "--", input.host.ssh, probeScript], {
    cwd: input.cwd,
    env: input.env,
  });
  if (probe.status !== 0) {
    return probe.status === 255
      ? { status: "unreachable", detail: probe.stderr.trim() || "ssh unreachable" }
      : { status: "failed", detail: probe.stderr.trim() || `probe exited ${probe.status}` };
  }

  let remoteArchivePath: string | undefined;
  if (!probe.stdout.split(/\r?\n/).includes("STAGED")) {
    remoteArchivePath = `/tmp/marscode-t3-${version}-${process.pid}.tar.gz`;
    const copy = runner.runCmd(
      "rsync",
      [
        "-az",
        "--timeout=60",
        "-e",
        `ssh ${SSH_COMMON_ARGS.join(" ")}`,
        input.artifact.archivePath,
        `${input.host.ssh}:${remoteArchivePath}`,
      ],
      { cwd: input.cwd, env: input.env },
    );
    if (copy.status !== 0) {
      return {
        status: copy.status === 255 ? "unreachable" : "failed",
        detail: `rsync failed (${copy.status}): ${copy.stderr.trim()}`,
      };
    }
  }

  const script = buildLinuxActivateScript({ version, t3Home, remoteArchivePath });
  const activate = runner.runCmd("ssh", [...SSH_COMMON_ARGS, "--", input.host.ssh, script], {
    cwd: input.cwd,
    env: input.env,
  });
  return parseRemoteOutcome(activate, version);
}

/** Triggers a local ARM64 build and idle-gated swap on a macOS host over SSH. */
export function deployMacAppHost(input: {
  readonly host: FleetHostConfig;
  readonly headSha: string;
  readonly version: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly runner?: CommandRunner | undefined;
}): FleetHostOutcome {
  const runner = input.runner ?? DEFAULT_RUNNER;
  const script = buildMacDeployScript({
    headSha: input.headSha,
    version: input.version,
    repo: input.host.repo ?? "~/Dev/marscode",
    dataRoot: input.host.dataRoot ?? "~/.local/share/marscode-sync",
    appPath: input.host.appPath ?? "/Applications/T3 Code (Nightly).app",
    t3Home: input.host.t3Home ?? "~/.t3",
  });
  const res = runner.runCmd("ssh", [...SSH_COMMON_ARGS, "--", input.host.ssh, script], {
    cwd: input.cwd,
    env: input.env,
  });
  return parseRemoteOutcome(res, input.version);
}

/** Runs planned fleet sync steps, isolating per-host failures so one offline machine never blocks others. */
export function runFleetSync(input: {
  readonly planned: ReadonlyArray<FleetHostPlan>;
  readonly needsLinuxBuild: boolean;
  readonly primary: string;
  readonly worktree: string;
  readonly dataRoot: string;
  readonly headSha: string;
  readonly previousArtifact?: FleetArtifactRecord | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
  readonly warn: (message: string) => void;
  readonly onArtifactBuilt: (artifact: FleetArtifactRecord) => void;
  readonly onHostSynced: (hostName: string, record: FleetHostSyncRecord) => void;
  readonly date?: string | undefined;
  readonly runner?: CommandRunner | undefined;
}): void {
  const toSync = input.planned.filter((entry) => entry.decision.action === "build");
  if (toSync.length === 0) return;

  let linuxArtifact: FleetArtifactRecord | undefined;
  if (input.needsLinuxBuild) {
    linuxArtifact = ensureLinuxServerArchive({
      worktree: input.worktree,
      dataRoot: input.dataRoot,
      headSha: input.headSha,
      previousArtifact: input.previousArtifact,
      env: input.env,
      log: input.log,
      date: input.date,
      runner: input.runner,
    });
    input.onArtifactBuilt(linuxArtifact);
  }

  const versionRoot = NodeFS.existsSync(NodePath.join(input.worktree, "apps/desktop/package.json"))
    ? input.worktree
    : input.primary;
  const macVersion =
    linuxArtifact?.version ??
    chooseFleetVersion({
      desktopVersion: readDesktopVersion(versionRoot),
      previousVersion: input.previousArtifact?.version,
      date: input.date ?? utcDate(),
    });
  const sshCwd = NodeFS.existsSync(input.worktree) ? input.worktree : input.primary;

  for (const { host } of toSync) {
    const outcome =
      host.kind === "linux-x64-server"
        ? deployLinuxServerHost({
            host,
            artifact: linuxArtifact!,
            cwd: sshCwd,
            env: input.env,
            runner: input.runner,
          })
        : deployMacAppHost({
            host,
            headSha: input.headSha,
            version: macVersion,
            cwd: sshCwd,
            env: input.env,
            runner: input.runner,
          });

    if (outcome.status === "updated") {
      input.onHostSynced(host.name, { sha: input.headSha, version: outcome.version });
      input.log(`marscode-sync: fleet ${host.name} (${host.kind}): updated to ${outcome.version}`);
    } else if (outcome.status === "deferred") {
      input.log(
        `marscode-sync: fleet ${host.name} (${host.kind}): staged; deferred (${outcome.reason})`,
      );
    } else if (outcome.status === "unreachable") {
      input.warn(
        `marscode-sync: fleet ${host.name} (${host.kind}): unreachable (${outcome.detail}); will retry next sync`,
      );
    } else {
      input.warn(
        `marscode-sync: fleet ${host.name} (${host.kind}): failed (${outcome.detail}); will retry next sync`,
      );
    }
  }
}
