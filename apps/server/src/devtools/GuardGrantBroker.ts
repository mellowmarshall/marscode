// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Server-owned 0600 Unix socket broker matching host-guards/hg_t3_grant.py.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeStringDecoder from "node:string_decoder";

export type PeerThreadResolution =
  | { readonly verified: true; readonly threadId: string; readonly peerPid?: number | undefined }
  | { readonly verified: false; readonly error: string };

export interface PendingGuardRequest {
  readonly requestId: string;
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly argvSha256: string;
  readonly cwd: string;
  readonly refusal: string;
  readonly proposedReason: string;
  readonly threadId: string;
  readonly session: string;
  readonly pid: number;
  readonly createdAt: string;
  readonly expiresAt: string;
}

export type GuardBrokerEvent =
  | { readonly type: "snapshot"; readonly pending: ReadonlyArray<PendingGuardRequest> }
  | { readonly type: "pending_added"; readonly request: PendingGuardRequest }
  | {
      readonly type: "pending_resolved";
      readonly requestId: string;
      readonly decision: "approved" | "denied" | "expired" | "disconnected";
    };

export interface GuardGrantBrokerOptions {
  readonly socketPath?: string | undefined;
  readonly defaultGrantTtlMs?: number | undefined;
  readonly defaultRequestTimeoutMs?: number | undefined;
  readonly maxPending?: number | undefined;
  readonly maxPreapproved?: number | undefined;
  readonly auditLogPath?: string | undefined;
  readonly exceptionsPaths?: ReadonlyArray<string> | undefined;
  readonly resolvePeerThreadId?:
    | ((socket: NodeNet.Socket) => Promise<PeerThreadResolution>)
    | undefined;
}

interface StoredGrant {
  readonly grantId: string;
  readonly guard: string;
  readonly argvSha256: string;
  readonly cwd: string;
  readonly reason: string;
  readonly approvedBy: string;
  readonly approvedVia?: string | undefined;
  readonly threadId: string;
  readonly expiresAtMs: number;
}

const MAX_LINE_BYTES = 64 * 1024;
const MAX_ARGS = 256;
const MAX_PENDING_DEFAULT = 64;
const MAX_PREAPPROVED_DEFAULT = 256;
const MAX_CONNECTIONS = 128;
const DEFAULT_GRANT_TTL_MS = 120_000;
const DEFAULT_REQUEST_TIMEOUT_MS = 300_000;
const MIN_REQUEST_TIMEOUT_MS = 5_000;
const MAX_REQUEST_TIMEOUT_MS = 600_000;
const MAX_AUDIT_READ_BYTES = 256 * 1024;
const MAX_EXCEPTIONS_READ_BYTES = 512 * 1024;
const SOCKET_PROBE_TIMEOUT_MS = 300;
const GUARD_NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;

interface PendingEntry {
  readonly request: PendingGuardRequest;
  readonly socket: NodeNet.Socket | null;
  readonly timer: ReturnType<typeof setTimeout>;
  settled: boolean;
}

const HEX_SHA256_RE = /^[0-9a-f]{64}$/;

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

function defaultGuardSocketPath(): string {
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
  // Canonicalize /tmp -> /private/tmp on macOS so broker and client agree on the exact realpath.
  return NodePath.join(canonicalExistingDir("/tmp"), `t3-guard-${uid}`, "t3-guard-grant.sock");
}

function argvSha256(command: ReadonlyArray<string>): string {
  return NodeCrypto.createHash("sha256").update(command.join("\0"), "utf8").digest("hex");
}

function canonicalCwd(cwd: string): string {
  if (!cwd) return "";
  try {
    return NodeFS.realpathSync(cwd);
  } catch {
    return NodePath.resolve(cwd);
  }
}

function grantKey(guard: string, digest: string, cwd: string, threadId = ""): string {
  return `${guard}\0${digest}\0${canonicalCwd(cwd)}\0${threadId}`;
}

function sanitizeText(value: unknown, maxLen: number): string {
  if (typeof value !== "string") return "";
  // Strip C0 control chars and Unicode bidi override chars to avoid spoofing in UI/logs.
  const cleaned = value.replace(/[\u0000-\u001f\u007f\u202a-\u202e\u2066-\u2069]/g, " ").trim();
  return cleaned.length > maxLen ? cleaned.slice(0, maxLen) : cleaned;
}

const ARGV_PROGRAMS = new Set(["curl", "wget", "http", "https", "xh"]);
const ARGV_TOKEN_OPTS = new Set([
  "--token",
  "--access-token",
  "--oauth2-bearer",
  "--password",
  "--http-password",
  "--proxy-user",
  "--user",
  "-u",
]);
const ARGV_SECRET_NAME =
  "(?:access[_-]?token|auth[_-]?token|token|api[_-]?key|apikey|secret|password|passwd|client[_-]?secret)";
const ARGV_AUTH_HEADER_RE = /^\s*(?:--header=)?\s*(?:proxy-)?authorization\s*[:=]/i;
const ARGV_BEARER_RE = /(\bbearer\s+)\S+/gi;
const ARGV_URL_USERINFO_RE = /([a-z][a-z0-9+.-]*:\/\/)[^/@\s:]+:[^/@\s]+@/gi;
const ARGV_QUERY_SECRET_RE = new RegExp(`([?&;]${ARGV_SECRET_NAME}=)[^&\\s]+`, "gi");

function redactUrlSecrets(value: string): string {
  ARGV_URL_USERINFO_RE.lastIndex = 0;
  ARGV_QUERY_SECRET_RE.lastIndex = 0;
  return value
    .replace(ARGV_URL_USERINFO_RE, "$1<redacted>@")
    .replace(ARGV_QUERY_SECRET_RE, "$1<redacted>");
}

