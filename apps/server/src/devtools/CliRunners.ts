// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Bounded non-shell CLI/process adapters for local devtools.
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
const JOB_ID_RE = /^[0-9]{1,16}$/;
const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const DEP_REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}:[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const CONTRACT_NAME_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/;
const MAX_CONTRACTS = 24;
const ACTIVE_DEP_ATTEMPT_STATES = new Set([
  "preparing",
  "ready",
  "failed",
  "merging",
  "cancelling",
]);

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

const SAFE_ENV_PREFIXES = [
  "LC_",
  "XDG_",
  "SHIP_QUEUE_",
  "DEVLEASE_",
  "ANDROID_",
  "CARGO_",
  "RUSTUP_",
];

export interface ToolAvailabilityFlags {
  readonly devdeck: boolean;
  readonly shipQueue: boolean;
  readonly playbook: boolean;
  readonly devlease: boolean;
  readonly reaper: boolean;
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

function resolveReaperToolName(): "agent-tmp-reap.py" | "agent-tmp-reap" {
  if (resolveToolPath("agent-tmp-reap.py") !== null) return "agent-tmp-reap.py";
  return "agent-tmp-reap";
}

export function discoverTools(nativeFleetAvailable: boolean): ToolAvailabilityFlags {
  return {
    devdeck: nativeFleetAvailable,
    shipQueue: resolveToolPath("ship-queue") !== null,
    playbook: resolveToolPath("playbook") !== null,
    devlease: resolveToolPath("devlease") !== null,
    reaper:
      resolveToolPath("agent-tmp-reap.py") !== null || resolveToolPath("agent-tmp-reap") !== null,
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
      finish({
        exitCode: typeof code === "number" ? code : 1,
        stdout,
        stderr,
      });
    });
  });
}

async function execJsonTool(
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

async function execTextTool(
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

// Single-flight coalescing for read-only snapshots
let inFlightShipStatus: Promise<ExecJsonResult> | null = null;
let inFlightDevleaseFull: Promise<DevleaseOverviewResult> | null = null;
let inFlightDevleaseListOnly: Promise<DevleaseOverviewResult> | null = null;
let inFlightReaperStatus: Promise<ExecJsonResult> | null = null;

export function getShipQueueStatus(): Promise<ExecJsonResult> {
  if (inFlightShipStatus) return inFlightShipStatus;
  inFlightShipStatus = execJsonTool("ship-queue", ["status", "--json"], {
    timeoutMs: 15_000,
  }).finally(() => {
    inFlightShipStatus = null;
  });
  return inFlightShipStatus;
}

export async function cancelShipQueueJob(
  jobId: string,
  signal?: AbortSignal,
): Promise<ExecJsonResult> {
  if (!JOB_ID_RE.test(jobId)) {
    return { ok: false, exitCode: 2, data: null, error: "Invalid numeric job ID" };
  }
  return await execTextTool("ship-queue", ["cancel", jobId], { timeoutMs: 15_000, signal });
}

export interface ShipQueueDepUpdateSummary {
  readonly packageFile: string;
  readonly depName: string;
  readonly currentValue: string;
  readonly newValue: string;
  readonly releaseTimestamp: string | null;
}

export interface ShipQueueDepRepoSummary {
  readonly repo: string;
  readonly reportId: string | null;
  readonly status: string;
  readonly scannedAt: number | null;
  readonly active: boolean;
  readonly holding: boolean;
  readonly pendingCount: number;
  readonly waitingCount: number;
  readonly heldCount: number;
  readonly failedCount: number;
  readonly attemptId: string | null;
  readonly attemptStatus: string | null;
  readonly decisionKind: string | null;
  readonly decisionUntil: number | null;
  readonly error: string | null;
  readonly updates: ReadonlyArray<ShipQueueDepUpdateSummary>;
}

function resolveShipQueueRoot(): string {
  const fromEnv = (process.env.SHIP_QUEUE_ROOT ?? "").trim();
  if (fromEnv) return fromEnv;
  const home = NodeOS.homedir();
  const confPath = NodePath.join(home, ".local", "lib", "host-guards.conf");
  try {
    const text = NodeFS.readFileSync(confPath, "utf8");
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof raw.queue_root === "string" && raw.queue_root.trim()) {
        const val = raw.queue_root.trim();
        return val.startsWith("~/") ? NodePath.join(home, val.slice(2)) : val;
      }
    } else {
      for (const rawLine of text.split("\n")) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) continue;
        const eq = line.indexOf("=");
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        let val = line.slice(eq + 1).trim();
        if (
          val.length >= 2 &&
          ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'")))
        ) {
          val = val.slice(1, -1).trim();
        }
        if (key === "queue_root" && val) {
          return val.startsWith("~/") ? NodePath.join(home, val.slice(2)) : val;
        }
      }
    }
  } catch {
    // fall through to default path
  }
  return "/data/Dev/.ship-queue";
}

