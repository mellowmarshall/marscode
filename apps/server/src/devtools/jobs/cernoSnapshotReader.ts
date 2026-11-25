// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Safe sidecar snapshot reading, Linux /proc verification, and background-job matching for cerno processes.
import * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { deriveCommandTitle } from "./commandJobParser.ts";
import { openValidatedLogFile, redactLogLine } from "./logFileGuard.ts";
import { sanitizeJobText, type JobCernoVerdict } from "./types.ts";

const MAX_SNAPSHOT_BYTES = 16_384;
const MAX_LOG_TAIL_BYTES = 8_192;
const MAX_ENVIRON_BYTES = 262_144;
const ENVIRON_CHUNK_BYTES = 16_384;
const MAX_CMDLINE_BYTES = 4_096;
const MAX_PARENT_WALK = 6;

const SAFE_READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

const CERNO_BIN_NAMES = new Set(["cerno", "cerno-exec"]);

const SSH_VALUE_FLAGS = new Set([
  "-B",
  "-b",
  "-c",
  "-D",
  "-E",
  "-e",
  "-F",
  "-I",
  "-i",
  "-J",
  "-L",
  "-l",
  "-m",
  "-O",
  "-o",
  "-p",
  "-Q",
  "-R",
  "-S",
  "-W",
  "-w",
]);

export interface RawCernoLiveSnapshot {
  readonly schema_version: number;
  readonly pid: number;
  readonly child_pid?: number | undefined;
  readonly proc_start_ticks?: number | undefined;
  readonly started_at_ms: number;
  readonly updated_at_ms: number;
  readonly elapsed_sec?: number | undefined;
  readonly mode: string;
  readonly cwd: string;
  readonly command: string;
  readonly log_path: string | null;
  readonly state: string;
  readonly confidence?: number | undefined;
  readonly outcome?: string | undefined;
  readonly prompt?: boolean | undefined;
  readonly hang_loop?: boolean | undefined;
  readonly server_ready?: boolean | undefined;
  readonly auth_required?: boolean | undefined;
  readonly resource_kill?: string | undefined;
  readonly git_conflict?: string | undefined;
  readonly cpu_active?: boolean | undefined;
  readonly has_remote_socket?: boolean | undefined;
  readonly silence_sec?: number | undefined;
  readonly alert?: string | null | undefined;
  readonly tail?: string | undefined;
}

export function defaultCernoSnapshotDirs(
  platform: NodeJS.Platform = "linux",
): ReadonlyArray<string> {
  const dirs: string[] = [];
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg && xdg.startsWith("/")) {
    dirs.push(NodePath.join(xdg, "cerno"));
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  if (uid !== null) {
    if (platform !== "linux") {
      const tmpEnv = process.env.TMPDIR?.trim();
      if (tmpEnv && tmpEnv.startsWith("/")) {
        const macDir = NodePath.join(tmpEnv, `cerno-${uid}`);
        if (!dirs.includes(macDir)) dirs.push(macDir);
      }
    }
    const tmpDir = `/tmp/cerno-${uid}`;
    if (!dirs.includes(tmpDir)) dirs.push(tmpDir);
  }
  return dirs;
}

export async function isSafeCernoSnapshotDir(
  dir: string,
  expectedUid: number | null,
): Promise<boolean> {
  try {
    const st = await NodeFSP.lstat(dir);
    if (!st.isDirectory()) return false;
    if (expectedUid !== null) {
      if (st.uid !== expectedUid) return false;
      if ((st.mode & 0o077) !== 0) return false;
    }
    return true;
  } catch {
    return false;
  }
}

export function defaultIsPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 1) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

async function readLinuxProcStat(
  pid: number,
): Promise<{ readonly ppid: number; readonly startTicks: number } | null> {
  try {
    const text = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const rp = text.lastIndexOf(")");
    if (rp < 0) return null;
    const fields = text
      .slice(rp + 2)
      .trim()
      .split(/\s+/u);
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks) || startTicks <= 0) return null;
    return { ppid: Number.isInteger(ppid) ? ppid : 0, startTicks };
  } catch {
    return null;
  }
}

