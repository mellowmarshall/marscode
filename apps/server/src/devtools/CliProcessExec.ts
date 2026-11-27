// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Bounded non-shell CLI process runner and tool discovery for local devtools.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  classifyCliError,
  stripHostGuardBanner,
  type DevtoolsErrorCode,
} from "./DevtoolsErrors.ts";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const TOOL_CACHE_TTL_MS = 30_000;

const SAFE_ENV_EXACT = new Set([
  "HOME",
  "USER",
  "LOGNAME",
  "SHELL",
  "TERM",
  "LANG",
  "PATH",
  "TMPDIR",
  "SSH_AUTH_SOCK",
  "DISPLAY",
  "WAYLAND_DISPLAY",
  "DBUS_SESSION_BUS_ADDRESS",
  "GOPATH",
  "GOMODCACHE",
  "CARGO_HOME",
  "RUSTUP_HOME",
  "NVM_DIR",
  "PNPM_HOME",
]);

const SAFE_ENV_PREFIXES = ["LC_", "XDG_", "SHIP_QUEUE_", "ANDROID_", "CARGO_", "RUSTUP_"];

export interface ToolAvailabilityFlags {
  readonly devdeck: boolean;
  readonly shipQueue: boolean;
  readonly playbook: boolean;
}

export interface ExecJsonResult {
  readonly ok: boolean;
  readonly exitCode: number;
  readonly data: unknown;
  readonly error?: string | undefined;
  readonly errorCode?: DevtoolsErrorCode | undefined;
}

const toolPathCache = new Map<
  string,
  { readonly path: string | null; readonly expiresAt: number }
>();

function isExecutableFile(candidate: string): boolean {
  try {
    const st = NodeFS.statSync(candidate);
    if (!st.isFile()) return false;
    NodeFS.accessSync(candidate, NodeFS.constants.X_OK);
    return true;
  } catch {
    return false;
  }
}

function resolveToolPath(name: string): string | null {
  const now = Date.now();
  const cached = toolPathCache.get(name);
  if (cached && cached.expiresAt > now) {
    return cached.path;
  }

  const home = NodeOS.homedir();
  const localBin = NodePath.join(home, ".local", "bin", name);
  let resolved: string | null = null;
  if (isExecutableFile(localBin)) {
    resolved = localBin;
  } else {
    const pathDirs = (process.env.PATH ?? "").split(NodePath.delimiter).filter(Boolean);
    for (const dir of pathDirs) {
      const candidate = NodePath.join(dir, name);
      if (isExecutableFile(candidate)) {
        resolved = candidate;
        break;
      }
    }
  }
  toolPathCache.set(name, { path: resolved, expiresAt: now + TOOL_CACHE_TTL_MS });
  return resolved;
}

export function discoverTools(nativeFleetAvailable: boolean): ToolAvailabilityFlags {
  return {
    devdeck: nativeFleetAvailable,
    shipQueue: true,
    playbook: resolveToolPath("playbook") !== null,
  };
}

function buildToolEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (value === undefined) continue;
    if (SAFE_ENV_EXACT.has(key) || SAFE_ENV_PREFIXES.some((p) => key.startsWith(p))) {
      env[key] = value;
    }
  }
  const home = NodeOS.homedir();
  const localBin = NodePath.join(home, ".local", "bin");
  const basePath = env.PATH ?? "/usr/local/bin:/usr/bin:/bin";
  const parts = basePath.split(NodePath.delimiter).filter(Boolean);
  env.PATH = parts.includes(localBin) ? basePath : `${localBin}${NodePath.delimiter}${basePath}`;
  if (!env.HOME) env.HOME = home;
  return env;
}

function killProcessTree(child: NodeChildProcess.ChildProcess, detachedGroup: boolean): void {
  const pid = child.pid;
  if (!pid) return;
  const target = detachedGroup ? -pid : pid;
  try {
    process.kill(target, "SIGTERM");
  } catch {
    try {
      child.kill("SIGTERM");
    } catch {
      // already exited
    }
  }
  const forceTimer = setTimeout(() => {
    try {
      process.kill(target, "SIGKILL");
    } catch {
      try {
        child.kill("SIGKILL");
      } catch {
        // already exited
      }
    }
  }, 1_500);
  forceTimer.unref();
}

interface ExecRawOutput {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
  readonly error?: string | undefined;
}

