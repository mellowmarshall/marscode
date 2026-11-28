// Rolls out built MarsCode artifacts to configured SSH hosts with per-host failure isolation.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodeFS from "node:fs";

import {
  ensureLinuxServerArchive,
  readDesktopVersionAtSha,
  utcDate,
} from "./marscode-sync-fleet-build.ts";
import {
  FLEET_ROLLOUT_TARGET_ID,
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
  buildLinuxStageProbeScript,
  buildMacDeployScript,
} from "./marscode-sync-fleet-scripts.ts";
import { runChecked, runCmd } from "./marscode-sync-install.ts";

const SSH_COMMON_ARGS = [
  "-o",
  "BatchMode=yes",
  "-o",
  "ConnectTimeout=5",
  "-o",
  "ServerAliveInterval=15",
  "-o",
  "ServerAliveCountMax=4",
] as const;
const LINUX_SSH_TIMEOUT_MS = 5 * 60_000;
const MAC_SSH_TIMEOUT_MS = 15 * 60_000;
const SSH_MAX_BUFFER = 8 * 1024 * 1024;

export type FleetHostOutcome =
  | { readonly status: "updated"; readonly version: string }
  | { readonly status: "deferred"; readonly reason: string }
  | { readonly status: "unreachable"; readonly detail: string }
  | { readonly status: "failed"; readonly detail: string };

export interface CommandResult {
  readonly status: number;
  readonly stdout: string;
  readonly stderr: string;
}

export interface CommandRunner {
  readonly runCmd: (
    command: string,
    args: ReadonlyArray<string>,
    options: {
      readonly cwd: string;
      readonly env?: Readonly<Record<string, string | undefined>>;
      readonly inheritStdio?: boolean;
      readonly input?: string | undefined;
      readonly timeoutMs?: number | undefined;
    },
  ) => CommandResult;
  readonly runChecked: typeof runChecked;
}

