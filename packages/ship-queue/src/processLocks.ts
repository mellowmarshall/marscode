// @effect-diagnostics nodeBuiltinImport:off - Lock files owned by a process identity: the per-repo landing lock and the queue worker's claim.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { repoLockPath } from "./jobStore.ts";
import { parseProcessIdentity, sameProcess, type ProcessIdentity } from "./processIdentity.ts";

export type IsAlive = (identity: ProcessIdentity) => boolean;

interface LockContents {
  readonly holder: ProcessIdentity;
  readonly token: string;
}

function readLock(lockPath: string): LockContents | null {
  let text: string;
  try {
    text = NodeFS.readFileSync(lockPath, "utf8");
  } catch {
    return null;
  }
  const holder = parseProcessIdentity(text);
  if (!holder) return null;
  try {
    const token = (JSON.parse(text) as { token?: unknown }).token;
    return { holder, token: typeof token === "string" ? token : "" };
  } catch {
    return null;
  }
}

export function lockHolder(lockPath: string): ProcessIdentity | null {
  return readLock(lockPath)?.holder ?? null;
}

const UNREADABLE_LOCK: LockContents = { holder: { pid: 0, startTicks: null }, token: "" };

/** Hard-links a fully written file into place: atomic, and it fails when a lock already exists. */
function linkNewLock(lockPath: string, self: ProcessIdentity, token: string): boolean {
  const tmp = `${lockPath}.${self.pid}.${token}.tmp`;
  NodeFS.writeFileSync(tmp, JSON.stringify({ ...self, token }), { mode: 0o600 });
  try {
    NodeFS.linkSync(tmp, lockPath);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
    return false;
  } finally {
    NodeFS.rmSync(tmp, { force: true });
  }
}

/**
 * Moves a dead holder's lock aside. The rename is atomic, so of two callers racing for the same
 * stale lock only one moves it; a caller that finds it moved a fresh lock instead puts it back.
 */
function removeStaleLock(lockPath: string, stale: LockContents, token: string): void {
  const aside = `${lockPath}.stale.${token}`;
  try {
    NodeFS.renameSync(lockPath, aside);
  } catch {
    return;
  }
  const moved = readLock(aside);
  if (moved && moved.token !== stale.token) {
    try {
      NodeFS.linkSync(aside, lockPath);
    } catch {
      // another caller has linked its own lock since; it verifies that one itself
    }
  }
  NodeFS.rmSync(aside, { force: true });
}

/**
 * Takes the lock for `self`; a lock whose holder died (or whose pid was reused) is stale and
 * taken over. Ownership counts only once the file reads back with this claim's own token.
 */
export function claimLock(lockPath: string, self: ProcessIdentity, isAlive: IsAlive): boolean {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  const token = NodeCrypto.randomUUID();
  for (let attempt = 0; attempt < 3; attempt += 1) {
    if (linkNewLock(lockPath, self, token)) {
      const now = readLock(lockPath);
      return now !== null && now.token === token && sameProcess(now.holder, self);
    }
    const current = readLock(lockPath);
    if (!current) {
      // Gone since the link failed, or unreadable (no holder to wait for): move it aside.
      if (NodeFS.existsSync(lockPath)) removeStaleLock(lockPath, UNREADABLE_LOCK, token);
      continue;
    }
    if (sameProcess(current.holder, self)) return true;
    if (isAlive(current.holder)) return false;
    removeStaleLock(lockPath, current, token);
  }
  return false;
}

export function releaseLock(lockPath: string, self: ProcessIdentity): void {
  const holder = lockHolder(lockPath);
  if (holder && sameProcess(holder, self)) NodeFS.rmSync(lockPath, { force: true });
}

/** One job of a repo runs at a time. */
export const tryAcquireRepoLock = (
  root: string,
  repo: string,
  self: ProcessIdentity,
  isAlive: IsAlive,
) => claimLock(repoLockPath(root, repo), self, isAlive);

export const releaseRepoLock = (root: string, repo: string, self: ProcessIdentity) =>
  releaseLock(repoLockPath(root, repo), self);

export const repoLockHolder = (root: string, repo: string) => lockHolder(repoLockPath(root, repo));

export const workerLockPath = (root: string) => NodePath.join(root, "worker.json");

/** The live queue worker, if any: what a restarted MarsCode reattaches to instead of starting another. */
export function liveWorker(root: string, isAlive: IsAlive): ProcessIdentity | null {
  const holder = lockHolder(workerLockPath(root));
  return holder && isAlive(holder) ? holder : null;
}
