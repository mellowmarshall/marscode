// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";

import { archiveFsSlotUsage, runArchiveFsOp } from "../usage/usageArchiveFsGuard.ts";
import { ArchiveMount, darwinMountIsRemote } from "./SessionArchiveMount.ts";

const cleanups: Array<() => void> = [];

afterEach(() => {
  vi.useRealTimers();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempArchiveRoot(): string {
  const dir = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-archive-mount-")),
  );
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const syncDeviceOf = async (target: string) => {
  try {
    return NodeFS.statSync(target).dev;
  } catch {
    return null;
  }
};

async function openLocalMount(): Promise<ArchiveMount> {
  const mount = await ArchiveMount.open({
    archiveRoot: tempArchiveRoot(),
    host: "host-a",
    allowLocal: true,
    deviceOf: syncDeviceOf,
  });
  if (typeof mount === "string") throw new Error(mount);
  return mount;
}

describe("ArchiveMount.ensureDir", () => {
  it("creates each level below the host folder and frees every archive FS slot", async () => {
    const mount = await openLocalMount();
    NodeFS.mkdirSync(NodePath.join(mount.hostDir, "claude"));
    const nested = NodePath.join(mount.hostDir, "claude", "-work", "2029");

    await mount.ensureDir(nested);

    expect(NodeFS.statSync(nested).isDirectory()).toBe(true);
    expect(archiveFsSlotUsage()).toEqual({ active: 0, waiting: 0 });
  });

  it("times out a nested mkdir while the archive share is stalled instead of hanging", async () => {
    const mount = await openLocalMount();
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
    const releases: Array<() => void> = [];
    const held = [0, 1].map(() =>
      runArchiveFsOp(
        () => new Promise<void>((resolve) => releases.push(resolve)),
        60_000,
        "stalled share op",
      ),
    );

    const pending = mount.ensureDir(NodePath.join(mount.hostDir, "claude", "-work"));
    const outcome = expect(pending).rejects.toThrow("archive mkdir timed out");
    await vi.advanceTimersByTimeAsync(5_000);
    await outcome;

    expect(NodeFS.existsSync(NodePath.join(mount.hostDir, "claude"))).toBe(false);
    for (const release of releases) release();
    await Promise.all(held);
    expect(archiveFsSlotUsage()).toEqual({ active: 0, waiting: 0 });
  });
});

describe("darwinMountIsRemote", () => {
  const mountOutput = [
    "/dev/disk3s1s1 on / (apfs, sealed, local, read-only, journaled)",
    "//guest@host-a/archive on /Volumes/smb-archive (smbfs, nodev, nosuid, mounted by guest)",
    "host-a:/srv/archive on /Volumes/nfs-archive (nfs, nodev, nosuid, mounted by guest)",
    "guest@host-a:/srv/archive on /Volumes/sshfs-archive (macfuse, nodev, nosuid, synchronous, mounted by guest)",
    "remote:srv/archive on /Volumes/rclone archive (osxfuse, nodev, nosuid, mounted by guest)",
    "/dev/disk4s1 on /Volumes/ntfs-disk (macfuse, local, nodev, nosuid, synchronous, mounted by guest)",
    "cryfs@macfuse0 on /Volumes/vault (macfuse, nodev, nosuid, synchronous, mounted by guest)",
    "/srv/archive on /Volumes/bindfs-archive (osxfuse, nodev, nosuid, mounted by guest)",
    "guest@host-a:/srv/archive on /Volumes/flagged-local (macfuse, local, nodev, nosuid)",
  ].join("\n");

  it("detects kernel network shares and FUSE mounts whose source names a remote host", () => {
    for (const target of [
      "/Volumes/smb-archive",
      "/Volumes/nfs-archive",
      "/Volumes/sshfs-archive",
      "/Volumes/rclone archive",
    ]) {
      expect(darwinMountIsRemote(mountOutput, target), target).toBe(true);
    }
  });

  it("does not treat local macFUSE/osxfuse volumes or local disks as network shares", () => {
    for (const target of [
      "/",
      "/Volumes/ntfs-disk",
      "/Volumes/vault",
      "/Volumes/bindfs-archive",
      "/Volumes/flagged-local",
      "/Volumes/not-mounted",
    ]) {
      expect(darwinMountIsRemote(mountOutput, target), target).toBe(false);
    }
  });
});