function runFleetCmd(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly inheritStdio?: boolean;
    readonly input?: string | undefined;
    readonly timeoutMs?: number | undefined;
  },
): CommandResult {
  if (options.input === undefined && options.timeoutMs === undefined) {
    return runCmd(command, args, options);
  }
  const res = NodeChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    input: options.input,
    timeout: options.timeoutMs,
    maxBuffer: SSH_MAX_BUFFER,
    stdio: options.inheritStdio ? "inherit" : "pipe",
  });
  if (res.error) {
    return { status: 1, stdout: res.stdout ?? "", stderr: res.error.message };
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

const DEFAULT_RUNNER: CommandRunner = { runCmd: runFleetCmd, runChecked };

/** Reads local fleet-deploy.json. Missing file is normal (returns []); bad JSON throws. */
export function readFleetConfig(configPath: string): ReadonlyArray<FleetHostConfig> {
  if (!NodeFS.existsSync(configPath)) return [];
  return parseFleetConfig(NodeFS.readFileSync(configPath, "utf8"));
}

/** Loads fleet hosts for a sync run; malformed config warns unless fleet was explicitly targeted. */
export function loadFleetHostsForSync(input: {
  readonly configPath: string;
  readonly skipFleet: boolean;
  readonly only?: ReadonlySet<string> | undefined;
  readonly warn: (message: string) => void;
}): ReadonlyArray<FleetHostConfig> {
  if (input.skipFleet) return [];
  try {
    return readFleetConfig(input.configPath);
  } catch (err) {
    const fleetOnly =
      input.only !== undefined &&
      (input.only.has("fleet") || input.only.has(FLEET_ROLLOUT_TARGET_ID));
    if (fleetOnly) throw err;
    input.warn(`marscode-sync: warning: ignoring invalid fleet config: ${String(err)}`);
    return [];
  }
}

export function formatFleetDryRunLines(
  planned: ReadonlyArray<FleetHostPlan>,
): ReadonlyArray<string> {
  return planned.map(({ host, decision }) => {
    const desc =
      decision.action === "build"
        ? `sync (${decision.reason})`
        : `skip (${decision.reason}${decision.detail ? `: ${decision.detail}` : ""})`;
    return `[dry-run] fleet ${host.name} (${host.kind}): ${desc}`;
  });
}

function parseRemoteOutcome(res: CommandResult, version: string): FleetHostOutcome {
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

/** Runs a POSIX shell script on `sshTarget` via `sh -s` on stdin so non-POSIX login shells work. */
function runRemotePosixScript(input: {
  readonly runner: CommandRunner;
  readonly sshTarget: string;
  readonly script: string;
  readonly cwd: string;
  readonly env: Readonly<Record<string, string>>;
  readonly timeoutMs: number;
}): CommandResult {
  return input.runner.runCmd("ssh", [...SSH_COMMON_ARGS, "--", input.sshTarget, "sh", "-s"], {
    cwd: input.cwd,
    env: input.env,
    input: `${input.script}\n`,
    timeoutMs: input.timeoutMs,
  });
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
  const headSha = assertValidSha(input.artifact.sha);
  const probeScript = buildLinuxStageProbeScript({ version, headSha, t3Home });
  const probe = runRemotePosixScript({
    runner,
    sshTarget: input.host.ssh,
    script: probeScript,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: 30_000,
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
      { cwd: input.cwd, env: input.env, timeoutMs: LINUX_SSH_TIMEOUT_MS },
    );
    if (copy.status !== 0) {
      return {
        status: copy.status === 255 ? "unreachable" : "failed",
        detail: `rsync failed (${copy.status}): ${copy.stderr.trim()}`,
      };
    }
  }

  const script = buildLinuxActivateScript({ version, headSha, t3Home, remoteArchivePath });
  const activate = runRemotePosixScript({
    runner,
    sshTarget: input.host.ssh,
    script,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: LINUX_SSH_TIMEOUT_MS,
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
  const res = runRemotePosixScript({
    runner,
    sshTarget: input.host.ssh,
    script,
    cwd: input.cwd,
    env: input.env,
    timeoutMs: MAC_SSH_TIMEOUT_MS,
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
  const runner = input.runner ?? DEFAULT_RUNNER;
  const toSync = input.planned.filter((entry) => entry.decision.action === "build");
  if (toSync.length === 0) return;

  let linuxArtifact: FleetArtifactRecord | undefined;
  if (input.needsLinuxBuild) {
    linuxArtifact = ensureLinuxServerArchive({
      primary: input.primary,
      worktree: input.worktree,
      dataRoot: input.dataRoot,
      headSha: input.headSha,
      previousArtifact: input.previousArtifact,
      env: input.env,
      log: input.log,
      date: input.date,
      runner,
    });
    input.onArtifactBuilt(linuxArtifact);
  }

  const macVersion =
    linuxArtifact?.version ??
    chooseFleetVersion({
      desktopVersion: readDesktopVersionAtSha({
        primary: input.primary,
        worktree: input.worktree,
        headSha: input.headSha,
        runner,
      }),
      previousVersion: input.previousArtifact?.version,
      date: input.date ?? utcDate(),
    });
  const sshCwd = NodeFS.existsSync(input.worktree) ? input.worktree : input.primary;

  for (const { host } of toSync) {
    let outcome: FleetHostOutcome;
    try {
      outcome =
        host.kind === "linux-x64-server"
          ? deployLinuxServerHost({
              host,
              artifact: linuxArtifact!,
              cwd: sshCwd,
              env: input.env,
              runner,
            })
          : deployMacAppHost({
              host,
              headSha: input.headSha,
              version: macVersion,
              cwd: sshCwd,
              env: input.env,
              runner,
            });
    } catch (err) {
      outcome = {
        status: "failed",
        detail: err instanceof Error ? err.message : String(err),
      };
    }

    if (outcome.status === "updated") {
      input.onHostSynced(host.name, { sha: input.headSha, version: outcome.version });
      input.log(`marscode-sync: fleet ${host.name} (${host.kind}): updated to ${outcome.version}`);
    } else if (outcome.status === "deferred") {
      const emit = outcome.reason === "sync_locked" ? input.warn : input.log;
      emit(
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
