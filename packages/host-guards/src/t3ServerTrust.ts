// @effect-diagnostics nodeBuiltinImport:off - Verified MarsCode/T3 server PID, AppImage-safe exe checks, thread attribution, and hardened ship-queue daemon ancestry.
import * as NodePath from "node:path";
import { AGENT_THREAD_ENV } from "@t3tools/shared/procIdentity";

import { isTempPath, TEST_TMP_PREFIXES } from "./hostConfig.ts";
import {
  defaultProcFs,
  isReadOnlyAppImageMount,
  isUnsafeEnvEntry,
  listAncestorsWithComm,
  readProcArgv,
  readProcCgroup,
  readProcEnvVar,
  readProcStat,
  verifyServerOwnsSocket,
  type ProcFsReader,
} from "./procFs.ts";
import {
  isAgentCgroup,
  isAgentProcess,
  isExplicitAgentCgroup,
  isTransientServiceCgroup,
} from "./procIdentity.ts";

const WORKER_EXTRA_UNSAFE_ENV_KEYS = new Set([
  "NODE_OPTIONS",
  "NODE_PATH",
  "NODE_EXTRA_CA_CERTS",
  "BASH_ENV",
  "SHELLOPTS",
  "BASHOPTS",
]);
const WORKER_EXTRA_UNSAFE_ENV_PREFIXES: ReadonlyArray<string> = ["BASH_FUNC_"];

const T3_CODEX_SCOPE_RE =
  /\/app-t3code-agents(?:-[0-9a-f]+)?\.slice\/t3code-codex-[A-Za-z0-9_.-]+\.scope(?:\s|$)/;
const UNTRUSTED_EXE_PREFIXES = [...TEST_TMP_PREFIXES, "/dev/shm/"];
const TRUSTED_QUEUE_SCRIPT_BASENAMES: ReadonlySet<string> = new Set([
  "bin.mjs",
  "cli.mjs",
  "ship-queue.mjs",
  "ship-queue",
]);
const TRUSTED_QUEUE_SUBCOMMANDS = new Set(["work", "daemon"]);

function extractAppImageMountRoot(exePath: string): string | null {
  const match = /^(\/tmp\/\.mount_[^/]+)(?:\/|$)/.exec(exePath);
  return match?.[1] ?? null;
}

export function isUntrustedPath(filePath: string): boolean {
  return UNTRUSTED_EXE_PREFIXES.some((prefix) => filePath.startsWith(prefix));
}

function isServerScriptArg(arg: string): boolean {
  return (
    arg.endsWith("/apps/server/dist/bin.mjs") ||
    arg.endsWith("/apps/server/dist/bin.js") ||
    arg.endsWith("/apps/server/src/bin.ts")
  );
}

/**
 * Verifies a live MarsCode/T3 server PID: same UID, non-agent cgroup, trusted exe
 * (any RO `/tmp/.mount_*` AppImage running `/apps/server/dist/bin.mjs`, non-tmp `t3code`/`marscode`/`t3 serve`, or `node`/`bun`/`electron`), and optional socket ownership.
 */