function parseDepUpdate(item: unknown): ShipQueueDepUpdateSummary | null {
  if (!item || typeof item !== "object") return null;
  const rec = item as Record<string, unknown>;
  const packageFile = typeof rec.packageFile === "string" ? rec.packageFile : "";
  const depName = typeof rec.depName === "string" ? rec.depName : "";
  if (!packageFile && !depName) return null;
  const rawCur = typeof rec.currentValue === "string" ? rec.currentValue : "";
  const rawNew = typeof rec.newValue === "string" ? rec.newValue : "";
  const currentValue =
    rawCur && rawCur === rawNew && typeof rec.currentVersion === "string"
      ? rec.currentVersion
      : rawCur;
  const newValue =
    rawCur && rawCur === rawNew && typeof rec.newVersion === "string" ? rec.newVersion : rawNew;
  const releaseTimestamp =
    typeof rec.releaseTimestamp === "string" && rec.releaseTimestamp.trim()
      ? rec.releaseTimestamp
      : null;
  return { packageFile, depName, currentValue, newValue, releaseTimestamp };
}

export function readShipQueueDeps(queueRootOverride?: string): {
  readonly queueRoot: string;
  readonly repos: ReadonlyArray<ShipQueueDepRepoSummary>;
} {
  const queueRoot = queueRootOverride ?? resolveShipQueueRoot();
  const depsDir = NodePath.join(queueRoot, "dependencies");
  const repos: ShipQueueDepRepoSummary[] = [];
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(depsDir, { withFileTypes: true });
  } catch {
    return { queueRoot, repos };
  }
  const nowSec = Date.now() / 1000;
  const sortedNames = entries
    .filter((e) => e.isDirectory() && REPO_NAME_RE.test(e.name))
    .map((e) => e.name)
    .toSorted();

  for (const repo of sortedNames.slice(0, 64)) {
    const statePath = NodePath.join(depsDir, repo, "state.json");
    let raw: Record<string, unknown>;
    try {
      const parsed = JSON.parse(NodeFS.readFileSync(statePath, "utf8")) as unknown;
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      raw = parsed as Record<string, unknown>;
    } catch {
      continue;
    }
    const report =
      raw.report && typeof raw.report === "object" ? (raw.report as Record<string, unknown>) : {};
    const attempt =
      raw.attempt && typeof raw.attempt === "object"
        ? (raw.attempt as Record<string, unknown>)
        : {};
    const attemptReport =
      attempt.report && typeof attempt.report === "object"
        ? (attempt.report as Record<string, unknown>)
        : {};
    const decision =
      raw.decision && typeof raw.decision === "object"
        ? (raw.decision as Record<string, unknown>)
        : {};

    const reportId = typeof report.id === "string" && report.id.trim() ? report.id.trim() : null;
    const rawStatus =
      typeof report.status === "string" && report.status.trim() ? report.status.trim() : "unknown";
    const scannedAt =
      typeof report.created === "number" && Number.isFinite(report.created) ? report.created : null;
    const attemptId =
      typeof attempt.id === "string" && attempt.id.trim() ? attempt.id.trim() : null;
    const attemptStatus =
      typeof attempt.status === "string" && attempt.status.trim() ? attempt.status.trim() : null;
    const attemptReportId =
      typeof attemptReport.id === "string" && attemptReport.id.trim()
        ? attemptReport.id.trim()
        : null;

    const superseded =
      attemptStatus === "merged" && attemptReportId !== null && attemptReportId === reportId;
    const rawUpdates = Array.isArray(report.updates) ? report.updates : [];
    const updates = superseded
      ? []
      : rawUpdates
          .slice(0, 50)
          .map(parseDepUpdate)
          .filter((u): u is ShipQueueDepUpdateSummary => u !== null);
    const pendingCount = superseded ? 0 : rawUpdates.length;
    const waitingCount = Array.isArray(report.waiting) ? report.waiting.length : 0;
    const heldCount = Array.isArray(report.held) ? report.held.length : 0;
    const failedCount = Array.isArray(report.incomplete) ? report.incomplete.length : 0;

    const decisionUntil =
      typeof decision.until === "number" && Number.isFinite(decision.until) ? decision.until : null;
    const decided = decisionUntil !== null && decisionUntil > nowSec;
    const decisionKind =
      decided && typeof decision.kind === "string" && decision.kind.trim()
        ? decision.kind.trim()
        : null;
    const fresh = scannedAt !== null && scannedAt > nowSec - 86_400;
    const active = typeof raw.holding === "boolean" ? raw.holding : Boolean(raw.enabled);
    const activeAttempt = attemptStatus !== null && ACTIVE_DEP_ATTEMPT_STATES.has(attemptStatus);
    const holding = active && (activeAttempt || !(decided || (rawStatus === "clean" && fresh)));
    const error =
      typeof report.error === "string" && report.error.trim() ? report.error.trim() : null;

    repos.push({
      repo,
      reportId,
      status: superseded ? "superseded" : rawStatus,
      scannedAt,
      active,
      holding,
      pendingCount,
      waitingCount,
      heldCount,
      failedCount,
      attemptId,
      attemptStatus,
      decisionKind,
      decisionUntil: decided ? decisionUntil : null,
      error,
      updates,
    });
  }

  return { queueRoot, repos };
}

