// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owner-only Unix socket path & liveness probing for GuardGrantBroker.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { readRegularFileRange } from "./GuardAuditFiles.ts";

const SOCKET_PROBE_TIMEOUT_MS = 300;

function isPrivateOwnedDir(dir: string, uid: number): boolean {
  try {
    const st = NodeFS.lstatSync(dir);
    return st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function canonicalExistingDir(dir: string): string {
  try {
    return NodeFS.realpathSync(dir);
  } catch {
    return NodePath.resolve(dir);
  }
}

export function canonicalCwd(cwd: string): string {
  if (!cwd) return "";
  try {
    return NodeFS.realpathSync(cwd);
  } catch {
    return NodePath.resolve(cwd);
  }
}

export function defaultGuardSocketPath(): string {
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg && isPrivateOwnedDir(xdg, uid)) {
    return NodePath.join(canonicalExistingDir(xdg), "t3-guard-grant.sock");
  }
  const runDir = `/run/user/${uid}`;
  if (isPrivateOwnedDir(runDir, uid)) {
    return NodePath.join(canonicalExistingDir(runDir), "t3-guard-grant.sock");
  }
  return NodePath.join(canonicalExistingDir("/tmp"), `t3-guard-${uid}`, "t3-guard-grant.sock");
}

export function resolveConfiguredStateDir(): string {
  const home = NodeOS.homedir();
  const confPath = NodePath.join(home, ".local", "lib", "host-guards.conf");
  const conf = readRegularFileRange(confPath, 16 * 1024, "head");
  if (conf) {
    for (const rawLine of conf.text.split("\n")) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const val = line.slice(eq + 1).trim();
      if (key === "state_dir" && val) {
        return val.startsWith("~/") ? NodePath.join(home, val.slice(2)) : val;
      }
    }
  }
  const defaultDir = NodePath.join(home, ".local", "state", "host-guards");
  if (NodeFS.existsSync(defaultDir)) return defaultDir;
  const xdgState = process.env.XDG_STATE_HOME?.trim();
  if (xdgState) return NodePath.join(xdgState, "host-guards");
  return defaultDir;
}

export function ensurePrivateParentDir(socketPath: string): void {
  const dir = NodePath.dirname(socketPath);
  NodeFS.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const stat = NodeFS.lstatSync(dir);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Guard socket parent is not a regular directory: ${dir}`);
  }
  if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
    throw new Error(`Guard socket parent is not owned by current user: ${dir}`);
  }
  if ((stat.mode & 0o077) !== 0) {
    if (dir === "/tmp" || dir === "/var/tmp" || dir === "/private/tmp") {
      throw new Error(`Refusing to bind guard socket directly in shared directory: ${dir}`);
    }
    NodeFS.chmodSync(dir, 0o700);
    const after = NodeFS.lstatSync(dir);
    if ((after.mode & 0o077) !== 0) {
      throw new Error(`Guard socket parent permissions are too open: ${dir}`);
    }
  }
}

export function probeSocketAlive(socketPath: string): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      conn.destroy();
      resolve(alive);
    };
    const conn = NodeNet.createConnection({ path: socketPath });
    const timer = setTimeout(() => done(false), SOCKET_PROBE_TIMEOUT_MS);
    conn.once("connect", () => done(true));
    conn.once("error", () => done(false));
  });
}
