// @effect-diagnostics nodeBuiltinImport:off - Temp-directory filesystem fixtures for DevtoolsConfig and ReviewStats unit tests.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import {
  ProviderDriverKind,
  UsageLimitSourceId,
  type UsageLimitSourceSnapshot,
} from "@t3tools/contracts";

import {
  DEFAULT_DEVTOOLS_HOST_CONFIG,
  classifyModel,
  readDevtoolsHostConfig,
  resolveReviewRolePlan,
  writeDevtoolsHostConfig,
} from "./DevtoolsConfig.ts";
import {
  discoverFleetHosts,
  isValidSshAlias,
  readFleetConfigSnapshot,
  writeFleetHostConfig,
  type SshRunner,
} from "./DevtoolsFleetConfig.ts";
import {
  _resetFleetConfigCacheForTests,
  getCachedFleetConfigSnapshot,
  invalidateFleetConfigCache,
  warmFleetConfigCache,
} from "./DevtoolsFleetConfigCache.ts";
import {
  aggregateReviewStats,
  appendReviewStatRecord,
  buildRecordFromDelegatedReview,
  buildSubmitterLookupFromRows,
  deriveRepoNameFromWorktree,
  isDelegatedReviewSubagent,
  loadReviewRecords,
  parseAdversarialReviewCounts,
} from "./ReviewStats.ts";

const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

type TestWindow = { readonly usedPercent: number; readonly resetsAt: string };

function limitSource(
  accounts: ReadonlyArray<{ readonly driver: string; readonly windows: ReadonlyArray<TestWindow> }>,
): UsageLimitSourceSnapshot {
  const checkedAt = "2026-01-01T00:00:00Z";
  return {
    id: UsageLimitSourceId.make("test-hub"),
    kind: "cliproxy",
    label: "Test hub",
    checkedAt,
    accounts: accounts.map((acc, idx) => ({
      id: `${acc.driver}-${idx}`,
      driver: ProviderDriverKind.make(acc.driver),
      usageLimits: {
        checkedAt,
        windows: acc.windows.map((w, wIdx) => ({
          id: `w${wIdx}`,
          kind: "weekly" as const,
          label: `w${wIdx}`,
          usedPercent: w.usedPercent,
          resetsAt: w.resetsAt,
        })),
      },
    })),
  };
}

const FUTURE = "2099-01-01T00:00:00Z";
const PAST = "2020-01-01T00:00:00Z";

