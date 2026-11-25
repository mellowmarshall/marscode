// @effect-diagnostics-next-line nodeBuiltinImport:off -- Effect FileSystem lacks O_NOFOLLOW|O_NONBLOCK open flags and fstat ownership checks.
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- Linux /proc stat and environ inspection requires direct file descriptor reads.
import * as NodeFSP from "node:fs/promises";

export const CERNO_SAFE_READ_FLAGS =
  NodeFS.constants.O_RDONLY |
  (NodeFS.constants.O_NOFOLLOW ?? 0) |
  (NodeFS.constants.O_NONBLOCK ?? 0);

const MAX_ENVIRON_BYTES = 262_144;
const ENVIRON_CHUNK_BYTES = 16_384;
const MAX_PARENT_WALK = 6;
const THREAD_ID_ENV_PREFIX = "T3CODE_THREAD_ID=";

const SENSITIVE_LOG_SEGMENTS = [
  "/.ssh/",
  "/.gnupg/",
  "/.aws/",
  "/.azure/",
  "/.config/gh/",
  "/.config/gcloud/",
  "/.claude/",
  "/.docker/",
  "/.kube/",
  "/.system_generated/",
  "/.t3/userdata/providers/",
  "/.t3/userdata/secrets/",
  "/.t3/userdata/attachments/",
];

const SENSITIVE_LOG_BASENAMES = new Set([
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".pgpass",
  ".my.cnf",
  ".env",
  ".env.local",
  ".env.production",
  "id_rsa",
  "id_ed25519",
  "kubeconfig",
  "auth.json",
  "credentials",
  "credentials.json",
  "server-owner.sqlite",
  "state.sqlite",
  "statev2.sqlite",
]);

const SENSITIVE_LOG_EXTS = [".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db"];

export function isSensitiveCernoLogPath(filePath: string): boolean {
  if (!filePath || filePath.includes("\0")) return true;
  if (filePath.startsWith("/etc/") || filePath === "/etc" || filePath.startsWith("/proc/")) {
    return true;
  }
  const slash = filePath.lastIndexOf("/");
  const base = (slash >= 0 ? filePath.slice(slash + 1) : filePath).toLowerCase();
  if (
    SENSITIVE_LOG_BASENAMES.has(base) ||
    base.startsWith(".env.") ||
    base.startsWith("secrets.") ||
    SENSITIVE_LOG_EXTS.some((ext) => base.endsWith(ext))
  ) {
    return true;
  }
  return SENSITIVE_LOG_SEGMENTS.some((seg) => filePath.includes(seg));
}

async function readLinuxProcStatPromise(
  pid: number,
): Promise<{ readonly ppid: number; readonly startTicks: number } | null> {
  try {
    const text = await NodeFSP.readFile(`/proc/${pid}/stat`, "utf8");
    const rp = text.lastIndexOf(")");
    if (rp < 0) return null;
    const fields = text
      .slice(rp + 2)
      .trim()
      .split(/\s+/u);
    const ppid = Number(fields[1]);
    const startTicks = Number(fields[19]);
    if (!Number.isFinite(startTicks) || startTicks <= 0) return null;
    return { ppid: Number.isInteger(ppid) ? ppid : 0, startTicks };
  } catch {
    return null;
  }
}

async function readSingleProcThreadIdPromise(
  pid: number,
  uid: number | null,
): Promise<string | null> {
  let handle: NodeFSP.FileHandle | undefined;
  try {
    handle = await NodeFSP.open(`/proc/${pid}/environ`, CERNO_SAFE_READ_FLAGS);
    const stat = await handle.stat();
    if (uid !== null && stat.uid !== uid) return null;
    const chunks: Buffer[] = [];
    let total = 0;
    while (total < MAX_ENVIRON_BYTES) {
      const toRead = Math.min(ENVIRON_CHUNK_BYTES, MAX_ENVIRON_BYTES - total);
      const buf = Buffer.allocUnsafe(toRead);
      const { bytesRead } = await handle.read(buf, 0, toRead, null);
      if (bytesRead <= 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    if (total === 0) return null;
    const raw = Buffer.concat(chunks, total).toString("utf8");
    for (const entry of raw.split("\0")) {
      if (entry.startsWith(THREAD_ID_ENV_PREFIX)) {
        const val = entry.slice(THREAD_ID_ENV_PREFIX.length).trim();
        return val.length > 0 ? (val.length > 128 ? val.slice(0, 128) : val) : null;
      }
    }
    return null;
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

export async function readLinuxProcThreadIdPromise(
  pid: number,
  uid: number | null,
): Promise<string | null> {
  if (!Number.isInteger(pid) || pid <= 1) return null;
  let current = pid;
  const visited = new Set<number>();
  for (
    let depth = 0;
    depth <= MAX_PARENT_WALK && current > 1 && !visited.has(current);
    depth += 1
  ) {
    if (current === process.pid) break;
    visited.add(current);
    const tid = await readSingleProcThreadIdPromise(current, uid);
    if (tid) return tid;
    const stat = await readLinuxProcStatPromise(current);
    if (!stat || stat.ppid <= 1 || stat.ppid === process.pid) break;
    current = stat.ppid;
  }
  return null;
}

export function readLinuxProcStartTicksPromise(pid: number): Promise<number | null> {
  return readLinuxProcStatPromise(pid).then((parsed) => parsed?.startTicks ?? null);
}
