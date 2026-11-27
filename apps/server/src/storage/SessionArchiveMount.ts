// @effect-diagnostics nodeBuiltinImport:off - Mount guard for the session archive share: never write onto a bare mount point.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Schema from "effect/Schema";

import { runArchiveFsOp } from "../usage/usageArchiveFsGuard.ts";

const DEVICE_TIMEOUT_MS = 5_000;

/** Linux statfs(2) magic numbers for kernel network share filesystems. */
const LINUX_REMOTE_SHARE_MAGICS = new Set([
  0xff534d42, // CIFS_SUPER_MAGIC
  0xfe534d42, // SMB2_SUPER_MAGIC (SMB2/SMB3)
  0x517b, // SMB_SUPER_MAGIC
  0x6969, // NFS_SUPER_MAGIC
]);
const LINUX_FUSE_MAGIC = 0x65735546;
const LINUX_REMOTE_FUSE_TYPES = new Set([
  "fuse.sshfs",
  "fuse.rclone",
  "fuse.gvfsd-fuse",
  "fuse.smbnetfs",
  "fuse.cifs",
]);
const DARWIN_REMOTE_FS_TYPES = new Set(["smbfs", "nfs", "afpfs", "webdav", "macfuse", "osxfuse"]);

/** The device a path is on, or null when it is missing, offline or slow. */
export type ArchiveDeviceOf = (target: string) => Promise<number | null>;

/** Returns true when `mountPoint` is backed by a mounted remote/network share filesystem. */
export type ArchiveShareCheck = (mountPoint: string) => Promise<boolean>;

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

function unescapeMountInfoPath(raw: string): string {
  return raw.replace(/\\([0-7]{3})/g, (_, oct: string) =>
    String.fromCharCode(Number.parseInt(oct, 8)),
  );
}

async function isLinuxRemoteFuseMount(mountPoint: string): Promise<boolean> {
  try {
    const text = await NodeFSP.readFile("/proc/self/mountinfo", "utf8");
    const target = NodePath.resolve(mountPoint);
    let matchedType: string | null = null;
    for (const line of text.split("\n")) {
      const sep = line.indexOf(" - ");
      if (sep === -1) continue;
      const left = line.slice(0, sep).split(" ");
      const right = line.slice(sep + 3).split(" ");
      const mp = unescapeMountInfoPath(left[4] ?? "");
      if (mp === target) {
        // Later entries shadow earlier mounts at the same mountpoint (e.g. autofs -> cifs).
        matchedType = right[0] ?? null;
      }
    }
    return matchedType !== null && LINUX_REMOTE_FUSE_TYPES.has(matchedType);
  } catch {
    return false;
  }
}

async function isDarwinRemoteMount(mountPoint: string): Promise<boolean> {
  try {
    const target = NodePath.resolve(mountPoint);
    const stdout = await runArchiveFsOp(
      () =>
        new Promise<string>((resolve, reject) => {
          NodeChildProcess.execFile(
            "/sbin/mount",
            [],
            { timeout: DEVICE_TIMEOUT_MS, encoding: "utf8" },
            (error, out) => {
              if (error) reject(error);
              else resolve(out);
            },
          );
        }),
      DEVICE_TIMEOUT_MS,
      "archive mount inspect",
    );
    for (const line of stdout.split("\n")) {
      const match = / on (.+) \(([^,)]+)/.exec(line);
      if (match && match[1] === target && DARWIN_REMOTE_FS_TYPES.has(match[2] ?? "")) {
        return true;
      }
    }
    return false;
  } catch {
    return false;
  }
}

