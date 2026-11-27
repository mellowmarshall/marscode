// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - TypeScript Unix-socket client for MarsCode GuardGrantBroker.
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { WireGuardBundle } from "./bundleInspect.ts";
import { argvSha256 } from "./digests.ts";

const GUARD_SOCKET_ENV = "T3_GUARD_GRANT_SOCKET";
const GUARD_TIMEOUT_ENV = "T3_GUARD_REQUEST_TIMEOUT";
const DEFAULT_SOCKET_NAME = "t3-guard-grant.sock";
const CHECK_TIMEOUT_MS = 1_500;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MIN_REQUEST_TIMEOUT_MS = 1_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const MAX_RESPONSE_BYTES = 65_536;
const PROC_NET_UNIX_RE = /^\s*\S+\s+\S+\s+\S+\s+\S+\s+\S+\s+(\S+)\s+(\d+)\s+(.*)$/;
const CTRL_CHAR_RE = /[\x00-\x1f\x7f]/;

export interface GuardGrantReply {
  readonly ok: boolean;
  readonly grantId?: string | undefined;
  readonly scope?: "once" | "bundle" | undefined;
  readonly reason?: string | undefined;
  readonly approvedBy?: string | undefined;
  readonly approvedVia?: string | undefined;
  readonly signature?: string | undefined;
  readonly threadId?: string | undefined;
  readonly queued?: boolean | undefined;
  readonly coalesced?: boolean | undefined;
  readonly alreadyApproved?: boolean | undefined;
  readonly denied?: boolean | undefined;
  readonly error?: string | undefined;
  readonly errCode?: "unreachable" | "timeout" | "protocol" | undefined;
}

export interface ResolveSocketOptions {
  /**
   * Must be set explicitly by code (e.g. unit tests or a CLI installed inside a temp dir).
   * Caller-controlled `HOST_GUARDS_TEST=1` alone never unlocks custom socket paths.
   */
  readonly allowTestOverride?: boolean | undefined;
}

function isPrivateOwnedDir(dir: string, uid: number): boolean {
  try {
    const st = NodeFS.lstatSync(dir);
    return st.isDirectory() && st.uid === uid && (st.mode & 0o077) === 0;
  } catch {
    return false;
  }
}

function canonicalReal(p: string): string {
  try {
    return NodeFS.realpathSync(p);
  } catch {
    return NodePath.resolve(p);
  }
}

function passwdHomeDir(): string {
  try {
    return NodeOS.userInfo().homedir || NodeOS.homedir();
  } catch {
    return NodeOS.homedir();
  }
}

function defaultGuardSocketDir(): string {
  // Never honor agent-controlled XDG_RUNTIME_DIR in production; use OS-owned /run/user/<uid>.
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  const runDir = `/run/user/${uid}`;
  if (isPrivateOwnedDir(runDir, uid)) {
    return canonicalReal(runDir);
  }
  return NodePath.join(canonicalReal("/tmp"), `t3-guard-${uid}`);
}

function readTrustedServerPid(uid: number): number | null {
  // Read strictly from passwd home, never caller-controlled HOME or T3CODE_HOME.
  const runtimePath = NodePath.join(passwdHomeDir(), ".t3", "userdata", "server-runtime.json");
  try {
    const st = NodeFS.lstatSync(runtimePath);
    if (!st.isFile() || st.uid !== uid || (st.mode & 0o077) !== 0) {
      return null;
    }
    const parsed = JSON.parse(NodeFS.readFileSync(runtimePath, "utf8")) as { pid?: unknown };
    const pid = parsed.pid;
    if (typeof pid !== "number" || !Number.isInteger(pid) || pid <= 1) {
      return null;
    }
    return pid;
  } catch {
    return null;
  }
}