const FLY_NON_SECRET_VALUE_SHORTS = new Set(["a", "c", "o", "r", "A", "g"]);
const FLY_NON_SECRET_VALUE_LONGS = new Set([
  "--address",
  "--app",
  "--config",
  "--container",
  "--group",
  "--hours",
  "--machine",
  "--org",
  "--process-group",
  "--region",
]);

function scanFlyShortFlag(
  arg: string,
  nxt: string,
): {
  readonly kind: "C" | "t" | "u" | "value";
  readonly splitPos: number;
  readonly value: string;
} | null {
  if (!arg.startsWith("-") || arg.startsWith("--") || arg.length < 2) return null;
  for (let pos = 1; pos < arg.length; pos += 1) {
    const ch = arg[pos]!;
    if (FLY_NON_SECRET_VALUE_SHORTS.has(ch)) {
      const value = pos + 1 < arg.length ? arg.slice(pos + 1) : nxt;
      return { kind: "value", splitPos: pos + 1, value };
    }
    if (ch === "C" || ch === "t" || ch === "u") {
      const value = pos + 1 < arg.length ? arg.slice(pos + 1) : nxt;
      return { kind: ch, splitPos: pos + 1, value };
    }
    if (!/[A-Za-z]/.test(ch)) return null;
  }
  return null;
}

function redactRemoteCommand(): string {
  // Unconditionally redact fly ssh remote command strings in previews and audit logs
  // so no quoted credential flag, whitespace username, or shell trick can ever leak.
  return "<redacted-remote-command>";
}

/**
 * Server-side secret redaction for `argv` guard display previews (mirrors `host-guards/hg_argv.py`).
 * Raw secrets stay strictly ephemeral during SHA-256 verification and never enter stored requests, SSE, or UI.
 */
export function redactArgvCommand(words: ReadonlyArray<string>): ReadonlyArray<string> {
  if (words.length === 0) return [];
  const program = NodePath.basename(words[0]!);
  const args = words.slice(1);
  const flySsh = (program === "fly" || program === "flyctl") && args.includes("ssh");
  if (!ARGV_PROGRAMS.has(program) && !flySsh) {
    return [...words];
  }
  const out: string[] = [words[0]!];
  let skipNext = false;
  let skipMode: "redacted" | "none" | "verbatim" = "redacted";
  let afterDoubleDash = false;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (skipNext) {
      if (skipMode === "redacted") out.push("<redacted>");
      else if (skipMode === "verbatim") out.push(a);
      skipNext = false;
      skipMode = "redacted";
      continue;
    }
    const nxt = i + 1 < args.length ? args[i + 1]! : "";
    const eqIdx = a.indexOf("=");
    const name = eqIdx === -1 ? a : a.slice(0, eqIdx);
    const hasEq = eqIdx !== -1;
    const value = hasEq ? a.slice(eqIdx + 1) : "";

    if (!afterDoubleDash && a === "--") {
      afterDoubleDash = true;
      out.push(a);
      continue;
    }
    // Handle fly ssh flags (including pflag combined short flags & value-taking flags) FIRST.
    if (flySsh && !afterDoubleDash) {
      if (a === "--command" && nxt) {
        out.push(a, redactRemoteCommand());
        skipNext = true;
        skipMode = "none";
        continue;
      }
      if (a.startsWith("--command=")) {
        out.push(`--command=${redactRemoteCommand()}`);
        continue;
      }
      if (a === "--user") {
        out.push(a);
        if (nxt) {
          skipNext = true;
          skipMode = nxt.includes(":") ? "redacted" : "verbatim";
        }
        continue;
      }
      if (a.startsWith("--user=")) {
        out.push(a.slice(7).includes(":") ? "--user=<redacted>" : a);
        continue;
      }
      if (FLY_NON_SECRET_VALUE_LONGS.has(a)) {
        out.push(a);
        if (nxt) {
          skipNext = true;
          skipMode = "verbatim";
        }
        continue;
      }
      if (hasEq && FLY_NON_SECRET_VALUE_LONGS.has(name)) {
        out.push(a);
        continue;
      }
      const shortHit = scanFlyShortFlag(a, nxt);
      if (shortHit?.kind === "C") {
        if (shortHit.splitPos < a.length) {
          out.push(`${a.slice(0, shortHit.splitPos)}${redactRemoteCommand()}`);
        } else if (nxt) {
          out.push(a, redactRemoteCommand());
          skipNext = true;
          skipMode = "none";
        } else {
          out.push(a);
        }
        continue;
      }
      if (shortHit?.kind === "t") {
        if (shortHit.splitPos < a.length) {
          out.push(`${a.slice(0, shortHit.splitPos)}<redacted>`);
        } else if (nxt) {
          out.push(a);
          skipNext = true;
          skipMode = "redacted";
        } else {
          out.push(a);
        }
        continue;
      }
      if (shortHit?.kind === "u") {
        if (shortHit.value.includes(":")) {
          if (shortHit.splitPos < a.length) {
            out.push(`${a.slice(0, shortHit.splitPos)}<redacted>`);
          } else if (nxt) {
            out.push(a);
            skipNext = true;
            skipMode = "redacted";
          } else {
            out.push(a);
          }
        } else {
          out.push(a);
          if (shortHit.splitPos === a.length && nxt) {
            skipNext = true;
            skipMode = "verbatim";
          }
        }
        continue;
      }
      if (shortHit?.kind === "value") {
        out.push(a);
        if (shortHit.splitPos === a.length && nxt) {
          skipNext = true;
          skipMode = "verbatim";
        }
        continue;
      }
    }
    if (!afterDoubleDash) {
      if ((a === "-H" || a === "--header") && ARGV_AUTH_HEADER_RE.test(nxt)) {
        out.push(a);
        skipNext = true;
        continue;
      }
      if (
        ARGV_AUTH_HEADER_RE.test(a) ||
        (a.startsWith("-H") && ARGV_AUTH_HEADER_RE.test(a.slice(2)))
      ) {
        const prefix = a.toLowerCase().startsWith("--header=")
          ? "--header="
          : a.startsWith("-H")
            ? "-H"
            : "";
        out.push(`${prefix}<redacted-auth-header>`);
        continue;
      }
      if (
        ARGV_TOKEN_OPTS.has(name) &&
        ((hasEq && value) || (!hasEq && nxt && !nxt.startsWith("-")))
      ) {
        const credVal = hasEq ? value : nxt;
        if (
          (name === "-u" || name === "--user" || name === "--proxy-user") &&
          !credVal.includes(":")
        ) {
          out.push(a);
          if (!hasEq && nxt) {
            skipNext = true;
            skipMode = "verbatim";
          }
          continue;
        }
        if (hasEq) {
          out.push(`${name}=<redacted>`);
        } else {
          out.push(a);
          skipNext = true;
        }
        continue;
      }
    }
    let cur = a;
    ARGV_BEARER_RE.lastIndex = 0;
    cur = cur.replace(ARGV_BEARER_RE, "$1<redacted>");
    cur = redactUrlSecrets(cur);
    out.push(cur);
  }
  return out;
}

