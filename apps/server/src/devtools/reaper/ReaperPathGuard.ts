// @effect-diagnostics nodeBuiltinImport:off - Path protection for reaper sweeps: live process paths and StorageManifest history roots.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import type { StorageManifest, StorageManifestEntry } from "../StorageManifest.ts";

const trimSlash = (p: string) => (p.length > 1 ? p.replace(/\/+$/, "") : p);

export function inside(candidate: string, folder: string): boolean {
  const c = trimSlash(candidate);
  const f = trimSlash(folder);
  return c === f || c.startsWith(f === "/" ? "/" : `${f}/`);
}

/** True when `candidate` is a root, inside one, or holds one. */
export function overlapsAny(candidate: string, roots: Iterable<string>): boolean {
  for (const root of roots) {
    if (inside(candidate, root) || inside(root, candidate)) return true;
  }
  return false;
}

function strictAncestors(p: string): string[] {
  const out: string[] = [];
  let cur = NodePath.dirname(trimSlash(p));
  while (cur !== "/" && cur !== NodePath.dirname(cur)) {
    out.push(cur);
    cur = NodePath.dirname(cur);
  }
  return out;
}

/**
 * Indexed check, O(path depth) per lookup. A path is protected when a live path is at it,
 * inside it, or (for `isProtected`) above it.
 */
export class PathGuard {
  private readonly exact = new Set<string>();
  private readonly ancestors = new Set<string>();

  constructor(livePaths: Iterable<string>) {
    for (const raw of livePaths) {
      const norm = trimSlash(raw);
      this.exact.add(norm);
      for (const ancestor of strictAncestors(norm)) this.ancestors.add(ancestor);
    }
  }

  get size(): number {
    return this.exact.size;
  }

  /** True when a live path is at dir or inside it; a live path above dir does not count. */
  holdsLivePath(dir: string): boolean {
    const norm = trimSlash(dir);
    return this.exact.has(norm) || this.ancestors.has(norm);
  }

  isProtected(realPath: string): boolean {
    const norm = trimSlash(realPath);
    if (this.exact.has(norm) || this.ancestors.has(norm)) return true;
    return strictAncestors(norm).some((ancestor) => this.exact.has(ancestor));
  }

  /** Like isProtected, but a live path above `root` (a shell in $HOME) does not protect it. */
  isProtectedUnder(realPath: string, root: string): boolean {
    const norm = trimSlash(realPath);
    if (this.exact.has(norm) || this.ancestors.has(norm)) return true;
    const realRoot = trimSlash(root);
    return strictAncestors(norm).some(
      (ancestor) => this.exact.has(ancestor) && inside(ancestor, realRoot),
    );
  }
}

/** An absolute, non-link folder at least three levels deep that is neither `/` nor home. */
export async function safeReapRoot(raw: string, homeDir: string): Promise<string | null> {
  const expanded = raw.trim().startsWith("~/")
    ? NodePath.join(homeDir, raw.trim().slice(2))
    : raw.trim();
  if (!expanded || !NodePath.isAbsolute(expanded)) return null;
  try {
    if ((await NodeFSP.lstat(expanded)).isSymbolicLink()) return null;
    const resolved = await NodeFSP.realpath(expanded);
    const home = await NodeFSP.realpath(homeDir).catch(() => homeDir);
    if (resolved === "/" || resolved === home) return null;
    return resolved.split("/").filter(Boolean).length >= 3 ? resolved : null;
  } catch {
    return null;
  }
}

/** Manifest roots the reaper never removes from, by real path when they exist. */
export async function manifestHistoryRoots(manifest: StorageManifest): Promise<string[]> {
  const roots = [
    ...manifest.entries.filter((entry) => entry.trust === "history").map((entry) => entry.path),
    manifest.worktreesDir,
  ];
  return Promise.all(roots.map((root) => NodeFSP.realpath(root).catch(() => root)));
}

const REAPABLE_EPHEMERAL_KINDS = new Set<StorageManifestEntry["kind"]>([
  "temp-dir",
  "cache-dir",
  "crashes",
  "shell-snapshots",
]);

/** Ephemeral entries the reaper sweeps; T3's own logs and browser artifacts belong to StorageCleanup. */
export function reapableEphemeralEntries(
  manifest: StorageManifest,
): ReadonlyArray<StorageManifestEntry> {
  return manifest.entries.filter(
    (entry) => entry.trust === "ephemeral" && REAPABLE_EPHEMERAL_KINDS.has(entry.kind),
  );
}