export async function decideShipQueueDeps(input: {
  readonly reportId: string;
  readonly decision: "approve" | "reject";
  readonly cwd: string;
  readonly extraEnv?: Readonly<Record<string, string>> | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ExecJsonResult> {
  if (!DEP_REPORT_ID_RE.test(input.reportId)) {
    return {
      ok: false,
      exitCode: 2,
      data: null,
      error: "Invalid dependency report ID",
      errorCode: "invalid_input",
    };
  }
  if (input.decision === "reject") {
    return execTextTool("ship-queue", ["deps", "decide", input.reportId, "reject"], {
      cwd: input.cwd,
      extraEnv: input.extraEnv,
      timeoutMs: 30_000,
      signal: input.signal,
    });
  }

  const bin = resolveToolPath("ship-queue");
  if (!bin) {
    return {
      ok: false,
      exitCode: 127,
      data: null,
      error: "ship-queue not found in PATH or ~/.local/bin",
      errorCode: "tool_missing",
    };
  }
  const repo = input.reportId.split(":", 1)[0] ?? "deps";
  const logDir = NodePath.join(resolveShipQueueRoot(), "dependencies", repo);
  let logPath = NodePath.join(NodeOS.tmpdir(), `t3-deps-decide-${Date.now()}.log`);
  try {
    NodeFS.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    logPath = NodePath.join(logDir, "ui-decide.log");
  } catch {
    // fallback to tmpdir
  }
  let logFd: number;
  try {
    logFd = NodeFS.openSync(logPath, "w", 0o600);
  } catch (err) {
    return { ok: false, exitCode: 1, data: null, error: String(err) };
  }

  return await new Promise<ExecJsonResult>((resolve) => {
    let settled = false;
    const finish = (res: ExecJsonResult) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(res);
    };

    const child = NodeChildProcess.spawn(bin, ["deps", "decide", input.reportId, "approve"], {
      cwd: input.cwd,
      env: input.extraEnv ? { ...buildToolEnv(), ...input.extraEnv } : buildToolEnv(),
      stdio: ["ignore", logFd, logFd],
      detached: NodePath.sep === "/",
      shell: false,
    });
    try {
      NodeFS.closeSync(logFd);
    } catch {
      // ignore
    }

    const readLog = () => {
      try {
        return NodeFS.readFileSync(logPath, "utf8").trim();
      } catch {
        return "";
      }
    };

    child.on("error", (err) => {
      finish({ ok: false, exitCode: 127, data: null, error: err.message });
    });

    child.on("close", (code) => {
      const output = readLog();
      if (code === 0) {
        finish({ ok: true, exitCode: 0, data: { output, started: false, logPath } });
      } else {
        const exitCode = typeof code === "number" ? code : 1;
        const norm = classifyCliError({
          toolName: "ship-queue",
          exitCode,
          stderr: output,
        });
        finish({
          ok: false,
          exitCode,
          data: output ? { output: norm.message, logPath } : null,
          error: norm.message,
          errorCode: norm.code,
        });
      }
    });

    const poll = setInterval(() => {
      const output = readLog();
      if (output.includes("Approved ")) {
        child.unref();
        finish({ ok: true, exitCode: 0, data: { output, started: true, logPath } });
      }
    }, 200);
    poll.unref();

    const deadline = setTimeout(() => {
      const output = readLog();
      child.unref();
      finish({
        ok: true,
        exitCode: 0,
        data: { output: output || "Started dependency approval", started: true, logPath },
      });
    }, 8_000);
    deadline.unref();
  });
}

export function scanShipQueueDeps(repo: string): ExecJsonResult {
  if (!REPO_NAME_RE.test(repo)) {
    return { ok: false, exitCode: 2, data: null, error: "Invalid repository name" };
  }
  const bin = resolveToolPath("ship-queue");
  if (!bin) {
    return {
      ok: false,
      exitCode: 127,
      data: null,
      error: "ship-queue not found in PATH or ~/.local/bin",
    };
  }
  const logDir = NodePath.join(resolveShipQueueRoot(), "dependencies", repo);
  let logFd: number | "ignore" = "ignore";
  try {
    NodeFS.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    logFd = NodeFS.openSync(NodePath.join(logDir, "ui-scan.log"), "w", 0o600);
  } catch {
    logFd = "ignore";
  }
  try {
    const child = NodeChildProcess.spawn(bin, ["deps", "scan", repo], {
      env: buildToolEnv(),
      stdio: ["ignore", logFd, logFd],
      detached: NodePath.sep === "/",
      shell: false,
    });
    child.unref();
    return { ok: true, exitCode: 0, data: { started: true, repo } };
  } catch (err) {
    return { ok: false, exitCode: 1, data: null, error: String(err) };
  } finally {
    if (typeof logFd === "number") {
      try {
        NodeFS.closeSync(logFd);
      } catch {
        // ignore
      }
    }
  }
}

/**
 * Live SSE stream for Ship Queue panel backed by fs.watch on `<queue_root>/jobs`
 * + single-flight `ship-queue status --json` (zero polling when panel is closed).
 */
export function createShipQueueEventStream(signal: AbortSignal): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  let cleanupFn: (() => void) | null = null;
  let pullFn: (() => void) | null = null;

  return new ReadableStream<Uint8Array>(
    {
      start(controller) {
        let closed = false;
        const watchers = new Map<string, NodeFS.FSWatcher>();
        let debounceTimer: ReturnType<typeof setTimeout> | null = null;
        let pollTimer: ReturnType<typeof setInterval> | null = null;
        let pingTimer: ReturnType<typeof setInterval> | null = null;
        let lastSerialized = "";
        let pendingFrame: Uint8Array | null = null;
        let jobsRootDir = "";

        const closeAllWatchers = () => {
          for (const w of watchers.values()) {
            try {
              w.close();
            } catch {
              // ignore watcher close error
            }
          }
          watchers.clear();
        };

        const finish = () => {
          if (closed) return;
          closed = true;
          pendingFrame = null;
          signal.removeEventListener("abort", finish);
          if (debounceTimer) clearTimeout(debounceTimer);
          if (pollTimer) clearInterval(pollTimer);
          if (pingTimer) clearInterval(pingTimer);
          closeAllWatchers();
          try {
            controller.close();
          } catch {
            // already closed
          }
        };
        cleanupFn = finish;

        const flushPending = () => {
          if (closed || !pendingFrame) return;
          if ((controller.desiredSize ?? 0) <= 0) return;
          const frame = pendingFrame;
          pendingFrame = null;
          try {
            controller.enqueue(frame);
          } catch {
            finish();
          }
        };

        const enqueue = (text: string) => {
          if (closed) return;
          const bytes = encoder.encode(text);
          // Bounded O(1) backpressure: retain only the newest frame when the reader stalls.
          if ((controller.desiredSize ?? 0) <= 0) {
            pendingFrame = bytes;
            return;
          }
          pendingFrame = null;
          try {
            controller.enqueue(bytes);
          } catch {
            finish();
          }
        };

        const watchDir = (dir: string, onEvent: () => void) => {
          if (closed || watchers.has(dir)) return;
          try {
            if (!NodeFS.existsSync(dir)) return;
            const w = NodeFS.watch(dir, { persistent: false }, onEvent);
            w.on("error", () => {
              try {
                w.close();
              } catch {
                // ignore
              }
              watchers.delete(dir);
            });
            watchers.set(dir, w);
          } catch {
            // ignore unwatched dir
          }
        };

        const syncJobWatchers = (data: Record<string, unknown>, onEvent: () => void) => {
          if (closed || !jobsRootDir) return;
          const desired = new Set<string>([jobsRootDir, NodePath.join(jobsRootDir, "open")]);
          const jobs = Array.isArray(data.jobs) ? data.jobs : [];
          let added = 0;
          for (const item of jobs) {
            if (added >= 64) break;
            if (!item || typeof item !== "object") continue;
            const job = item as Record<string, unknown>;
            const id = typeof job.id === "string" ? job.id : "";
            const state = typeof job.state === "string" ? job.state.toLowerCase() : "";
            if (!/^[0-9A-Za-z._-]{1,64}$/.test(id)) continue;
            if (state === "done" || state === "failed" || state === "cancelled") continue;
            desired.add(NodePath.join(jobsRootDir, id));
            added += 1;
          }
          for (const [dir, w] of watchers.entries()) {
            if (!desired.has(dir)) {
              try {
                w.close();
              } catch {
                // ignore
              }
              watchers.delete(dir);
            }
          }
          for (const dir of desired) {
            watchDir(dir, onEvent);
          }
        };

        const scheduleRefresh = () => {
          if (closed || debounceTimer) return;
          debounceTimer = setTimeout(() => {
            debounceTimer = null;
            void pushSnapshot(false);
          }, 300);
          debounceTimer.unref();
        };

        const pushSnapshot = async (force: boolean): Promise<string | null> => {
          const res = await getShipQueueStatus();
          if (closed) return null;
          if (!res.ok || res.data === null || typeof res.data !== "object") {
            if (force) {
              enqueue(
                `event: unavailable\ndata: ${JSON.stringify({ error: res.error ?? "ship-queue unavailable" })}\n\n`,
              );
              finish();
            }
            return null;
          }
          const record = res.data as Record<string, unknown>;
          const qroot =
            typeof record.queue_root === "string" && record.queue_root ? record.queue_root : null;
          if (qroot) {
            jobsRootDir = NodePath.join(qroot, "jobs");
          } else if (!jobsRootDir) {
            jobsRootDir = NodePath.join(NodeOS.homedir(), ".local", "share", "ship-queue", "jobs");
          }
          syncJobWatchers(record, scheduleRefresh);
          const serialized = JSON.stringify(res.data);
          if (force || serialized !== lastSerialized) {
            lastSerialized = serialized;
            enqueue(`event: snapshot\ndata: ${serialized}\n\n`);
          }
          return qroot;
        };

        if (signal.aborted) {
          finish();
          return;
        }
        signal.addEventListener("abort", finish, { once: true });

        void pushSnapshot(true).then(() => {
          if (closed) return;
          // When fs.watch is attached to jobs + open subdirs, only run a 60s safety refresh.
          const pollMs = watchers.size > 0 ? 60_000 : 10_000;
          pollTimer = setInterval(() => {
            void pushSnapshot(false);
          }, pollMs);
          pollTimer.unref();

          pingTimer = setInterval(() => {
            if (!pendingFrame && (controller.desiredSize ?? 0) > 0) {
              enqueue(": ping\n\n");
            }
          }, 20_000);
          pingTimer.unref();
        });
        pullFn = flushPending;
      },
      pull() {
        pullFn?.();
      },
      cancel() {
        cleanupFn?.();
        cleanupFn = null;
        pullFn = null;
      },
    },
    { highWaterMark: 2 },
  );
}

