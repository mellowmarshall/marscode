// @effect-diagnostics nodeBuiltinImport:off - Link-safe tree walks, sizes and removals for reaper sweeps.
import type * as NodeFS from "node:fs";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

interface WalkEntry {
  readonly path: string;
  readonly name: string;
  readonly parentRel: ReadonlyArray<string>;
}

/** Every entry below root, depth first, never following a link. Stops when visit returns true. */
async function walk(root: string, visit: (entry: WalkEntry) => Promise<boolean>): Promise<boolean> {
  const stack: Array<{ dir: string; rel: ReadonlyArray<string> }> = [{ dir: root, rel: [] }];
  while (stack.length > 0) {
    const { dir, rel } = stack.pop()!;
    let children: Array<NodeFS.Dirent>;
    try {
      children = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const child of children) {
      const childPath = NodePath.join(dir, child.name);
      if (await visit({ path: childPath, name: child.name, parentRel: rel })) return true;
      if (child.isDirectory()) stack.push({ dir: childPath, rel: [...rel, child.name] });
    }
  }
  return false;
}

/**
 * True at the first entry (root included) changed at or after cutoffMs. With `gitIsRecent`,
 * a `.git` anywhere outside node_modules counts too: a checkout is never exhaust.
 */
export async function hasRecentEntry(
  root: string,
  cutoffMs: number,
  options: { readonly gitIsRecent?: boolean } = {},
): Promise<boolean> {
  try {
    if ((await NodeFSP.lstat(root)).mtimeMs >= cutoffMs) return true;
  } catch {
    return false;
  }
  return walk(root, async (entry) => {
    if (
      options.gitIsRecent === true &&
      entry.name === ".git" &&
      !entry.parentRel.includes("node_modules")
    ) {
      return true;
    }
    try {
      return (await NodeFSP.lstat(entry.path)).mtimeMs >= cutoffMs;
    } catch {
      return false;
    }
  });
}

/** Entries a git-data check reads before it gives up and treats the tree as unsafe. */
const GIT_DATA_SCAN_LIMIT = 200_000;

/** Git's data by name: a `.git` entry or a `*.git` directory, in any case. */
function gitDataName(name: string, isDirectory: boolean): boolean {
  const lower = name.toLowerCase();
  return lower === ".git" || (isDirectory && lower.endsWith(".git"));
}

/** A bare repository or mirror: `HEAD` beside `objects/` and `refs/`. */
function bareRepoLayout(children: ReadonlyArray<NodeFS.Dirent>): boolean {
  const has = (name: string, dir: boolean) =>
    children.some((c) => c.name === name && (!dir || c.isDirectory()));
  return has("HEAD", false) && has("objects", true) && has("refs", true);
}

/**
 * Why removing target could destroy git history, or null when its tree holds no git data:
 * a `.git` entry, a `*.git` directory, or a bare repo layout, at target or anywhere below.
 * Stops at the first match. A folder it cannot read, or a tree past the scan limit, counts as
 * unsafe, since a forced removal unlocks and deletes what this check could not see.
 */
export async function gitDataIn(target: string): Promise<string | null> {
  const st = await NodeFSP.lstat(target).catch(() => null);
  if (st === null) return null;
  if (gitDataName(NodePath.basename(target), st.isDirectory())) return `git data ${target}`;
  if (!st.isDirectory()) return null;
  const stack = [target];
  let seen = 0;
  while (stack.length > 0) {
    const dir = stack.pop()!;
    let children: Array<NodeFS.Dirent>;
    try {
      children = await NodeFSP.readdir(dir, { withFileTypes: true });
    } catch (cause) {
      if ((cause as NodeJS.ErrnoException)?.code === "ENOENT") continue;
      return `unreadable folder ${dir}`;
    }
    if (bareRepoLayout(children)) return `bare git repository ${dir}`;
    for (const child of children) {
      const childPath = NodePath.join(dir, child.name);
      if (gitDataName(child.name, child.isDirectory())) return `git data ${childPath}`;
      if (child.isDirectory()) stack.push(childPath);
    }
    seen += children.length;
    if (seen > GIT_DATA_SCAN_LIMIT) return `more than ${GIT_DATA_SCAN_LIMIT} entries to check`;
  }
  return null;
}

/** Allocated bytes under target; a hard-linked file counts once. */
export async function diskBytes(target: string): Promise<number> {
  let total = 0;
  const inodes = new Set<string>();
  const add = async (p: string) => {
    try {
      const st = await NodeFSP.lstat(p);
      if (st.nlink > 1 && !st.isDirectory()) {
        const key = `${st.dev}:${st.ino}`;
        if (inodes.has(key)) return;
        inodes.add(key);
      }
      total += st.blocks * 512;
    } catch {
      // gone since listed
    }
  };
  await add(target);
  await walk(target, async (entry) => {
    await add(entry.path);
    return false;
  });
  return total;
}

/** The device a path is on, by lstat; null when it is gone. Tests may stand in a mount. */
export type DeviceOf = (target: string) => Promise<number | null>;

export const lstatDevice: DeviceOf = async (target) =>
  (await NodeFSP.lstat(target).catch(() => null))?.dev ?? null;

/** True when a folder below root is on another device: a mount point. */
export async function holdsMount(root: string, deviceOf: DeviceOf = lstatDevice): Promise<boolean> {
  const dev = await deviceOf(root);
  if (dev === null) return false;
  return walk(root, async (entry) => {
    const st = await NodeFSP.lstat(entry.path).catch(() => null);
    if (st?.isDirectory() !== true) return false;
    const childDev = await deviceOf(entry.path);
    return childDev !== null && childDev !== dev;
  });
}

/**
 * True when target is on its sweep root's device and holds no mount point, so a walk or a
 * recursive removal of it can never reach into another file system.
 */
export async function onRootDevice(
  target: string,
  root: string,
  deviceOf: DeviceOf = lstatDevice,
): Promise<boolean> {
  const [rootDev, targetDev] = await Promise.all([deviceOf(root), deviceOf(target)]);
  if (rootDev === null || targetDev !== rootDev) return false;
  return !(await holdsMount(target, deviceOf));
}

async function exists(target: string): Promise<boolean> {
  try {
    await NodeFSP.lstat(target);
    return true;
  } catch {
    return false;
  }
}

/** Removes a file, link or tree, unlocking read-only folders (Go's module cache); true when gone. */
export async function forceRemove(target: string): Promise<boolean> {
  try {
    await NodeFSP.rm(target, { recursive: true, force: true });
  } catch {
    const st = await NodeFSP.lstat(target).catch(() => null);
    if (st?.isDirectory() === true) {
      await NodeFSP.chmod(target, 0o700).catch(() => undefined);
      await walk(target, async (entry) => {
        const child = await NodeFSP.lstat(entry.path).catch(() => null);
        if (child?.isDirectory() === true) {
          await NodeFSP.chmod(entry.path, 0o700).catch(() => undefined);
        }
        return false;
      });
      await NodeFSP.rm(target, { recursive: true, force: true }).catch(() => undefined);
    }
  }
  return !(await exists(target));
}