function validateGuardAndCommand(
  rawGuard: unknown,
  rawCommand: unknown,
  suppliedDigest?: unknown,
):
  | {
      readonly ok: true;
      readonly guard: string;
      readonly displayCommand: ReadonlyArray<string>;
      readonly digest: string;
    }
  | { readonly ok: false; readonly error: string } {
  if (typeof rawGuard !== "string" || !GUARD_NAME_RE.test(rawGuard)) {
    return { ok: false, error: "invalid guard name" };
  }
  if (!Array.isArray(rawCommand) || rawCommand.length === 0) {
    return { ok: false, error: "command must be a non-empty string array" };
  }
  if (rawCommand.length > MAX_ARGS) {
    return { ok: false, error: `command exceeds max ${MAX_ARGS} arguments` };
  }
  const command: string[] = [];
  for (const item of rawCommand) {
    if (typeof item !== "string") {
      return { ok: false, error: "command arguments must be strings" };
    }
    if (item.includes("\0")) {
      return { ok: false, error: "command arguments must not contain NUL bytes" };
    }
    command.push(item);
  }
  // Always verify supplied argv_sha256 against the exact command so preview and grant digest cannot diverge.
  const computed = argvSha256(command);
  if (suppliedDigest !== undefined && suppliedDigest !== "") {
    if (
      typeof suppliedDigest !== "string" ||
      !HEX_SHA256_RE.test(suppliedDigest) ||
      suppliedDigest !== computed
    ) {
      return { ok: false, error: "argv_sha256 mismatch" };
    }
  }
  const displayCommand = rawGuard === "argv" ? redactArgvCommand(command) : command;
  return { ok: true, guard: rawGuard, displayCommand, digest: computed };
}

function readRegularFileRange(
  filePath: string,
  maxBytes: number,
  mode: "head" | "tail",
): { readonly text: string; readonly truncated: boolean } | null {
  let fd: number | null = null;
  try {
    const flags = NodeFS.constants.O_RDONLY | (NodeFS.constants.O_NOFOLLOW ?? 0);
    fd = NodeFS.openSync(filePath, flags);
    const stat = NodeFS.fstatSync(fd);
    if (!stat.isFile()) return null;
    if (mode === "head" && stat.size > maxBytes) {
      return null;
    }
    const truncated = stat.size > maxBytes;
    const size = Math.min(stat.size, maxBytes);
    if (size === 0) return { text: "", truncated: false };
    const start = mode === "tail" ? Math.max(0, stat.size - size) : 0;
    const buf = Buffer.alloc(size);
    let offset = 0;
    while (offset < size) {
      const n = NodeFS.readSync(fd, buf, offset, size - offset, start + offset);
      if (n <= 0) break;
      offset += n;
    }
    return { text: buf.subarray(0, offset).toString("utf8"), truncated };
  } catch {
    return null;
  } finally {
    if (fd !== null) {
      try {
        NodeFS.closeSync(fd);
      } catch {
        // ignore close failure
      }
    }
  }
}

