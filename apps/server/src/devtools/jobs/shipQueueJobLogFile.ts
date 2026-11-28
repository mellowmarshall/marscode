// @effect-diagnostics nodeBuiltinImport:off - Needs O_NOFOLLOW opens and fstat dev/ino/nlink checks, which the Effect FileSystem does not expose, inside the synchronous ShipQueueBridge refresh.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { isJobId } from "@t3tools/ship-queue/jobStore";

/** A job log found by `statShipJobLog`: its path and the identities a later open must still match. */
export interface ShipJobLogStat {
  readonly path: string;
  readonly dirPath: string;
  readonly dirDev: number;
  readonly dirIno: number;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
}

const OPEN_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

/**
 * `jobs/<id>/log` for a queue job id, when the job directory is a real directory and the log a
 * regular file with one link: a symlink at either step, or a hardlinked log, is refused.
 */
export function statShipJobLog(jobsRootDir: string, jobId: string): ShipJobLogStat | null {
  if (!jobsRootDir || !isJobId(jobId)) return null;
  const dirPath = NodePath.join(jobsRootDir, jobId);
  const path = NodePath.join(dirPath, "log");
  try {
    const dir = NodeFS.lstatSync(dirPath);
    if (!dir.isDirectory()) return null;
    const st = NodeFS.lstatSync(path);
    if (!st.isFile() || st.nlink !== 1) return null;
    return {
      path,
      dirPath,
      dirDev: dir.dev,
      dirIno: dir.ino,
      dev: st.dev,
      ino: st.ino,
      size: st.size,
      mtimeMs: st.mtimeMs,
    };
  } catch {
    return null;
  }
}

function sameDirectory(log: ShipJobLogStat): boolean {
  const dir = NodeFS.lstatSync(log.dirPath);
  return dir.isDirectory() && dir.dev === log.dirDev && dir.ino === log.dirIno;
}

/**
 * Opens a log `statShipJobLog` found. O_NOFOLLOW guards only the last path component, so after the
 * open the job directory is checked again (same directory, still not a link) and the opened file
 * must be the one at the path (same dev and ino), a regular file with one link. A directory swapped
 * for a link around the open, or a hardlink, is refused. The caller closes the descriptor.
 */
export function openShipJobLog(log: ShipJobLogStat): number | null {
  let fd: number | null = null;
  try {
    fd = NodeFS.openSync(log.path, OPEN_FLAGS);
    const opened = NodeFS.fstatSync(fd);
    const atPath = NodeFS.lstatSync(log.path);
    const verified =
      opened.isFile() &&
      opened.nlink === 1 &&
      sameDirectory(log) &&
      atPath.isFile() &&
      atPath.dev === opened.dev &&
      atPath.ino === opened.ino &&
      opened.dev === log.dev &&
      opened.ino === log.ino;
    if (verified) return fd;
  } catch {
    // fall through: refuse
  }
  if (fd !== null) NodeFS.closeSync(fd);
  return null;
}

/** Bytes `[start, log.size)` of a verified log, or `null` if it cannot be opened as verified. */
export function readShipJobLogRange(log: ShipJobLogStat, start: number): Buffer | null {
  const fd = openShipJobLog(log);
  if (fd === null) return null;
  try {
    const buf = Buffer.alloc(Math.max(0, log.size - start));
    const read = buf.length > 0 ? NodeFS.readSync(fd, buf, 0, buf.length, start) : 0;
    return buf.subarray(0, read);
  } catch {
    return null;
  } finally {
    NodeFS.closeSync(fd);
  }
}

/** Changes whenever the log grows or is rewritten. */
export function shipJobLogSignature(log: ShipJobLogStat | null): string {
  return log ? `${log.size}:${log.mtimeMs}` : "";
}