afterEach(() => {
  _resetFleetConfigCacheForTests();
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("DevtoolsConfig & usage-based review model resolution", () => {
  it("reads defaults when host-config.json is absent and persists updates atomically while preserving unknown keys", () => {
    const dir = makeTempDir("t3-devtools-cfg-");
    const cfgPath = NodePath.join(dir, "host-config.json");
    expect(readDevtoolsHostConfig(cfgPath)).toEqual(DEFAULT_DEVTOOLS_HOST_CONFIG);

    NodeFS.writeFileSync(
      cfgPath,
      JSON.stringify({
        custom_host_flag: "keep-me",
        devdeck: { endpoint_override: "/run/user/1000/devdeck.sock" },
      }),
    );
    const res = writeDevtoolsHostConfig(
      {
        challenge_timeout_s: 300,
        playbook_challenge: {
          default: { provider: "codex", model: "gpt-6.2-astra", effort: "high" },
          fallbacks: [
            { provider: "claudeAgent", model: "claude-sonnet-5-5", effort: "medium" },
            { provider: "antigravity", model: "gemini-4-neon", effort: "medium" },
          ],
          min_remaining_pct: 15,
        },
        guards: { request_timeout_s: 180, grant_ttl_s: 90 },
        jobs: { default_stall_minutes: 20 },
        devdeck: { endpoint_override: "127.0.0.1:3219" },
      },
      cfgPath,
    );
    expect(res.ok).toBe(true);
    if (!res.ok) return;
    expect(res.config.challenge_timeout_s).toBe(300);
    expect(res.config.guards.request_timeout_s).toBe(180);
    expect(res.config.jobs.default_stall_minutes).toBe(20);
    expect("devdeck" in res.config).toBe(false);

    const raw = JSON.parse(NodeFS.readFileSync(cfgPath, "utf8")) as Record<string, unknown>;
    expect(raw.custom_host_flag).toBe("keep-me");
    // The retired DevDeck endpoint override is never persisted again.
    expect("devdeck" in raw).toBe(false);
  });

  it("picks default first when healthy, and auto-picks highest remaining usage fallback when default is below threshold", () => {
    const limitSources = [
      limitSource([
        { driver: "codex", windows: [{ usedPercent: 96, resetsAt: FUTURE }] },
        { driver: "claudeAgent", windows: [{ usedPercent: 30, resetsAt: FUTURE }] },
        { driver: "claudeAgent", windows: [{ usedPercent: 5, resetsAt: FUTURE }] },
        {
          driver: "antigravity",
          windows: [
            { usedPercent: 25, resetsAt: FUTURE },
            { usedPercent: 99, resetsAt: PAST },
          ],
        },
        { driver: "grok", windows: [{ usedPercent: 12, resetsAt: FUTURE }] },
      ]),
    ];

    const cfg = {
      ...DEFAULT_DEVTOOLS_HOST_CONFIG,
      playbook_challenge: {
        default: { provider: "codex", model: "gpt-6.2-astra", effort: "medium" as const },
        fallbacks: [
          { provider: "antigravity", model: "gemini-4-neon", effort: "medium" as const },
          { provider: "grok", model: "grok-4.7", effort: "high" as const },
          { provider: "claudeAgent", model: "claude-sonnet-5-5", effort: "medium" as const },
        ],
        min_remaining_pct: 10,
      },
    };

    const pbPlan = resolveReviewRolePlan("playbook_challenge", cfg, { limitSources });
    expect(pbPlan.fallbackUsed).toBe(true);
    // Claude proxy best account has 95% remaining > Grok 88% > Gemini 75% (expired 5h ignored)
    expect(pbPlan.selected.provider).toBe("claudeAgent");
    expect(pbPlan.selected.remainingPct).toBe(95);
    expect(pbPlan.candidates.map((c) => c.provider)).toEqual([
      "claudeAgent",
      "grok",
      "antigravity",
      "codex",
    ]);

    const sqPlan = resolveReviewRolePlan("ship_queue_review", cfg, { limitSources });
    expect(sqPlan.fallbackUsed).toBe(false);
    expect(sqPlan.selected.provider).toBe("claudeAgent");
    expect(sqPlan.selected.model).toBe("claude-fable-5-2");
  });

  it("classifies models into normalized family and lab", () => {
    expect(classifyModel("gpt-6.2-astra (medium)")).toMatchObject({
      model: "gpt-6.2-astra",
      effort: "medium",
      family: "Astra",
      lab: "OpenAI",
    });
    expect(classifyModel("Claude Opus 5.5 high")).toMatchObject({
      family: "Opus",
      lab: "Anthropic",
      effort: "high",
    });
    expect(classifyModel("gemini-4-neon", "antigravity")).toMatchObject({
      family: "Gemini 4",
      lab: "Google",
    });
  });
});

describe("ReviewStats aggregation (reviewer + submitter sides)", () => {
  it("parses adversarial review markdown counts and enriches submitters from T3 thread rows", () => {
    const dir = makeTempDir("t3-devtools-stats-");
    const pbRepoDir = NodePath.join(dir, "playbook", "devtools");
    const shipJobDir = NodePath.join(dir, "jobs", "10999");
    NodeFS.mkdirSync(pbRepoDir, { recursive: true });
    NodeFS.mkdirSync(shipJobDir, { recursive: true });

    NodeFS.writeFileSync(
      NodePath.join(pbRepoDir, "feat-a.1.challenge.json"),
      JSON.stringify({
        acceptable: false,
        repo: "devtools",
        branch: "feat-a",
        commit: "abc123456789",
        reviewer: "gpt-6.2-astra (medium)",
        thread_id: "thread-opus",
        timestamp: "2026-11-21T12:00:00Z",
        bypass_detected: false,
        playbook_friction: false,
        rejected_rises: [],
        defects: [
          { severity: "breaking", file: "a.py", what: "boom" },
          { severity: "high", file: "b.py", what: "bug" },
          { severity: "medium", file: "c.py", what: "meh" },
        ],
      }),
    );

    NodeFS.writeFileSync(
      NodePath.join(shipJobDir, "job.json"),
      JSON.stringify({
        id: "10999",
        repo: "private-repo",
        branch: "feat-b",
        thread_id: "thread-opus",
        submitted_at: "2026-11-21T13:00:00Z",
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(shipJobDir, "adversarial-review.md"),
      [
        "## Adversarial Review",
        "- Reviewer: Claude Fable 5.2 (high)",
        "- Verdict: Ship after fixes",
        "- C1: Auth bypass in token check",
        "- H1: Race in lockfile update",
        "- L1: Typo in hint",
      ].join("\n"),
    );

    const parsedCounts = parseAdversarialReviewCounts(
      "- C1: bad\n- H1: bug\n- M1: nit\n- L1: typo",
    );
    expect(parsedCounts).toEqual({
      breaking: 0,
      critical: 1,
      high: 1,
      medium: 1,
      low: 1,
      info: 0,
      total: 4,
    });

    const lookup = buildSubmitterLookupFromRows([
      {
        thread_id: "thread-opus",
        payload_json: JSON.stringify({
          branch: "feat-a",
          modelSelection: {
            instanceId: "claudeAgent",
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "medium" }],
          },
        }),
      },
    ]);

    const records = loadReviewRecords(
      {
        playbookStateDir: NodePath.join(dir, "playbook"),
        shipJobsDir: NodePath.join(dir, "jobs"),
        jsonlPath: NodePath.join(dir, "missing.jsonl"),
      },
      lookup,
    );
    expect(records).toHaveLength(2);

    const bySubmitter = aggregateReviewStats(records, { side: "submitter", by: "model" });
    expect(bySubmitter.totals.total).toBe(6);
    expect(bySubmitter.totals.breaking).toBe(1);
    expect(bySubmitter.totals.critical).toBe(1);
    expect(bySubmitter.totals.high).toBe(2);
    expect(bySubmitter.totals.medium).toBe(1);
    expect(bySubmitter.totals.low).toBe(1);
    expect(bySubmitter.groups[0]?.key).toBe("claude-opus-5-5 (medium)");
    expect(bySubmitter.highlights.topBugSubmitter?.label).toBe("claude-opus-5-5 (medium)");
    expect(bySubmitter.highlights.topBugCatcher?.totalIssues).toBe(3);

    const byPair = aggregateReviewStats(records, { side: "pair", by: "model" });
    expect(byPair.groups.map((g) => g.key)).toContain(
      "claude-opus-5-5 (medium) → gpt-6.2-astra (medium)",
    );
  });

  it("handles review findings regressions: bracket models, validation 400, default-vs-fallback quota, prose hyphens, and subagent exclusion", () => {
    const dir = makeTempDir("devtools-reg-");
    const configPath = NodePath.join(dir, "host-config.json");

    // M4: bracketed model slugs persist; invalid submitted model specs fail instead of silently resetting.
    const bracketWrite = writeDevtoolsHostConfig(
      {
        ship_queue_review: {
          default: { provider: "claudeAgent", model: "claude-opus-5-5[1m]", effort: "high" },
          fallbacks: [],
          min_remaining_pct: 10,
        },
      },
      configPath,
    );
    expect(bracketWrite.ok).toBe(true);
    if (bracketWrite.ok) {
      expect(bracketWrite.config.ship_queue_review.default.model).toBe("claude-opus-5-5[1m]");
    }
    const invalidWrite = writeDevtoolsHostConfig(
      {
        ship_queue_review: {
          default: { provider: "claudeAgent", model: "bad model with spaces!", effort: "high" },
        },
      },
      configPath,
    );
    expect(invalidWrite.ok).toBe(false);

    // M5: default at 9% (< 10% threshold) still beats fallback at 1%.
    const m5LimitSources = [
      limitSource([
        { driver: "codex", windows: [{ usedPercent: 91, resetsAt: FUTURE }] },
        { driver: "claudeAgent", windows: [{ usedPercent: 99, resetsAt: FUTURE }] },
      ]),
    ];
    const plan = resolveReviewRolePlan(
      "playbook_challenge",
      {
        ...DEFAULT_DEVTOOLS_HOST_CONFIG,
        playbook_challenge: {
          default: { provider: "codex", model: "auto:astra", effort: "medium" },
          fallbacks: [{ provider: "claudeAgent", model: "claude-fable-5-2", effort: "high" }],
          min_remaining_pct: 10,
        },
      },
      { limitSources: m5LimitSources },
    );
    expect(plan.selected.provider).toBe("codex");
    expect(plan.fallbackUsed).toBe(false);
    expect(plan.reason).toBe("no_healthier_fallback");

    // M3: prose hyphens ("High-level", "Low-risk") never count as findings.
    const proseCounts = parseAdversarialReviewCounts(
      "High-level overview of changes.\nLow-risk refactor only.\n- No blocking issues found.",
    );
    expect(proseCounts.total).toBe(0);

    // H3: deleted and subagent threads never overwrite the author's model in byWorktree/byBranch.
    const lookup = buildSubmitterLookupFromRows([
      {
        thread_id: "thread-author",
        payload_json: JSON.stringify({
          branch: "feat-x",
          worktreePath: "/data/Dev/repo/wt-x",
          modelSelection: {
            instanceId: "claudeAgent",
            model: "claude-opus-5-5",
            options: [{ id: "effort", value: "medium" }],
          },
        }),
      },
      {
        thread_id: "thread:delegated-task:review-1",
        payload_json: JSON.stringify({
          branch: "feat-x",
          worktreePath: "/data/Dev/repo/wt-x",
          lineage: { relationshipToParent: "subagent" },
          modelSelection: {
            instanceId: "codex",
            model: "gpt-6.2-astra",
            options: [{ id: "effort", value: "high" }],
          },
        }),
      },
      {
        thread_id: "thread-deleted",
        payload_json: JSON.stringify({
          branch: "feat-x",
          worktreePath: "/data/Dev/repo/wt-x",
          deletedAt: "2026-11-21T15:00:00Z",
          modelSelection: {
            instanceId: "grok",
            model: "grok-4",
          },
        }),
      },
    ]);
    expect(lookup.byWorktree.get("/data/Dev/repo/wt-x")?.model).toBe("claude-opus-5-5");
    expect(lookup.byBranch.get("feat-x")?.model).toBe("claude-opus-5-5");
    // Subagent thread is still indexed in byThreadId so reviewThreadId resolves reviewer models.
    expect(lookup.byThreadId.get("thread:delegated-task:review-1")?.model).toBe("gpt-6.2-astra");
  });

  it("ingests completed delegated review subagents, appends review-stats.jsonl idempotently, and deduplicates with ship-queue jobs", () => {
    const dir = makeTempDir("devtools-delegated-stats-");
    const shipJobDir = NodePath.join(dir, "jobs", "11001");
    const jsonlPath = NodePath.join(dir, "review-stats.jsonl");
    NodeFS.mkdirSync(shipJobDir, { recursive: true });

    expect(isDelegatedReviewSubagent("Act as the review sub-agent for this task.\n\nReview.")).toBe(
      true,
    );
    expect(isDelegatedReviewSubagent("Act as the research sub-agent for this task.")).toBe(false);
    expect(deriveRepoNameFromWorktree("/dataprivate-repo/issue-1281")).toBe("devtools");
    expect(deriveRepoNameFromWorktree("/home/dev/.t3/worktrees/private-repo/abc123")).toBe("private-repo");

    const lookup = buildSubmitterLookupFromRows([
      {
        thread_id: "parent-thread-1",
        model: "gemini-4-neon",
        instance_id: "antigravity",
        provider: "antigravity",
        default_provider: "antigravity",
        options_json: JSON.stringify([{ id: "effort", value: "high" }]),
        branch: "issue-1281",
        worktree_path: "/dataprivate-repo/issue-1281",
        is_subagent: 0,
      },
      {
        thread_id: "thread:delegated-task:rev-abc",
        model: "claude-fable-5-2",
        instance_id: "claudeAgent",
        provider: "claudeAgent",
        default_provider: "claudeAgent",
        options_json: JSON.stringify([{ id: "effort", value: "high" }]),
        branch: "issue-1281",
        worktree_path: "/dataprivate-repo/issue-1281",
        is_subagent: 1,
      },
    ]);

    const delegatedRow = {
      subagentId: "node:delegated-task:rev-abc",
      parentThreadId: "parent-thread-1",
      childThreadId: "thread:delegated-task:rev-abc",
      status: "completed",
      startedAt: "2026-11-21T12:00:00.000Z",
      completedAt: "2026-11-21T12:01:30.000Z",
      updatedAt: "2026-11-21T12:01:30.000Z",
      prompt: "Act as the review sub-agent for this task.\n\nReview diff.",
      result: "Verdict: Do not ship\n- H1: Race condition in lockfile\n- M1: Missing retry bound",
      model: "claude-fable-5-2",
      provider: "claudeAgent",
      providerInstanceId: "claudeAgent",
      modelSelection: {
        instanceId: "claudeAgent",
        model: "claude-fable-5-2",
        options: [{ id: "effort", value: "high" }],
      },
    };

    const built = buildRecordFromDelegatedReview(delegatedRow, lookup);
    expect(built).not.toBeNull();
    expect(built?.threadId).toBe("parent-thread-1");
    expect(built?.reviewThreadId).toBe("thread:delegated-task:rev-abc");
    expect(built?.repo).toBe("devtools");
    expect(built?.durationS).toBe(90);
    expect(built?.submitter.model).toBe("gemini-4-neon");
    expect(built?.reviewer.model).toBe("claude-fable-5-2");
    expect(built?.reviewer.effort).toBe("high");
    expect(built?.counts.high).toBe(1);
    expect(built?.counts.medium).toBe(1);

    // Idempotent append writes once even if called twice.
    expect(appendReviewStatRecord(built!, jsonlPath)).toBe(true);
    expect(appendReviewStatRecord(built!, jsonlPath)).toBe(false);
    const lines = NodeFS.readFileSync(jsonlPath, "utf8").trim().split("\n");
    expect(lines).toHaveLength(1);
    expect(JSON.parse(lines[0]!).review_thread_id).toBe("thread:delegated-task:rev-abc");

    // Matching ship-queue job referencing the same review_thread_id deduplicates into ONE record.
    NodeFS.writeFileSync(
      NodePath.join(shipJobDir, "job.json"),
      JSON.stringify({
        id: "11001",
        repo: "devtools",
        branch: "issue-1281",
        thread_id: "parent-thread-1",
        review_thread_id: "thread:delegated-task:rev-abc",
        submitted_at: "2026-11-21T12:05:00Z",
      }),
    );
    NodeFS.writeFileSync(
      NodePath.join(shipJobDir, "adversarial-review.md"),
      JSON.stringify({
        verdict: "do not ship",
        counts: { breaking: 0, critical: 0, high: 1, medium: 1, low: 0, info: 0 },
      }),
    );

    const merged = loadReviewRecords(
      {
        playbookStateDir: NodePath.join(dir, "pb-none"),
        shipJobsDir: NodePath.join(dir, "jobs"),
        jsonlPath,
      },
      lookup,
      [delegatedRow],
    );
    expect(merged).toHaveLength(1);
    expect(merged[0]?.id).toBe("ship:11001");
    expect(merged[0]?.reviewThreadId).toBe("thread:delegated-task:rev-abc");
    expect(merged[0]?.reviewer.model).toBe("claude-fable-5-2");
    expect(merged[0]?.reviewer.effort).toBe("high");
    expect(merged[0]?.submitter.model).toBe("gemini-4-neon");
    expect(merged[0]?.durationS).toBe(90);
  });
});

describe("DevtoolsFleetConfig SSH discovery and sync", () => {
  it("discovers fleet hosts including parent workstation hosts and validates SSH aliases", () => {
    const dir = makeTempDir("devtools-fleet-");
    const ciHostsPath = NodePath.join(dir, "ci-hosts.json");
    NodeFS.writeFileSync(
      ciHostsPath,
      JSON.stringify({
        hosts: [
          { name: "main-box", ssh: null, role: "ci" },
          { name: "worker-1", ssh: "worker-1", role: "ci" },
          { name: "mac-vm", ssh: "mac-vm", role: "ci", on: "MacBook-Air" },
          { name: "bad-host", ssh: "evil;rm -rf /", role: "ci" },
        ],
      }),
    );
    expect(isValidSshAlias("dev-host-x")).toBe(true);
    expect(isValidSshAlias("-oProxyCommand=bad")).toBe(false);
    expect(isValidSshAlias("host;whoami")).toBe(false);

    const hosts = discoverFleetHosts(ciHostsPath);
    expect(hosts.map((h) => ({ name: h.name, ssh: h.ssh, local: h.local }))).toEqual([
      { name: "main-box", ssh: null, local: true },
      { name: "worker-1", ssh: "worker-1", local: false },
      { name: "mac-vm", ssh: "mac-vm", local: false },
      { name: "MacBook-Air", ssh: "MacBook-Air", local: false },
    ]);
  });

  it("reads fleet snapshot and syncs patches to all hosts via SSH while preserving remote keys and handling offline hosts", async () => {
    const dir = makeTempDir("devtools-fleet-sync-");
    const ciHostsPath = NodePath.join(dir, "ci-hosts.json");
    const localCfgPath = NodePath.join(dir, "local-host-config.json");
    NodeFS.writeFileSync(
      ciHostsPath,
      JSON.stringify({
        hosts: [
          { name: "main-box", ssh: null, role: "ci" },
          { name: "worker-ok", ssh: "worker-ok", role: "ci" },
          { name: "worker-down", ssh: "worker-down", role: "ci" },
        ],
      }),
    );

    const remoteFiles = new Map<string, string>([
      ["worker-ok", JSON.stringify({ keep_remote_flag: "yes", challenge_timeout_s: 120 })],
    ]);

    const sshRunner: SshRunner = async (alias, script, opts) => {
      if (alias === "worker-down") {
        return { exitCode: 255, stdout: "", stderr: "ssh: connect to host worker-down refused" };
      }
      if (script.includes("mv -f")) {
        remoteFiles.set(alias, opts?.stdin ?? "");
        return { exitCode: 0, stdout: "", stderr: "" };
      }
      return { exitCode: 0, stdout: remoteFiles.get(alias) ?? "{}", stderr: "" };
    };

    const before = await readFleetConfigSnapshot({
      ciHostsPath,
      localConfigPath: localCfgPath,
      sshRunner,
    });
    expect(before.hosts).toHaveLength(3);
    expect(before.hosts[1]?.reachable).toBe(true);
    expect(before.hosts[1]?.inSyncWithLocal).toBe(false);
    expect(before.hosts[2]?.reachable).toBe(false);

    const writeAll = await writeFleetHostConfig(
      "all",
      {
        challenge_timeout_s: 240,
        targetHost: "all",
      },
      { ciHostsPath, localConfigPath: localCfgPath, sshRunner },
    );
    expect(writeAll.ok).toBe(false);
    expect(writeAll.results.map((r) => ({ host: r.host, ok: r.ok }))).toEqual([
      { host: "main-box", ok: true },
      { host: "worker-ok", ok: true },
      { host: "worker-down", ok: false },
    ]);
    expect(readDevtoolsHostConfig(localCfgPath).challenge_timeout_s).toBe(240);
    const savedRemote = JSON.parse(remoteFiles.get("worker-ok") ?? "{}") as Record<string, unknown>;
    expect(savedRemote.challenge_timeout_s).toBe(240);
    expect(savedRemote.keep_remote_flag).toBe("yes");
    expect("targetHost" in savedRemote).toBe(false);

    // Invalid model spec fails up front without calling SSH.
    let sshCalled = false;
    const rejected = await writeFleetHostConfig(
      "all",
      {
        ship_queue_review: {
          default: { provider: "claudeAgent", model: "bad model!", effort: "high" },
        },
      },
      {
        ciHostsPath,
        localConfigPath: localCfgPath,
        sshRunner: async () => {
          sshCalled = true;
          return { exitCode: 0, stdout: "{}", stderr: "" };
        },
      },
    );
    expect(rejected.ok).toBe(false);
    expect(sshCalled).toBe(false);
  });
});

describe("DevtoolsFleetConfigCache startup warmup and drift refresh", () => {
  it("warms once in the background, serves cached remote state with fresh local edits, refreshes on demand, and ignores stale invalidated probes", async () => {
    const dir = makeTempDir("devtools-fleet-cache-");
    const ciHostsPath = NodePath.join(dir, "ci-hosts.json");
    const localCfgPath = NodePath.join(dir, "local-host-config.json");
    NodeFS.writeFileSync(
      ciHostsPath,
      JSON.stringify({
        hosts: [
          { name: "main-box", ssh: null, role: "ci" },
          { name: "worker-1", ssh: "worker-1", role: "ci" },
        ],
      }),
    );
    writeDevtoolsHostConfig({ challenge_timeout_s: 180 }, localCfgPath);

    let sshCalls = 0;
    let remoteTimeout = 180;
    const sshRunner: SshRunner = async () => {
      sshCalls += 1;
      return {
        exitCode: 0,
        stdout: JSON.stringify({ challenge_timeout_s: remoteTimeout }),
        stderr: "",
      };
    };
    const opts = { ciHostsPath, localConfigPath: localCfgPath, sshRunner };

    // 1. Startup warm-up runs SSH once and populates the cache.
    warmFleetConfigCache(opts);
    warmFleetConfigCache(opts); // deduped while in-flight
    const first = await getCachedFleetConfigSnapshot({ options: opts });
    expect(sshCalls).toBe(1);
    expect(first.localConfig.challenge_timeout_s).toBe(180);
    expect(first.hosts[1]?.inSyncWithLocal).toBe(true);

    // 2. Subsequent non-refresh reads skip SSH and still merge fresh local disk edits.
    writeDevtoolsHostConfig({ challenge_timeout_s: 240 }, localCfgPath);
    const cached = await getCachedFleetConfigSnapshot({ options: opts });
    expect(sshCalls).toBe(1);
    expect(cached.localConfig.challenge_timeout_s).toBe(240);
    expect(cached.hosts[1]?.inSyncWithLocal).toBe(false);

    // 3. Explicit refresh re-probes remote SSH hosts and sees updated remote config.
    remoteTimeout = 240;
    const refreshed = await getCachedFleetConfigSnapshot({ refresh: true, options: opts });
    expect(sshCalls).toBe(2);
    expect(refreshed.hosts[1]?.inSyncWithLocal).toBe(true);

    // 4. Invalidating while an older probe is in flight drops its stale result and forces a fresh probe.
    const staleGate = Promise.withResolvers<void>();
    const slowStaleRunner: SshRunner = async () => {
      sshCalls += 1;
      await staleGate.promise;
      return { exitCode: 0, stdout: JSON.stringify({ challenge_timeout_s: 99 }), stderr: "" };
    };
    const stalePromise = getCachedFleetConfigSnapshot({
      refresh: true,
      options: { ...opts, sshRunner: slowStaleRunner },
    });
    invalidateFleetConfigCache();
    remoteTimeout = 300;
    const freshAfterInvalidate = await getCachedFleetConfigSnapshot({
      refresh: true,
      options: opts,
    });
    staleGate.resolve();
    await stalePromise;

    expect(freshAfterInvalidate.hosts[1]?.config?.challenge_timeout_s).toBe(300);
    const afterStaleSettles = await getCachedFleetConfigSnapshot({ options: opts });
    expect(afterStaleSettles.hosts[1]?.config?.challenge_timeout_s).toBe(300);

    // 5. Expired server cache (maxAgeMs exceeded) re-probes SSH on non-refresh reads.
    const callsBeforeExpiry = sshCalls;
    remoteTimeout = 360;
    const afterTtlExpiry = await getCachedFleetConfigSnapshot({ maxAgeMs: 0, options: opts });
    expect(sshCalls).toBe(callsBeforeExpiry + 1);
    expect(afterTtlExpiry.hosts[1]?.config?.challenge_timeout_s).toBe(360);
  });
});
