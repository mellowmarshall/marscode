// @effect-diagnostics nodeBuiltinImport:off - Linux /proc filesystem reader, stat/environ/argv parsing, AppImage mount check, and Unix socket ownership verification.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import { parseProcEnvironValue, parseProcStatParent } from "@t3tools/shared/procIdentity";

import { canonicalHomeDir, safeRealpath } from "./hostConfig.ts";

const PROC_NET_UNIX_RE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\d+)\s+(.*)$/;

export interface ProcStatMeta {
  readonly dev: number;
  readonly ino: number;
  readonly uid: number;
  readonly mode: number;
  readonly isFile: boolean;
}

export interface ProcFsReader {
  readonly hasProc: () => boolean;
  readonly selfPid: () => number;
  readonly currentUid: () => number;
  readonly readText: (path: string) => string | null;
  readonly readLink: (path: string) => string | null;
  readonly readDir: (path: string) => ReadonlyArray<string> | null;
  readonly stat: (path: string) => ProcStatMeta | null;
  readonly lstat: (path: string) => ProcStatMeta | null;
  readonly realpath: (path: string) => string;
  readonly canonicalHome: () => string;
}

function createNodeProcFs(): ProcFsReader {
  const toMeta = (st: NodeFS.Stats): ProcStatMeta => ({
    dev: st.dev,
    ino: st.ino,
    uid: st.uid,
    mode: st.mode,
    isFile: st.isFile(),
  });
  return {
    hasProc: () => NodeFS.existsSync("/proc"),
    selfPid: () => process.pid,
    currentUid: () => (typeof process.getuid === "function" ? process.getuid() : 0),
    readText: (filePath) => {
      try {
        return NodeFS.readFileSync(filePath, "utf8");
      } catch {
        return null;
      }
    },
    readLink: (linkPath) => {
      try {
        return NodeFS.readlinkSync(linkPath);
      } catch {
        return null;
      }
    },
    readDir: (dirPath) => {
      try {
        return NodeFS.readdirSync(dirPath);
      } catch {
        return null;
      }
    },
    stat: (filePath) => {
      try {
        return toMeta(NodeFS.statSync(filePath));
      } catch {
        return null;
      }
    },
    lstat: (filePath) => {
      try {
        return toMeta(NodeFS.lstatSync(filePath));
      } catch {
        return null;
      }
    },
    realpath: safeRealpath,
    canonicalHome: canonicalHomeDir,
  };
}

export const defaultProcFs: ProcFsReader = createNodeProcFs();

export interface ParsedProcStat {
  readonly comm: string;
  readonly ppid: number | null;
  readonly ttyNr: number;
  readonly starttime: string;
}

function parseProcStat(raw: string): ParsedProcStat {
  const lparen = raw.indexOf("(");
  const rparen = raw.lastIndexOf(")");
  if (lparen === -1 || rparen === -1 || rparen <= lparen) {
    return { comm: "", ppid: null, ttyNr: 0, starttime: "" };
  }
  const comm = raw.slice(lparen + 1, rparen);
  const fields = raw
    .slice(rparen + 2)
    .trim()
    .split(/\s+/);
  const ppid = parseProcStatParent(raw);
  const ttyNr = Number.parseInt(fields[4] ?? "0", 10);
  const starttime = fields[19] ?? "";
  return {
    comm,
    ppid,
    ttyNr: Number.isInteger(ttyNr) ? ttyNr : 0,
    starttime: /^\d+$/.test(starttime) ? starttime : "",
  };
}

export function readProcStat(
  pid: number | "self",
  procFs: ProcFsReader = defaultProcFs,
): ParsedProcStat {
  const raw = procFs.readText(`/proc/${pid}/stat`);
  if (!raw) return { comm: "", ppid: null, ttyNr: 0, starttime: "" };
  return parseProcStat(raw);
}

export function readProcArgv(
  pid: number,
  procFs: ProcFsReader = defaultProcFs,
): ReadonlyArray<string> {
  const raw = procFs.readText(`/proc/${pid}/cmdline`);
  if (!raw) return [];
  const parts = raw.split("\0");
  if (parts.length > 0 && parts[parts.length - 1] === "") {
    parts.pop();
  }
  return parts;
}

export function readProcEnvVar(
  pid: number,
  name: string,
  procFs: ProcFsReader = defaultProcFs,
): string {
  const raw = procFs.readText(`/proc/${pid}/environ`);
  if (!raw) return "";
  return parseProcEnvironValue(raw, name) ?? "";
}

export function readProcCgroup(
  pid: number | "self" = "self",
  procFs: ProcFsReader = defaultProcFs,
): string {
  return procFs.readText(`/proc/${pid}/cgroup`) ?? "";
}