function resolveConfiguredStateDir(): string {
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
    // Attempt tightening if we just created it or own a temp subdir; refuse shared dirs like /tmp.
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

const LINUX_PEER_THREAD_PY = `
import os, re, socket, struct, sys

ino = int(sys.argv[1])
srv = int(sys.argv[2])
s = socket.socket(socket.AF_NETLINK, socket.SOCK_DGRAM, 4)
s.settimeout(1.0)
body = struct.pack("=BBHIIIII", socket.AF_UNIX, 0, 0, 0xFFFFFFFF, ino, 0x04, 0xFFFFFFFF, 0xFFFFFFFF)
hdr = struct.pack("=IHHII", 16 + len(body), 20, 1 | 0x300, 1, 0)
s.send(hdr + body)
peer_ino = None
while True:
    data = s.recv(65536)
    off = 0
    done = False
    while off + 16 <= len(data):
        mlen, mtype, _f, _q, _p = struct.unpack_from("=IHHII", data, off)
        if mtype in (2, 3):
            done = True
            break
        if mtype == 20:
            _fam, _st, _state, _pad, uino, _c0, _c1 = struct.unpack_from("=BBBBIII", data, off + 16)
            if uino == ino:
                aoff = off + 32
                while aoff + 4 <= off + mlen:
                    alen, atype = struct.unpack_from("=HH", data, aoff)
                    if atype == 2 and alen >= 8:
                        peer_ino = struct.unpack_from("=I", data, aoff + 4)[0]
                    aoff += (alen + 3) & ~3
        off += (mlen + 3) & ~3
    if done:
        break
if not peer_ino:
    print("ERR:no-peer-inode")
    sys.exit(0)
target = f"socket:[{peer_ino}]"
me = os.getpid()
pids = []
for name in os.listdir("/proc"):
    if not name.isdigit():
        continue
    p = int(name)
    if p == me:
        continue
    try:
        for fdname in os.listdir(f"/proc/{p}/fd"):
            try:
                if os.readlink(f"/proc/{p}/fd/{fdname}") == target:
                    pids.append(p)
                    break
            except OSError:
                pass
    except OSError:
        pass
if not pids:
    print("ERR:no-peer-pid")
    sys.exit(0)
if len(pids) != 1:
    print("ERR:ambiguous-peer-holders")
    sys.exit(0)

def ppid_of(p):
    try:
        with open(f"/proc/{p}/stat", encoding="utf-8", errors="replace") as fh:
            return int(fh.read().rsplit(")", 1)[1].split()[1])
    except Exception:
        return 0

def env_tid(p):
    try:
        with open(f"/proc/{p}/environ", "rb") as fh:
            for item in fh.read().split(b"\\0"):
                if item.startswith(b"T3CODE_THREAD_ID="):
                    return item[17:].decode("utf-8", errors="replace").strip()
    except OSError:
        pass
    return ""

UNTRUSTED_EXE_PFX = ("/tmp/", "/var/tmp/", "/dev/shm/", "/private/tmp/", "/private/var/tmp/")
CODEX_SLICE_SCOPE_RE = re.compile(
    r"/app-t3code-agents(?:-[0-9a-f]+)?\\.slice/t3code-codex-[A-Za-z0-9_.-]+\\.scope(?:\\s|$)"
)

def is_codex_app_server(p):
    try:
        if os.stat(f"/proc/{p}").st_uid != os.getuid():
            return False
        exe = os.readlink(f"/proc/{p}/exe").removesuffix(" (deleted)")
        if not exe or exe.startswith(UNTRUSTED_EXE_PFX):
            return False
        with open(f"/proc/{p}/cmdline", "rb") as fh:
            argv = [a.decode("utf-8", errors="replace") for a in fh.read().split(b"\\0") if a]
        exe_base = os.path.basename(exe).lower()
        if exe_base == "codex":
            ok_exec = bool(argv) and os.path.basename(argv[0]).lower() == "codex" and "app-server" in argv[1:3]
        elif exe_base in ("node", "bun") and len(argv) >= 3:
            script = os.path.realpath(argv[1])
            ok_exec = (
                os.path.isfile(script)
                and not script.startswith(UNTRUSTED_EXE_PFX)
                and os.path.basename(script).lower() in ("codex", "codex.js")
                and "app-server" in argv[2:4]
            )
        else:
            return False
        if not ok_exec:
            return False
        with open(f"/proc/{p}/cgroup", encoding="utf-8", errors="replace") as fh:
            cg = fh.read()
        return bool(cg and CODEX_SLICE_SCOPE_RE.search(cg))
    except OSError:
        return False

def exe_id(p):
    try:
        st = os.stat(f"/proc/{p}/exe")
    except OSError:
        return None
    return (st.st_dev, st.st_ino)

def is_t3_process_launcher(p, server_exe):
    try:
        if os.stat(f"/proc/{p}").st_uid != os.getuid():
            return False
        if exe_id(p) != server_exe:
            return False
        with open(f"/proc/{p}/cmdline", "rb") as fh:
            argv = [a.decode("utf-8", errors="replace") for a in fh.read().split(b"\\0") if a]
    except OSError:
        return False
    if len(argv) == 2 and argv[1] == "__process-launcher":
        return True
    if len(argv) == 2 and os.path.basename(argv[1]) == "process-launcher.mjs":
        return True
    if len(argv) == 3 and argv[1] == "--experimental-strip-types" and os.path.basename(argv[2]) == "process-launcher.ts":
        return True
    return False

def resolve_pid(p):
    if p == srv:
        return ""
    chain = []
    cur = p
    seen = set()
    reached = False
    while cur > 1 and cur not in seen and len(chain) < 64:
        if cur == srv:
            reached = True
            break
        seen.add(cur)
        chain.append(cur)
        cur = ppid_of(cur)
    if not (reached and chain):
        return ""
    top = len(chain) - 1
    server_exe = exe_id(srv)
    if top > 0 and server_exe is not None and not env_tid(chain[top]) and is_t3_process_launcher(chain[top], server_exe):
        top -= 1
    tid = env_tid(chain[top])
    if tid:
        return tid
    if top >= 1 and is_codex_app_server(chain[top]):
        return env_tid(chain[top - 1])
    return ""

peer_pid = pids[0]
print(f"OK:{peer_pid}:{resolve_pid(peer_pid)}")
`.trim();

function defaultResolvePeerThreadId(
  socket: NodeNet.Socket,
  platform: NodeJS.Platform,
): Promise<PeerThreadResolution> {
  if (platform !== "linux") {
    return Promise.resolve({
      verified: false,
      error: "cannot verify caller thread ownership on this platform",
    });
  }
  const fd = (socket as unknown as { readonly _handle?: { readonly fd?: number } })._handle?.fd;
  if (typeof fd !== "number" || !Number.isInteger(fd) || fd < 0) {
    return Promise.resolve({ verified: false, error: "cannot inspect client socket descriptor" });
  }
  let serverIno: string;
  try {
    const link = NodeFS.readlinkSync(`/proc/self/fd/${fd}`);
    const match = /^socket:\[(\d+)\]$/.exec(link);
    if (!match?.[1]) {
      return Promise.resolve({ verified: false, error: "cannot inspect client socket inode" });
    }
    serverIno = match[1];
  } catch {
    return Promise.resolve({ verified: false, error: "cannot inspect client socket inode" });
  }
  const pythonBin = NodeFS.existsSync("/usr/bin/python3") ? "/usr/bin/python3" : "python3";
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      pythonBin,
      ["-I", "-c", LINUX_PEER_THREAD_PY, serverIno, String(process.pid)],
      { timeout: 2_000, maxBuffer: 4096 },
      (err, stdout) => {
        if (err) {
          resolve({ verified: false, error: "cannot verify caller thread ownership" });
          return;
        }
        const line = stdout.trim();
        if (!line.startsWith("OK:")) {
          resolve({ verified: false, error: "cannot verify caller thread ownership" });
          return;
        }
        const rest = line.slice(3);
        const sep = rest.indexOf(":");
        if (sep === -1) {
          resolve({ verified: false, error: "cannot verify caller thread ownership" });
          return;
        }
        const peerPid = Number.parseInt(rest.slice(0, sep), 10);
        const threadId = sanitizeText(rest.slice(sep + 1), 128);
        resolve({
          verified: true,
          threadId,
          ...(Number.isInteger(peerPid) && peerPid > 0 ? { peerPid } : {}),
        });
      },
    );
  });
}