function execProcess(
  toolName: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string | undefined;
    readonly extraEnv?: Readonly<Record<string, string>> | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<ExecRawOutput> {
  const bin = resolveToolPath(toolName);
  if (!bin) {
    return Promise.resolve({
      exitCode: 127,
      stdout: "",
      stderr: "",
      error: `${toolName} not found in PATH or ~/.local/bin`,
    });
  }

  const timeoutMs = options.timeoutMs ?? 20_000;
  const detachedGroup = NodePath.sep === "/";

  return new Promise((resolve) => {
    if (options.signal?.aborted) {
      resolve({ exitCode: 130, stdout: "", stderr: "", error: `${toolName} cancelled` });
      return;
    }

    let settled = false;
    let timedOut = false;
    let aborted = false;
    let outputExceeded = false;
    const stdoutChunks: Buffer[] = [];
    const stderrChunks: Buffer[] = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;

    const child = NodeChildProcess.spawn(bin, [...args], {
      cwd: options.cwd,
      env: options.extraEnv ? { ...buildToolEnv(), ...options.extraEnv } : buildToolEnv(),
      stdio: ["ignore", "pipe", "pipe"],
      detached: detachedGroup,
      shell: false,
    });

    const finish = (out: ExecRawOutput) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      options.signal?.removeEventListener("abort", onAbort);
      resolve(out);
    };

    const timer = setTimeout(() => {
      timedOut = true;
      killProcessTree(child, detachedGroup);
    }, timeoutMs);
    timer.unref();

    const onAbort = () => {
      aborted = true;
      killProcessTree(child, detachedGroup);
    };
    options.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (chunk: Buffer) => {
      stdoutBytes += chunk.byteLength;
      if (stdoutBytes > MAX_BUFFER_BYTES) {
        outputExceeded = true;
        killProcessTree(child, detachedGroup);
        return;
      }
      stdoutChunks.push(chunk);
    });

    child.stderr.on("data", (chunk: Buffer) => {
      stderrBytes += chunk.byteLength;
      if (stderrBytes <= MAX_BUFFER_BYTES) {
        stderrChunks.push(chunk);
      }
    });

    child.on("error", (err) => {
      if ((err as NodeJS.ErrnoException)?.code === "ENOENT") {
        toolPathCache.delete(toolName);
      }
      finish({ exitCode: 127, stdout: "", stderr: "", error: err.message });
    });

    child.on("close", (code) => {
      const stdout = Buffer.concat(stdoutChunks).toString("utf8");
      const stderr = Buffer.concat(stderrChunks).toString("utf8").trim();
      if (aborted) {
        finish({ exitCode: 130, stdout, stderr, error: `${toolName} cancelled` });
        return;
      }
      if (timedOut) {
        finish({
          exitCode: 124,
          stdout,
          stderr,
          error: `${toolName} timed out after ${timeoutMs}ms`,
        });
        return;
      }
      if (outputExceeded) {
        finish({ exitCode: 1, stdout: "", stderr, error: `${toolName} output exceeded limit` });
        return;
      }
      finish({ exitCode: typeof code === "number" ? code : 1, stdout, stderr });
    });
  });
}

export async function execJsonTool(
  toolName: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string | undefined;
    readonly timeoutMs?: number | undefined;
    readonly allowNonZeroJson?: boolean | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<ExecJsonResult> {
  const raw = await execProcess(toolName, args, options);
  if (raw.error) {
    const norm = classifyCliError({
      toolName,
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      rawError: raw.error,
    });
    return {
      ok: false,
      exitCode: raw.exitCode,
      data: null,
      error: norm.message,
      errorCode: norm.code,
    };
  }
  const trimmed = raw.stdout.trim();
  let parsed: unknown = null;
  let parseErr: string | undefined;
  if (trimmed) {
    try {
      parsed = JSON.parse(trimmed) as unknown;
    } catch {
      parseErr = `${toolName} returned non-JSON output`;
    }
  }
  if (raw.exitCode === 0) {
    if (parseErr) {
      return {
        ok: false,
        exitCode: raw.exitCode,
        data: null,
        error: parseErr,
        errorCode: "parse_error",
      };
    }
    return { ok: true, exitCode: 0, data: parsed };
  }
  if (options.allowNonZeroJson && parsed !== null) {
    return { ok: true, exitCode: raw.exitCode, data: parsed };
  }
  const norm = classifyCliError({
    toolName,
    exitCode: raw.exitCode,
    stdout: raw.stdout,
    stderr: raw.stderr,
    parseError: parseErr,
  });
  return {
    ok: false,
    exitCode: raw.exitCode,
    data: parsed,
    error: norm.message,
    errorCode: norm.code,
  };
}

export async function execTextTool(
  toolName: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd?: string | undefined;
    readonly extraEnv?: Readonly<Record<string, string>> | undefined;
    readonly timeoutMs?: number | undefined;
    readonly signal?: AbortSignal | undefined;
  } = {},
): Promise<ExecJsonResult> {
  const raw = await execProcess(toolName, args, options);
  if (raw.error) {
    const norm = classifyCliError({
      toolName,
      exitCode: raw.exitCode,
      stdout: raw.stdout,
      stderr: raw.stderr,
      rawError: raw.error,
    });
    return {
      ok: false,
      exitCode: raw.exitCode,
      data: null,
      error: norm.message,
      errorCode: norm.code,
    };
  }
  const trimmed = raw.stdout.trim();
  if (raw.exitCode === 0) {
    return { ok: true, exitCode: 0, data: { output: trimmed } };
  }
  const norm = classifyCliError({
    toolName,
    exitCode: raw.exitCode,
    stdout: trimmed,
    stderr: raw.stderr,
  });
  return {
    ok: false,
    exitCode: raw.exitCode,
    data: trimmed ? { output: stripHostGuardBanner(trimmed) } : null,
    error: norm.message,
    errorCode: norm.code,
  };
}
