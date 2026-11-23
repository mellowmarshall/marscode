// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Unix socket transport and 0700/0600 ownership helpers.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

const MAX_LINE_BYTES = 64 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 300;

export interface OwnedSocketStat {
  readonly dev: number;
  readonly ino: number;
}

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

export function defaultGuardSocketPath(): string {
  if (process.env.T3_GUARD_GRANT_TEST_MODE === "1") {
    const testSocket = process.env.T3_GUARD_GRANT_SOCKET?.trim();
    if (testSocket) return NodePath.resolve(testSocket);
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const xdg = process.env.XDG_RUNTIME_DIR?.trim();
  if (xdg && isPrivateOwnedDir(xdg, uid)) {
    return NodePath.join(canonicalExistingDir(xdg), "t3-guard-grant.sock");
  }
  const runDir = `/run/user/${uid}`;
  if (isPrivateOwnedDir(runDir, uid)) {
    return NodePath.join(canonicalExistingDir(runDir), "t3-guard-grant.sock");
  }
  // Never place the socket directly inside world-writable 1777 /tmp (hg_t3_grant.py requires 0700 owner dir).
  return NodePath.join(canonicalExistingDir("/tmp"), `t3-guard-${uid}`, "t3-guard-grant.sock");
}

function ensurePrivateParentDir(socketPath: string): void {
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

function probeSocketAlive(socketPath: string): Promise<boolean> {
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

export async function bindPrivateUnixSocket(input: {
  readonly socketPath: string;
  readonly maxConnections: number;
  readonly isClosed: () => boolean;
  readonly onConnection: (socket: NodeNet.Socket) => void;
}): Promise<{
  readonly server: NodeNet.Server;
  readonly boundStat: OwnedSocketStat | null;
} | null> {
  ensurePrivateParentDir(input.socketPath);
  try {
    const existing = NodeFS.lstatSync(input.socketPath);
    if (!existing.isSocket()) {
      throw new Error(`Refusing to replace non-socket path at ${input.socketPath}`);
    }
    const alive = await probeSocketAlive(input.socketPath);
    if (alive) {
      throw new Error(`Guard socket ${input.socketPath} is already owned by a live broker`);
    }
    if (input.isClosed()) return null;
    // Re-verify dev/ino immediately before unlink so concurrent startup cannot delete a live socket.
    const recheck = NodeFS.lstatSync(input.socketPath);
    if (recheck.isSocket() && recheck.dev === existing.dev && recheck.ino === existing.ino) {
      NodeFS.unlinkSync(input.socketPath);
    } else {
      throw new Error(`Guard socket ${input.socketPath} was replaced during startup`);
    }
  } catch (err) {
    if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
      throw err;
    }
  }

  if (input.isClosed()) return null;
  const server = NodeNet.createServer(input.onConnection);
  server.maxConnections = input.maxConnections;

  let boundStat: OwnedSocketStat | null = null;
  await new Promise<void>((resolve, reject) => {
    const onError = (err: Error) => {
      server.removeListener("listening", onListening);
      reject(err);
    };
    const onListening = () => {
      server.removeListener("error", onError);
      try {
        NodeFS.chmodSync(input.socketPath, 0o600);
        const st = NodeFS.lstatSync(input.socketPath);
        boundStat = { dev: st.dev, ino: st.ino };
      } catch {
        // best-effort; parent dir is already 0700 owner-only
      }
      resolve();
    };
    server.once("error", onError);
    server.once("listening", onListening);
    server.listen(input.socketPath);
  });

  if (input.isClosed()) {
    await new Promise<void>((resolve) => server.close(() => resolve()));
    unlinkOwnedSocket(input.socketPath, boundStat);
    return null;
  }

  server.on("error", () => {
    // Keep running; per-socket errors are handled on each client socket.
  });
  return { server, boundStat };
}

export function unlinkOwnedSocket(socketPath: string, owned: OwnedSocketStat | null): void {
  if (!owned) return;
  try {
    const st = NodeFS.lstatSync(socketPath);
    if (st.isSocket() && st.dev === owned.dev && st.ino === owned.ino) {
      NodeFS.unlinkSync(socketPath);
    }
  } catch {
    // ignore missing/replaced socket
  }
}

export function parseGrantWireMessage(line: string): Record<string, unknown> | string {
  try {
    const parsed = JSON.parse(line) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return "invalid JSON object";
    }
    const msg = parsed as Record<string, unknown>;
    return msg.v !== 1 ? "unsupported protocol version" : msg;
  } catch {
    return "malformed JSON";
  }
}

export function writeJsonLineAndClose(
  socket: NodeNet.Socket,
  payload: Record<string, unknown>,
): void {
  if (socket.destroyed) return;
  const forceDestroy = setTimeout(() => {
    if (!socket.destroyed) socket.destroy();
  }, 250);
  forceDestroy.unref();
  socket.once("close", () => clearTimeout(forceDestroy));
  if (!socket.writable) {
    socket.destroy();
    return;
  }
  try {
    socket.end(`${JSON.stringify(payload)}\n`, () => {
      if (!socket.destroyed) socket.destroy();
    });
  } catch {
    socket.destroy();
  }
}

export function attachSingleJsonLineReader(input: {
  readonly socket: NodeNet.Socket;
  readonly onLine: (line: string) => void;
  readonly onClose: () => void;
}): void {
  const decoder = new NodeStringDecoder.StringDecoder("utf8");
  let buffer = "";
  let rawBytes = 0;
  let handled = false;
  const headerTimeout = setTimeout(() => {
    if (!handled) {
      handled = true;
      writeJsonLineAndClose(input.socket, { ok: false, error: "request timeout" });
    }
  }, 5_000);
  input.socket.on("error", () => clearTimeout(headerTimeout));
  input.socket.on("close", () => {
    clearTimeout(headerTimeout);
    input.onClose();
  });
  input.socket.on("data", (chunk: Buffer) => {
    if (handled) return;
    rawBytes += chunk.byteLength;
    if (rawBytes > MAX_LINE_BYTES) {
      handled = true;
      clearTimeout(headerTimeout);
      writeJsonLineAndClose(input.socket, { ok: false, error: "request too large" });
      return;
    }
    buffer += decoder.write(chunk);
    const newlineIdx = buffer.indexOf("\n");
    if (newlineIdx === -1) return;
    handled = true;
    clearTimeout(headerTimeout);
    input.onLine(buffer.slice(0, newlineIdx).trim());
  });
}