export class GuardGrantBroker {
  readonly socketPath: string;
  private defaultGrantTtlMs: number;
  private defaultRequestTimeoutMs: number;
  private readonly maxPending: number;
  private readonly maxPreapproved: number;
  private readonly auditLogPathOverride: string | undefined;
  private readonly exceptionsPathsOverride: ReadonlyArray<string> | undefined;
  private readonly resolvePeerThreadId: (
    socket: NodeNet.Socket,
    platform: NodeJS.Platform,
  ) => Promise<PeerThreadResolution>;
  private readonly hasCustomResolver: boolean;

  private server: NodeNet.Server | null = null;
  private startPromise: Promise<void> | null = null;
  private platform: NodeJS.Platform = "linux";
  private boundStat: { readonly dev: number; readonly ino: number } | null = null;
  private readonly activeSockets = new Set<NodeNet.Socket>();
  private readonly preapproved = new Map<string, StoredGrant>();
  private readonly pending = new Map<string, PendingEntry>();
  private readonly subscribers = new Set<(event: GuardBrokerEvent) => void>();
  private closed = false;

  constructor(options: GuardGrantBrokerOptions = {}) {
    this.socketPath = options.socketPath ?? defaultGuardSocketPath();
    this.defaultGrantTtlMs = options.defaultGrantTtlMs ?? DEFAULT_GRANT_TTL_MS;
    this.defaultRequestTimeoutMs = options.defaultRequestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    this.maxPending = options.maxPending ?? MAX_PENDING_DEFAULT;
    this.maxPreapproved = options.maxPreapproved ?? MAX_PREAPPROVED_DEFAULT;
    this.auditLogPathOverride = options.auditLogPath;
    this.exceptionsPathsOverride = options.exceptionsPaths;
    this.hasCustomResolver = options.resolvePeerThreadId !== undefined;
    this.resolvePeerThreadId = options.resolvePeerThreadId ?? defaultResolvePeerThreadId;
  }

  get listening(): boolean {
    return this.server !== null && this.server.listening && !this.closed;
  }

  setRuntimeTimeouts(options: {
    readonly defaultGrantTtlMs?: number | undefined;
    readonly defaultRequestTimeoutMs?: number | undefined;
  }): void {
    if (
      typeof options.defaultGrantTtlMs === "number" &&
      Number.isFinite(options.defaultGrantTtlMs) &&
      options.defaultGrantTtlMs >= 10_000 &&
      options.defaultGrantTtlMs <= 600_000
    ) {
      this.defaultGrantTtlMs = Math.round(options.defaultGrantTtlMs);
    }
    if (
      typeof options.defaultRequestTimeoutMs === "number" &&
      Number.isFinite(options.defaultRequestTimeoutMs) &&
      options.defaultRequestTimeoutMs >= MIN_REQUEST_TIMEOUT_MS &&
      options.defaultRequestTimeoutMs <= MAX_REQUEST_TIMEOUT_MS
    ) {
      this.defaultRequestTimeoutMs = Math.round(options.defaultRequestTimeoutMs);
    }
  }

  start(platform: NodeJS.Platform = "linux"): Promise<void> {
    this.platform = platform;
    if (this.closed || platform === "win32") return Promise.resolve();
    if (platform !== "linux" && !this.hasCustomResolver) return Promise.resolve();
    if (this.server) return Promise.resolve();
    if (this.startPromise) return this.startPromise;
    this.startPromise = this.doStart().finally(() => {
      this.startPromise = null;
    });
    return this.startPromise;
  }

  private async doStart(): Promise<void> {
    ensurePrivateParentDir(this.socketPath);

    try {
      const existing = NodeFS.lstatSync(this.socketPath);
      if (!existing.isSocket()) {
        throw new Error(`Refusing to replace non-socket path at ${this.socketPath}`);
      }
      const probedDev = existing.dev;
      const probedIno = existing.ino;
      const alive = await probeSocketAlive(this.socketPath);
      if (alive) {
        throw new Error(`Guard socket ${this.socketPath} is already owned by a live broker`);
      }
      if (this.closed) return;
      // Re-verify inode identity right before unlink so concurrent startup cannot unlink a live replacement.
      const recheck = NodeFS.lstatSync(this.socketPath);
      if (recheck.isSocket() && recheck.dev === probedDev && recheck.ino === probedIno) {
        NodeFS.unlinkSync(this.socketPath);
      } else {
        throw new Error(`Guard socket ${this.socketPath} was replaced during startup`);
      }
    } catch (err) {
      if ((err as NodeJS.ErrnoException)?.code !== "ENOENT") {
        throw err;
      }
    }

    if (this.closed) return;

    const server = NodeNet.createServer((socket) => {
      this.handleConnection(socket);
    });
    server.maxConnections = MAX_CONNECTIONS;

    await new Promise<void>((resolve, reject) => {
      const onError = (err: Error) => {
        server.removeListener("listening", onListening);
        reject(err);
      };
      const onListening = () => {
        server.removeListener("error", onError);
        try {
          NodeFS.chmodSync(this.socketPath, 0o600);
          const st = NodeFS.lstatSync(this.socketPath);
          this.boundStat = { dev: st.dev, ino: st.ino };
        } catch {
          // best-effort; parent dir is already 0700 owner-only
        }
        resolve();
      };
      server.once("error", onError);
      server.once("listening", onListening);
      server.listen(this.socketPath);
    });

    if (this.closed) {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      this.unlinkOwnedSocket();
      return;
    }

    server.on("error", () => {
      // Keep running; per-socket errors are handled on each client socket.
    });
    this.server = server;
  }

