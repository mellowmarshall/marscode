#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off - Headless `ship-queue` CLI: submit, watch, status, cancel, and the queue worker.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { ghForge } from "./ghForge.ts";
import {
  runDepsSubcommand,
  runHostsSubcommand,
  runPinsSubcommand,
  runVersionSubcommand,
} from "./cliSubcommands.ts";
import { gitleaksScanner, guardProtocolGuard } from "./houseGate.ts";
import { isJobId, jobLogPath, listJobIds, readJob, readLog } from "./jobStore.ts";
import { lastMarker, SHIP_QUEUE_STAGE_AFTER, SHIP_QUEUE_STAGE_MARKERS } from "./markers.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { currentProcessIdentity, isProcessAlive } from "./processIdentity.ts";
import { claimLock, releaseLock, versionWorkerLockPath, workerLockPath } from "./processLocks.ts";
import { submitJob } from "./submit.ts";
import type { ShipQueueDeps } from "./types.ts";
import { fileChangeWaiter, watchJob } from "./watcher.ts";
import { cancelJob, hasOpenJobsForWorker, runDueWork } from "./worker.ts";
import { hasLiveWorkerForJob, launchDetachedWorker } from "./workerLauncher.ts";
import { readCurrentWorkerVersion, resolveCurrentWorkerVersion } from "./workerVersion.ts";

const QUIET_MS = 300_000;
const WATCHER_WAIT_MS = 300_000;
const WATCH_POLL_MS = 2_000;
const WORK_TICK_MS = 2_000;
// A launched worker takes a moment to claim its lock; a watch does not launch another meanwhile.
const WORKER_RELAUNCH_MS = 30_000;

export interface CliIo {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly cwd: string;
}

export interface CliOptions {
  readonly deps?: Partial<ShipQueueDeps> | undefined;
  readonly io?: Partial<CliIo> | undefined;
  /** Starts the detached worker after a submit or for a watched job with none; the default spawns `ship-queue work`. */
  readonly startWorker?: ((root: string, jobId?: string) => string) | undefined;
  readonly waitForChange?: ((root: string, id: string) => () => Promise<void>) | undefined;
  readonly quietMs?: number | undefined;
}

export function resolveQueueRoot(env: Readonly<Record<string, string | undefined>>): string {
  const fromEnv = env.SHIP_QUEUE_ROOT?.trim();
  return fromEnv || NodePath.join(NodeOS.homedir(), ".local", "share", "ship-queue");
}

export function defaultDeps(root: string): ShipQueueDeps {
  return {
    root,
    run: nodeProcessRunner,
    forge: ghForge(nodeProcessRunner),
    guard: guardProtocolGuard,
    secretScan: gitleaksScanner(nodeProcessRunner),
    clock: { now: () => new Date().toISOString() },
    isProcessAlive,
    self: currentProcessIdentity(),
    watcherWaitMs: WATCHER_WAIT_MS,
  };
}

function startDetachedWorker(root: string, env: CliIo["env"], jobId?: string): string {
  const res = launchDetachedWorker({
    root,
    cliPath: NodeURL.fileURLToPath(import.meta.url),
    env,
    isAlive: isProcessAlive,
    // oxlint-disable-next-line t3code/no-global-process-runtime -- Standalone CLI has no Effect runtime.
    platform: NodeOS.platform(),
    ...(jobId ? { jobId } : {}),
  });
  return res.kind === "spawned" ? `worker=${res.via}` : `worker=running pid=${res.pid}`;
}

function stageOf(logText: string): string {
  let stage = "";
  for (const line of logText.split("\n")) {
    const prefix = SHIP_QUEUE_STAGE_MARKERS.find((p) => line.startsWith(p));
    if (prefix) stage = SHIP_QUEUE_STAGE_AFTER[prefix] ?? stage;
  }
  return stage;
}

function watcherBlock(id: string): string {
  return [
    "Arm the watcher now, before anything else: the job does not start without one.",
    `  ship-queue watch ${id}`,
    "The watch prints each marker as it lands and exits on DONE job= (0) or FAILED reason= (1).",
    "It exits 2 on QUIET job= (the job keeps running; look, then re-arm or cancel) and 3 on",
    "ACTION_REQUIRED job= (the owner approves the protected diff; re-arm after).",
    "Outcome lines: REBASED, PUSH_EXIT=, PR=, MERGE_EXIT=, CLEANED, then DONE or FAILED reason=.",
  ].join("\n");
}

