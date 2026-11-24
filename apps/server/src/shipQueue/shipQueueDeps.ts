// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Ship Queue dependency state reader and detached decide/scan runners.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type {
  ShipQueueActionResult,
  ShipQueueDepDecision,
  ShipQueueDepRepo,
  ShipQueueDepUpdate,
} from "@t3tools/contracts";

const MAX_BUFFER_BYTES = 4 * 1024 * 1024;
const DECIDE_TIMEOUT_MS = 30_000;
const APPROVE_WAIT_DEADLINE_MS = 8_000;

const REPO_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;
const DEP_REPORT_ID_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,100}:[A-Za-z0-9][A-Za-z0-9_.-]{0,100}$/;

const ACTIVE_DEP_ATTEMPT_STATES = new Set([
  "preparing",
  "ready",
  "failed",
  "merging",
  "cancelling",
]);

function stripHostGuardBanner(raw: string): string {
  const lines = raw.split(/\r?\n/u);
  const kept: string[] = [];
  for (const line of lines) {
    const t = line.trim();
    if (t.startsWith("HOST_GUARD") || t.startsWith("Override:")) continue;
    kept.push(line);
  }
  return kept.join("\n").trim();
}

export function resolveShipQueueRoot(
  homeDir: string,
  env: Readonly<Record<string, string | undefined>>,
): string {
  const fromEnv = (env.SHIP_QUEUE_ROOT ?? "").trim();
  if (fromEnv) return fromEnv;
  const confPath = NodePath.join(homeDir, ".local", "lib", "host-guards.conf");
  try {
    const text = NodeFS.readFileSync(confPath, "utf8");
    const trimmed = text.trim();
    if (trimmed.startsWith("{")) {
      const raw = JSON.parse(trimmed) as Record<string, unknown>;
      if (typeof raw.queue_root === "string" && raw.queue_root.trim()) {
        const val = raw.queue_root.trim();
        return val.startsWith("~/") ? NodePath.join(homeDir, val.slice(2)) : val;
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
          return val.startsWith("~/") ? NodePath.join(homeDir, val.slice(2)) : val;
        }
      }
    }
  } catch {
    // Missing or unreadable host-guards.conf falls through to standard queue root.
  }
  return "/data/Dev/.ship-queue";
}