export function isTrustedT3ServerProcess(
  pid: number,
  options?: {
    readonly procFs?: ProcFsReader | undefined;
    readonly socketPath?: string | undefined;
  },
): boolean {
  const procFs = options?.procFs ?? defaultProcFs;
  const procStat = procFs.stat(`/proc/${pid}`);
  if (!procStat || procStat.uid !== procFs.currentUid()) return false;
  const rawExe = procFs.readLink(`/proc/${pid}/exe`);
  if (!rawExe) return false;
  const exe = rawExe.replace(/ \(deleted\)$/, "");
  if (!exe) return false;

  const cg = readProcCgroup(pid, procFs);
  if (isAgentCgroup(cg) || cg.includes("app-t3code-agents") || cg.includes("t3code-")) {
    return false;
  }
  if (isAgentProcess({ startPid: pid, procFs })) {
    return false;
  }

  const exeBase = NodePath.basename(exe).toLowerCase();
  const argv = readProcArgv(pid, procFs);
  let exeOk = false;

  const appImageRoot = extractAppImageMountRoot(exe);
  if (appImageRoot) {
    exeOk =
      isReadOnlyAppImageMount(appImageRoot, procFs) &&
      argv.slice(1).some((arg) => arg.endsWith("/apps/server/dist/bin.mjs"));
  } else if (exeBase === "t3code" || exeBase === "marscode") {
    exeOk = !isUntrustedPath(exe);
  } else if (exeBase === "t3" && !isUntrustedPath(exe)) {
    const rest = argv.slice(1);
    exeOk =
      rest.length >= 1 &&
      (rest[0] === "serve" || rest[0] === "start") &&
      !rest.some((a) => a === "--help" || a === "-h" || a === "--version" || a === "-v");
  } else if (
    (exeBase === "node" || exeBase === "bun" || exeBase === "electron") &&
    !isUntrustedPath(exe)
  ) {
    exeOk = argv
      .slice(1)
      .some((arg) => isServerScriptArg(arg) && !isUntrustedPath(procFs.realpath(arg)));
  }

  if (!exeOk) return false;
  if (options?.socketPath) {
    return verifyServerOwnsSocket(pid, options.socketPath, procFs);
  }
  return true;
}

/**
 * Resolves the verified live MarsCode/T3 server PID strictly from OS passwd home
 * `~/.t3/userdata/server-runtime.json`. Never reads caller-controlled HOME or T3CODE_HOME.
 */
export function resolveT3ServerPid(options?: {
  readonly procFs?: ProcFsReader | undefined;
  readonly socketPath?: string | undefined;
}): number | null {
  const procFs = options?.procFs ?? defaultProcFs;
  const canon = procFs.canonicalHome();
  if (!canon) return null;

  const runtimePath = NodePath.join(canon, ".t3", "userdata", "server-runtime.json");
  const realRuntime = procFs.realpath(runtimePath);
  if (isTempPath(realRuntime)) return null;

  const uid = procFs.currentUid();
  const st = procFs.lstat(realRuntime);
  if (!st || !st.isFile || st.uid !== uid || (st.mode & 0o077) !== 0) return null;

  const text = procFs.readText(realRuntime);
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { pid?: unknown };
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) return null;
    if (
      !procFs.hasProc() ||
      isTrustedT3ServerProcess(pid, { procFs, socketPath: options?.socketPath })
    ) {
      return pid;
    }
  } catch {
    // Malformed runtime JSON fails closed.
  }
  return null;
}

function isCodexAppServer(pid: number, procFs: ProcFsReader): boolean {
  const st = procFs.stat(`/proc/${pid}`);
  if (!st || st.uid !== procFs.currentUid()) return false;
  if (T3_CODEX_SCOPE_RE.test(readProcCgroup(pid, procFs))) return true;
  const argv = readProcArgv(pid, procFs);
  if (
    argv.length >= 2 &&
    NodePath.basename(argv[0] ?? "")
      .toLowerCase()
      .startsWith("codex")
  ) {
    return argv.slice(1).includes("app-server");
  }
  return false;
}

function isSameServerBinary(
  pid: number,
  serverExe: { readonly dev: number; readonly ino: number },
  procFs: ProcFsReader,
): boolean {
  const procSt = procFs.stat(`/proc/${pid}`);
  if (!procSt || procSt.uid !== procFs.currentUid()) return false;
  const exeSt = procFs.stat(`/proc/${pid}/exe`);
  return exeSt !== null && exeSt.dev === serverExe.dev && exeSt.ino === serverExe.ino;
}

/**
 * Resolves the T3 thread ID strictly from the verified `/proc` ancestor chain on Linux.
 * `allowEnvThreadId` is strictly programmatic DI for unit tests (never enabled from env vars).
 */