/** One worker per pinned version (zero global drain lock across versions), recorded with its start time. */
async function runWork(deps: ShipQueueDeps, io: CliIo, once: boolean): Promise<number> {
  const selfVersion = deps.workerVersion?.version;
  const primaryLock = selfVersion
    ? versionWorkerLockPath(deps.root, selfVersion)
    : workerLockPath(deps.root);
  if (!claimLock(primaryLock, deps.self, deps.isProcessAlive)) {
    io.stdout("ship-queue: a worker is already running\n");
    return 0;
  }
  const legacyLock = workerLockPath(deps.root);
  if (selfVersion) {
    // Best-effort legacy lock pointer; never blocks a newer version worker when an older one is draining.
    claimLock(legacyLock, deps.self, deps.isProcessAlive);
  }
  try {
    for (;;) {
      const res = await runDueWork(deps);
      for (const id of res.ended) io.stdout(`ended job=${id}\n`);
      const currentVersion = readCurrentWorkerVersion(deps.root)?.version;
      if (once || !hasOpenJobsForWorker(deps.root, selfVersion, currentVersion)) return 0;
      await new Promise((resolve) => setTimeout(resolve, WORK_TICK_MS));
    }
  } catch (err) {
    // A detached worker has no terminal; its own failures land beside the queue.
    NodeFS.appendFileSync(
      NodePath.join(deps.root, "worker.log"),
      `${deps.clock.now()} worker ${deps.self.pid}: ${err instanceof Error ? (err.stack ?? err.message) : String(err)}\n`,
    );
    return 1;
  } finally {
    releaseLock(primaryLock, deps.self);
    if (selfVersion) releaseLock(legacyLock, deps.self);
  }
}

function runStatus(deps: ShipQueueDeps, io: CliIo, args: ReadonlyArray<string>): number {
  const json = args.includes("--json");
  const ids = args.filter((a) => a !== "--json");
  const selected = ids.length > 0 ? ids.filter(isJobId) : listJobIds(deps.root);
  const jobs = selected.flatMap((id) => {
    const job = readJob(deps.root, id);
    if (!job) return [];
    const log = readLog(deps.root, id);
    const workerAlive = job.worker ? deps.isProcessAlive(job.worker) : false;
    return [
      { ...job, last_marker: lastMarker(log), stage: stageOf(log), worker_alive: workerAlive },
    ];
  });
  if (json) {
    io.stdout(`${JSON.stringify({ queue_root: deps.root, jobs })}\n`);
  } else {
    for (const job of jobs)
      io.stdout(`${job.id} ${job.state} ${job.branch} :: ${job.last_marker}\n`);
  }
  return 0;
}