  private unlinkOwnedSocket(): void {
    const owned = this.boundStat;
    this.boundStat = null;
    if (!owned) return;
    try {
      const st = NodeFS.lstatSync(this.socketPath);
      if (st.isSocket() && st.dev === owned.dev && st.ino === owned.ino) {
        NodeFS.unlinkSync(this.socketPath);
      }
    } catch {
      // ignore missing/replaced socket
    }
  }

  async close(): Promise<void> {
    this.closed = true;
    if (this.startPromise) {
      try {
        await this.startPromise;
      } catch {
        // ignore failed startup during shutdown
      }
    }

    for (const entry of this.pending.values()) {
      // Shutdown is broker unavailability, NOT an explicit owner denial.
      this.finishPending(entry, "disconnected", {
        ok: false,
        denied: false,
        error: "T3 Code server shutting down",
      });
    }
    this.pending.clear();
    this.preapproved.clear();

    for (const socket of this.activeSockets) {
      socket.destroy();
    }
    this.activeSockets.clear();

    const server = this.server;
    this.server = null;
    if (server) {
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    }
    this.unlinkOwnedSocket();
  }

  listPending(): ReadonlyArray<PendingGuardRequest> {
    return Array.from(this.pending.values(), (entry) => entry.request);
  }

  subscribe(listener: (event: GuardBrokerEvent) => void): () => void {
    this.subscribers.add(listener);
    return () => {
      this.subscribers.delete(listener);
    };
  }

  private emit(event: GuardBrokerEvent): void {
    for (const listener of this.subscribers) {
      try {
        listener(event);
      } catch {
        // isolate subscriber failures
      }
    }
  }

  preapprove(input: {
    readonly guard: string;
    readonly command: ReadonlyArray<string>;
    readonly cwd: string;
    readonly reason?: string | undefined;
    readonly threadId?: string | undefined;
    readonly ttlMs?: number | undefined;
    readonly approvedVia?: string | undefined;
  }):
    | { readonly ok: true; readonly grantId: string; readonly expiresAt: string }
    | { readonly ok: false; readonly error: string } {
    if (!this.listening) {
      return { ok: false, error: "guard grant broker is not listening" };
    }
    this.pruneExpiredGrants();
    const validated = validateGuardAndCommand(input.guard, input.command);
    if (!validated.ok) {
      return validated;
    }
    if (this.preapproved.size >= this.maxPreapproved) {
      return { ok: false, error: "too many pre-approved grants pending" };
    }

    const ttlMs = Math.max(5_000, Math.min(600_000, input.ttlMs ?? this.defaultGrantTtlMs));
    const expiresAtMs = Date.now() + ttlMs;
    const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
    const threadId = sanitizeText(input.threadId, 128);
    const grant: StoredGrant = {
      grantId,
      guard: validated.guard,
      argvSha256: validated.digest,
      cwd: canonicalCwd(input.cwd),
      reason: sanitizeText(input.reason, 400) || "approved in T3 Code",
      approvedBy: "human",
      approvedVia: input.approvedVia,
      threadId,
      expiresAtMs,
    };
    this.preapproved.set(grantKey(validated.guard, validated.digest, grant.cwd, threadId), grant);
    return { ok: true, grantId, expiresAt: new Date(expiresAtMs).toISOString() };
  }

  resolveRequest(
    requestId: string,
    input: {
      readonly decision: "approve" | "deny";
      readonly reason?: string | undefined;
      readonly approvedVia?: string | undefined;
    },
  ): { readonly found: boolean; readonly grantId?: string } {
    const entry = this.pending.get(requestId);
    if (!entry || entry.settled) {
      return { found: false };
    }

    if (input.decision === "approve") {
      const grantId = `t3g_${NodeCrypto.randomBytes(12).toString("hex")}`;
      const reason =
        sanitizeText(input.reason, 400) || entry.request.proposedReason || "approved in T3 Code";
      // For non-blocking hook requests (socket === null), store a thread-bound single-use grant
      // so the caller's retry consumes it via `check` without ever blocking a PreToolUse hook.
      if (entry.socket === null) {
        if (!entry.request.threadId) {
          this.finishPending(entry, "denied", {
            ok: false,
            denied: true,
            error: "override requests require a verified thread_id",
          });
          return { found: true };
        }
        this.pruneExpiredGrants();
        const expiresAtMs = Date.now() + this.defaultGrantTtlMs;
        const grant: StoredGrant = {
          grantId,
          guard: entry.request.guard,
          argvSha256: entry.request.argvSha256,
          cwd: entry.request.cwd,
          reason,
          approvedBy: "human",
          approvedVia: input.approvedVia,
          threadId: entry.request.threadId,
          expiresAtMs,
        };
        this.preapproved.set(
          grantKey(grant.guard, grant.argvSha256, grant.cwd, grant.threadId),
          grant,
        );
      }
      this.finishPending(entry, "approved", {
        ok: true,
        grant_id: grantId,
        reason,
        approved_by: "human",
        ...(input.approvedVia ? { approved_via: input.approvedVia } : {}),
        thread_id: entry.request.threadId,
      });
      return { found: true, grantId };
    }

    const reason = sanitizeText(input.reason, 400) || "denied by owner in T3 Code";
    this.finishPending(entry, "denied", {
      ok: false,
      denied: true,
      error: reason,
    });
    return { found: true };
  }

