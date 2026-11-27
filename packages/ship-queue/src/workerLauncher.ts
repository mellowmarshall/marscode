// @effect-diagnostics nodeBuiltinImport:off - Starts the queue worker outside its caller's lifecycle: closing MarsCode or the CLI never stops a job.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { liveWorker, type IsAlive } from "./processLocks.ts";

export interface LaunchInput {
  readonly root: string;
  /** The `ship-queue` CLI entry the worker runs as `<cliPath> work`. */
  readonly cliPath: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly isAlive: IsAlive;
  readonly platform: NodeJS.Platform;
  readonly nodePath?: string | undefined;
}

export type LaunchResult =
  | { readonly kind: "already-running"; readonly pid: number }
  | {
      readonly kind: "spawned";
      readonly via: "systemd-scope" | "detached";
      readonly launcherPid: number;
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

/**
 * Its own session (`detached`), no inherited stdio, and unref'd: the parent's exit sends it no
 * SIGHUP and leaves no pipe to break. Job state lives on disk, so any later process reattaches.
 */
export function launchDetachedWorker(input: LaunchInput): LaunchResult {
  const running = liveWorker(input.root, input.isAlive);
  if (running) return { kind: "already-running", pid: running.pid };
  const node = input.nodePath ?? process.execPath;
  const env = { ...input.env, SHIP_QUEUE_ROOT: input.root };
  const systemdRun = systemdScopeRunner(input.platform, input.env);
  const [command, args] = systemdRun
    ? [systemdRun, ["--user", "--scope", "--quiet", "--collect", "--", node, input.cliPath, "work"]]
    : [node, [input.cliPath, "work"]];
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
  };
}
