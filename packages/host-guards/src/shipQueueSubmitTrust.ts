// @effect-diagnostics nodeBuiltinImport:off - Verifies a peer process is the installed `ship-queue submit <worktree> <branch>` for one job.
import * as NodeCrypto from "node:crypto";
import * as NodePath from "node:path";

import { defaultProcFs, readProcArgv, type ProcFsReader } from "./procFs.ts";
import { hasUnsafeWorkerEnv, isUntrustedPath } from "./t3ServerTrust.ts";

export interface InstalledShipQueue {
  /** Canonical node binary the installer pinned in the wrapper. */
  readonly nodeBin: string;
  /** Canonical entry script the wrapper runs. */
  readonly script: string;
}

function unquoteShell(word: string): string | null {
  const m = /^'((?:[^']|'\\'')*)'$/.exec(word);
  return m ? m[1]!.replace(/'\\''/g, "'") : null;
}

/** Where `marscode-sync` writes the `ship-queue` wrapper (`<prefix>/bin`, default prefix `~/.local`). */
function wrapperCandidates(procFs: ProcFsReader): ReadonlyArray<string> {
  const home = procFs.canonicalHome();
  return [
    ...(home ? [NodePath.join(home, ".local", "bin", "ship-queue")] : []),
    "/usr/local/bin/ship-queue",
  ];
}

/**
 * Reads the installed wrapper exactly as `atomicInstallNodeCli` writes it: a pinned
 * `node_bin='<abs>'` and `exec "$node_bin" '<abs script>' "$@"`. Any other shape is untrusted,
 * including the wrapper's `command -v node` fallback.
 */
export function readInstalledShipQueue(procFs: ProcFsReader): InstalledShipQueue | null {
  for (const wrapper of wrapperCandidates(procFs)) {
    const st = procFs.lstat(wrapper);
    if (!st || !st.isFile || st.uid !== procFs.currentUid() || (st.mode & 0o022) !== 0) continue;
    const text = procFs.readText(wrapper);
    if (!text) continue;
    const nodeLine = /^node_bin=('.*')$/m.exec(text)?.[1];
    const execLine = /^exec "\$node_bin" ('.*') "\$@"$/m.exec(text)?.[1];
    const nodeBin = nodeLine ? unquoteShell(nodeLine) : null;
    const script = execLine ? unquoteShell(execLine) : null;
    if (!nodeBin || !script || !NodePath.isAbsolute(nodeBin) || !NodePath.isAbsolute(script)) {
      continue;
    }
    const realNode = procFs.realpath(nodeBin);
    const realScript = procFs.realpath(script);
    if (!realNode || !realScript || isUntrustedPath(realNode) || isUntrustedPath(realScript)) {
      continue;
    }
    return { nodeBin: realNode, script: realScript };
  }
  return null;
}

function sha256Of(path: string, procFs: ProcFsReader): string | null {
  const text = procFs.readText(path);
  return text === null ? null : NodeCrypto.createHash("sha256").update(text).digest("hex");
}

/** The installer stages the same bundle as the queue's current version; both must hash alike. */
function matchesStagedVersion(script: string, queueRoot: string, procFs: ProcFsReader): boolean {
  const pointer = procFs.readText(NodePath.join(queueRoot, "versions", "current.json"));
  if (!pointer) return false;
  let entryPath = "";
  try {
    const parsed = JSON.parse(pointer) as { entryPath?: unknown };
    entryPath = typeof parsed.entryPath === "string" ? parsed.entryPath : "";
  } catch {
    return false;
  }
  const versionsDir = `${procFs.realpath(NodePath.join(queueRoot, "versions"))}/`;
  const entry = procFs.realpath(entryPath);
  if (!entry || versionsDir === "/" || !entry.startsWith(versionsDir)) return false;
  const want = sha256Of(entry, procFs);
  return want !== null && sha256Of(script, procFs) === want;
}

/**
 * The installer's pinned node running its script (hashing like the staged version) as
 * `submit <worktree> <branch>`, from a clean env. The wrapper, script and versions are writable by
 * this uid, so this stops other threads' stray processes, not a same-uid attacker.
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
  const installed = readInstalledShipQueue(procFs);
  if (!installed || procFs.realpath(rawExe) !== installed.nodeBin) return false;
  const argv = readProcArgv(pid, procFs);
  if (!argv[1] || procFs.realpath(argv[1]) !== installed.script) return false;
  if (!matchesStagedVersion(installed.script, input.queueRoot, procFs)) return false;
  const [sub, worktreeArg, branchArg] = argv.slice(2).filter((a) => a !== "--no-start");
  if (sub !== "submit" || !worktreeArg || branchArg !== input.branch) return false;
  const procCwd = procFs.readLink(`/proc/${pid}/cwd`);
  if (!procCwd) return false;
  return procFs.realpath(NodePath.resolve(procCwd, worktreeArg)) === input.worktree;
}