function verifyLinuxSocketPeer(sockPath: string, uid: number, expectedStat: NodeFS.Stats): boolean {
  if (!NodeFS.existsSync("/proc/net/unix")) return true;
  const serverPid = readTrustedServerPid(uid);
  if (serverPid === null) return false;

  // Reject any server PID running inside an agent cgroup.
  try {
    const cg = NodeFS.readFileSync(`/proc/${serverPid}/cgroup`, "utf8");
    if (cg.includes("app-t3code-agents") || cg.includes("t3code-")) {
      return false;
    }
  } catch {
    return false;
  }

  let listeningInode: string | null = null;
  try {
    const table = NodeFS.readFileSync("/proc/net/unix", "utf8");
    for (const line of table.split("\n")) {
      const m = PROC_NET_UNIX_RE.exec(line);
      if (!m) continue;
      const state = m[1];
      const inode = m[2];
      const rawPath = m[3]?.trimEnd() ?? "";
      if (state === "01" && rawPath === sockPath) {
        listeningInode = inode ?? null;
        break;
      }
    }
  } catch {
    return false;
  }
  if (!listeningInode) return false;

  const target = `socket:[${listeningInode}]`;
  let ownsSocket = false;
  try {
    const fdDir = `/proc/${serverPid}/fd`;
    for (const entry of NodeFS.readdirSync(fdDir)) {
      try {
        if (NodeFS.readlinkSync(NodePath.join(fdDir, entry)) === target) {
          ownsSocket = true;
          break;
        }
      } catch {
        // fd closed concurrently
      }
    }
  } catch {
    return false;
  }
  if (!ownsSocket) return false;

  // Re-verify the socket path inode has not been swapped since initial lstat.
  try {
    const after = NodeFS.lstatSync(sockPath);
    return after.isSocket() && after.dev === expectedStat.dev && after.ino === expectedStat.ino;
  } catch {
    return false;
  }
}

/**
 * Resolves the verified owner-only (0600) GuardGrantBroker socket path.
 * Custom socket overrides require `allowTestOverride` + `HOST_GUARDS_TEST=1`.
 */
export function resolveGuardSocketPath(
  env: NodeJS.ProcessEnv = process.env,
  options?: ResolveSocketOptions,
): string | null {
  const testMode = options?.allowTestOverride === true && env.HOST_GUARDS_TEST === "1";
  let sockPath: string;
  if (GUARD_SOCKET_ENV in env) {
    const override = env[GUARD_SOCKET_ENV]?.trim() ?? "";
    if (!override || !testMode) return null;
    sockPath = override;
  } else {
    sockPath = NodePath.join(defaultGuardSocketDir(), DEFAULT_SOCKET_NAME);
  }

  try {
    const st = NodeFS.lstatSync(sockPath);
    const uid = typeof process.getuid === "function" ? process.getuid() : 0;
    if (!st.isSocket() || st.uid !== uid || (st.mode & 0o077) !== 0) {
      return null;
    }
    const parent = NodePath.dirname(sockPath);
    const pst = NodeFS.lstatSync(parent);
    if (!pst.isDirectory() || pst.uid !== uid) return null;
    if (!testMode && (pst.mode & 0o077) !== 0) return null;
    if (NodeFS.realpathSync(sockPath) !== NodePath.resolve(sockPath)) return null;
    if (!testMode && !verifyLinuxSocketPeer(sockPath, uid, st)) return null;
    return sockPath;
  } catch {
    return null;
  }
}

function resolveRequestTimeoutMs(
  env: NodeJS.ProcessEnv = process.env,
  explicitMs?: number,
): number {
  if (explicitMs !== undefined && Number.isFinite(explicitMs)) {
    return Math.max(
      MIN_REQUEST_TIMEOUT_MS,
      Math.min(MAX_REQUEST_TIMEOUT_MS, Math.round(explicitMs)),
    );
  }
  const raw = env[GUARD_TIMEOUT_ENV]?.trim();
  if (raw) {
    const parsed = Number(raw);
    if (Number.isFinite(parsed) && parsed > 0) {
      const ms = parsed <= 600 ? parsed * 1_000 : parsed;
      return Math.max(MIN_REQUEST_TIMEOUT_MS, Math.min(MAX_REQUEST_TIMEOUT_MS, Math.round(ms)));
    }
  }
  return DEFAULT_REQUEST_TIMEOUT_MS;
}

function sendGuardRpc(
  socketPath: string,
  payload: Record<string, unknown>,
  timeoutMs: number,
): Promise<
  | { readonly ok: true; readonly data: Record<string, unknown> }
  | { readonly ok: false; readonly errCode: "unreachable" | "timeout" | "protocol" }
