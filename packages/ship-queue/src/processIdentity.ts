// @effect-diagnostics nodeBuiltinImport:off - A process named by pid and kernel start time, so a reused pid never passes for a live worker or watcher.
import * as NodeFS from "node:fs";

export interface ProcessIdentity {
  readonly pid: number;
  /** `/proc/<pid>/stat` start time in clock ticks; `null` where the host has no procfs. */
  readonly startTicks: string | null;
}

export function processStartTicks(pid: number): string | null {
  try {
    const stat = NodeFS.readFileSync(`/proc/${pid}/stat`, "utf8");
    // The command name can hold spaces and parentheses; fields resume after its last ")".
    const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const ticks = fields[19];
    return ticks && /^\d+$/.test(ticks) ? ticks : null;
  } catch {
    return null;
  }
}

export function currentProcessIdentity(): ProcessIdentity {
  return { pid: process.pid, startTicks: processStartTicks(process.pid) };
}

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function isProcessAlive(identity: ProcessIdentity): boolean {
  if (!Number.isInteger(identity.pid) || identity.pid <= 0 || !pidAlive(identity.pid)) return false;
  if (identity.startTicks === null) return true;
  const now = processStartTicks(identity.pid);
  return now === null || now === identity.startTicks;
}

export function sameProcess(a: ProcessIdentity, b: ProcessIdentity): boolean {
  return (
    a.pid === b.pid &&
    (a.startTicks === null || b.startTicks === null || a.startTicks === b.startTicks)
  );
}

export function parseProcessIdentity(text: string): ProcessIdentity | null {
  try {
    const raw = JSON.parse(text) as { pid?: unknown; startTicks?: unknown };
    if (typeof raw.pid !== "number" || !Number.isInteger(raw.pid) || raw.pid <= 0) return null;
    return { pid: raw.pid, startTicks: typeof raw.startTicks === "string" ? raw.startTicks : null };
  } catch {
    return null;
  }
}