export async function runShipQueueCli(
  argv: ReadonlyArray<string>,
  options: CliOptions = {},
): Promise<number> {
  const io: CliIo = {
    stdout: options.io?.stdout ?? ((t) => void process.stdout.write(t)),
    stderr: options.io?.stderr ?? ((t) => void process.stderr.write(t)),
    env: options.io?.env ?? process.env,
    cwd: options.io?.cwd ?? process.cwd(),
  };
  const root = options.deps?.root ?? resolveQueueRoot(io.env);
  NodeFS.mkdirSync(root, { recursive: true });
  const workerVersion =
    options.deps?.workerVersion ??
    resolveCurrentWorkerVersion({
      root,
      fallbackCliPath: NodeURL.fileURLToPath(import.meta.url),
      env: io.env,
    });
  const deps: ShipQueueDeps = { ...defaultDeps(root), ...options.deps, root, workerVersion };
  const [sub, ...rest] = argv;
  const startWorker =
    options.startWorker ?? ((r: string, jobId?: string) => startDetachedWorker(r, io.env, jobId));
  const usage =
    "ship-queue <submit WORKTREE BRANCH TITLE BODY.md [--no-start] | watch JOB | status [--json] [JOB...] | cancel JOB | work [--once] | hosts ... | deps ... | pins ... | version ...>\n";

  if (!sub || sub === "--help" || sub === "-h") {
    io.stdout(usage);
    return 0;
  }
  if (sub === "submit") {
    const positional = rest.filter((a) => a !== "--no-start");
    const [worktree, branch, title, bodyFile] = positional;
    if (!worktree || !branch || title === undefined || !bodyFile) {
      io.stderr(usage);
      return 64;
    }
    let body: string;
    try {
      body = NodeFS.readFileSync(NodePath.resolve(io.cwd, bodyFile), "utf8");
    } catch {
      io.stderr(`ship-queue: refused: body file not readable: ${bodyFile}\n`);
      return 1;
    }
    const res = await submitJob(deps, {
      worktree: NodePath.resolve(io.cwd, worktree),
      branch,
      title,
      body,
      identity: { session: io.env.SHIP_QUEUE_AGENT_SESSION, thread: io.env.T3CODE_THREAD_ID },
    });
    if (!res.ok) {
      io.stderr(`ship-queue: refused: ${res.reason}\n`);
      return 1;
    }
    for (const warning of res.warnings) io.stderr(`ship-queue: warning: ${warning}\n`);
    io.stdout(`job=${res.id} log=${jobLogPath(root, res.id)}\n${watcherBlock(res.id)}\n`);
    if (!rest.includes("--no-start")) io.stdout(`${startWorker(root, res.id)}\n`);
    return 0;
  }
  if (sub === "watch" || sub === "cancel") {
    const id = rest[0] ?? "";
    if (!isJobId(id) || !readJob(root, id)) {
      io.stderr(`ship-queue: no such job: ${id} in ${root}\n`);
      return 64;
    }
    if (sub === "cancel") {
      const res = cancelJob(deps, id);
      (res.ok ? io.stdout : io.stderr)(`${res.message}\n`);
      return res.ok ? 0 : 1;
    }
    let launchedAt: string | null = null;
    const cliEntry = NodeURL.fileURLToPath(import.meta.url);
    const ensureWorker = () => {
      if (
        hasLiveWorkerForJob({
          root,
          jobId: id,
          isAlive: deps.isProcessAlive,
          fallbackCliPath: cliEntry,
        })
      ) {
        return;
      }
      const now = deps.clock.now();
      if (launchedAt !== null && Date.parse(now) - Date.parse(launchedAt) < WORKER_RELAUNCH_MS) {
        return;
      }
      launchedAt = now;
      io.stderr(`ship-queue: job ${id} has no live worker; ${startWorker(root, id)}\n`);
    };
    return watchJob({
      root,
      id,
      self: deps.self,
      ensureWorker,
      clock: deps.clock,
      quietMs: options.quietMs ?? QUIET_MS,
      write: (line) => io.stdout(`${line}\n`),
      waitForChange: (options.waitForChange ?? ((r, j) => fileChangeWaiter(r, j, WATCH_POLL_MS)))(
        root,
        id,
      ),
    });
  }
  if (sub === "status") return runStatus(deps, io, rest);
  if (sub === "work") return runWork(deps, io, rest.includes("--once"));
  if (sub === "hosts") return runHostsSubcommand(root, rest, io);
  if (sub === "deps") return runDepsSubcommand(root, rest, io);
  if (sub === "pins") return runPinsSubcommand(rest, io);
  if (sub === "version") return runVersionSubcommand(root, rest, io, deps);
  io.stderr(`ship-queue: unknown command '${sub}'\n${usage}`);
  return 64;
}

function isInvokedAsMain(): boolean {
  if (!process.argv[1]) return false;
  try {
    return (
      NodeFS.realpathSync(process.argv[1]) ===
      NodeFS.realpathSync(NodeURL.fileURLToPath(import.meta.url))
    );
  } catch {
    return false;
  }
}

if (isInvokedAsMain()) {
  runShipQueueCli(process.argv.slice(2))
    .then((code) => {
      process.exitCode = code;
    })
    .catch((err: unknown) => {
      process.stderr.write(`ship-queue: ${err instanceof Error ? err.message : String(err)}\n`);
      process.exitCode = 1;
    });
}