> {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (
      result:
        | { readonly ok: true; readonly data: Record<string, unknown> }
        | { readonly ok: false; readonly errCode: "unreachable" | "timeout" | "protocol" },
    ) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(result);
    };

    const socket = NodeNet.createConnection(socketPath);
    const timer = setTimeout(() => finish({ ok: false, errCode: "timeout" }), timeoutMs);
    const chunks: Buffer[] = [];
    let totalBytes = 0;

    socket.on("error", () => finish({ ok: false, errCode: "unreachable" }));
    socket.on("connect", () => {
      try {
        socket.write(`${JSON.stringify(payload)}\n`);
      } catch {
        finish({ ok: false, errCode: "unreachable" });
      }
    });
    socket.on("data", (chunk: Buffer) => {
      totalBytes += chunk.byteLength;
      if (totalBytes > MAX_RESPONSE_BYTES) {
        finish({ ok: false, errCode: "protocol" });
        return;
      }
      const nl = chunk.indexOf(0x0a);
      if (nl !== -1) {
        chunks.push(chunk.subarray(0, nl));
        const raw = Buffer.concat(chunks).toString("utf8").trim();
        try {
          const parsed = JSON.parse(raw) as unknown;
          if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
            finish({ ok: true, data: parsed as Record<string, unknown> });
            return;
          }
        } catch {
          // fall through to protocol error
        }
        finish({ ok: false, errCode: "protocol" });
        return;
      }
      chunks.push(chunk);
    });
    socket.on("end", () => {
      if (chunks.length === 0) {
        finish({ ok: false, errCode: "protocol" });
        return;
      }
      const raw = Buffer.concat(chunks).toString("utf8").trim();
      try {
        const parsed = JSON.parse(raw) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          finish({ ok: true, data: parsed as Record<string, unknown> });
          return;
        }
      } catch {
        // invalid json
      }
      finish({ ok: false, errCode: "protocol" });
    });
  });
}

function parseGrantReply(
  data: Record<string, unknown>,
  options?: { readonly allowQueued?: boolean },
): GuardGrantReply {
  const rawOk = data.ok === true;
  const queued = data.queued === true;
  const alreadyApproved = data.already_approved === true;
  const scope = data.scope === "bundle" ? "bundle" : data.scope === "once" ? "once" : undefined;

  if (rawOk && !(options?.allowQueued && (queued || alreadyApproved))) {
    const grantId = typeof data.grant_id === "string" ? data.grant_id.trim() : "";
    const approvedBy = data.approved_by;
    const validApprover = approvedBy === undefined || approvedBy === "" || approvedBy === "human";
    if (!grantId || CTRL_CHAR_RE.test(grantId) || !validApprover) {
      return { ok: false, errCode: "protocol", error: "invalid grant reply" };
    }
  }

  return {
    ok: rawOk,
    ...(typeof data.grant_id === "string" ? { grantId: data.grant_id.trim() } : {}),
    ...(scope ? { scope } : {}),
    ...(typeof data.reason === "string" ? { reason: data.reason } : {}),
    ...(typeof data.approved_by === "string" ? { approvedBy: data.approved_by } : {}),
    ...(typeof data.approved_via === "string" ? { approvedVia: data.approved_via } : {}),
    ...(typeof data.signature === "string" ? { signature: data.signature } : {}),
    ...(typeof data.thread_id === "string" ? { threadId: data.thread_id } : {}),
    ...(queued ? { queued: true } : {}),
    ...(data.coalesced === true ? { coalesced: true } : {}),
    ...(alreadyApproved ? { alreadyApproved: true } : {}),
    ...(data.denied === true ? { denied: true } : {}),
    ...(typeof data.error === "string" ? { error: data.error } : {}),
  };
}

