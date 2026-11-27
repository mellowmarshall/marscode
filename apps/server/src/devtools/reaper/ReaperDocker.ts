// @effect-diagnostics nodeBuiltinImport:off - Stale ephemeral Docker containers and networks, by allowlist and safety labels.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";

import { EMPTY_DOCKER_REAP_RULES, type DockerReapRules } from "./ReaperDockerPolicy.ts";
import type { ReaperLog } from "./ReaperTypes.ts";

const DOCKER_MIN_AGE_S = 300;
const OWNER_PID_LABEL = "dev.reaper.owner-pid";
const OWNER_HOST_LABEL = "dev.reaper.owner-host";
const OWNER_NS_LABEL = "dev.reaper.owner-ns";
const COMPOSE_LABEL = "com.docker.compose.project";
const CHECKOUT_LABEL = "dev.devdeck.checkout";
const KEEP_LABEL = "dev.reaper.keep";
const PROTECTED_RESTART_POLICIES = new Set(["always", "unless-stopped", "on-failure"]);
const BUILTIN_NETWORKS = new Set(["bridge", "host", "none"]);
const INSPECT_BATCH = 50;

// Generic `<name>-ci-<pid>-<n>` names; project-specific patterns come from the policy's `[docker]` section.
const CONTAINER_PID_PATTERNS = [/^[a-z0-9][a-z0-9_.-]*-ci-(\d+)-\d+$/];
const NETWORK_PID_PATTERNS = [/^[a-z0-9][a-z0-9_.-]*-ci-smoke-(\d+)$/];

type Labels = Readonly<Record<string, string>>;

export interface DockerScope {
  readonly nowMs: number;
  readonly selfHost: string;
  readonly selfPidNs: string;
  /** Docker Desktop: one daemon several hosts share, where PIDs and paths are not this host's. */
  readonly sharedDaemon: boolean;
  readonly pidDead: (pid: number) => boolean;
  readonly checkoutDeleted: (path: string) => Promise<boolean>;
  readonly minAgeS?: number;
  readonly rules?: DockerReapRules;
}

/** True only when the PID is positively gone on this host. */
export function isPidDead(pid: number): boolean {
  if (pid <= 0 || pid === process.pid || pid === process.ppid) return false;
  try {
    process.kill(pid, 0);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ESRCH";
  }
}

