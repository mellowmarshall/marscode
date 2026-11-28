// Neutral README fixtures. Public repo: no real host, user, path, repo, or usage figure here.
import type {
  PendingGuardRequest,
  ShipQueueJob,
  UnifiedActiveGrant,
} from "../../src/devtools/devtoolsClient";
import { mergeFleetHosts } from "../../src/devtools/devdeckTypes";
import type { JobCernoVerdict, JobSummary } from "../../src/devtools/jobs/jobTypes";

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
  // Before a first hosts check the server lists manifest hosts with only their CI state.
  hostsReport: {
    report: {
      hosts: [
        { name: "host-a", ssh: null, ci_off: false },
        { name: "host-b", ssh: "host-b", ci_off: false },
        { name: "host-c", ssh: "host-c", ci_off: true },
      ],
    },
  },
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
      load: { cpuPct: 1220, memBytes: 18 * GiB, processCount: 6 },
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
      load: { cpuPct: 310, memBytes: 2 * GiB, processCount: 3 },
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

// Sidebar and thread rail: three threads, each showing MarsCode states.
export const sidebarThreads = {
  approval: { id: "thread-approval", title: "Rename the default branch" },
  shipping: { id: "thread-shipping", title: "Add search filters" },
  job: { id: "thread-job", title: "Tune the ranking model" },
} as const;

/** A batch override plan: one owner approval covers every listed command once. */
export function planGuardRequest(nowMs: number): PendingGuardRequest {
  const repo = "example-org/example-repo";
  const entry = (guard: string, command: ReadonlyArray<string>) => ({
    guard,
    command,
    argvSha256: "5".repeat(64),
  });
  const plan = [
    entry("gh", ["gh", "repo", "edit", repo, "--default-branch", "main"]),
    entry("gh", ["gh", "api", "-X", "DELETE", `repos/${repo}/branches/master/protection`]),
    entry("gh", [
      "gh",
      "api",
      "-X",
      "PUT",
      `repos/${repo}/branches/main/protection`,
      "--input",
      "protection.json",
    ]),
    entry("git", ["git", "push", "origin", "--delete", "master"]),
  ];
  return {
    requestId: "req-plan-1",
    guard: "gh",
    command: plan[0]!.command,
    argvSha256: "2".repeat(64),
    cwd: "~/work/example-repo",
    refusal: "repository administration needs the owner's approval",
    proposedReason: "Move the default branch to main and keep its protection rules",
    threadId: sidebarThreads.approval.id,
    session: "session-1",
    pid: 4100,
    createdAt: new Date(nowMs - 40_000).toISOString(),
    expiresAt: new Date(nowMs + 10 * 60_000).toISOString(),
    plan,
  };
}

/** Grants the key badge lists on the shipping thread. */
export function threadKeyGrants(nowMs: number): ReadonlyArray<UnifiedActiveGrant> {
  return [
    {
      kind: "secret_access",
      grantId: "grant-search-1",
      threadId: sidebarThreads.shipping.id,
      projectId: "project-a",
      delivery: "file",
      summary: "Package registry token",
      createdAt: new Date(nowMs - 30 * 60_000).toISOString(),
      expiresAt: new Date(nowMs + (3 * 60 + 25) * 60_000).toISOString(),
    },
    {
      kind: "guard_bundle",
      grantId: "grant-search-2",
      threadId: sidebarThreads.shipping.id,
      repo: "example-org/example-repo",
      branch: "feat/42-search-filters",
      prOrIssue: "#42",
      guard: "protected-paths",
      gateIds: ["ci-config"],
      protectedPaths: [".github/workflows/ci.yml"],
      protectedDiffSha256: "3".repeat(64),
      bodySha256: "4".repeat(64),
      summary: "CI workflow change for #42",
      reason: "The new search tests need their own CI job",
      approvedVia: "modal",
      createdAt: new Date(nowMs - 25 * 60_000).toISOString(),
      expiresAt: null,
      useCount: 1,
      lastUsedAt: new Date(nowMs - 10 * 60_000).toISOString(),
    },
  ];
}