// Playbook runner (single-flight deduplicated per repo + mode + contracts)
const inFlightPlaybook = new Map<string, Promise<ExecJsonResult>>();

export function validatePlaybookRequest(input: {
  readonly mode: unknown;
  readonly contracts: unknown;
}):
  | {
      readonly ok: true;
      readonly mode: "check" | "doctor";
      readonly contracts: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly error: string } {
  if (input.mode !== "check" && input.mode !== "doctor") {
    return { ok: false, error: "mode must be 'check' or 'doctor'" };
  }
  if (input.contracts === undefined) {
    return { ok: true, mode: input.mode, contracts: [] };
  }
  if (!Array.isArray(input.contracts)) {
    return { ok: false, error: "contracts must be an array of contract names" };
  }
  if (input.contracts.length > MAX_CONTRACTS) {
    return { ok: false, error: `contracts exceeds maximum of ${MAX_CONTRACTS}` };
  }
  if (input.mode === "doctor" && input.contracts.length > 0) {
    return { ok: false, error: "contracts cannot be specified with mode 'doctor'" };
  }
  const clean: string[] = [];
  for (const item of input.contracts) {
    if (typeof item !== "string" || !CONTRACT_NAME_RE.test(item)) {
      return { ok: false, error: `Invalid contract name: ${String(item)}` };
    }
    clean.push(item);
  }
  return { ok: true, mode: input.mode, contracts: clean };
}

