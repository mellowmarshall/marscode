// @effect-diagnostics nodeBuiltinImport:off - Durable on-disk job store shared by the headless CLI, the worker, and the server's JobRegistry bridge.
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { findTerminal, markerValue } from "./markers.ts";
import type { ProcessIdentity } from "./processIdentity.ts";
import type { Clock, JobRecord, JobState } from "./types.ts";

const MIN_JOB_ID = 1000;
const JOB_ID_RE = /^\d{4,16}$/;

export const jobsDir = (root: string) => NodePath.join(root, "jobs");
export const jobDir = (root: string, id: string) => NodePath.join(jobsDir(root), id);
export const jobLogPath = (root: string, id: string) => NodePath.join(jobDir(root, id), "log");
export const jobBodyPath = (root: string, id: string) => NodePath.join(jobDir(root, id), "body.md");
const openDir = (root: string) => NodePath.join(jobsDir(root), "open");
const recordPath = (root: string, id: string) => NodePath.join(jobDir(root, id), "job.json");
const watchersDir = (root: string, id: string) => NodePath.join(jobDir(root, id), "watchers");

export function isJobId(id: string): boolean {
  return JOB_ID_RE.test(id);
}

/** A repo slug (`owner/name`) as one safe directory name. */
export function repoKey(repo: string): string {
  return repo.replace(/[^A-Za-z0-9._-]/g, "_");
}

const repoDir = (root: string, repo: string) => NodePath.join(root, "repos", repoKey(repo));

function writeFileAtomic(filePath: string, contents: string): void {
  const tmp = `${filePath}.${process.pid}.tmp`;
  NodeFS.writeFileSync(tmp, contents, { mode: 0o600 });
  NodeFS.renameSync(tmp, filePath);
}

export function listJobIds(root: string, options?: { readonly open?: boolean }): string[] {
  const dir = options?.open ? openDir(root) : jobsDir(root);
  let names: string[];
  try {
    names = NodeFS.readdirSync(dir);
  } catch {
    return [];
  }
  return names.filter(isJobId).toSorted((a, b) => Number(a) - Number(b));
}

export type NewJob = Omit<JobRecord, "id" | "key" | "state" | "submitted_at">;

/** `mkdir` without `recursive` is the claim, so two racing submits never share an id. */
export function createJob(
  root: string,
  init: NewJob,
  body: string,
  clock: Clock,
): { readonly id: string; readonly record: JobRecord } {
  NodeFS.mkdirSync(openDir(root), { recursive: true });
  const existing = listJobIds(root);
  let n = Math.max(MIN_JOB_ID, ...existing.map((id) => Number(id) + 1));
  for (;;) {
    const id = String(n);
    try {
      NodeFS.mkdirSync(jobDir(root, id));
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "EEXIST") {
        n += 1;
        continue;
      }
      throw err;
    }
    const submittedAt = clock.now();
    const epoch = Math.floor(Date.parse(submittedAt) / 1000);
    const record: JobRecord = {
      ...init,
      id,
      state: "queued",
      submitted_at: submittedAt,
      key: `${String(Number.isFinite(epoch) ? epoch : 0).padStart(10, "0")}-j${id}`,
    };
    NodeFS.writeFileSync(jobBodyPath(root, id), body, { mode: 0o600 });
    writeFileAtomic(recordPath(root, id), `${JSON.stringify(record, null, 2)}\n`);
    NodeFS.writeFileSync(jobLogPath(root, id), "");
    NodeFS.writeFileSync(NodePath.join(openDir(root), id), "");
    return { id, record };
  }
}

export function readJob(root: string, id: string): JobRecord | null {
  if (!isJobId(id)) return null;
  try {
    return JSON.parse(NodeFS.readFileSync(recordPath(root, id), "utf8")) as JobRecord;
  } catch {
    return null;
  }
}

export function requireJob(root: string, id: string): JobRecord {
  const job = readJob(root, id);
  if (!job) throw new Error(`no such job: ${id} in ${root}`);
  return job;
}

export function updateJob(root: string, id: string, patch: Partial<JobRecord>): JobRecord {
  const next = { ...requireJob(root, id), ...patch, id };
  writeFileAtomic(recordPath(root, id), `${JSON.stringify(next, null, 2)}\n`);
  return next;
}

export function readLog(root: string, id: string): string {
  try {
    return NodeFS.readFileSync(jobLogPath(root, id), "utf8");
  } catch {
    return "";
  }
}

/** Stage output, indented so nothing it prints can pose as a marker. */
export function appendLog(root: string, id: string, text: string): void {
  const lines = text.replace(/\s+$/, "").split(/\r?\n/);
  if (lines.length === 1 && lines[0] === "") return;
  NodeFS.appendFileSync(jobLogPath(root, id), `${lines.map((l) => `  ${l}`).join("\n")}\n`);
}