export function createArchiveRemoteShareCheck(
  platform: NodeJS.Platform = HostProcess.Platform.defaultValue(),
): ArchiveShareCheck {
  return async (mountPoint) => {
    if (platform === "linux") {
      try {
        const st = await runArchiveFsOp(
          () => NodeFSP.statfs(mountPoint),
          DEVICE_TIMEOUT_MS,
          "archive statfs",
        );
        if (LINUX_REMOTE_SHARE_MAGICS.has(st.type)) return true;
        if (st.type === LINUX_FUSE_MAGIC) return await isLinuxRemoteFuseMount(mountPoint);
        return false;
      } catch {
        return false;
      }
    }
    if (platform === "darwin") {
      return await isDarwinRemoteMount(mountPoint);
    }
    return false;
  };
}

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
  private readonly mountPoint: string | null;
  private readonly deviceOf: ArchiveDeviceOf;

  private constructor(
    archiveRoot: string,
    hostDir: string,
    device: number,
    mountPoint: string | null,
    deviceOf: ArchiveDeviceOf,
  ) {
    this.archiveRoot = archiveRoot;
    this.hostDir = hostDir;
    this.device = device;
    this.mountPoint = mountPoint;
    this.deviceOf = deviceOf;
  }

  /**
   * The mounted archive and this host's folder in it, or the reason the pass must not write.
   * Unless `allowLocal`, `archiveRoot` must lie on a mounted filesystem distinct from the root
   * filesystem, `homeDir`, and the OS temp directory (either at the mount point itself or in a
   * subdirectory beneath it). Only the host folder itself is ever created, never a folder above it.
   */
  static async open(input: {
    readonly archiveRoot: string;
    readonly host: string;
    readonly homeDir?: string;
    readonly platform?: NodeJS.Platform;
    readonly allowLocal: boolean;
    readonly deviceOf: ArchiveDeviceOf;
    readonly isRemoteShare?: ArchiveShareCheck;
  }): Promise<ArchiveMount | string> {
    const { deviceOf } = input;
    const isRemoteShare = input.isRemoteShare ?? createArchiveRemoteShareCheck(input.platform);
    const resolvedInput = NodePath.resolve(input.archiveRoot);
    const resolvedRoot = await runArchiveFsOp(
      () => NodeFSP.realpath(resolvedInput),
      DEVICE_TIMEOUT_MS,
      "archive realpath",
    ).catch(() => null);
    if (resolvedRoot === null) return "the archive folder is unreachable";
    const rootDev = await deviceOf(resolvedRoot);
    if (rootDev === null) return "the archive folder is unreachable";

    let mountPoint: string | null = null;
    if (!input.allowLocal) {
      let current = resolvedRoot;
      while (true) {
        const parent = NodePath.dirname(current);
        if (parent === current) break;
        const parentDev = await deviceOf(parent);
        if (parentDev === null) return "the archive folder is unreachable";
        if (parentDev !== rootDev) {
          mountPoint = current;
          break;
        }
        current = parent;
      }
      if (mountPoint === null) {
        return "the archive folder is not a mounted share";
      }
      const [homeDev, tmpDev, remoteShare] = await Promise.all([
        input.homeDir ? deviceOf(input.homeDir) : Promise.resolve(null),
        deviceOf(NodeOS.tmpdir()),
        isRemoteShare(mountPoint),
      ]);
      if (
        !remoteShare ||
        (homeDev !== null && rootDev === homeDev) ||
        (tmpDev !== null && rootDev === tmpDev)
      ) {
        return "the archive folder is not a mounted share";
      }
    }

    const hostDir = NodePath.join(resolvedRoot, input.host);
    if ((await deviceOf(hostDir)) === null) {
      await runArchiveFsOp(() => NodeFSP.mkdir(hostDir), DEVICE_TIMEOUT_MS, "archive mkdir").catch(
        () => undefined,
      );
    }
    const mount = new ArchiveMount(resolvedRoot, hostDir, rootDev, mountPoint, deviceOf);
    return (await mount.online()) ? mount : "the host folder could not be made on the share";
  }

  async online(): Promise<boolean> {
    const checks: Array<Promise<number | null>> = [
      this.deviceOf(this.archiveRoot),
      this.deviceOf(this.hostDir),
    ];
    if (this.mountPoint !== null) {
      checks.push(this.deviceOf(this.mountPoint), this.deviceOf(NodePath.dirname(this.mountPoint)));
    }
    const [rootDev, hostDev, mountDev, mountParentDev] = await Promise.all(checks);
    if (rootDev !== this.device || hostDev !== this.device) return false;
    if (
      this.mountPoint !== null &&
      (mountDev !== this.device || mountParentDev === null || mountParentDev === this.device)
    ) {
      return false;
    }
    return true;
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