export async function runPlaybook(input: {
  readonly repoDir: string;
  readonly mode: "check" | "doctor";
  readonly contracts?: ReadonlyArray<string> | undefined;
  readonly signal?: AbortSignal | undefined;
}): Promise<ExecJsonResult> {
  const dir = input.repoDir.trim();
  if (!dir || !NodePath.isAbsolute(dir)) {
    return { ok: false, exitCode: 2, data: null, error: "repoDir must be an absolute path" };
  }
  const validated = validatePlaybookRequest({
    mode: input.mode,
    contracts: input.contracts,
  });
  if (!validated.ok) {
    return { ok: false, exitCode: 2, data: null, error: validated.error };
  }

  let resolvedDir: string;
  try {
    resolvedDir = NodeFS.realpathSync(dir);
    if (!NodeFS.statSync(resolvedDir).isDirectory()) {
      return { ok: false, exitCode: 2, data: null, error: "Invalid repository directory" };
    }
  } catch {
    return { ok: false, exitCode: 2, data: null, error: "Invalid repository directory" };
  }

  const args: string[] = [validated.mode, "--json", ...validated.contracts];
  const key = `${resolvedDir}\0${args.join("\0")}`;
  const existing = inFlightPlaybook.get(key);
  if (existing) return await existing;

  const run = execJsonTool("playbook", args, {
    cwd: resolvedDir,
    timeoutMs: 120_000,
    allowNonZeroJson: true,
    signal: input.signal,
  }).finally(() => {
    inFlightPlaybook.delete(key);
  });
  inFlightPlaybook.set(key, run);
  return await run;
}