  readAuditTail(limit = 50): ReadonlyArray<Record<string, unknown>> {
    const cappedLimit = Math.max(1, Math.min(200, Math.floor(limit)));
    const logPath =
      this.auditLogPathOverride ?? NodePath.join(resolveConfiguredStateDir(), "overrides.log");
    const result = readRegularFileRange(logPath, MAX_AUDIT_READ_BYTES, "tail");
    if (!result || !result.text) return [];
    let raw = result.text;
    if (result.truncated) {
      const firstNl = raw.indexOf("\n");
      raw = firstNl === -1 ? "" : raw.slice(firstNl + 1);
    }
    const lines = raw
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    const tail = lines.slice(-cappedLimit);
    return tail.map((line) => {
      try {
        const parsed = JSON.parse(line) as unknown;
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          const rec = parsed as Record<string, unknown>;
          // Redact legacy audit records at read time so historical raw argv entries never leak secrets.
          if (Array.isArray(rec.command) && rec.command.every((v) => typeof v === "string")) {
            return { ...rec, command: redactArgvCommand(rec.command) };
          }
          return rec;
        }
      } catch {
        // Never echo unparsed plain-text audit lines over HTTP (could contain legacy raw secrets).
      }
      return { unparsed: true };
    });
  }

  readExceptions(): { readonly path: string | null; readonly entries: unknown } {
    const home = NodeOS.homedir();
    const candidates = this.exceptionsPathsOverride ?? [
      NodePath.join(home, ".local", "lib", "exceptions.json"),
      NodePath.join(home, ".local", "lib", "host-guards", "exceptions.json"),
    ];
    for (const candidate of candidates) {
      const res = readRegularFileRange(candidate, MAX_EXCEPTIONS_READ_BYTES, "head");
      if (!res || !res.text) continue;
      try {
        return { path: candidate, entries: JSON.parse(res.text) as unknown };
      } catch {
        return { path: candidate, entries: null };
      }
    }
    return { path: null, entries: null };
  }

  private pruneExpiredGrants(): void {
    const now = Date.now();
    for (const [k, grant] of this.preapproved) {
      if (grant.expiresAtMs <= now) {
        this.preapproved.delete(k);
      }
    }
  }

  private finishPending(
    entry: PendingEntry,
    decision: "approved" | "denied" | "expired" | "disconnected",
    payload: Record<string, unknown>,
  ): void {
    if (entry.settled) return;
    entry.settled = true;
    clearTimeout(entry.timer);
    this.pending.delete(entry.request.requestId);
    if (entry.socket !== null) {
      this.writeAndClose(entry.socket, payload);
    }
    this.emit({
      type: "pending_resolved",
      requestId: entry.request.requestId,
      decision,
    });
  }

  private writeAndClose(socket: NodeNet.Socket, payload: Record<string, unknown>): void {
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

  private lookupPreapproved(
    guard: string,
    digest: string,
    cwd: string,
    threadId: string,
  ): { readonly key: string; readonly grant: StoredGrant } | null {
    // Thread-bound grants match only their owning thread; unscoped manual preapprovals (threadId === "") match any thread.
    if (threadId) {
      const exactKey = grantKey(guard, digest, cwd, threadId);
      const exact = this.preapproved.get(exactKey);
      if (exact) return { key: exactKey, grant: exact };
    }
    const unscopedKey = grantKey(guard, digest, cwd, "");
    const unscoped = this.preapproved.get(unscopedKey);
    if (unscoped) return { key: unscopedKey, grant: unscoped };
    return null;
  }

  private handleConnection(socket: NodeNet.Socket): void {
    if (this.closed) {
      socket.destroy();
      return;
    }
    this.activeSockets.add(socket);
    const decoder = new NodeStringDecoder.StringDecoder("utf8");
    let buffer = "";
    let rawBytes = 0;
    let handled = false;

    const headerTimeout = setTimeout(() => {
      if (!handled) {
        handled = true;
        this.writeAndClose(socket, { ok: false, error: "request timeout" });
      }
    }, 5_000);

    socket.on("error", () => {
      clearTimeout(headerTimeout);
    });
    socket.on("close", () => {
      clearTimeout(headerTimeout);
      this.activeSockets.delete(socket);
    });

    socket.on("data", (chunk: Buffer) => {
      if (handled) return;
      rawBytes += chunk.byteLength;
      if (rawBytes > MAX_LINE_BYTES) {
        handled = true;
        clearTimeout(headerTimeout);
        this.writeAndClose(socket, { ok: false, error: "request too large" });
        return;
      }
      buffer += decoder.write(chunk);
      const newlineIdx = buffer.indexOf("\n");
      if (newlineIdx === -1) return;

      handled = true;
      clearTimeout(headerTimeout);
      const line = buffer.slice(0, newlineIdx).trim();
      void this.handleMessage(socket, line).catch(() => {
        this.writeAndClose(socket, { ok: false, error: "internal broker error" });
      });
    });
  }

  private async handleMessage(socket: NodeNet.Socket, line: string): Promise<void> {
    if (this.closed) {
      this.writeAndClose(socket, { ok: false, denied: false, error: "broker closed" });
      return;
    }
    let msg: Record<string, unknown>;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        this.writeAndClose(socket, { ok: false, error: "invalid JSON object" });
        return;
      }
      msg = parsed as Record<string, unknown>;
    } catch {
      this.writeAndClose(socket, { ok: false, error: "malformed JSON" });
      return;
    }

    if (msg.v !== 1) {
      this.writeAndClose(socket, { ok: false, error: "unsupported protocol version" });
      return;
    }

    const op = typeof msg.op === "string" ? msg.op : "";
    if (op !== "peek" && op !== "check" && op !== "request") {
      this.writeAndClose(socket, { ok: false, error: "unsupported op" });
      return;
    }
    const validated = validateGuardAndCommand(msg.guard, msg.command, msg.argv_sha256);
    if (!validated.ok) {
      this.writeAndClose(socket, { ok: false, error: validated.error });
      return;
    }
    const cwd = typeof msg.cwd === "string" ? canonicalCwd(msg.cwd) : "";
    const reqThreadId = sanitizeText(msg.thread_id, 128);

    // Verify caller thread ownership from the kernel peer PID / ancestor T3 environment.
    // Never trust a self-reported thread_id to match/consume thread-bound grants or forge thread UI requests.
    const peer = await this.resolvePeerThreadId(socket, this.platform);
    if (this.closed || socket.destroyed) {
      return;
    }
    if (!peer.verified) {
      this.writeAndClose(socket, { ok: false, error: peer.error });
      return;
    }
    if (reqThreadId && reqThreadId !== peer.threadId) {
      this.writeAndClose(socket, { ok: false, error: "thread_id does not match caller process" });
      return;
    }
    const effectiveThreadId = peer.threadId;

    this.pruneExpiredGrants();
    const matched = this.lookupPreapproved(
      validated.guard,
      validated.digest,
      cwd,
      effectiveThreadId,
    );

    if (op === "peek") {
      this.writeAndClose(socket, { ok: matched !== null });
      return;
    }

    if (op === "check") {
      if (!matched) {
        this.writeAndClose(socket, { ok: false });
        return;
      }
      this.preapproved.delete(matched.key);
      this.writeAndClose(socket, {
        ok: true,
        grant_id: matched.grant.grantId,
        reason: matched.grant.reason,
        approved_by: matched.grant.approvedBy,
        ...(matched.grant.approvedVia ? { approved_via: matched.grant.approvedVia } : {}),
        thread_id: matched.grant.threadId || effectiveThreadId,
      });
      return;
    }

    if (op === "request") {
      const wait = msg.wait !== false;
      const consumeExisting = msg.consume_existing !== false;
      if (matched) {
        if (!wait && !consumeExisting) {
          // Hook-before-shim path: leave the single-use grant intact for the PATH shim to consume and log.
          this.writeAndClose(socket, { ok: true, already_approved: true });
          return;
        }
        this.preapproved.delete(matched.key);
        this.writeAndClose(socket, {
          ok: true,
          grant_id: matched.grant.grantId,
          reason: matched.grant.reason,
          approved_by: matched.grant.approvedBy,
          ...(matched.grant.approvedVia ? { approved_via: matched.grant.approvedVia } : {}),
          thread_id: matched.grant.threadId || effectiveThreadId,
        });
        return;
      }

      if (socket.destroyed || !socket.writable) {
        return;
      }

      if (!effectiveThreadId) {
        this.writeAndClose(socket, {
          ok: false,
          error: "override requests require a verified thread_id",
        });
        return;
      }

      if (this.pending.size >= this.maxPending) {
        this.writeAndClose(socket, { ok: false, error: "too many pending override requests" });
        return;
      }

      const rawTimeoutSec = typeof msg.timeout === "number" ? msg.timeout : undefined;
      const timeoutMs =
        rawTimeoutSec !== undefined && Number.isFinite(rawTimeoutSec)
          ? Math.max(
              MIN_REQUEST_TIMEOUT_MS,
              Math.min(MAX_REQUEST_TIMEOUT_MS, Math.round(rawTimeoutSec * 1000)),
            )
          : this.defaultRequestTimeoutMs;

      const nowMs = Date.now();
      const requestId = `t3r_${NodeCrypto.randomBytes(10).toString("hex")}`;
      const reportedPid =
        typeof msg.pid === "number" && Number.isInteger(msg.pid) && msg.pid > 0 ? msg.pid : 0;
      const request: PendingGuardRequest = {
        requestId,
        guard: validated.guard,
        command: validated.displayCommand,
        argvSha256: validated.digest,
        cwd,
        refusal: sanitizeText(msg.refusal, 1000),
        proposedReason: sanitizeText(msg.proposed_reason, 400),
        threadId: effectiveThreadId,
        session: sanitizeText(msg.session, 128),
        pid: peer.verified && peer.peerPid && peer.peerPid > 0 ? peer.peerPid : reportedPid,
        createdAt: new Date(nowMs).toISOString(),
        expiresAt: new Date(nowMs + timeoutMs).toISOString(),
      };

      const timer = setTimeout(() => {
        this.finishPending(entry, "expired", {
          ok: false,
          denied: false,
          error: "override request timed out waiting for owner",
        });
      }, timeoutMs);

      const entry: PendingEntry = {
        request,
        socket: wait ? socket : null,
        timer,
        settled: false,
      };
      this.pending.set(requestId, entry);

      if (wait) {
        socket.once("close", () => {
          if (!entry.settled) {
            this.finishPending(entry, "disconnected", { ok: false, error: "client disconnected" });
          }
        });
      } else {
        this.writeAndClose(socket, { ok: true, queued: true, request_id: requestId });
      }

      this.emit({ type: "pending_added", request });
      return;
    }

    this.writeAndClose(socket, { ok: false, error: `unknown op: ${op}` });
  }
}