export function resolveT3ThreadId(
  env: NodeJS.ProcessEnv = process.env,
  options?: {
    readonly procFs?: ProcFsReader | undefined;
    readonly socketPath?: string | undefined;
    readonly allowEnvThreadId?: boolean | undefined;
  },
): string {
  if (options?.allowEnvThreadId === true) {
    return env[AGENT_THREAD_ENV]?.trim() ?? "";
  }
  const procFs = options?.procFs ?? defaultProcFs;
  if (procFs.hasProc()) {
    const srvPid = resolveT3ServerPid({
      procFs,
      socketPath: options?.socketPath,
    });
    if (srvPid === null) return "";

    const chain: number[] = [procFs.selfPid()];
    let reached = false;
    for (const { pid } of listAncestorsWithComm(undefined, procFs)) {
      if (pid === srvPid) {
        reached = true;
        break;
      }
      chain.push(pid);
    }
    if (!reached) return "";

    let top = chain.length - 1;
    const serverExe = procFs.stat(`/proc/${srvPid}/exe`);
    if (serverExe !== null) {
      while (
        top > 0 &&
        !readProcEnvVar(chain[top]!, AGENT_THREAD_ENV, procFs) &&
        isSameServerBinary(chain[top]!, serverExe, procFs)
      ) {
        top -= 1;
      }
    }
    const directTid = readProcEnvVar(chain[top]!, AGENT_THREAD_ENV, procFs);
    if (directTid) return directTid;
    if (top >= 1 && isCodexAppServer(chain[top]!, procFs)) {
      return readProcEnvVar(chain[top - 1]!, AGENT_THREAD_ENV, procFs);
    }
    return "";
  }
  return env[AGENT_THREAD_ENV]?.trim() ?? "";
}

// Trust boundary: the installed ship-queue roots and server binaries run as the same uid as
// agents and are often owner-writable. These checks stop spoofed PIDs, preload env, and tmp
// executables; they do not stop a same-uid agent that rewrites the installed tools in place.
function buildTrustedQueueRoots(queueRoot: string, procFs: ProcFsReader): ReadonlyArray<string> {
  const roots: string[] = ["/usr/local/lib/marscode", "/opt/marscode"];
  const canonHome = procFs.canonicalHome();
  if (canonHome) {
    roots.push(
      NodePath.join(canonHome, ".local", "lib", "marscode"),
      NodePath.join(canonHome, ".local", "lib", "marscode-tools", "ship-queue"),
      NodePath.join(canonHome, ".local", "lib", "ship-queue"),
      NodePath.join(canonHome, ".local", "bin"),
    );
  }
  const realQueue = procFs.realpath(queueRoot);
  if (realQueue && !isUntrustedPath(realQueue)) {
    roots.push(NodePath.join(realQueue, "versions"));
  }
  return roots.map((r) => procFs.realpath(r));
}

function isSafeLdLibraryPath(value: string, procFs: ProcFsReader): boolean {
  if (!value) return true;
  for (const seg of value.split(":")) {
    if (!seg || !seg.startsWith("/") || seg.includes("..")) return false;
    const mountRoot = extractAppImageMountRoot(seg);
    if (mountRoot) {
      if (!isReadOnlyAppImageMount(mountRoot, procFs)) return false;
      continue;
    }
    if (seg.startsWith("/usr/lib") || seg.startsWith("/lib")) {
      continue;
    }
    return false;
  }
  return true;
}

export function hasUnsafeWorkerEnv(pid: number, procFs: ProcFsReader): boolean {
  const raw = procFs.readText(`/proc/${pid}/environ`);
  if (raw === null) return true;
  for (const entry of raw.split("\0")) {
    if (!entry) continue;
    if (entry.startsWith("LD_LIBRARY_PATH=")) {
      if (!isSafeLdLibraryPath(entry.slice("LD_LIBRARY_PATH=".length), procFs)) return true;
      continue;
    }
    if (isUnsafeEnvEntry(entry, WORKER_EXTRA_UNSAFE_ENV_KEYS, WORKER_EXTRA_UNSAFE_ENV_PREFIXES)) {
      return true;
    }
  }
  return false;
}

