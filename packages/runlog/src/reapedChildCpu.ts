// @effect-diagnostics nodeBuiltinImport:off - headless CLI library on node:* builtins only.
/**
 * The user+system seconds of reaped children, as getrusage(RUSAGE_CHILDREN)
 * counts them. Node has no such call, so it reads cutime and cstime from
 * /proc/self/stat; elsewhere it is null (not measured).
 */
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";

/** USER_HZ on every Linux architecture but one; getconf says when it differs. */
const DEFAULT_TICKS = 100;

/** The clock ticks per second of /proc's times. Call it before the snapshot: getconf is a child too. */
export function clockTicks(): number {
  const res = NodeChildProcess.spawnSync("getconf", ["CLK_TCK"], { encoding: "utf8" });
  const ticks = res.status === 0 ? Number.parseInt(res.stdout.trim(), 10) : Number.NaN;
  return Number.isInteger(ticks) && ticks > 0 ? ticks : DEFAULT_TICKS;
}

/** The reaped children's CPU in clock ticks, or null where /proc/self/stat is not there. */
export function reapedChildTicks(): number | null {
  let stat: string;
  try {
    stat = NodeFS.readFileSync("/proc/self/stat", "utf8");
  } catch {
    return null;
  }
  // The command name may hold spaces and parentheses: the fields start after the last ")".
  // Field 3 (state) is at index 0, so cutime (16) and cstime (17) are at 13 and 14.
  const fields = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
  const cutime = Number.parseInt(fields[13] ?? "", 10);
  const cstime = Number.parseInt(fields[14] ?? "", 10);
  return Number.isInteger(cutime) && Number.isInteger(cstime) ? cutime + cstime : null;
}