function buildBasePayload(input: {
  readonly op: "peek" | "check" | "request";
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly threadId?: string | undefined;
  readonly session?: string | undefined;
  readonly bundle?: WireGuardBundle | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): Record<string, unknown> {
  const env = input.env ?? process.env;
  return {
    v: 1,
    op: input.op,
    guard: input.guard,
    command: input.command,
    argv_sha256: argvSha256(input.command),
    cwd: input.cwd ? canonicalReal(input.cwd) : "",
    thread_id: input.threadId?.trim() || env.T3CODE_THREAD_ID?.trim() || "",
    session: input.session ?? "",
    pid: process.pid,
    ...(input.bundle ? { bundle: input.bundle } : {}),
  };
}

export async function peekGuardGrant(input: {
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly bundle?: WireGuardBundle | undefined;
  readonly threadId?: string | undefined;
  readonly session?: string | undefined;
  readonly socketPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly allowTestOverride?: boolean | undefined;
}): Promise<boolean> {
  const sock =
    input.socketPath ??
    resolveGuardSocketPath(input.env, { allowTestOverride: input.allowTestOverride });
  if (!sock) return false;
  const res = await sendGuardRpc(
    sock,
    buildBasePayload({ ...input, op: "peek" }),
    CHECK_TIMEOUT_MS,
  );
  return res.ok && res.data.ok === true;
}

export async function checkGuardGrant(input: {
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly bundle?: WireGuardBundle | undefined;
  readonly threadId?: string | undefined;
  readonly session?: string | undefined;
  readonly socketPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly allowTestOverride?: boolean | undefined;
}): Promise<GuardGrantReply> {
  const sock =
    input.socketPath ??
    resolveGuardSocketPath(input.env, { allowTestOverride: input.allowTestOverride });
  if (!sock) return { ok: false, errCode: "unreachable", error: "guard socket unavailable" };
  const res = await sendGuardRpc(
    sock,
    buildBasePayload({ ...input, op: "check" }),
    CHECK_TIMEOUT_MS,
  );
  if (!res.ok) return { ok: false, errCode: res.errCode, error: res.errCode };
  return parseGrantReply(res.data);
}

export async function requestGuardGrant(input: {
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly refusal: string;
  readonly proposedReason?: string | undefined;
  readonly bundle?: WireGuardBundle | undefined;
  readonly wait?: boolean | undefined;
  readonly consumeExisting?: boolean | undefined;
  readonly timeoutMs?: number | undefined;
  readonly threadId?: string | undefined;
  readonly session?: string | undefined;
  readonly socketPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly allowTestOverride?: boolean | undefined;
}): Promise<GuardGrantReply> {
  const sock =
    input.socketPath ??
    resolveGuardSocketPath(input.env, { allowTestOverride: input.allowTestOverride });
  if (!sock) return { ok: false, errCode: "unreachable", error: "guard socket unavailable" };
  const timeoutMs = resolveRequestTimeoutMs(input.env, input.timeoutMs);
  const payload: Record<string, unknown> = {
    ...buildBasePayload({ ...input, op: "request" }),
    refusal: input.refusal,
    proposed_reason: input.proposedReason ?? "",
    timeout: Math.ceil(timeoutMs / 1_000),
    ...(input.wait === false ? { wait: false } : {}),
    ...(input.consumeExisting === false ? { consume_existing: false } : {}),
  };
  const res = await sendGuardRpc(sock, payload, timeoutMs + 2_000);
  if (!res.ok) return { ok: false, errCode: res.errCode, error: res.errCode };
  return parseGrantReply(res.data, { allowQueued: input.wait === false });
}

export async function identifyGuardThread(options?: {
  readonly socketPath?: string | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  readonly allowTestOverride?: boolean | undefined;
}): Promise<{ readonly ok: boolean; readonly threadId?: string; readonly error?: string }> {
  const sock =
    options?.socketPath ??
    resolveGuardSocketPath(options?.env, { allowTestOverride: options?.allowTestOverride });
  if (!sock) return { ok: false, error: "guard socket unavailable" };
  const res = await sendGuardRpc(sock, { v: 1, op: "identify" }, CHECK_TIMEOUT_MS);
  if (!res.ok) return { ok: false, error: res.errCode };
  return {
    ok: res.data.ok === true,
    ...(typeof res.data.thread_id === "string" ? { threadId: res.data.thread_id } : {}),
    ...(typeof res.data.error === "string" ? { error: res.data.error } : {}),
  };
}
