// @effect-diagnostics nodeBuiltinImport:off - Mount guard for the session archive share: never write onto a bare mount point.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import * as Schema from "effect/Schema";

import { runArchiveFsOp } from "../usage/usageArchiveFsGuard.ts";

const DEVICE_TIMEOUT_MS = 5_000;

/** The device a path is on, or null when it is missing, offline or slow. */
export type ArchiveDeviceOf = (target: string) => Promise<number | null>;

export const archiveDevice: ArchiveDeviceOf = async (target) => {
  try {
    return await runArchiveFsOp(
      () => NodeFSP.stat(target).then((st) => st.dev),
      DEVICE_TIMEOUT_MS,
      "archive stat",
    );
  } catch {
    return null;
  }
};

export class ArchiveChangedError extends Schema.TaggedError<ArchiveChangedError>()(
  "ArchiveChangedError",
  { archiveRoot: Schema.String },
) {
  override get message() {
    return `The archive share at ${this.archiveRoot} changed or went away mid-pass; the pass stopped`;
  }
}

/**
 * Holds the archive's device as probed at the start of a pass. Every write checks that the
 * root and the host folder are still on that device, so a share that unmounts mid-pass
 * never receives a write on the local mount point beneath it.
 */
export class ArchiveMount {
  readonly archiveRoot: string;
  readonly hostDir: string;
  private readonly device: number;
  private readonly deviceOf: ArchiveDeviceOf;

  private constructor(
    archiveRoot: string,
    hostDir: string,
    device: number,
    deviceOf: ArchiveDeviceOf,
  ) {
    this.archiveRoot = archiveRoot;
    this.hostDir = hostDir;
    this.device = device;
    this.deviceOf = deviceOf;
  }

  /**
   * The mounted archive and this host's folder in it, or the reason the pass must not write.
   * The root must be a mount point (on another device than its parent) unless `allowLocal`.
   * Only the host folder itself is ever created, never a folder above it.
   */
  static async open(input: {
    readonly archiveRoot: string;
    readonly host: string;
    readonly allowLocal: boolean;
    readonly deviceOf: ArchiveDeviceOf;
  }): Promise<ArchiveMount | string> {
    const { archiveRoot, deviceOf } = input;
    const [rootDev, parentDev] = await Promise.all([
      deviceOf(archiveRoot),
      deviceOf(NodePath.dirname(archiveRoot)),
    ]);
    if (rootDev === null) return "the archive folder is unreachable";
    if (rootDev === parentDev && !input.allowLocal) {
      return "the archive folder is not a mounted share";
    }
    const hostDir = NodePath.join(archiveRoot, input.host);
    if ((await deviceOf(hostDir)) === null) {
      await NodeFSP.mkdir(hostDir).catch(() => undefined);
    }
    const mount = new ArchiveMount(archiveRoot, hostDir, rootDev, deviceOf);
    return (await mount.online()) ? mount : "the host folder could not be made on the share";
  }

  async online(): Promise<boolean> {
    const [rootDev, hostDev] = await Promise.all([
      this.deviceOf(this.archiveRoot),
      this.deviceOf(this.hostDir),
    ]);
    return rootDev === this.device && hostDev === this.device;
  }

  /** Throws ArchiveChangedError unless the share is still the one the pass probed. */
  async assertOnline(): Promise<void> {
    if (!(await this.online())) throw new ArchiveChangedError({ archiveRoot: this.archiveRoot });
  }

  /** Creates dir below the host folder one level at a time, never above it. */
  async ensureDir(dir: string): Promise<void> {
    const relative = NodePath.relative(this.hostDir, dir);
    if (relative.startsWith("..") || NodePath.isAbsolute(relative)) {
      throw new Error(`${dir} is outside the host archive folder`);
    }
    await this.assertOnline();
    let current = this.hostDir;
    for (const segment of relative.split(NodePath.sep).filter(Boolean)) {
      current = NodePath.join(current, segment);
      await NodeFSP.mkdir(current).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "EEXIST") throw error;
      });
    }
  }
}

/** Points the usage reader's stable link at this host's archive; a real folder there is left alone. */
export async function updateRemoteLink(homeDir: string, hostDir: string): Promise<void> {
  const link = NodePath.join(homeDir, ".local", "state", "session-archive", "remote");
  const current = await NodeFSP.readlink(link).catch(() => null);
  if (current === hostDir) return;
  if (current === null && (await NodeFSP.lstat(link).catch(() => null)) !== null) return;
  await NodeFSP.mkdir(NodePath.dirname(link), { recursive: true });
  const tmp = `${link}.${process.pid}.tmp`;
  await NodeFSP.rm(tmp, { force: true });
  await NodeFSP.symlink(hostDir, tmp);
  await NodeFSP.rename(tmp, link);
}