// Verdicts as the server builds them (`buildCernoVerdict`): bars follow confidence, colour the label.
const healthy: JobCernoVerdict = {
  checkedAt: "2026-01-01T00:00:00.000Z",
  state: "RUNNING",
  confidence: 0.94,
  tone: "info",
  pips: 4,
  label: "Healthy",
  outcome: "unknown",
  summary: "RUNNING (94%) · CPU active",
};

/** The cerno verdict on a watched training run as it stalls and recovers (one GIF frame each). */
export const cernoHealthStages: ReadonlyArray<{
  readonly cerno: JobCernoVerdict;
  readonly fraction: number;
}> = [
  { cerno: healthy, fraction: 0.42 },
  {
    cerno: {
      ...healthy,
      confidence: 0.78,
      tone: "warning",
      pips: 3,
      label: "Possibly stalled",
      summary: "RUNNING (78%) · stall:suspicion",
    },
    fraction: 0.44,
  },
  {
    cerno: {
      ...healthy,
      confidence: 0.93,
      tone: "destructive",
      pips: 4,
      label: "Stalled",
      summary: "RUNNING (93%) · stall:confirmed",
    },
    fraction: 0.44,
  },
  {
    cerno: { ...healthy, confidence: 0.8, pips: 3, summary: "RUNNING (80%) · CPU active" },
    fraction: 0.47,
  },
  { cerno: healthy, fraction: 0.52 },
];

/** Live jobs bound to the sidebar threads: one ship job, two watched background commands. */
export function sidebarJobs(
  nowMs: number,
  stage = cernoHealthStages[0]!,
): ReadonlyArray<JobSummary> {
  const startedAt = (minutesAgo: number) => new Date(nowMs - minutesAgo * 60_000).toISOString();
  const ship = shipJobStages(nowMs)[2]!;
  return [
    {
      ...jobFromShip({ ...ship, thread_id: sidebarThreads.shipping.id }),
      binding: { host: "host-b", threadId: sidebarThreads.shipping.id },
    },
    {
      id: "bg:train-ranker",
      revision: 1,
      source: "background",
      kind: "train",
      title: "Ranker training",
      phaseLabel: "Epoch 3/6",
      state: "running",
      binding: { host: "host-a", threadId: sidebarThreads.job.id },
      timing: { startedAt: startedAt(52) },
      progress: { current: 3, total: 6, fraction: stage.fraction, stageLabel: "Epoch 3/6" },
      cerno: stage.cerno,
      cancellable: true,
    },
    {
      id: "bg:eval-ranker",
      revision: 1,
      source: "background",
      kind: "eval",
      title: "Offline eval suite",
      phaseLabel: "Running",
      state: "running",
      binding: { host: "host-a", threadId: sidebarThreads.job.id },
      timing: { startedAt: startedAt(9) },
      progress: { current: 140, total: 400, fraction: 0.35 },
      cerno: { ...healthy, confidence: 0.88 },
      cancellable: true,
    },
  ];
}

/** A merged ship job with its declared steps timed, and a challenge the agent overrode. */
export function shipJobWithSteps(nowMs: number): ShipQueueJob {
  return {
    id: "1043",
    repo: "example-repo",
    branch: "feat/44-saved-searches",
    title: "feat(web): save searches",
    submitted_at: new Date(nowMs - 14 * 60_000).toISOString(),
    pr_repo: shipRepo,
    state: "done",
    ci_done: 1,
    push_exit: 0,
    pr: 88,
    merge_exit: 0,
    sync_exit: 0,
    rebased_onto: "a1b2c3d4e5f6",
    pushed_sha: "0f9e8d7c6b5a",
    steps: [
      { name: "ship_body_check", host: "local", exit: 0, ms: 420 },
      { name: "ship_install", host: "host-b", exit: 0, ms: 21_800 },
      { name: "ship_ci", host: "host-b", exit: 0, ms: 154_000 },
      { name: "ship_merge", host: "local", exit: 0, ms: 3_900 },
    ],
    challenge_override: {
      reason: "The flagged file is generated; its size limit does not apply",
      at: new Date(nowMs - 4 * 60_000).toISOString(),
    },
  };
}
