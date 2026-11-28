// @effect-diagnostics nodeBuiltinImport:off - Starts version-pinned queue workers outside the caller's lifecycle: upgrades never block on draining older workers.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isEnded, readJob, updateJob } from "./jobStore.ts";
import { liveWorker, liveWorkerForVersion, type IsAlive } from "./processLocks.ts";
import {
  isSafeVersionId,
  readCurrentWorkerVersion,
  resolveCurrentWorkerVersion,
  validateWorkerEntryForVersion,
  type WorkerRuntimeVersion,
} from "./workerVersion.ts";

export interface LaunchInput {
  readonly root: string;
  /** The `ship-queue` CLI entry the worker runs as `<cliPath> work` when no staged version overrides it. */
  readonly cliPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isAlive: IsAlive;
  readonly platform: NodeJS.Platform;
  readonly nodePath?: string | undefined;
  /** Optional job id being launched: records or re-pins `worker_version` + `worker_entry` at spawn time. */
  readonly jobId?: string | undefined;
  /** Explicit runtime version to pin/spawn instead of resolving `<root>/versions/current.json`. */
  readonly workerVersion?: WorkerRuntimeVersion | undefined;
}

export type LaunchResult =
  | {
      readonly kind: "already-running";
      readonly pid: number;
      readonly version: string;
      readonly entryPath: string;
    }
  | {
      readonly kind: "spawned";
      readonly via: "systemd-scope" | "detached";
      readonly launcherPid: number;
      readonly version: string;
      readonly entryPath: string;
    };

function onPath(binary: string, env: Readonly<Record<string, string | undefined>>): string | null {
  for (const dir of (env.PATH ?? "").split(NodePath.delimiter)) {
    if (!dir) continue;
    const candidate = NodePath.join(dir, binary);
    try {
      NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
      return candidate;
    } catch {
      // next
    }
  }
  return null;
}

/**
 * A transient `systemd-run --user --scope` moves the worker out of the caller's cgroup, so a
 * desktop or service manager stopping MarsCode's unit cannot take the worker with it.
 */
function systemdScopeRunner(
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
): string | null {
  if (platform !== "linux" || env.SHIP_QUEUE_NO_SYSTEMD === "1") return null;
  const runtimeDir = env.XDG_RUNTIME_DIR;
  if (!runtimeDir || !NodeFS.existsSync(NodePath.join(runtimeDir, "systemd", "private")))
    return null;
  return onPath("systemd-run", env);
}

function resolveTargetVersion(input: LaunchInput): WorkerRuntimeVersion {
  if (input.workerVersion) {
    const verified = validateWorkerEntryForVersion({
      root: input.root,
      version: input.workerVersion.version,
      entryPath: input.workerVersion.entryPath,
      allowedEntryPath: input.cliPath,
    });
    if (!verified) {
      throw new Error(
        `Refused unsafe worker runtime version ${JSON.stringify(input.workerVersion.version)} entry ${JSON.stringify(input.workerVersion.entryPath)}`,
      );
    }
    return { version: input.workerVersion.version, entryPath: verified };
  }
  if (input.jobId) {
    const job = readJob(input.root, input.jobId);
    if (job && !isEnded(job) && job.worker_version && job.worker_entry) {
      const verified = validateWorkerEntryForVersion({
        root: input.root,
        version: job.worker_version,
        entryPath: job.worker_entry,
        allowedEntryPath: input.cliPath,
      });
      if (verified) {
        return { version: job.worker_version, entryPath: verified };
      }
    }
  }
  return resolveCurrentWorkerVersion({
    root: input.root,
    fallbackCliPath: input.cliPath,
    env: input.env,
  });
}

/**
 * Checks whether a live worker matching `jobId`'s target version is running.
 * Unpinned jobs target the current staged version (never satisfied by an older version worker),
 * and jobs whose pinned entrypoint is missing on disk trigger relaunch/re-pinning.
 */
export function hasLiveWorkerForJob(input: {
  readonly root: string;
  readonly jobId: string;
  readonly isAlive: IsAlive;
  readonly fallbackCliPath?: string | undefined;
}): boolean {
  const job = readJob(input.root, input.jobId);
  if (job?.worker_version) {
    if (!isSafeVersionId(job.worker_version)) return false;
    if (liveWorkerForVersion(input.root, job.worker_version, input.isAlive)) return true;
    return false;
  }
  const current = readCurrentWorkerVersion(input.root, input.fallbackCliPath);
  if (current) {
    return liveWorkerForVersion(input.root, current.version, input.isAlive) !== null;
  }
  return liveWorker(input.root, input.isAlive) !== null;
}

/**
 * Spawns a detached, version-pinned worker (`workers/<version>.json`). An in-flight worker on an
 * older version never blocks spawning a new worker on the latest version for newly submitted jobs.
 * Re-pins `jobId` to `target` when unpinned or when its previously pinned `worker_entry` is missing/unsafe.
 */
export function launchDetachedWorker(input: LaunchInput): LaunchResult {
  const target = resolveTargetVersion(input);
  if (input.jobId) {
    const job = readJob(input.root, input.jobId);
    if (
      job &&
      !isEnded(job) &&
      (job.worker_version !== target.version || job.worker_entry !== target.entryPath)
    ) {
      updateJob(input.root, input.jobId, {
        worker_version: target.version,
        worker_entry: target.entryPath,
      });
    }
  }

  const running = liveWorkerForVersion(input.root, target.version, input.isAlive);
  if (running) {
    return {
      kind: "already-running",
      pid: running.pid,
      version: target.version,
      entryPath: target.entryPath,
    };
  }

  const node = input.nodePath ?? process.execPath;
  const env: Record<string, string | undefined> = {
    ...input.env,
    SHIP_QUEUE_ROOT: input.root,
    SHIP_QUEUE_WORKER_VERSION: target.version,
    SHIP_QUEUE_WORKER_ENTRY: target.entryPath,
  };
  const systemdRun = systemdScopeRunner(input.platform, input.env);
  const workerArgv = systemdRun
    ? [
        systemdRun,
        "--user",
        "--scope",
        "--quiet",
        "--collect",
        "--",
        node,
        target.entryPath,
        "work",
      ]
    : [node, target.entryPath, "work"];
  // `setsid --fork` returns at once, so the worker never stays a child of the caller (a `watch`
  // inside an agent shell). Host guards trust the queue worker only outside agent ancestry.
  const setsid = input.platform === "linux" ? onPath("setsid", input.env) : null;
  const [command, args] = setsid
    ? [setsid, ["--fork", ...workerArgv]]
    : [workerArgv[0]!, workerArgv.slice(1)];
  const child = NodeChildProcess.spawn(command, args, {
    detached: true,
    stdio: "ignore",
    env,
    cwd: input.root,
  });
  child.unref();
  return {
    kind: "spawned",
    via: systemdRun ? "systemd-scope" : "detached",
    launcherPid: child.pid ?? 0,
    version: target.version,
    entryPath: target.entryPath,
  };
}
