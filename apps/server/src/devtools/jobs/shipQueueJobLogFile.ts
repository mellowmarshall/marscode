// @effect-diagnostics nodeBuiltinImport:off - Locates a ship-queue job's log and opens it without following links.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isJobId } from "@t3tools/ship-queue/jobStore";

export interface ShipJobLogStat {
  readonly path: string;
  readonly size: number;
  readonly mtimeMs: number;
}

const OPEN_NO_FOLLOW = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);

/**
 * `jobs/<id>/log` for a queue job id, when the job directory and the log are a real directory
 * and a regular file: a link at either step is refused.
 */
export function statShipJobLog(jobsRootDir: string, jobId: string): ShipJobLogStat | null {
  if (!jobsRootDir || !isJobId(jobId)) return null;
  const jobDir = NodePath.join(jobsRootDir, jobId);
  const path = NodePath.join(jobDir, "log");
  try {
    if (!NodeFS.lstatSync(jobDir).isDirectory()) return null;
    const st = NodeFS.lstatSync(path);
    return st.isFile() ? { path, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}

/** Opens a log `statShipJobLog` found; the caller closes the descriptor. `null` if it changed into a link. */
export function openShipJobLog(log: ShipJobLogStat): number | null {
  try {
    const fd = NodeFS.openSync(log.path, OPEN_NO_FOLLOW);
    if (NodeFS.fstatSync(fd).isFile()) return fd;
    NodeFS.closeSync(fd);
    return null;
  } catch {
    return null;
  }
}

/** Changes whenever the job's log grows or is rewritten. */
export function shipJobLogSignature(jobsRootDir: string, jobId: string): string {
  const log = statShipJobLog(jobsRootDir, jobId);
  return log ? `${log.size}:${log.mtimeMs}` : "";
}
