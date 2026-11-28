// @effect-diagnostics nodeBuiltinImport:off - Verifies a peer process is the installed `ship-queue submit <worktree> <branch>` for one job.
import * as NodePath from "node:path";

import { defaultProcFs, readProcArgv, type ProcFsReader } from "./procFs.ts";
import {
  buildTrustedQueueRoots,
  hasUnsafeWorkerEnv,
  isUnderTrustedRoot,
  isUntrustedPath,
  TRUSTED_QUEUE_SCRIPT_BASENAMES,
} from "./t3ServerTrust.ts";

/**
 * Same uid, a clean environment, and the installed ship-queue entry running exactly
 * `submit <worktree> <branch> ...` whose worktree (from the process's own cwd) is `worktree`.
 * It runs inside an agent shell, so unlike the worker check it ignores cgroup and ancestry.
 */
export function isTrustedShipQueueSubmit(
  pid: number,
  input: { readonly queueRoot: string; readonly worktree: string; readonly branch: string },
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  const procSt = procFs.stat(`/proc/${pid}`);
  if (!procSt || procSt.uid !== procFs.currentUid()) return false;
  if (hasUnsafeWorkerEnv(pid, procFs)) return false;
  const rawExe = procFs.readLink(`/proc/${pid}/exe`);
  if (!rawExe || rawExe.endsWith(" (deleted)") || isUntrustedPath(rawExe)) return false;
  const argv = readProcArgv(pid, procFs);
  const trustedRoots = buildTrustedQueueRoots(input.queueRoot, procFs);
  const exeBase = NodePath.basename(rawExe).toLowerCase();
  let rest: ReadonlyArray<string>;
  if (exeBase === "node" || exeBase === "bun") {
    const script = procFs.realpath(argv[1] ?? "");
    if (
      !isUnderTrustedRoot(script, trustedRoots) ||
      !TRUSTED_QUEUE_SCRIPT_BASENAMES.has(NodePath.basename(script))
    ) {
      return false;
    }
    rest = argv.slice(2);
  } else if (
    exeBase === "ship-queue" &&
    isUnderTrustedRoot(procFs.realpath(rawExe), trustedRoots)
  ) {
    rest = argv.slice(1);
  } else {
    return false;
  }
  const [sub, worktreeArg, branchArg] = rest.filter((a) => a !== "--no-start");
  if (sub !== "submit" || !worktreeArg || branchArg !== input.branch) return false;
  const procCwd = procFs.readLink(`/proc/${pid}/cwd`);
  if (!procCwd) return false;
  return procFs.realpath(NodePath.resolve(procCwd, worktreeArg)) === input.worktree;
}
