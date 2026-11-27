// @effect-diagnostics nodeBuiltinImport:off - Finds and signals orphaned headless browsers and test helpers with PID-reuse guards.
import * as NodeFSP from "node:fs/promises";

import { inAgentScope } from "../../process/agentScope.ts";
import {
  collectProtectedSelfPids,
  readLinuxProcStartTicks,
} from "../fleet/NativeServersScanner.ts";
import { parsePsOutput, runUserPs, type ParsedPsProcess } from "../fleet/NativeSessionsScanner.ts";

const ORPHAN_MIN_AGE_S = 1_800;
const CMD_SNIPPET = 100;

export interface OrphanTarget {
  readonly pid: number;
  readonly cmd: string;
  readonly ageS: number;
  /** Linux start time in clock ticks, or the full command line on macOS: a PID-reuse guard. */
  readonly identity: string;
}

export function isLinuxOrphanCommand(cmd: string): boolean {
  if (cmd.includes("agent-browser")) return true;
  if (
    (cmd.includes("chrome") || cmd.includes("chromium")) &&
    ["--headless", "--ozone-platform=headless", "/tmp/playwright", "/tmp/agent-browser"].some((k) =>
      cmd.includes(k),
    )
  ) {
    return true;
  }
  if (cmd.includes("Xvfb") && (cmd.includes("/tmp/") || cmd.includes("-screen"))) return true;
  if (cmd.includes("dbus-daemon") && cmd.includes("--nofork") && cmd.includes("/tmp/")) {
    return true;
  }
  const parts = cmd.trim().split(/\s+/);
  return (
    parts[0] !== undefined &&
    /(?:^|\/)sleep$/.test(parts[0]) &&
    /^\d+$/.test(parts[1] ?? "") &&
    Number(parts[1]) > 3_600
  );
}

export function isDarwinOrphanCommand(cmd: string): boolean {
  return (
    cmd.includes("agent-browser") ||
    (cmd.toLowerCase().includes("chrome") && cmd.includes("--headless")) ||
    cmd.includes("playwright")
  );
}

async function readIdentity(
  proc: Pick<ParsedPsProcess, "pid" | "args">,
  platform: NodeJS.Platform,
): Promise<string | null> {
  if (platform === "linux") return readLinuxProcStartTicks(proc.pid, platform);
  return platform === "darwin" ? proc.args : null;
}

/** A process in a T3 agent scope (its thread stops it) or a systemd service (its unit owns it). */
async function ownedByScope(pid: number, platform: NodeJS.Platform): Promise<boolean> {
  if (platform !== "linux") return false;
  const text = await NodeFSP.readFile(`/proc/${pid}/cgroup`, "utf8").catch(() => "");
  return inAgentScope(text) || /\.service\s*$/m.test(text);
}

/**
 * The user's processes that init (or the user's systemd) adopted, match a browser/test helper,
 * and ran longer than minAgeS. Never this server's ancestors, and never a process inside a T3
 * agent scope: the thread that owns that scope stops it.
 */
export async function findOrphans(
  platform: NodeJS.Platform,
  options: { readonly minAgeS?: number; readonly psOutput?: string } = {},
): Promise<OrphanTarget[]> {
  if (platform !== "linux" && platform !== "darwin") return [];
  const minAgeS = options.minAgeS ?? ORPHAN_MIN_AGE_S;
  const procs = parsePsOutput(options.psOutput ?? (await runUserPs()));
  const protectedPids = await collectProtectedSelfPids(platform);
  const userSystemd = procs.find((p) => p.comm === "systemd")?.pid;
  const matches = platform === "linux" ? isLinuxOrphanCommand : isDarwinOrphanCommand;
  const out: OrphanTarget[] = [];
  for (const proc of procs) {
    if (protectedPids.has(proc.pid) || proc.ageSeconds <= minAgeS) continue;
    const adopted = proc.ppid === 1 || (platform === "linux" && proc.ppid === userSystemd);
    if (!adopted || !matches(proc.args)) continue;
    if (await ownedByScope(proc.pid, platform)) continue;
    const identity = await readIdentity(proc, platform);
    if (identity === null) continue;
    out.push({
      pid: proc.pid,
      cmd: proc.args.trim().slice(0, CMD_SNIPPET),
      ageS: proc.ageSeconds,
      identity,
    });
  }
  return out;
}

async function stillSameProcess(target: OrphanTarget, platform: NodeJS.Platform): Promise<boolean> {
  if (platform === "linux") {
    return (await readLinuxProcStartTicks(target.pid, platform)) === target.identity;
  }
  if (platform !== "darwin") return false;
  const now = parsePsOutput(await runUserPs()).find((p) => p.pid === target.pid);
  return now !== undefined && now.args === target.identity && now.ageSeconds >= target.ageS;
}

/**
 * Sends `signal` only when the PID still names the process the scan saw; a PID the kernel
 * reused since then is never signalled. False when the process is gone, reused or refused.
 */
export async function signalVerified(
  target: OrphanTarget,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform,
): Promise<boolean> {
  if ((await collectProtectedSelfPids(platform)).has(target.pid)) return false;
  if (!(await stillSameProcess(target, platform))) return false;
  try {
    process.kill(target.pid, signal);
    return true;
  } catch {
    return false;
  }
}