/** A marker always starts a line, whatever was written before it. */
export function mark(root: string, id: string, line: string): void {
  const logPath = jobLogPath(root, id);
  let prefix = "";
  try {
    const st = NodeFS.statSync(logPath);
    if (st.size > 0) {
      const fd = NodeFS.openSync(logPath, "r");
      try {
        const last = Buffer.alloc(1);
        NodeFS.readSync(fd, last, 0, 1, st.size - 1);
        if (last.toString("utf8") !== "\n") prefix = "\n";
      } finally {
        NodeFS.closeSync(fd);
      }
    }
  } catch {
    // a missing log is created by the append
  }
  NodeFS.appendFileSync(logPath, `${prefix}${line}\n`);
}

export function isEnded(job: JobRecord): boolean {
  return job.state === "done" || job.state === "failed";
}

/**
 * Ends a job exactly once: a log that already holds a terminal line keeps it, and the record
 * takes that outcome instead of writing a second one.
 */
export function endJob(
  root: string,
  id: string,
  outcome: { readonly state: Extract<JobState, "done" | "failed">; readonly line: string },
  clock: Clock,
): JobRecord {
  const job = requireJob(root, id);
  if (isEnded(job)) return job;
  const existing = findTerminal(readLog(root, id), id);
  let next: JobRecord;
  if (existing) {
    const reason = /^FAILED reason=(.*)$/m.exec(readLog(root, id))?.[1];
    next = updateJob(root, id, {
      state: existing,
      ended_at: clock.now(),
      ...(reason ? { reason } : {}),
    });
  } else {
    const reason = /^FAILED reason=(.*)$/.exec(outcome.line)?.[1];
    // The line lands before the record ends, so a reader that sees an ended record finds it.
    mark(root, id, outcome.line);
    next = updateJob(root, id, {
      state: outcome.state,
      ended_at: clock.now(),
      waiting_for: undefined,
      ...(reason ? { reason } : {}),
    });
  }
  NodeFS.rmSync(NodePath.join(openDir(root), id), { force: true });
  return next;
}

export function failJob(root: string, id: string, reason: string, clock: Clock): JobRecord {
  return endJob(root, id, { state: "failed", line: `FAILED reason=${markerValue(reason)}` }, clock);
}

export function requestCancel(root: string, id: string): void {
  NodeFS.writeFileSync(NodePath.join(jobDir(root, id), "cancel"), "");
}

export function cancelRequested(root: string, id: string): boolean {
  return NodeFS.existsSync(NodePath.join(jobDir(root, id), "cancel"));
}

/** A watcher is a live process with a file under `watchers/`; its removal is the returned function. */
export function registerWatcher(root: string, id: string, self: ProcessIdentity): () => void {
  const dir = watchersDir(root, id);
  NodeFS.mkdirSync(dir, { recursive: true });
  const file = NodePath.join(dir, String(self.pid));
  NodeFS.writeFileSync(file, self.startTicks ?? "");
  return () => NodeFS.rmSync(file, { force: true });
}

export function hasLiveWatcher(
  root: string,
  id: string,
  isAlive: (identity: ProcessIdentity) => boolean,
): boolean {
  let names: string[];
  try {
    names = NodeFS.readdirSync(watchersDir(root, id));
  } catch {
    return false;
  }
  let live = false;
  for (const name of names) {
    const file = NodePath.join(watchersDir(root, id), name);
    const pid = Number(name);
    let startTicks: string | null = null;
    try {
      startTicks = NodeFS.readFileSync(file, "utf8").trim() || null;
    } catch {
      continue;
    }
    if (Number.isInteger(pid) && pid > 0 && isAlive({ pid, startTicks })) {
      live = true;
    } else {
      NodeFS.rmSync(file, { force: true });
    }
  }
  return live;
}

export const repoLockPath = (root: string, repo: string) =>
  NodePath.join(repoDir(root, repo), "landing.lock");

export interface RepoRegistration {
  readonly primary: string;
  readonly remoteUrl: string;
}

export function readRegistration(root: string, repo: string): RepoRegistration | null {
  try {
    return JSON.parse(
      NodeFS.readFileSync(NodePath.join(repoDir(root, repo), "registration.json"), "utf8"),
    ) as RepoRegistration;
  } catch {
    return null;
  }
}

export function writeRegistration(root: string, repo: string, reg: RepoRegistration): void {
  NodeFS.mkdirSync(repoDir(root, repo), { recursive: true });
  writeFileAtomic(
    NodePath.join(repoDir(root, repo), "registration.json"),
    `${JSON.stringify(reg, null, 2)}\n`,
  );
}
