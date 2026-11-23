// @effect-diagnostics nodeBuiltinImport:off - inspects kernel /proc socket descriptors and Netlink SOCK_DIAG on Linux.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import type * as NodeNet from "node:net";

import { sanitizeHostGuardText } from "./hostGuardRedaction.ts";

export type PeerThreadResolution =
  | { readonly verified: true; readonly threadId: string; readonly peerPid?: number | undefined }
  | { readonly verified: false; readonly error: string };

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
    top = chain[-1]
    tid = env_tid(top)
    if tid:
        return tid
    if len(chain) >= 2 and is_codex_app_server(top):
        return env_tid(chain[-2])
    return ""

peer_pid = pids[0]
print(f"OK:{peer_pid}:{resolve_pid(peer_pid)}")
`.trim();

/** Resolves the kernel peer PID and T3 thread ownership for an accepted Unix socket connection. */
export function defaultResolvePeerThreadId(
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
        const threadId = sanitizeHostGuardText(rest.slice(sep + 1), 128);
        resolve({
          verified: true,
          threadId,
          ...(Number.isInteger(peerPid) && peerPid > 0 ? { peerPid } : {}),
        });
      },
    );
  });
}