/** True only when the path is missing while its parent exists: an unmounted /data never counts. */
export async function isCheckoutDeleted(path: string): Promise<boolean> {
  if (!path || !NodePath.isAbsolute(path)) return false;
  const parent = NodePath.dirname(path.replace(/\/+$/, ""));
  if (!parent || parent === path) return false;
  try {
    await NodeFSP.stat(parent);
  } catch {
    return false;
  }
  try {
    await NodeFSP.stat(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "ENOENT";
  }
}

/** Docker RFC 3339 timestamps (nanosecond precision) as epoch ms; null for the zero time. */
function parseDockerTimestamp(ts: unknown): number | null {
  if (typeof ts !== "string" || !ts.trim() || ts.startsWith("0001-01-01")) return null;
  const ms = Date.parse(ts.trim().replace(/\.(\d{3})\d*(?=Z|[+-]\d\d:\d\d$)/, ".$1"));
  return Number.isFinite(ms) ? ms : null;
}

// Any `*.keep` / `*.keep-db` label protects a resource with no policy file at all.
const isKeepKey = (key: string, keepLabels: ReadonlyArray<string>) =>
  key === KEEP_LABEL ||
  key.endsWith(".keep") ||
  key.endsWith(".keep-db") ||
  keepLabels.includes(key);

const hasKeepLabel = (labels: Labels, keepLabels: ReadonlyArray<string>) =>
  Object.entries(labels).some(
    ([key, value]) =>
      isKeepKey(key, keepLabels) &&
      ["1", "true", "yes"].includes(
        String(value ?? "")
          .trim()
          .toLowerCase(),
      ),
  );

const positivePid = (raw: unknown) => {
  const s = String(raw ?? "").trim();
  return /^\d+$/.test(s) && Number(s) > 0 ? Number(s) : null;
};

function ownerScopeMatches(labels: Labels, scope: DockerScope): boolean {
  const host = String(labels[OWNER_HOST_LABEL] ?? "").trim();
  if (host && scope.selfHost && host.split(".")[0] !== scope.selfHost.split(".")[0]) return false;
  const ns = String(labels[OWNER_NS_LABEL] ?? "").trim();
  return !(ns && scope.selfPidNs && ns !== scope.selfPidNs);
}

function commonRefusal(labels: Labels, created: unknown, scope: DockerScope): boolean {
  if (labels[COMPOSE_LABEL] || hasKeepLabel(labels, scope.rules?.keepLabels ?? [])) return true;
  const createdMs = parseDockerTimestamp(created);
  if (createdMs === null || scope.nowMs - createdMs < (scope.minAgeS ?? DOCKER_MIN_AGE_S) * 1_000)
    return true;
  return !ownerScopeMatches(labels, scope);
}

function ownerPidReason(
  labels: Labels,
  name: string,
  patterns: ReadonlyArray<RegExp>,
  scope: DockerScope,
) {
  const ownerPid = positivePid(labels[OWNER_PID_LABEL]);
  if (ownerPid !== null) {
    if (scope.sharedDaemon && !(labels[OWNER_HOST_LABEL] && labels[OWNER_NS_LABEL])) return null;
    return scope.pidDead(ownerPid) ? `dead owner-pid=${ownerPid} (label)` : null;
  }
  if (scope.sharedDaemon) return undefined;
  for (const pattern of patterns) {
    const match = pattern.exec(name);
    // A match without a captured PID (an alternation branch that skips group 1) proves nothing.
    if (match && /^\d+$/.test(match[1] ?? "")) {
      const pid = Number(match[1]);
      return scope.pidDead(pid) ? `dead owner-pid=${pid} (name)` : null;
    }
  }
  return undefined;
}

/** A stale reason when the container may go, else null. Never age alone: an allowlist rule must match. */
export async function classifyContainer(
  info: Record<string, any>,
  scope: DockerScope,
): Promise<string | null> {
  const labels: Labels = info.Config?.Labels ?? {};
  const restart = String(info.HostConfig?.RestartPolicy?.Name ?? "")
    .trim()
    .toLowerCase();
  if (PROTECTED_RESTART_POLICIES.has(restart) || commonRefusal(labels, info.Created, scope))
    return null;
  const name = String(info.Name ?? "").replace(/^\//, "");
  const rules = scope.rules ?? EMPTY_DOCKER_REAP_RULES;
  const patterns = [...rules.containerPidPatterns, ...CONTAINER_PID_PATTERNS];
  const byPid = ownerPidReason(labels, name, patterns, scope);
  if (byPid !== undefined) return byPid;
  const checkout = String(labels[CHECKOUT_LABEL] ?? "").trim();
  if (checkout && !scope.sharedDaemon && (await scope.checkoutDeleted(checkout))) {
    return `deleted checkout ${checkout}`;
  }
  return null;
}

export function classifyNetwork(info: Record<string, any>, scope: DockerScope): string | null {
  const name = String(info.Name ?? "");
  if (!name || BUILTIN_NETWORKS.has(name)) return null;
  const labels: Labels = info.Labels ?? {};
  if (info.Containers && Object.keys(info.Containers).length > 0) return null;
  if (commonRefusal(labels, info.Created, scope)) return null;
  const rules = scope.rules ?? EMPTY_DOCKER_REAP_RULES;
  const patterns = [...rules.networkPidPatterns, ...NETWORK_PID_PATTERNS];
  return ownerPidReason(labels, name, patterns, scope) ?? null;
}

export interface DockerRunResult {
  readonly code: number;
  readonly stdout: string;
}
export type DockerRunner = (
  args: ReadonlyArray<string>,
  timeoutMs: number,
) => Promise<DockerRunResult | null>;

const runDocker: DockerRunner = (args, timeoutMs) =>
  new Promise((resolve) => {
    NodeChildProcess.execFile(
      "docker",
      [...args],
      { timeout: timeoutMs, maxBuffer: 64 * 1024 * 1024 },
      (error, stdout) => {
        if (error && (error as NodeJS.ErrnoException).code === "ENOENT") resolve(null);
        else
          resolve({ code: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout });
      },
    );
  });

async function inspectAll(
  run: DockerRunner,
  cmd: ReadonlyArray<string>,
  ids: ReadonlyArray<string>,
) {
  const items: Array<Record<string, any>> = [];
  for (let i = 0; i < ids.length; i += INSPECT_BATCH) {
    const res = await run([...cmd, ...ids.slice(i, i + INSPECT_BATCH)], 60_000);
    if (!res || res.code !== 0 || !res.stdout.trim()) continue;
    try {
      const parsed: unknown = JSON.parse(res.stdout);
      if (Array.isArray(parsed)) items.push(...parsed.filter((x) => x && typeof x === "object"));
    } catch {
      // a batch that changed mid-inspect is retried next run
    }
  }
  return items;
}

const lines = (res: DockerRunResult | null) =>
  res && res.code === 0
    ? res.stdout
        .split("\n")
        .map((l) => l.trim())
        .filter(Boolean)
    : [];

export async function reapDocker(
  scope: Omit<DockerScope, "sharedDaemon">,
  options: { readonly dryRun: boolean; readonly log: ReaperLog; readonly run?: DockerRunner },
): Promise<{ readonly containers: number; readonly networks: number }> {
  const run = options.run ?? runDocker;
  const info = await run(["info", "--format", "{{.OperatingSystem}}"], 15_000);
  if (!info || info.code !== 0) return { containers: 0, networks: 0 };
  const full: DockerScope = {
    ...scope,
    sharedDaemon: info.stdout.toLowerCase().includes("docker desktop"),
  };
  const verb = options.dryRun ? "would remove" : "removed";
  let containers = 0;
  for (const c of await inspectAll(run, ["inspect"], lines(await run(["ps", "-aq"], 30_000)))) {
    const reason = await classifyContainer(c, full);
    if (!reason) continue;
    const name = String(c.Name ?? c.Id ?? "").replace(/^\//, "");
    if (options.dryRun || (await run(["rm", "-fv", String(c.Id ?? name)], 60_000))?.code === 0) {
      containers += 1;
      options.log(`Docker ${verb} stale container ${name} (${reason})`);
    }
  }
  const netIds = lines(await run(["network", "ls", "--format", "{{.ID}}\t{{.Name}}"], 30_000))
    .map((l) => l.split("\t"))
    .filter(([id, name]) => id && name && !BUILTIN_NETWORKS.has(name.trim()))
    .map(([id]) => id!);
  let networks = 0;
  for (const n of await inspectAll(run, ["network", "inspect"], netIds)) {
    const reason = classifyNetwork(n, full);
    if (!reason) continue;
    if (
      options.dryRun ||
      (await run(["network", "rm", String(n.Id ?? n.Name)], 30_000))?.code === 0
    ) {
      networks += 1;
      options.log(`Docker ${verb} stale network ${String(n.Name)} (${reason})`);
    }
  }
  return { containers, networks };
}