export interface DevleaseOverviewResult {
  readonly available: boolean;
  readonly list: unknown;
  readonly boots: unknown;
  readonly error?: string | undefined;
}

export function getDevleaseOverview(
  bootsLimit = 15,
  includeBoots = true,
): Promise<DevleaseOverviewResult> {
  const capped = Math.max(1, Math.min(100, Math.floor(bootsLimit)));
  if (!includeBoots) {
    if (inFlightDevleaseListOnly) return inFlightDevleaseListOnly;
    inFlightDevleaseListOnly = (async (): Promise<DevleaseOverviewResult> => {
      const listRes = await execJsonTool("devlease", ["list", "--json"], { timeoutMs: 10_000 });
      if (!listRes.ok) {
        return { available: false, list: null, boots: null, error: listRes.error };
      }
      return { available: true, list: listRes.data, boots: null };
    })().finally(() => {
      inFlightDevleaseListOnly = null;
    });
    return inFlightDevleaseListOnly;
  }

  if (inFlightDevleaseFull && capped === 15) return inFlightDevleaseFull;

  const run = (async (): Promise<DevleaseOverviewResult> => {
    const [listRes, bootsRes] = await Promise.all([
      execJsonTool("devlease", ["list", "--json"], { timeoutMs: 10_000 }),
      execJsonTool("devlease", ["boots", "--json", String(capped)], { timeoutMs: 10_000 }),
    ]);
    if (!listRes.ok && !bootsRes.ok) {
      return {
        available: false,
        list: null,
        boots: null,
        error: listRes.error ?? bootsRes.error,
      };
    }
    return {
      available: true,
      list: listRes.ok ? listRes.data : null,
      boots: bootsRes.ok ? bootsRes.data : null,
    };
  })();

  if (capped === 15) {
    inFlightDevleaseFull = run.finally(() => {
      inFlightDevleaseFull = null;
    });
    return inFlightDevleaseFull;
  }
  return run;
}