export function listAncestorsWithComm(
  startPid?: number,
  procFs: ProcFsReader = defaultProcFs,
): ReadonlyArray<{ readonly pid: number; readonly comm: string }> {
  const out: Array<{ readonly pid: number; readonly comm: string }> = [];
  let pid = readProcStat(startPid ?? procFs.selfPid(), procFs).ppid;
  for (let i = 0; i < 64; i += 1) {
    if (pid === null || pid <= 1) break;
    const info = readProcStat(pid, procFs);
    out.push({ pid, comm: info.comm });
    pid = info.ppid;
  }
  return out;
}

/**
 * Verifies `/tmp/.mount_*` is a read-only AppImage FUSE/squashfs mount in `/proc/self/mounts`.
 * Accepts ANY read-only AppImage mount prefix (MarsCode, T3-Code, etc.) — never hardcodes `/tmp/.mount_T3-`.
 */
export function isReadOnlyAppImageMount(
  mountDir: string,
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  const normalized = NodePath.posix.normalize(mountDir);
  if (!normalized.startsWith("/tmp/.mount_") || normalized.includes("..")) {
    return false;
  }
  const mounts = procFs.readText("/proc/self/mounts");
  if (!mounts) return false;
  for (const line of mounts.split("\n")) {
    const parts = line.split(/\s+/);
    if (parts.length < 4) continue;
    const target = parts[1];
    const fsType = parts[2] ?? "";
    const opts = (parts[3] ?? "").split(",");
    if (
      target === normalized &&
      (fsType.startsWith("fuse.") || fsType === "squashfs") &&
      opts.includes("ro")
    ) {
      return true;
    }
  }
  return false;
}

export function verifyServerOwnsSocket(
  pid: number,
  sockPath: string,
  procFs: ProcFsReader = defaultProcFs,
): boolean {
  const table = procFs.readText("/proc/net/unix");
  if (!table) return false;
  let listeningInode: string | null = null;
  for (const line of table.split("\n")) {
    const m = PROC_NET_UNIX_RE.exec(line);
    if (!m) continue;
    if (m[1] === "01" && (m[3]?.trimEnd() ?? "") === sockPath) {
      listeningInode = m[2] ?? null;
      break;
    }
  }
  if (!listeningInode) return false;
  const target = `socket:[${listeningInode}]`;
  const entries = procFs.readDir(`/proc/${pid}/fd`);
  if (!entries) return false;
  for (const entry of entries) {
    if (procFs.readLink(`/proc/${pid}/fd/${entry}`) === target) {
      return true;
    }
  }
  return false;
}

const UNIVERSAL_UNSAFE_ENV_KEYS = new Set([
  "LD_PRELOAD",
  "LD_AUDIT",
  "OPENSSL_CONF",
  "PYTHONPATH",
  "PERL5OPT",
  "RUBYOPT",
  "ENV",
  "CDPATH",
  "GIT_EXTERNAL_DIFF",
  "GIT_CONFIG",
  "GIT_CONFIG_COUNT",
  "GIT_CONFIG_PARAMETERS",
  "GIT_CONFIG_GLOBAL",
  "GIT_CONFIG_SYSTEM",
  "GIT_SSH_COMMAND",
  "GIT_SSH",
  "GIT_ASKPASS",
  "GIT_EXEC_PATH",
  "GIT_TEMPLATE_DIR",
  "SSH_ASKPASS",
]);

const UNIVERSAL_UNSAFE_ENV_PREFIXES: ReadonlyArray<string> = [
  "DYLD_",
  "GIT_CONFIG_KEY_",
  "GIT_CONFIG_VALUE_",
];

/**
 * Checks a single `/proc/<pid>/environ` `KEY=VALUE` entry against universal code-injection /
 * git-execution env vars plus caller-specific exact keys and key prefixes.
 * Splits strictly on the first `=` so values ending in `=` never bypass the check.
 */
export function isUnsafeEnvEntry(
  entry: string,
  extraKeys?: ReadonlySet<string>,
  extraKeyPrefixes?: ReadonlyArray<string>,
): boolean {
  const eq = entry.indexOf("=");
  if (eq <= 0) return false;
  const key = entry.slice(0, eq);
  const value = entry.slice(eq + 1);
  if (!value) return false;
  if (UNIVERSAL_UNSAFE_ENV_KEYS.has(key) || extraKeys?.has(key) === true) {
    return true;
  }
  if (UNIVERSAL_UNSAFE_ENV_PREFIXES.some((prefix) => key.startsWith(prefix))) {
    return true;
  }
  if (extraKeyPrefixes?.some((prefix) => key.startsWith(prefix)) === true) {
    return true;
  }
  return false;
}
