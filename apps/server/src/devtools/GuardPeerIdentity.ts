// @effect-diagnostics nodeBuiltinImport:off - Kernel-verified Unix socket peer PID -> T3 thread identity resolver.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";

import { sanitizeText } from "@t3tools/guard-protocol/protocol";
import type { TrustedCodexAppServer } from "./TrustedProviderRegistry.ts";

export type PeerThreadResolution =
  | { readonly verified: true; readonly threadId: string; readonly peerPid?: number | undefined }
  | { readonly verified: false; readonly error: string };

const LINUX_PEER_THREAD_PY = `
import os, re, socket, struct, sys

ino = int(sys.argv[1])
srv = int(sys.argv[2])
trusted_codex = {}
if len(sys.argv) > 3 and sys.argv[3]:
    for pair in sys.argv[3].split(","):
        if ":" in pair:
            k, v = pair.split(":", 1)
            if k.isdigit() and v.isdigit():
                trusted_codex[int(k)] = v
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

def stat_info(p):
    try:
        with open(f"/proc/{p}/stat", encoding="utf-8", errors="replace") as fh:
            fields = fh.read().rsplit(")", 1)[1].split()
        return int(fields[1]), fields[19]
    except Exception:
        return 0, ""

def ppid_of(p):
    return stat_info(p)[0]

def starttime_of(p):
    return stat_info(p)[1]

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
        expected_start = trusted_codex.get(p)
        if expected_start and starttime_of(p) == expected_start:
            return True
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

function formatTrustedCodexArg(entries: ReadonlyArray<TrustedCodexAppServer> | undefined): string {
  if (!entries || entries.length === 0) return "";
  const encoded: string[] = [];
  for (const entry of entries) {
    if (
      Number.isInteger(entry.pid) &&
      entry.pid > 1 &&
      typeof entry.startTime === "string" &&
      /^\d+$/.test(entry.startTime)
    ) {
      encoded.push(`${entry.pid}:${entry.startTime}`);
    }
  }
  return encoded.join(",");
}

export function defaultResolvePeerThreadId(
  socket: NodeNet.Socket,
  platform: NodeJS.Platform,
  trustedCodexAppServers?: ReadonlyArray<TrustedCodexAppServer>,
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
  const trustedArg = formatTrustedCodexArg(trustedCodexAppServers);
  return new Promise((resolve) => {
    NodeChildProcess.execFile(
      pythonBin,
      ["-I", "-c", LINUX_PEER_THREAD_PY, serverIno, String(process.pid), trustedArg],
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
