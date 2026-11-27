// Neutral README fixtures. Public repo: no real host, user, path, repo, or usage figure here.
import type { ShipQueueJob, UnifiedActiveGrant } from "../../src/devtools/devtoolsClient";
import { mergeFleetHosts } from "../../src/devtools/devdeckTypes";
import type { JobSummary } from "../../src/devtools/jobs/jobTypes";

const GiB = 1024 ** 3;
const MiB = 1024 ** 2;

export const fleetHosts = mergeFleetHosts({
  localHost: {
    name: "host-a",
    uptime_s: 1_204_000,
    load1: 3.4,
    cpus: 16,
    cpu_pct: 41,
    cpu_hist: [12, 18, 30, 41, 38, 44, 41],
    mem: { used: 22 * GiB, total: 64 * GiB },
    gpu: {
      busy_pct: 63,
      busy_hist: [10, 40, 63, 58, 63],
      vram_used: 9 * GiB,
      vram_total: 24 * GiB,
    },
    disks: [
      { mount: "/", label: "root", used: 380 * GiB, total: 1000 * GiB },
      { mount: "/srv", label: "srv", used: 610 * GiB, total: 2000 * GiB },
    ],
  },
  localServers: [],
  localSessions: [
    {
      id: "proc:4242:1",
      kind: "process",
      name: "cargo",
      pid: 4242,
      cpu_pct: 96,
      mem_bytes: 1800 * MiB,
      high: true,
      close_allowed: true,
    },
    {
      id: "proc:5150:1",
      kind: "process",
      name: "node",
      pid: 5150,
      cpu_pct: 22,
      mem_bytes: 640 * MiB,
      close_allowed: true,
    },
  ],
  localAlerts: [],
  localWorktrees: null,
  nodes: {
    "host-b": {
      status: "online",
      host: { name: "host-b", uptime_s: 480_000, load1: 0.6, cpus: 8, cpu_pct: 12 },
    },
    "host-c": {
      status: "online",
      host: { name: "host-c", uptime_s: 290_000, load1: 1.1, cpus: 12, cpu_pct: 27 },
    },
  },
  hostsReport: null,
  shipPanel: null,
});

export function fleetJobs(nowMs: number): ReadonlyArray<JobSummary> {
  const startedAt = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();
  return [
    {
      id: "bg:train",
      revision: 3,
      source: "background",
      kind: "train",
      title: "Model fine-tune run",
      phaseLabel: "Epoch 2/5",
      state: "running",
      binding: { host: "host-a" },
      timing: { startedAt: startedAt(38), etaSeconds: 1500 },
      progress: { current: 2, total: 5, fraction: 0.46, stageLabel: "Epoch 2/5" },
      cancellable: true,
    },
    {
      id: "bg:bench",
      revision: 1,
      source: "background",
      kind: "bench",
      title: "Benchmark suite",
      phaseLabel: "Warm-up",
      state: "running",
      binding: { host: "host-a" },
      timing: { startedAt: startedAt(4) },
      cancellable: true,
    },
  ];
}

const shipRepo = "example-org/example-repo";

/** One ship job at each step of the queue, from submit to merged and synced. */
export function shipJobStages(nowMs: number): ReadonlyArray<ShipQueueJob> {
  const base: ShipQueueJob = {
    id: "1042",
    repo: "example-repo",
    branch: "feat/42-search-filters",
    title: "feat(web): add search filters",
    submitted_at: new Date(nowMs - 6 * 60_000).toISOString(),
    pr_repo: shipRepo,
    watchers: 1,
  };
  return [
    { ...base, state: "queued", last_marker: "QUEUED" },
    { ...base, state: "running", last_marker: "STARTED job=1042", route: { host: "host-b" } },
    { ...base, state: "running", ci_done: 1, route: { host: "host-b" } },
    { ...base, state: "running", ci_done: 1, push_exit: 0, route: { host: "host-b" } },
    { ...base, state: "running", ci_done: 1, push_exit: 0, pr: 87, route: { host: "host-b" } },
    {
      ...base,
      state: "done",
      ci_done: 1,
      push_exit: 0,
      pr: 87,
      merge_exit: 0,
      sync_exit: 0,
      route: { host: "host-b" },
    },
  ];
}

export function shipQueueHistory(nowMs: number): ReadonlyArray<ShipQueueJob> {
  const at = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();
  return [
    {
      id: "1041",
      repo: "example-repo",
      branch: "fix/40-empty-state",
      title: "fix(web): show the empty state again",
      submitted_at: at(55),
      state: "done",
      ci_done: 1,
      push_exit: 0,
      pr: 86,
      pr_repo: shipRepo,
      merge_exit: 0,
      sync_exit: 0,
    },
    {
      id: "1040",
      repo: "project-a",
      branch: "chore/39-bump-docs",
      title: "docs: update the setup guide",
      submitted_at: at(120),
      state: "failed",
      ci_done: 1,
      reason: "ci failed: lint",
    },
  ];
}

export function jobFromShip(job: ShipQueueJob): JobSummary {
  return {
    id: `ship:${job.id}`,
    revision: 1,
    source: "ship-queue",
    kind: "ship",
    title: job.title ?? "",
    phaseLabel: "Shipping",
    state: job.state === "done" ? "done" : job.state === "failed" ? "failed" : "running",
    binding: { host: "host-b" },
    timing: { startedAt: job.submitted_at ?? "" },
    cancellable: false,
    shipJob: job,
  };
}

export function securityGrants(nowMs: number): ReadonlyArray<UnifiedActiveGrant> {
  return [
    {
      kind: "guard_bundle",
      grantId: "grant-1",
      threadId: "thread-1",
      repo: "example-org/example-repo",
      branch: "feat/42-search-filters",
      prOrIssue: "#42",
      guard: "protected-paths",
      gateIds: ["ci-config", "lockfile"],
      protectedPaths: [".github/workflows/ci.yml", "pnpm-lock.yaml"],
      protectedDiffSha256: "0".repeat(64),
      bodySha256: "1".repeat(64),
      summary: "CI workflow and lockfile change for #42",
      reason: "New test job needs a dependency",
      approvedVia: "modal",
      createdAt: new Date(nowMs - 20 * 60_000).toISOString(),
      expiresAt: null,
      useCount: 2,
      lastUsedAt: new Date(nowMs - 5 * 60_000).toISOString(),
    },
    {
      kind: "secret_access",
      grantId: "grant-2",
      threadId: "thread-2",
      projectId: "project-a",
      delivery: "file",
      summary: "Deploy key for project-a",
      createdAt: new Date(nowMs - 60 * 60_000).toISOString(),
      expiresAt: new Date(nowMs + 23 * 60 * 60_000).toISOString(),
    },
  ];
}