function isUnderTrustedRoot(targetPath: string, trustedRoots: ReadonlyArray<string>): boolean {
  if (!targetPath || isUntrustedPath(targetPath)) return false;
  return trustedRoots.some((root) => targetPath === root || targetPath.startsWith(`${root}/`));
}

/**
 * Verifies a candidate ship-queue daemon or worker PID: same UID, non-agent cgroup/ancestry,
 * no transient `.service` units, clean environ (no NODE_OPTIONS/LD_PRELOAD/etc.), non-tmp
 * executable, and exact trusted installed script/subcommand shape.
 */
export function isTrustedShipQueueProcess(
  pid: number,
  queueRoot: string,
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  const procSt = procFs.stat(`/proc/${pid}`);
  if (!procSt || procSt.uid !== procFs.currentUid()) return false;

  const cg = readProcCgroup(pid, procFs);
  if (
    isExplicitAgentCgroup(cg) ||
    isTransientServiceCgroup(cg) ||
    cg.includes("app-t3code-agents") ||
    cg.includes("t3code-")
  ) {
    return false;
  }
  if (isAgentProcess({ startPid: pid, allowTransientScope: true, procFs })) {
    return false;
  }
  if (hasUnsafeWorkerEnv(pid, procFs)) {
    return false;
  }

  const rawExe = procFs.readLink(`/proc/${pid}/exe`);
  if (!rawExe || rawExe.endsWith(" (deleted)") || isUntrustedPath(rawExe)) return false;

  const argv = readProcArgv(pid, procFs);
  if (argv.length < 2) return false;

  const exeBase = NodePath.basename(rawExe).toLowerCase();
  const trustedRoots = buildTrustedQueueRoots(queueRoot, procFs);

  // Legacy bash daemon: exact `[bash, <queueRoot>/ship-queue.sh, daemon]` outside /tmp and not transient.
  if (exeBase === "bash") {
    if (isAgentCgroup(cg)) return false;
    const expectedScript = procFs.realpath(NodePath.join(queueRoot, "ship-queue.sh"));
    const actualScript = procFs.realpath(argv[1] ?? "");
    return (
      argv.length === 3 &&
      argv[2] === "daemon" &&
      !isUntrustedPath(actualScript) &&
      actualScript === expectedScript
    );
  }

  // MarsCode Node/Bun worker: exact `[<node|bun>, <trustedDir>/<bin.mjs|cli.mjs|ship-queue.mjs>, <work|daemon>]`.
  if (exeBase === "node" || exeBase === "bun") {
    const scriptArg = argv[1] ?? "";
    const subcmd = argv[2] ?? "";
    if (
      argv.length !== 3 ||
      !scriptArg ||
      scriptArg.startsWith("-") ||
      !TRUSTED_QUEUE_SUBCOMMANDS.has(subcmd)
    ) {
      return false;
    }
    const scriptReal = procFs.realpath(scriptArg);
    return (
      isUnderTrustedRoot(scriptReal, trustedRoots) &&
      TRUSTED_QUEUE_SCRIPT_BASENAMES.has(NodePath.basename(scriptReal))
    );
  }

  // Installed standalone `ship-queue` binary inside trusted root.
  if (exeBase === "ship-queue") {
    return (
      argv.length === 2 &&
      isUnderTrustedRoot(procFs.realpath(rawExe), trustedRoots) &&
      TRUSTED_QUEUE_SUBCOMMANDS.has(argv[1] ?? "")
    );
  }

  return false;
}

