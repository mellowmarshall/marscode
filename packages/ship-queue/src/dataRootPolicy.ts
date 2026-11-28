/**
 * Where a CI host's data root may live. CI worktrees, caches and the CI toolchain sit under it,
 * and some repos' tests refuse any path under a home directory, so a data root there breaks
 * their CI on that host. `ship-queue hosts check` flags it.
 */

/** Home directory trees: Linux, root's home, Fedora Atomic (`/var/home`) and macOS (any case). */
const HOME_TREE_RE = /^(~|\/home|\/root|\/var\/home|\/users)(\/|$)/i;

/** The remote data root a manifest host gets when it declares none. */
export const DEFAULT_REMOTE_DATA_ROOT = "/srv/ci";

/** True when DATA_ROOT (as declared in the manifest) is under a home directory. */
export function dataRootUnderHome(dataRoot: string): boolean {
  // Collapse repeated slashes, so `//home/ci` matches like `/home/ci`.
  return HOME_TREE_RE.test(dataRoot.trim().replace(/\/{2,}/g, "/"));
}

/** The note `hosts check` gives a host whose data root is under a home directory. */
export function dataRootUnderHomeNote(dataRoot: string): string {
  return `data_root under a home directory: ${dataRoot}: move it out of /home, for example to ${DEFAULT_REMOTE_DATA_ROOT}`;
}