export async function reapDevlease(signal?: AbortSignal): Promise<ExecJsonResult> {
  return await execTextTool("devlease", ["reap"], { timeoutMs: 15_000, signal });
}

export function getReaperStatus(): Promise<ExecJsonResult> {
  if (inFlightReaperStatus) return inFlightReaperStatus;
  inFlightReaperStatus = execJsonTool(resolveReaperToolName(), ["--status", "--json"], {
    timeoutMs: 15_000,
  }).finally(() => {
    inFlightReaperStatus = null;
  });
  return inFlightReaperStatus;
}

export async function runReaperScan(signal?: AbortSignal): Promise<ExecJsonResult> {
  return await execJsonTool(resolveReaperToolName(), ["--scan", "--json"], {
    timeoutMs: 30_000,
    signal,
  });
}

export async function getReaperCargoDryRun(signal?: AbortSignal): Promise<ExecJsonResult> {
  return await execJsonTool(resolveReaperToolName(), ["--cargo", "--dry-run", "--json"], {
    timeoutMs: 30_000,
    signal,
  });
}

export async function runReaper(cargoOnly: boolean, signal?: AbortSignal): Promise<ExecJsonResult> {
  const reaperTool = resolveReaperToolName();
  if (cargoOnly) {
    return await execJsonTool(reaperTool, ["--cargo", "--json"], {
      timeoutMs: 60_000,
      signal,
    });
  }
  return await execTextTool(reaperTool, [], { timeoutMs: 60_000, signal });
}