function resolveQueueDaemonPid(
  queueRoot: string,
  procFs: ProcFsReader = defaultProcFs,
): number | null {
  const pidText = procFs.readText(NodePath.join(queueRoot, "daemon.pid"));
  if (!pidText) return null;
  const pid = Number.parseInt(pidText.trim(), 10);
  if (!Number.isInteger(pid) || pid <= 1) return null;
  return isTrustedShipQueueProcess(pid, queueRoot, procFs) ? pid : null;
}

interface RecordedWorkerIdentity {
  readonly pid: number;
  readonly startTicks: string;
}

function parseWorkerLock(text: string | null): RecordedWorkerIdentity | null {
  if (!text) return null;
  try {
    const parsed = JSON.parse(text) as { pid?: unknown; startTicks?: unknown };
    const pid = parsed.pid;
    const startTicks = parsed.startTicks;
    if (
      typeof pid === "number" &&
      Number.isInteger(pid) &&
      pid > 1 &&
      typeof startTicks === "string" &&
      /^\d+$/.test(startTicks)
    ) {
      return { pid, startTicks };
    }
  } catch {
    // Malformed lock JSON fails closed.
  }
  return null;
}

function collectRecordedQueueWorkers(
  queueRoot: string,
  procFs: ProcFsReader,
): ReadonlyArray<RecordedWorkerIdentity> {
  const roots = [queueRoot];
  const canonHome = procFs.canonicalHome();
  if (canonHome) {
    const defaultMarscodeRoot = NodePath.join(canonHome, ".local", "share", "ship-queue");
    if (procFs.realpath(defaultMarscodeRoot) !== procFs.realpath(queueRoot)) {
      roots.push(defaultMarscodeRoot);
    }
  }

  const out: RecordedWorkerIdentity[] = [];
  for (const root of roots) {
    const legacy = parseWorkerLock(procFs.readText(NodePath.join(root, "worker.json")));
    if (legacy) out.push(legacy);
    const workersDir = NodePath.join(root, "workers");
    const entries = procFs.readDir(workersDir);
    if (entries) {
      for (const name of entries) {
        if (!name.endsWith(".json")) continue;
        const worker = parseWorkerLock(procFs.readText(NodePath.join(workersDir, name)));
        if (worker) out.push(worker);
      }
    }
  }
  return out;
}

/**
 * Whether `pid` is a live ship-queue worker that recorded itself in the queue's worker locks
 * (same start time) and passes `isTrustedShipQueueProcess`.
 */
export function isRecordedQueueWorker(
  queueRoot: string,
  pid: number,
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  return collectRecordedQueueWorkers(queueRoot, procFs).some(
    (worker) => worker.pid === pid && isLiveTrustedWorker(worker, queueRoot, procFs),
  );
}

function isLiveTrustedWorker(
  worker: RecordedWorkerIdentity,
  queueRoot: string,
  procFs: ProcFsReader,
): boolean {
  const stat = readProcStat(worker.pid, procFs);
  if (!stat.starttime || stat.starttime !== worker.startTicks) return false;
  return isTrustedShipQueueProcess(worker.pid, queueRoot, procFs);
}

export function isQueueDaemonInAncestry(
  queueRoot: string,
  startPid?: number,
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  const ancestors = listAncestorsWithComm(startPid, procFs);
  const ancestorPids = new Set(ancestors.map((a) => a.pid));

  const daemonPid = resolveQueueDaemonPid(queueRoot, procFs);
  if (daemonPid !== null && ancestorPids.has(daemonPid)) {
    return true;
  }

  // MarsCode's detached systemd-scope `ship-queue work` workers record `{ pid, startTicks }`
  // in `<queueRoot>/worker.json` or `<queueRoot>/workers/<version>.json`.
  return collectRecordedQueueWorkers(queueRoot, procFs).some(
    (worker) => ancestorPids.has(worker.pid) && isLiveTrustedWorker(worker, queueRoot, procFs),
  );
}
