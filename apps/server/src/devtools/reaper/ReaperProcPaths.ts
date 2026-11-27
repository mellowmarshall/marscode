// @effect-diagnostics nodeBuiltinImport:off - Reads /proc (Linux) or lsof (macOS) for the paths live processes hold.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

const LSOF_TIMEOUT_MS = 60_000;
const DELETED_SUFFIX = " (deleted)";

export interface ProcPathScan {
  /** Real paths of every cwd, open file and bound unix socket (plus executables and mappings when asked). */
  readonly paths: ReadonlySet<string>;
  /** Processes other than this one that gave at least one path; 0 means the scan saw nothing. */
  readonly otherProcesses: number;
}

export interface ProcPathScanOptions {
  readonly uid: number;
  readonly platform: NodeJS.Platform;
  /** Executables and mapped files of every readable process (the Cargo in-use check needs them). */
  readonly includeMappings?: boolean;
  readonly procRoot?: string;
}

const stripDeleted = (target: string) =>
  target.endsWith(DELETED_SUFFIX) ? target.slice(0, -DELETED_SUFFIX.length) : target;

async function realOrRaw(target: string): Promise<string> {
  try {
    return await NodeFSP.realpath(target);
  } catch {
    return target;
  }
}

/**
 * Bound unix socket paths in one /proc net/unix file; null when it cannot be read.
 * A listening socket shows in /proc/<pid>/fd only as socket:[inode], so without this a
 * long-running app's socket directory (Chrome's SingletonSocket) looks stale and is deleted.
 */
async function readNetUnixSockets(netUnixPath: string): Promise<Set<string> | null> {
  let text: string;
  try {
    text = await NodeFSP.readFile(netUnixPath, "utf8");
  } catch {
    return null;
  }
  const out = new Set<string>();
  for (const line of text.split("\n").slice(1)) {
    const fields = line.trim().split(/\s+/);
    const socketPath = fields.length >= 8 ? fields.slice(7).join(" ") : "";
    if (socketPath.startsWith("/")) out.add(await realOrRaw(socketPath));
  }
  return out;
}

async function readProcUid(procDir: string): Promise<number | null> {
  try {
    const status = await NodeFSP.readFile(NodePath.join(procDir, "status"), "utf8");
    const match = /^Uid:\s+(\d+)/m.exec(status);
    return match ? Number(match[1]) : null;
  } catch {
    return null;
  }
}

async function readLinkOrNull(target: string): Promise<string | null> {
  try {
    return await NodeFSP.readlink(target);
  } catch {
    return null;
  }
}

async function readOwnedProcPaths(procDir: string, add: (p: string) => void): Promise<void> {
  const cwd = await readLinkOrNull(NodePath.join(procDir, "cwd"));
  if (cwd?.startsWith("/")) add(stripDeleted(cwd));
  let fds: string[] = [];
  try {
    fds = await NodeFSP.readdir(NodePath.join(procDir, "fd"));
  } catch {
    return;
  }
  await Promise.all(
    fds.map(async (fd) => {
      const target = await readLinkOrNull(NodePath.join(procDir, "fd", fd));
      if (target?.startsWith("/")) add(stripDeleted(target));
    }),
  );
}

async function readMappedPaths(procDir: string, add: (p: string) => void): Promise<void> {
  const exe = await readLinkOrNull(NodePath.join(procDir, "exe"));
  if (exe?.startsWith("/")) add(stripDeleted(exe));
  try {
    const maps = await NodeFSP.readFile(NodePath.join(procDir, "maps"), "utf8");
    for (const line of maps.split("\n")) {
      const index = line.indexOf("/");
      if (index > 0) add(stripDeleted(line.slice(index)));
    }
  } catch {
    // unreadable for other users' processes
  }
}

async function scanLinux(options: ProcPathScanOptions): Promise<ProcPathScan | null> {
  const procRoot = options.procRoot ?? "/proc";
  const paths = new Set<string>();
  const doneNamespaces = new Set<string>();
  const own = await readNetUnixSockets(NodePath.join(procRoot, "net", "unix"));
  if (own !== null) {
    for (const socketPath of own) paths.add(socketPath);
    const ns = await readLinkOrNull(NodePath.join(procRoot, "self", "ns", "net"));
    if (ns !== null) doneNamespaces.add(ns);
  }
  let entries: string[] = [];
  try {
    entries = await NodeFSP.readdir(procRoot);
  } catch {
    return null;
  }
  let otherProcesses = 0;
  for (const name of entries) {
    if (!/^\d+$/.test(name)) continue;
    const procDir = NodePath.join(procRoot, name);
    let got = 0;
    const add = (p: string) => {
      got += 1;
      paths.add(p);
    };
    if ((await readProcUid(procDir)) === options.uid) {
      await readOwnedProcPaths(procDir, add);
      // A sandbox with its own network namespace still sees desktop sockets this way.
      const ns = await readLinkOrNull(NodePath.join(procDir, "ns", "net"));
      if (ns !== null && !doneNamespaces.has(ns)) {
        const sockets = await readNetUnixSockets(NodePath.join(procDir, "net", "unix"));
        if (sockets !== null) {
          for (const socketPath of sockets) add(socketPath);
          doneNamespaces.add(ns);
        }
      }
    }
    if (options.includeMappings === true) await readMappedPaths(procDir, add);
    if (got > 0 && Number(name) !== process.pid) otherProcesses += 1;
  }
  return { paths, otherProcesses };
}

function runLsof(uid: number): Promise<string | null> {
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      "lsof",
      ["-n", "-P", "-u", String(uid), "-Fpn"],
      {
        timeout: LSOF_TIMEOUT_MS,
        maxBuffer: 256 * 1024 * 1024,
        env: { ...process.env, LC_ALL: "C" },
      },
      // A timeout or a failed run is no scan: partial output would leave live paths unprotected.
      (error, stdout) => resolve(error ? null : stdout),
    );
  });
}

async function scanLsof(options: ProcPathScanOptions): Promise<ProcPathScan | null> {
  const output = await runLsof(options.uid);
  if (output === null) return null;
  const paths = new Set<string>();
  const counted = new Set<number>();
  let pid: number | null = null;
  for (const line of output.split("\n")) {
    if (line.startsWith("p") && /^\d+$/.test(line.slice(1))) {
      pid = Number(line.slice(1));
    } else if (line.startsWith("n/")) {
      paths.add(await realOrRaw(line.slice(1)));
      if (pid !== null && pid !== process.pid) counted.add(pid);
    }
  }
  return { paths, otherProcesses: counted.size };
}

/** The live paths, or null when the scan failed: then nothing may be removed. */
export function scanProcessPaths(options: ProcPathScanOptions): Promise<ProcPathScan | null> {
  if (options.platform === "linux") return scanLinux(options);
  if (options.platform === "darwin") return scanLsof(options);
  return Promise.resolve(null);
}

/**
 * A scan a destructive step may trust: it succeeded and read at least one process other than
 * this one. A blind scan would show every path as unused.
 */
export function trustedScan(scan: ProcPathScan | null): scan is ProcPathScan {
  return scan !== null && scan.otherProcesses > 0;
}