function parseDepUpdate(item: unknown): ShipQueueDepUpdate | null {
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

export function readShipQueueDeps(
  queueRoot: string,
  nowMs: number,
): ReadonlyArray<ShipQueueDepRepo> {
  const depsDir = NodePath.join(queueRoot, "dependencies");
  const repos: ShipQueueDepRepo[] = [];
  let entries: ReadonlyArray<NodeFS.Dirent>;
  try {
    entries = NodeFS.readdirSync(depsDir, { withFileTypes: true });
  } catch {
    return repos;
  }
  const nowSec = nowMs / 1000;
  const sortedNames = entries
    .filter((entry) => entry.isDirectory() && REPO_NAME_RE.test(entry.name))
    .map((entry) => entry.name)
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
          .filter((item): item is ShipQueueDepUpdate => item !== null);
    const pendingCount = superseded ? 0 : Math.max(0, Math.floor(rawUpdates.length));
    const waitingCount = Array.isArray(report.waiting) ? Math.max(0, report.waiting.length) : 0;
    const heldCount = Array.isArray(report.held) ? Math.max(0, report.held.length) : 0;
    const failedCount = Array.isArray(report.incomplete)
      ? Math.max(0, report.incomplete.length)
      : 0;

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

  return repos;
}

export function decideShipQueueDeps(input: {
  readonly bin: string | null;
  readonly queueRoot: string;
  readonly reportId: string;
  readonly decision: ShipQueueDepDecision;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  readonly nowMs: number;
  readonly signal?: AbortSignal | undefined;
}): Promise<ShipQueueActionResult> {
  if (!DEP_REPORT_ID_RE.test(input.reportId)) {
    return Promise.resolve({ ok: false, error: "Invalid dependency report ID" });
  }
  const bin = input.bin;
  if (!bin) {
    return Promise.resolve({ ok: false, error: "ship-queue not found in PATH or ~/.local/bin" });
  }

  if (input.decision === "reject") {
    return new Promise((resolve) => {
      NodeChildProcess.execFile(
        bin,
        ["deps", "decide", input.reportId, "reject"],
        {
          cwd: input.cwd,
          env: input.env,
          timeout: DECIDE_TIMEOUT_MS,
          maxBuffer: MAX_BUFFER_BYTES,
          ...(input.signal ? { signal: input.signal } : {}),
        },
        (err, stdout, stderr) => {
          if (!err) {
            const output = stripHostGuardBanner(stdout.trim() || stderr.trim());
            resolve({ ok: true, ...(output ? { output } : {}) });
            return;
          }
          const detail = stripHostGuardBanner(stderr.trim() || stdout.trim() || err.message);
          resolve({ ok: false, error: detail || "Failed to reject dependency report" });
        },
      );
    });
  }

  const repo = input.reportId.split(":", 1)[0] ?? "deps";
  const logDir = NodePath.join(input.queueRoot, "dependencies", repo);
  let logPath = NodePath.join(NodeOS.tmpdir(), `t3-deps-decide-${input.nowMs}.log`);
  try {
    NodeFS.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    logPath = NodePath.join(logDir, "ui-decide.log");
  } catch {
    // Fallback to temp log if dependency dir is read-only.
  }

  let logFd: number;
  try {
    logFd = NodeFS.openSync(logPath, "w", 0o600);
  } catch (error) {
    return Promise.resolve({ ok: false, error: String(error) });
  }

  return new Promise((resolve) => {
    let settled = false;
    const finish = (result: ShipQueueActionResult) => {
      if (settled) return;
      settled = true;
      clearInterval(poll);
      clearTimeout(deadline);
      resolve(result);
    };

    const child = NodeChildProcess.spawn(bin, ["deps", "decide", input.reportId, "approve"], {
      cwd: input.cwd,
      env: input.env,
      stdio: ["ignore", logFd, logFd],
      detached: NodePath.sep === "/",
      shell: false,
    });
    try {
      NodeFS.closeSync(logFd);
    } catch {
      // ignore close failure
    }

    const readLog = () => {
      try {
        return stripHostGuardBanner(NodeFS.readFileSync(logPath, "utf8"));
      } catch {
        return "";
      }
    };

    child.on("error", (err) => {
      finish({ ok: false, error: err.message });
    });

    child.on("close", (code) => {
      const output = readLog();
      if (code === 0) {
        finish({ ok: true, started: false, ...(output ? { output } : {}) });
      } else {
        finish({ ok: false, error: output || `ship-queue exited with status ${code ?? 1}` });
      }
    });

    const poll = setInterval(() => {
      const output = readLog();
      if (output.includes("Approved ")) {
        child.unref();
        finish({ ok: true, started: true, output });
      }
    }, 200);
    poll.unref();

    const deadline = setTimeout(() => {
      const output = readLog();
      child.unref();
      finish({
        ok: true,
        started: true,
        output: output || "Started dependency approval",
      });
    }, APPROVE_WAIT_DEADLINE_MS);
    deadline.unref();
  });
}

export function scanShipQueueDeps(input: {
  readonly bin: string | null;
  readonly queueRoot: string;
  readonly repo: string;
  readonly env: NodeJS.ProcessEnv;
}): ShipQueueActionResult {
  if (!REPO_NAME_RE.test(input.repo)) {
    return { ok: false, error: "Invalid repository name" };
  }
  if (!input.bin) {
    return { ok: false, error: "ship-queue not found in PATH or ~/.local/bin" };
  }
  const logDir = NodePath.join(input.queueRoot, "dependencies", input.repo);
  let logFd: number | "ignore" = "ignore";
  try {
    NodeFS.mkdirSync(logDir, { recursive: true, mode: 0o700 });
    logFd = NodeFS.openSync(NodePath.join(logDir, "ui-scan.log"), "w", 0o600);
  } catch {
    logFd = "ignore";
  }
  try {
    const child = NodeChildProcess.spawn(input.bin, ["deps", "scan", input.repo], {
      env: input.env,
      stdio: ["ignore", logFd, logFd],
      detached: NodePath.sep === "/",
      shell: false,
    });
    child.unref();
    return { ok: true, started: true };
  } catch (error) {
    return { ok: false, error: String(error) };
  } finally {
    if (typeof logFd === "number") {
      try {
        NodeFS.closeSync(logFd);
      } catch {
        // ignore close failure
      }
    }
  }
}