export async function readProcStartTicks(
  pid: number,
  platform: NodeJS.Platform,
): Promise<number | null> {
  if (platform !== "linux") return null;
  const parsed = await readLinuxProcStat(pid);
  return parsed?.startTicks ?? null;
}

export async function readProcRssBytes(
  pid: number,
  platform: NodeJS.Platform,
): Promise<number | undefined> {
  if (platform !== "linux") return undefined;
  try {
    const text = await NodeFSP.readFile(`/proc/${pid}/status`, "utf8");
    const match = /^VmRSS:\s*(\d+)\s*kB/m.exec(text);
    if (!match?.[1]) return undefined;
    const kb = Number(match[1]);
    return Number.isFinite(kb) && kb > 0 ? kb * 1024 : undefined;
  } catch {
    return undefined;
  }
}

export async function isCernoProcessPid(pid: number, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "linux") return false;
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(`/proc/${pid}/cmdline`, SAFE_READ_FLAGS);
    const buf = Buffer.allocUnsafe(MAX_CMDLINE_BYTES);
    const { bytesRead } = await handle.read(buf, 0, MAX_CMDLINE_BYTES, 0);
    if (bytesRead <= 0) return false;
    const firstArg = buf.subarray(0, bytesRead).toString("utf8").split("\0")[0] ?? "";
    const base = NodePath.basename(firstArg).toLowerCase();
    return CERNO_BIN_NAMES.has(base);
  } catch {
    return false;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

async function readThreadIdFromProcEnviron(pid: number): Promise<string | undefined> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(`/proc/${pid}/environ`, SAFE_READ_FLAGS);
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_ENVIRON_BYTES) {
      const toRead = Math.min(ENVIRON_CHUNK_BYTES, MAX_ENVIRON_BYTES - total);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead <= 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total === 0) return undefined;
    const raw = Buffer.concat(chunks, total).toString("utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith("T3CODE_THREAD_ID=")) {
        const val = entry.slice("T3CODE_THREAD_ID=".length).trim();
        return val || undefined;
      }
    }
    return undefined;
  } catch {
    return undefined;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function resolveThreadIdForPid(
  pid: number,
  platform: NodeJS.Platform,
): Promise<string | undefined> {
  if (platform !== "linux") return undefined;
  let current = pid;
  const visited = new Set<number>();
  for (
    let depth = 0;
    depth <= MAX_PARENT_WALK && current > 1 && !visited.has(current);
    depth += 1
  ) {
    if (current === process.pid) break;
    visited.add(current);
    const tid = await readThreadIdFromProcEnviron(current);
    if (tid) return tid;
    const stat = await readLinuxProcStat(current);
    if (!stat || stat.ppid <= 1 || stat.ppid === process.pid) break;
    current = stat.ppid;
  }
  return undefined;
}

export async function resolveCanonicalLogPath(
  rawLogPath: string | null | undefined,
  cwd: string | null | undefined,
): Promise<string | undefined> {
  const trimmed = rawLogPath?.trim();
  if (!trimmed) return undefined;
  let abs: string;
  if (NodePath.isAbsolute(trimmed)) {
    abs = NodePath.resolve(trimmed);
  } else if (cwd && NodePath.isAbsolute(cwd)) {
    abs = NodePath.resolve(cwd, trimmed);
  } else {
    return undefined;
  }
  return NodeFSP.realpath(abs).catch(() => abs);
}

async function readSafeFileTail(
  filePath: string,
  isWorkspaceAllowed: (realPath: string) => Promise<boolean>,
  maxBytes = MAX_LOG_TAIL_BYTES,
): Promise<string | null> {
  const opened = await openValidatedLogFile({
    explicitPath: filePath,
    isWorkspaceAllowed,
  });
  if (!opened.ok) return null;
  const { handle, size } = opened.file;
  try {
    if (size === 0) return "";
    const readSize = Math.min(size, maxBytes);
    const offset = Math.max(0, size - readSize);
    const buf = Buffer.allocUnsafe(readSize);
    const { bytesRead } = await handle.read(buf, 0, readSize, offset);
    return buf.subarray(0, bytesRead).toString("utf8");
  } catch {
    return null;
  } finally {
    await handle.close().catch(() => undefined);
  }
}

export async function readCernoSnapshotFile(
  filePath: string,
  expectedUid: number | null,
): Promise<RawCernoLiveSnapshot | null> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(filePath, SAFE_READ_FLAGS);
    const st = await handle.stat();
    if (!st.isFile() || st.size === 0 || st.size > MAX_SNAPSHOT_BYTES) return null;
    if (expectedUid !== null && st.uid !== expectedUid) return null;
    const buf = Buffer.allocUnsafe(st.size);
    const { bytesRead } = await handle.read(buf, 0, st.size, 0);
    const parsed = JSON.parse(buf.subarray(0, bytesRead).toString("utf8")) as Record<
      string,
      unknown
    >;
    if (
      typeof parsed.pid !== "number" ||
      !Number.isInteger(parsed.pid) ||
      parsed.pid <= 1 ||
      typeof parsed.started_at_ms !== "number" ||
      typeof parsed.updated_at_ms !== "number" ||
      typeof parsed.mode !== "string" ||
      typeof parsed.command !== "string" ||
      typeof parsed.state !== "string"
    ) {
      return null;
    }
    return {
      schema_version: typeof parsed.schema_version === "number" ? parsed.schema_version : 1,
      pid: parsed.pid,
      child_pid: typeof parsed.child_pid === "number" ? parsed.child_pid : undefined,
      proc_start_ticks:
        typeof parsed.proc_start_ticks === "number" && parsed.proc_start_ticks > 0
          ? parsed.proc_start_ticks
          : undefined,
      started_at_ms: parsed.started_at_ms,
      updated_at_ms: parsed.updated_at_ms,
      elapsed_sec: typeof parsed.elapsed_sec === "number" ? parsed.elapsed_sec : undefined,
      mode: parsed.mode,
      cwd: typeof parsed.cwd === "string" ? parsed.cwd : "",
      command: parsed.command,
      log_path:
        typeof parsed.log_path === "string" && parsed.log_path.trim()
          ? parsed.log_path.trim()
          : null,
      state: parsed.state,
      confidence: typeof parsed.confidence === "number" ? parsed.confidence : undefined,
      outcome: typeof parsed.outcome === "string" ? parsed.outcome : undefined,
      prompt: parsed.prompt === true,
      hang_loop: parsed.hang_loop === true,
      server_ready: parsed.server_ready === true,
      auth_required: parsed.auth_required === true,
      resource_kill: typeof parsed.resource_kill === "string" ? parsed.resource_kill : undefined,
      git_conflict: typeof parsed.git_conflict === "string" ? parsed.git_conflict : undefined,
      cpu_active: parsed.cpu_active === true,
      has_remote_socket: parsed.has_remote_socket === true,
      silence_sec: typeof parsed.silence_sec === "number" ? parsed.silence_sec : undefined,
      alert: typeof parsed.alert === "string" && parsed.alert.trim() ? parsed.alert.trim() : null,
      tail: typeof parsed.tail === "string" ? parsed.tail : "",
    };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export function reconstructFullCernoCommand(snap: RawCernoLiveSnapshot): string {
  const modeLower = snap.mode.toLowerCase();
  if (modeLower.startsWith("tail")) {
    return snap.log_path ? `cerno tail ${snap.log_path}` : `cerno tail ${snap.command}`;
  }
  const logPart = snap.log_path ? ` --log ${snap.log_path}` : "";
  return `cerno watch${logPart} -- ${snap.command}`;
}

export function extractSshTargetHost(command: string): string | null {
  const tokens = command.trim().split(/\s+/u);
  if (tokens.length < 2 || NodePath.basename(tokens[0] ?? "").toLowerCase() !== "ssh") return null;
  let i = 1;
  while (i < tokens.length) {
    const tok = tokens[i]!;
    if (tok === "--") {
      i += 1;
      break;
    }
    if (!tok.startsWith("-")) break;
    i += tok.length === 2 && SSH_VALUE_FLAGS.has(tok) ? 2 : 1;
  }
  const target = tokens[i];
  if (!target || target.startsWith("-")) return null;
  const atIdx = target.lastIndexOf("@");
  return atIdx >= 0 ? target.slice(atIdx + 1) : target;
}

export function deriveCernoJobTitle(snap: RawCernoLiveSnapshot, fullCommand: string): string {
  if (snap.mode.toLowerCase().startsWith("tail") && snap.log_path) {
    return sanitizeJobText(`cerno tail ${NodePath.basename(snap.log_path)}`, 120);
  }
  const sshHost = extractSshTargetHost(snap.command);
  if (sshHost && snap.log_path) {
    const base = NodePath.basename(snap.log_path).replace(/\.log$/i, "");
    return sanitizeJobText(`${sshHost}: ${base}`, 120);
  }
  if (sshHost) {
    return sanitizeJobText(`ssh ${sshHost}`, 120);
  }
  return deriveCommandTitle(undefined, fullCommand);
}

export function deriveCernoAnomaly(snap: RawCernoLiveSnapshot): string | undefined {
  if (snap.alert) return sanitizeJobText(redactLogLine(snap.alert), 120);
  if (snap.hang_loop) return "Possible hang loop";
  if (snap.auth_required) return "Authentication required";
  if (snap.prompt || snap.state === "NEEDS_INPUT") return "Waiting for input";
  if (snap.resource_kill && snap.resource_kill !== "NORMAL") {
    return sanitizeJobText(`Resource kill: ${snap.resource_kill}`, 120);
  }
  if (snap.git_conflict && snap.git_conflict !== "NORMAL") {
    return sanitizeJobText(`Git conflict: ${snap.git_conflict}`, 120);
  }
  return undefined;
}

export async function resolveCernoTailLines(
  snap: RawCernoLiveSnapshot,
  canonicalLogPath: string | undefined,
  isWorkspaceAllowed: (realPath: string) => Promise<boolean>,
): Promise<ReadonlyArray<string>> {
  let raw = snap.tail ?? "";
  if (canonicalLogPath) {
    const fromFile = await readSafeFileTail(
      canonicalLogPath,
      isWorkspaceAllowed,
      MAX_LOG_TAIL_BYTES,
    );
    if (fromFile && fromFile.length > raw.length) {
      raw = fromFile;
    }
  }
  if (!raw.trim()) return [];
  return raw
    .split(/\r?\n/u)
    .map((l) => redactLogLine(l).trimEnd())
    .filter((l) => l.trim().length > 0)
    .slice(-100);
}

export function buildCernoVerdict(snap: RawCernoLiveSnapshot): JobCernoVerdict {
  const needsInput = Boolean(snap.prompt || snap.auth_required || snap.state === "NEEDS_INPUT");
  const upperOutcome = (snap.outcome ?? "").toUpperCase();
  const outcome: JobCernoVerdict["outcome"] =
    upperOutcome === "PASS" ? "pass" : upperOutcome === "FAIL" ? "fail" : "unknown";
  const pct =
    typeof snap.confidence === "number" && Number.isFinite(snap.confidence)
      ? `${Math.round(snap.confidence * 100)}%`
      : null;
  const parts: string[] = [pct ? `${snap.state} (${pct})` : snap.state];
  if (snap.alert) parts.push(snap.alert);
  else if (snap.has_remote_socket) parts.push("remote socket");
  else if (snap.cpu_active) parts.push("CPU active");
  return {
    checkedAt: new Date(snap.updated_at_ms).toISOString(),
    outcome,
    hangLoop: Boolean(snap.hang_loop),
    needsInput,
    serverReady: Boolean(snap.server_ready),
    summary: sanitizeJobText(redactLogLine(parts.join(" · ")), 160),
  };
}
