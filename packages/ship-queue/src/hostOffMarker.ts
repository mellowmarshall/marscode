// @effect-diagnostics nodeBuiltinImport:off globalDate:off - CI host `.off` markers: versioned reads, and turn-on/turn-off that never leave a host eligible by mistake.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { isSafeHostName, loadCiHostsManifest } from "./ciHosts.ts";
import { currentProcessIdentity, isProcessAlive } from "./processIdentity.ts";
import { claimLock, releaseLock } from "./processLocks.ts";

/** One read of a marker. `version` is a hash of its exact bytes, so any edit changes it. */
export interface HostOffState {
  readonly at: string;
  readonly by: string;
  readonly reason: string;
  readonly version: string;
}

export function hostOffFilePath(queueRoot: string, hostName: string): string {
  return NodePath.join(queueRoot, "hosts", `${hostName}.off`);
}

/** The router's test: a host with a marker file gets no CI. */
export function isHostOff(queueRoot: string, hostName: string): boolean {
  return NodeFS.existsSync(hostOffFilePath(queueRoot, hostName));
}

function markerVersion(bytes: Buffer): string {
  return NodeCrypto.createHash("sha256").update(bytes).digest("hex").slice(0, 32);
}

/** Parses `at=`/`by=`/`reason=` lines. A hand-written marker with no fields keeps its text as the reason. */
function parseHostOff(bytes: Buffer): HostOffState {
  const text = bytes.toString("utf8");
  const fields: Record<string, string> = {};
  for (const line of text.split(/\r?\n/)) {
    const eq = line.indexOf("=");
    if (eq > 0) fields[line.slice(0, eq).trim()] = line.slice(eq + 1).trim();
  }
  const known = fields.at !== undefined || fields.by !== undefined || fields.reason !== undefined;
  const loose = known ? "" : text.replace(/\s+/g, " ").trim().slice(0, 500);
  return {
    at: fields.at ?? "",
    by: fields.by ?? "",
    reason: fields.reason || loose,
    version: markerVersion(bytes),
  };
}

/** Reads the marker once; null when there is none. Throws when it exists but cannot be read. */
export function readHostOffState(queueRoot: string, hostName: string): HostOffState | null {
  let bytes: Buffer;
  try {
    bytes = NodeFS.readFileSync(hostOffFilePath(queueRoot, hostName));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
    throw error;
  }
  return parseHostOff(bytes);
}

type ToggleResult = { readonly ok: boolean; readonly message: string; readonly changed: boolean };

/**
 * Every ship-queue writer of one host's marker holds `<host>.off.lock`, so a verified marker
 * cannot be replaced between the check and the unlink by another ship-queue process.
 */
function withMarkerLock(filePath: string, name: string, fn: () => ToggleResult): ToggleResult {
  const lockPath = `${filePath}.lock`;
  const self = currentProcessIdentity();
  if (!claimLock(lockPath, self, isProcessAlive)) {
    return {
      ok: false,
      message: `ci host ${name} is being changed by another process; try again`,
      changed: false,
    };
  }
  try {
    return fn();
  } finally {
    releaseLock(lockPath, self);
  }
}

/**
 * Removes the marker only while its bytes still hash to `expectVersion`. The marker stays in place
 * (so the router keeps excluding the host) until the final unlink; a refusal or a failure at any
 * step leaves it untouched.
 */
function removeMarkerIfVersion(
  filePath: string,
  expectVersion: string,
  beforeUnlink: (() => void) | undefined,
): boolean {
  let fd: number;
  try {
    fd = NodeFS.openSync(filePath, NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0));
  } catch {
    return false;
  }
  let ino: number;
  let dev: number;
  try {
    const st = NodeFS.fstatSync(fd);
    if (!st.isFile()) return false;
    ({ ino, dev } = st);
    if (markerVersion(NodeFS.readFileSync(fd)) !== expectVersion) return false;
  } finally {
    NodeFS.closeSync(fd);
  }
  beforeUnlink?.();
  const now = NodeFS.lstatSync(filePath, { throwIfNoEntry: false });
  if (!now || now.ino !== ino || now.dev !== dev) return false;
  NodeFS.unlinkSync(filePath);
  return true;
}

function safeUsername(): string {
  try {
    return NodeOS.userInfo().username || "unknown";
  } catch {
    return "unknown";
  }
}

export function setCiHostAvailability(input: {
  readonly queueRoot: string;
  readonly hostName: string;
  readonly enabled: boolean;
  readonly reason?: string | undefined;
  readonly actor?: string | undefined;
  readonly manifestPath?: string | undefined;
  readonly nowIso?: (() => string) | undefined;
  /**
   * Turn on only while the marker is still the version the caller read (and showed or checked).
   * Without it, the marker read here under the lock is the one removed, never a later one.
   */
  readonly expectVersion?: string | undefined;
  /** Test injection: runs after the marker is verified and before it is unlinked. */
  readonly beforeUnlink?: (() => void) | undefined;
}): ToggleResult {
  const name = input.hostName;
  if (!isSafeHostName(name)) {
    return { ok: false, message: `Invalid host name: ${JSON.stringify(name)}`, changed: false };
  }
  const loaded = loadCiHostsManifest({ overridePath: input.manifestPath });
  const declared =
    loaded.ok && loaded.manifest ? loaded.manifest.hosts.some((h) => h.name === name) : false;
  const filePath = hostOffFilePath(input.queueRoot, name);
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true, mode: 0o700 });

  return withMarkerLock(filePath, name, () => {
    if (input.enabled) {
      const current = readHostOffState(input.queueRoot, name);
      if (!current) {
        return declared
          ? { ok: true, message: `ci host ${name} is already on for CI`, changed: false }
          : { ok: false, message: `no CI host ${name} in manifest`, changed: false };
      }
      const expect = input.expectVersion ?? current.version;
      if (!removeMarkerIfVersion(filePath, expect, input.beforeUnlink)) {
        return {
          ok: false,
          message: `CI stays off on ${name}: its .off marker changed since it was checked`,
          changed: false,
        };
      }
      return { ok: true, message: `CI enabled on ${name}`, changed: true };
    }

    if (loaded.ok && !declared) {
      return { ok: false, message: `no CI host ${name} in manifest`, changed: false };
    }
    if (NodeFS.existsSync(filePath)) {
      return { ok: true, message: `ci host ${name} is already off for CI`, changed: false };
    }
    const cleanReason = (input.reason ?? "").replace(/[\n\r\t]/g, " ").trim();
    const actor = input.actor ?? safeUsername();
    const at = (input.nowIso ?? (() => new Date().toISOString()))();
    const tmp = `${filePath}.tmp.${process.pid}`;
    NodeFS.writeFileSync(tmp, `at=${at}\nby=${actor}\nreason=${cleanReason}\n`, { mode: 0o600 });
    NodeFS.renameSync(tmp, filePath);
    return { ok: true, message: `CI disabled on ${name}`, changed: true };
  });
}
