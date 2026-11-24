// @effect-diagnostics nodeBuiltinImport:off - Safe explicit-path log file validation and secret redaction.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

export interface ValidatedLogHandle {
  readonly handle: NodeFS.promises.FileHandle;
  readonly realPath: string;
  readonly dev: number;
  readonly ino: number;
  readonly size: number;
  readonly mtimeMs: number;
  readonly startAtEof: boolean;
  readonly initialTailBytes?: number | undefined;
}

const DENIED_PATH_SEGMENTS = [
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
  "/.t3/userdata/",
];

const DENIED_EXACT_BASENAMES = new Set([
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

const DENIED_EXTENSIONS = [".pem", ".key", ".p12", ".pfx", ".sqlite", ".sqlite3", ".db"];

export function isSensitiveLogPath(realPath: string): boolean {
  if (!realPath || realPath.includes("\0")) return true;
  if (realPath.startsWith("/etc/") || realPath === "/etc" || realPath.startsWith("/proc/")) {
    return true;
  }
  const base = NodePath.basename(realPath).toLowerCase();
  if (
    DENIED_EXACT_BASENAMES.has(base) ||
    base.startsWith(".env.") ||
    base.startsWith("secrets.") ||
    DENIED_EXTENSIONS.some((ext) => base.endsWith(ext))
  ) {
    return true;
  }
  return DENIED_PATH_SEGMENTS.some((seg) => realPath.includes(seg));
}

const SAFE_CACHE_LOG_RE = /\/logs\/[^/]+\.(?:log|jsonl|ndjson)$/i;
let cachedDataCacheRoot: string | null | undefined;

function getDefaultDataCacheRoot(): string | null {
  if (cachedDataCacheRoot !== undefined) return cachedDataCacheRoot;
  try {
    const lst = NodeFS.lstatSync("/data/cache");
    if (!lst.isDirectory() || lst.isSymbolicLink()) {
      cachedDataCacheRoot = null;
      return null;
    }
    const real = NodeFS.realpathSync("/data/cache");
    const home = NodeOS.homedir();
    if (
      !real ||
      real === "/" ||
      (home && (real === home || home.startsWith(real + NodePath.sep)))
    ) {
      cachedDataCacheRoot = null;
      return null;
    }
    cachedDataCacheRoot = real;
    return real;
  } catch {
    cachedDataCacheRoot = null;
    return null;
  }
}

function getConfiguredLogRoots(): ReadonlyArray<string> {
  const raw = (process.env.T3_DEVTOOLS_JOB_LOG_ROOTS ?? "").trim();
  const out: string[] = [];
  if (raw) {
    for (const part of raw.split(NodePath.delimiter)) {
      const trimmed = part.trim();
      if (!trimmed || !NodePath.isAbsolute(trimmed)) continue;
      try {
        out.push(NodeFS.realpathSync(trimmed));
      } catch {
        // ignore missing configured root
      }
    }
  }
  for (const tmp of [NodeOS.tmpdir(), "/tmp"]) {
    try {
      const real = NodeFS.realpathSync(tmp);
      if (!out.includes(real)) out.push(real);
    } catch {
      // ignore
    }
  }
  return out;
}

function isAllowedCacheLogPath(realPath: string): boolean {
  if ((process.env.T3_DEVTOOLS_JOB_LOG_ROOTS ?? "").trim()) return false;
  if (!SAFE_CACHE_LOG_RE.test(realPath)) return false;
  const cacheRoot = getDefaultDataCacheRoot();
  return cacheRoot !== null && realPath.startsWith(cacheRoot + NodePath.sep);
}

function isPathInsideAnyRoot(realPath: string, roots: ReadonlyArray<string>): boolean {
  for (const root of roots) {
    if (realPath === root || realPath.startsWith(root + NodePath.sep)) {
      return true;
    }
  }
  return false;
}

export type LogOpenFailureKind = "restricted" | "missing" | "io";

/**
 * Safely opens a regular log file with `O_NONBLOCK | O_NOFOLLOW`, validates `fstat`
 * regular-file + `(dev, ino)` match against the canonical path, and enforces workspace/root
 * authorization.
 */
export async function openValidatedLogFile(input: {
  readonly explicitPath: string;
  readonly isWorkspaceAllowed: (realPath: string) => Promise<boolean>;
  readonly scopedRoots?: ReadonlyArray<string> | undefined;
  readonly configuredRoots?: ReadonlyArray<string> | undefined;
}): Promise<
  | { readonly ok: true; readonly file: ValidatedLogHandle }
  | { readonly ok: false; readonly kind: LogOpenFailureKind; readonly error: string }
> {
  const myUid = typeof process.getuid === "function" ? process.getuid() : 0;
  const trimmed = input.explicitPath.trim();
  if (!NodePath.isAbsolute(trimmed) || trimmed.includes("\0")) {
    return { ok: false, kind: "restricted", error: "log path must be an absolute path" };
  }

  let candidatePath: string;
  try {
    candidatePath = await NodeFS.promises.realpath(trimmed);
  } catch (err) {
    const code = (err as NodeJS.ErrnoException | null)?.code;
    if (code === "EACCES" || code === "EPERM") {
      return { ok: false, kind: "io", error: "log path is not accessible" };
    }
    if (code === "ELOOP") {
      return { ok: false, kind: "restricted", error: "log path symlink loop rejected" };
    }
    return { ok: false, kind: "missing", error: "log path does not exist" };
  }
  if (isSensitiveLogPath(candidatePath)) {
    return { ok: false, kind: "restricted", error: "log path points to a protected location" };
  }

  let inWorkspace = false;
  if (input.scopedRoots !== undefined) {
    const resolvedScoped: string[] = [];
    for (const root of input.scopedRoots) {
      try {
        resolvedScoped.push(await NodeFS.promises.realpath(root));
      } catch {
        // ignore missing root
      }
    }
    inWorkspace = isPathInsideAnyRoot(candidatePath, resolvedScoped);
  } else {
    inWorkspace = await input.isWorkspaceAllowed(candidatePath);
  }

  const roots = input.configuredRoots ?? getConfiguredLogRoots();
  const inConfigured =
    isPathInsideAnyRoot(candidatePath, roots) ||
    (input.configuredRoots === undefined && isAllowedCacheLogPath(candidatePath));
  if (!inWorkspace && !inConfigured) {
    return {
      ok: false,
      kind: "restricted",
      error: "log path must be inside the thread workspace or a configured log root",
    };
  }

  const requireMyUid = !inWorkspace;
  let openFlags = NodeFS.constants.O_RDONLY | NodeFS.constants.O_NONBLOCK;
  if (typeof NodeFS.constants.O_NOFOLLOW === "number") {
    openFlags |= NodeFS.constants.O_NOFOLLOW;
  }

  let handle: NodeFS.promises.FileHandle | null = null;
  try {
    handle = await NodeFS.promises.open(candidatePath, openFlags);
    const fstat = await handle.stat();
    if (!fstat.isFile()) {
      await handle.close();
      return {
        ok: false,
        kind: "restricted",
        error: "log path must be a regular file (FIFOs/devices are rejected)",
      };
    }
    const lstat = await NodeFS.promises.lstat(candidatePath);
    if (!lstat.isFile() || lstat.dev !== fstat.dev || lstat.ino !== fstat.ino) {
      await handle.close();
      return {
        ok: false,
        kind: "restricted",
        error: "log path changed during open (TOCTOU rejected)",
      };
    }
    const fdPath = await NodeFS.promises.readlink(`/proc/self/fd/${handle.fd}`).catch(() => null);
    if (fdPath) {
      const fdInAllowed = inWorkspace
        ? fdPath === candidatePath
        : isPathInsideAnyRoot(fdPath, roots) ||
          (input.configuredRoots === undefined && isAllowedCacheLogPath(fdPath));
      if (fdPath !== candidatePath || isSensitiveLogPath(fdPath) || !fdInAllowed) {
        await handle.close();
        return {
          ok: false,
          kind: "restricted",
          error: "log fd resolved outside allowed path (TOCTOU rejected)",
        };
      }
    }
    if (requireMyUid && typeof process.getuid === "function" && fstat.uid !== myUid) {
      await handle.close();
      return {
        ok: false,
        kind: "restricted",
        error: "log file outside workspace must be owned by the current user",
      };
    }
    return {
      ok: true,
      file: {
        handle,
        realPath: candidatePath,
        dev: fstat.dev,
        ino: fstat.ino,
        size: fstat.size,
        mtimeMs: fstat.mtimeMs,
        startAtEof: false,
      },
    };
  } catch (err) {
    if (handle) await handle.close().catch(() => undefined);
    const code = (err as NodeJS.ErrnoException | null)?.code;
    const kind: LogOpenFailureKind =
      code === "ENOENT" ? "missing" : code === "ELOOP" ? "restricted" : "io";
    return {
      ok: false,
      kind,
      error: `Failed to open log file: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
}

const SECRET_FLAG_NAME_RE =
  /^--?(?:[A-Za-z0-9_-]*[-_])?(?:token|api[-_]?key|secret|password|passwd|auth|bearer|access[-_]?key|private[-_]?key|credentials?)$/i;
const SECRET_FLAG_VALUE_RE =
  /^(--?(?:[A-Za-z0-9_-]*[-_])?(?:token|api[-_]?key|secret|password|passwd|auth|bearer|access[-_]?key|private[-_]?key|credentials?)[=:])(.+)$/i;
const SECRET_ENV_ASSIGN_RE =
  /^((?:[A-Za-z0-9_]*(?:TOKEN|SECRET|PASSWORD|PASSWD|API[-_]?KEY|ACCESS[-_]?KEY|PRIVATE[-_]?KEY|CREDENTIALS?|AUTH|_KEY)|KEY)=)(.+)$/i;
const REDACT_HEADER_SECRET_RE =
  /(\b[A-Za-z0-9_-]*(?:authorization|api[_-]?key|token|secret|password|passwd|access[_-]?key|private[_-]?key|credentials?)["']?\s*[:=]\s*["']?(?:Bearer\s+)?)[^\s"',;}]+/gi;
const REDACT_BEARER_RE = /\b(Bearer|Basic|Token)\s+[A-Za-z0-9._~+/=-]{8,}/gi;
const REDACT_URL_CREDS_RE = /([a-z][a-z0-9+.-]*:\/\/[^/\s:@'"]+:)[^/\s@'"]+(@)/gi;
const REDACT_KNOWN_KEY_RE =
  /\b(?:gh[pousr]_[A-Za-z0-9]{16,}|hf_[A-Za-z0-9]{16,}|sk-[A-Za-z0-9_-]{16,}|xox[baprs]-[A-Za-z0-9-]{10,}|AIza[0-9A-Za-z_-]{20,})\b/g;
const PASSWORD_FLAG_CMDS = new Set(["sshpass", "mysql", "mysqldump", "mariadb", "redis-cli"]);

export function redactLogLine(line: string): string {
  const preRedacted = line
    .replace(REDACT_URL_CREDS_RE, "$1[REDACTED]$2")
    .replace(REDACT_HEADER_SECRET_RE, "$1[REDACTED]")
    .replace(REDACT_BEARER_RE, "$1 [REDACTED]")
    .replace(REDACT_KNOWN_KEY_RE, "[REDACTED]");
  const tokens = preRedacted.split(/\s+/);
  const out: string[] = [];
  let activeCmd = "";
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok === "&&" || tok === "||" || tok === ";" || tok === "|") {
      activeCmd = "";
      out.push(tok);
      continue;
    }
    if (!activeCmd && !tok.includes("=") && !tok.startsWith("-")) {
      activeCmd = NodePath.basename(tok).toLowerCase();
    }
    if (SECRET_FLAG_NAME_RE.test(tok)) {
      out.push(tok);
      if (i + 1 < tokens.length) {
        out.push("[REDACTED]");
        i += 1;
      }
      continue;
    }
    if (SECRET_FLAG_VALUE_RE.test(tok)) {
      out.push(tok.replace(SECRET_FLAG_VALUE_RE, "$1[REDACTED]"));
      continue;
    }
    if (SECRET_ENV_ASSIGN_RE.test(tok)) {
      out.push(tok.replace(SECRET_ENV_ASSIGN_RE, "$1[REDACTED]"));
      continue;
    }
    if (
      (tok === "-u" || tok === "--user") &&
      i + 1 < tokens.length &&
      tokens[i + 1]!.includes(":")
    ) {
      out.push(tok);
      const next = tokens[i + 1]!;
      const colon = next.indexOf(":");
      out.push(`${next.slice(0, colon + 1)}[REDACTED]`);
      i += 1;
      continue;
    }
    if (tok.startsWith("-u") && tok.length > 2 && tok.includes(":")) {
      const colon = tok.indexOf(":");
      out.push(`${tok.slice(0, colon + 1)}[REDACTED]`);
      continue;
    }
    if (PASSWORD_FLAG_CMDS.has(activeCmd)) {
      if (tok === "-p" && i + 1 < tokens.length) {
        out.push(tok);
        out.push("[REDACTED]");
        i += 1;
        continue;
      }
      if (tok.startsWith("-p") && tok.length > 2 && !tok.startsWith("--")) {
        out.push("-p[REDACTED]");
        continue;
      }
    }
    out.push(tok);
  }
  return out.join(" ");
}
