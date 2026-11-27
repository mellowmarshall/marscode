// @effect-diagnostics nodeBuiltinImport:off - Bounded stat of a transcript the session archive moved behind a link.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as ByteSize from "effect/ByteSize";
import * as DateTime from "effect/DateTime";
import type * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";

import { boundedArchiveStat } from "../usage/usageArchiveWalk.ts";

const date = (ms: bigint) => Option.some(DateTime.toDateUtc(DateTime.makeUnsafe(Number(ms))));

/**
 * File info for a linked transcript, read from its archive target under the archive FS cap
 * and timeout, so an offline or slow share returns none instead of holding the scan.
 */
export async function archivedTranscriptInfo(
  linkPath: string,
  nowMs: number,
): Promise<Option.Option<FileSystem.File.Info>> {
  const linked = await NodeFSP.readlink(linkPath).catch(() => null);
  if (linked === null) return Option.none();
  const st = await boundedArchiveStat(NodePath.resolve(NodePath.dirname(linkPath), linked), {
    nowMs,
  });
  if (st === undefined || !st.isFile()) return Option.none();
  return Option.some({
    type: "File",
    mtime: date(st.mtimeMs),
    atime: date(st.atimeMs),
    birthtime: date(st.birthtimeMs),
    dev: st.dev,
    ino: Option.some(st.ino),
    mode: Number(st.mode),
    nlink: Option.some(st.nlink),
    uid: Option.some(Number(st.uid)),
    gid: Option.some(Number(st.gid)),
    rdev: Option.some(st.rdev),
    size: ByteSize.bytes(st.size),
    blksize: Option.some(ByteSize.bytes(st.blksize)),
    blocks: Option.some(st.blocks),
  });
}
