// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for ship_post_merge execution, SYNC_EXIT markers, crash-recovery idempotency, path validation, version CLI, and install-marscode-tools dry-run.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runShipQueueCli } from "./cli.ts";
import { guardProtocolGuard } from "./houseGate.ts";
import { mark, readJob, readLog, registerWatcher, updateJob } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { currentProcessIdentity, isProcessAlive } from "./processIdentity.ts";
import { submitJob } from "./submit.ts";
import type { ShipForge, ShipQueueDeps } from "./types.ts";
import { runJob } from "./worker.ts";

const SELF = currentProcessIdentity();
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function gitSync(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8", env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function makeClock() {
  let sec = 0;
  return {
    now: () => {
      const s = sec++;
      const pad = (n: number) => String(n).padStart(2, "0");
      return `2026-06-01T00:${pad(Math.floor(s / 60))}:${pad(s % 60)}.000Z`;
    },
  };
}

function makePostMergeFixture(options?: {
  readonly confText?: string | undefined;
  readonly extraBaseFiles?: Readonly<Record<string, string>> | undefined;
  readonly postMergeTimeoutMs?: number | undefined;
}) {
  const tmp = NodeFS.realpathSync(
    NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-post-merge-")),
  );
  cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));

  const remoteDir = NodePath.join(tmp, "remotes", "acme-fixture", "sync-repo.git");
  NodeFS.mkdirSync(remoteDir, { recursive: true });
  gitSync(remoteDir, ["init", "-q", "--bare", "-b", "main"]);

  const primary = NodePath.join(tmp, "sync-repo");
  gitSync(tmp, ["clone", "-q", remoteDir, primary]);
  gitSync(primary, ["config", "user.name", "Fixture Lane"]);
  gitSync(primary, ["config", "user.email", "lane@example.invalid"]);
  NodeFS.writeFileSync(NodePath.join(primary, "README.md"), "# sync repo\n");
  if (options?.confText !== undefined) {
    NodeFS.writeFileSync(NodePath.join(primary, ".tree-guard.conf"), options.confText);
  }
  for (const [rel, content] of Object.entries(options?.extraBaseFiles ?? {})) {
    const abs = NodePath.join(primary, rel);
    NodeFS.mkdirSync(NodePath.dirname(abs), { recursive: true });
    NodeFS.writeFileSync(abs, content);
  }
  gitSync(primary, ["add", "-A"]);
  gitSync(primary, ["commit", "-q", "-m", "init"]);
  gitSync(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
  gitSync(primary, ["remote", "set-head", "origin", "main"]);

  const prs = new Map<
    number,
    { head: string; base: string; title: string; body: string; open: boolean }
  >();
  const merged: number[] = [];
  const forgeClone = NodePath.join(tmp, "forge-clone");
  gitSync(tmp, ["clone", "-q", remoteDir, forgeClone]);
  gitSync(forgeClone, ["config", "user.name", "Fixture Forge"]);
  gitSync(forgeClone, ["config", "user.email", "forge@example.invalid"]);

  const forge: ShipForge = {
    isPullRequestMerged: async ({ number }) => merged.includes(number),
    findOpenPullRequest: async ({ head }) => {
      for (const [number, pr] of prs) if (pr.open && pr.head === head) return { number };
      return null;
    },
    createPullRequest: async ({ head, base, title, body }) => {
      const number = prs.size + 1;
      prs.set(number, { head, base, title, body, open: true });
      return { number };
    },
    mergePullRequest: async ({ number, headSha, title }) => {
      const pr = prs.get(number);
      if (!pr?.open) return { exitCode: 1, message: `PR #${number} not open` };
      gitSync(forgeClone, ["fetch", "-q", "origin"]);
      const tip = gitSync(forgeClone, ["rev-parse", `origin/${pr.head}`]);
      if (tip !== headSha) return { exitCode: 1, message: `head moved: ${tip} != ${headSha}` };
      gitSync(forgeClone, ["checkout", "-q", "-B", pr.base, `origin/${pr.base}`]);
      gitSync(forgeClone, ["merge", "-q", "--squash", `origin/${pr.head}`]);
      gitSync(forgeClone, ["commit", "-q", "-m", `${title} (#${number})`, "-m", pr.body]);
      gitSync(forgeClone, ["push", "-q", "origin", `HEAD:refs/heads/${pr.base}`]);
      pr.open = false;
      merged.push(number);
      return { exitCode: 0, message: `merged #${number}` };
    },
  };

  const root = NodePath.join(tmp, "queue");
  const deps: ShipQueueDeps = {
    root,
    run: nodeProcessRunner,
    forge,
    guard: {
      inspect: guardProtocolGuard.inspect,
      check: async () => ({ ok: true }),
    },
    secretScan: async () => [],
    clock: makeClock(),
    isProcessAlive,
    self: SELF,
    watcherWaitMs: 60_000,
    ...(options?.postMergeTimeoutMs !== undefined
      ? { postMergeTimeoutMs: options.postMergeTimeoutMs }
      : {}),
  };

  const makeWorktree = (branch: string, files: Record<string, string>) => {
    const wt = NodePath.join(tmp, "worktrees", branch.replace(/\//g, "-"));
    gitSync(primary, ["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
    for (const [rel, content] of Object.entries(files)) {
      const abs = NodePath.join(wt, rel);
      NodeFS.mkdirSync(NodePath.dirname(abs), { recursive: true });
      NodeFS.writeFileSync(abs, content);
    }
    gitSync(wt, ["add", "-A"]);
    gitSync(wt, ["commit", "-q", "-m", `work on ${branch}`]);
    return wt;
  };

  const submitOk = async (wt: string, branch: string) => {
    const res = await submitJob(deps, {
      worktree: wt,
      branch,
      title: `ship ${branch}`,
      body: "Closes #49\n",
      identity: {},
    });
    if (!res.ok) throw new Error(`submit refused: ${res.reason}`);
    return res.id;
  };

  const markers = (id: string) =>
    readLog(root, id)
      .split("\n")
      .filter((line) => line && !line.startsWith(" "));

  return { tmp, root, primary, deps, merged, makeWorktree, submitOk, markers };
}

describe("ship_post_merge execution and SYNC_EXIT markers", () => {
  it("executes ship_post_merge from updated default branch with scrubbed env, fast-forwards primary, and emits SYNC_EXIT=0", async () => {
    const outFile = NodePath.join(
      NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-pm-out-"))),
      "hook.txt",
    );
    cleanups.push(() => NodeFS.rmSync(NodePath.dirname(outFile), { recursive: true, force: true }));

    const prevCf = process.env.CLOUDFLARE_API_TOKEN;
    const prevNodeOpts = process.env.NODE_OPTIONS;
    process.env.CLOUDFLARE_API_TOKEN = "leaked-ambient-secret";
    process.env.NODE_OPTIONS = "--max-old-space-size=512";
    cleanups.push(() => {
      if (prevCf === undefined) delete process.env.CLOUDFLARE_API_TOKEN;
      else process.env.CLOUDFLARE_API_TOKEN = prevCf;
      if (prevNodeOpts === undefined) delete process.env.NODE_OPTIONS;
      else process.env.NODE_OPTIONS = prevNodeOpts;
    });

    const fixture = makePostMergeFixture({
      confText: "ship_repo=sync-repo\nship_post_merge=scripts/post-merge.sh --sync-flag\n",
      extraBaseFiles: {
        "scripts/post-merge.sh": [
          "#!/usr/bin/env bash",
          "set -euo pipefail",
          `{`,
          `  printf 'ARG1=%s\\n' "\${1:-}"`,
          `  printf 'JOB=%s\\n' "\${SHIP_QUEUE_JOB:-}"`,
          `  printf 'PR=%s\\n' "\${SHIP_QUEUE_PR:-}"`,
          `  printf 'ROOT=%s\\n' "\${SHIP_QUEUE_ROOT:-}"`,
          `  printf 'PRIMARY=%s\\n' "\${SHIP_QUEUE_PRIMARY:-}"`,
          `  printf 'CF=%s\\n' "\${CLOUDFLARE_API_TOKEN:-}"`,
          `  printf 'NODE_OPTIONS=%s\\n' "\${NODE_OPTIONS:-}"`,
          `  printf 'PWD=%s\\n' "$(pwd)"`,
          `  printf 'FEATURE_PRESENT=%s\\n' "$([ -f feature.txt ] && echo yes || echo no)"`,
          `} > ${JSON.stringify(outFile)}`,
          "echo 'post-merge hook synced'",
        ].join("\n"),
      },
    });

    const wt = fixture.makeWorktree("feat/post-merge-ok", { "feature.txt": "landed\n" });
    const id = await fixture.submitOk(wt, "feat/post-merge-ok");
    const unwatch = registerWatcher(fixture.root, id, SELF);
    try {
      expect(await runJob(fixture.deps, id)).toBe("ended");
    } finally {
      unwatch();
    }

    const job = readJob(fixture.root, id)!;
    expect(job.state).toBe("done");
    expect(job.merge_exit).toBe(0);
    expect(job.sync_exit).toBe(0);

    const m = fixture.markers(id);
    const mergeIdx = m.findIndex((l) => l === "MERGE_EXIT=0");
    const cleanedIdx = m.findIndex((l) => l.startsWith("CLEANED "));
    const postIdx = m.findIndex((l) => l === `POST_MERGE job=${id}`);
    const syncIdx = m.findIndex((l) => l === "SYNC_EXIT=0");
    const doneIdx = m.findIndex((l) => l.startsWith(`DONE job=${id} `));
    expect(mergeIdx).toBeGreaterThanOrEqual(0);
    expect(cleanedIdx).toBeGreaterThan(mergeIdx);
    expect(postIdx).toBeGreaterThan(cleanedIdx);
    expect(syncIdx).toBeGreaterThan(postIdx);
    expect(doneIdx).toBeGreaterThan(syncIdx);

    const recorded = NodeFS.readFileSync(outFile, "utf8");
    expect(recorded).toContain("ARG1=--sync-flag\n");
    expect(recorded).toContain(`JOB=${id}\n`);
    expect(recorded).toContain("PR=1\n");
    expect(recorded).toContain(`ROOT=${fixture.root}\n`);
    expect(recorded).toContain(`PRIMARY=${fixture.primary}\n`);
    expect(recorded).toContain("CF=\n");
    expect(recorded).toContain("NODE_OPTIONS=\n");
    expect(recorded).toContain("FEATURE_PRESENT=yes\n");
    expect(readLog(fixture.root, id)).toContain("post-merge hook synced");
  });

  it("logs non-zero SYNC_EXIT without marking an already-merged PR as unmerged", async () => {
    const fixture = makePostMergeFixture({
      confText: "ship_repo=sync-repo\nship_post_merge=scripts/fail-sync.sh\n",
      extraBaseFiles: {
        "scripts/fail-sync.sh": [
          "#!/usr/bin/env bash",
          "echo 'sync tool missing' >&2",
          "exit 7",
        ].join("\n"),
      },
    });

    const wt = fixture.makeWorktree("feat/sync-fails", { "a.txt": "merged change\n" });
    const id = await fixture.submitOk(wt, "feat/sync-fails");
    const unwatch = registerWatcher(fixture.root, id, SELF);
    try {
      expect(await runJob(fixture.deps, id)).toBe("ended");
    } finally {
      unwatch();
    }

    const job = readJob(fixture.root, id)!;
    expect(job.state).toBe("done");
    expect(job.merge_exit).toBe(0);
    expect(job.sync_exit).toBe(7);

    const logText = readLog(fixture.root, id);
    expect(fixture.markers(id)).toContain(`POST_MERGE job=${id}`);
    expect(fixture.markers(id)).toContain("SYNC_EXIT=7");
    expect(fixture.markers(id).some((l) => l.startsWith(`DONE job=${id} `))).toBe(true);
    expect(fixture.markers(id).some((l) => l.startsWith("FAILED reason="))).toBe(false);
    expect(logText).toContain("sync tool missing");
    expect(logText).toContain("remains merged");
  });

  it("enforces bounded timeout on ship_post_merge and still ends merged PR as DONE with SYNC_EXIT=124", async () => {
    const fixture = makePostMergeFixture({
      confText: "ship_repo=sync-repo\nship_post_merge=scripts/slow-sync.sh\n",
      extraBaseFiles: {
        "scripts/slow-sync.sh": "#!/usr/bin/env bash\nsleep 30\n",
      },
      postMergeTimeoutMs: 250,
    });

    const wt = fixture.makeWorktree("feat/sync-timeout", { "t.txt": "timeout test\n" });
    const id = await fixture.submitOk(wt, "feat/sync-timeout");
    const unwatch = registerWatcher(fixture.root, id, SELF);
    try {
      expect(await runJob(fixture.deps, id)).toBe("ended");
    } finally {
      unwatch();
    }

    const job = readJob(fixture.root, id)!;
    expect(job.state).toBe("done");
    expect(job.sync_exit).toBe(124);
    expect(fixture.markers(id)).toContain("SYNC_EXIT=124");
    expect(readLog(fixture.root, id)).toContain("timed out");
  });

  it("keeps crash-after-merge recovery idempotent when sync_exit is already recorded on the job or log", async () => {
    const counterDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-pm-count-")),
    );
    cleanups.push(() => NodeFS.rmSync(counterDir, { recursive: true, force: true }));
    const counterFile = NodePath.join(counterDir, "runs.txt");

    const fixture = makePostMergeFixture({
      confText: "ship_repo=sync-repo\nship_post_merge=scripts/count-sync.sh\n",
      extraBaseFiles: {
        "scripts/count-sync.sh": `#!/usr/bin/env bash\necho run >> ${JSON.stringify(counterFile)}\n`,
      },
    });

    // Case 1: Worker crashed after recording sync_exit=0 on job.json, before DONE.
    const wt1 = fixture.makeWorktree("feat/recover-with-record", { "r1.txt": "one\n" });
    const id1 = await fixture.submitOk(wt1, "feat/recover-with-record");
    fixture.merged.push(101);
    updateJob(fixture.root, id1, { state: "running", pr: 101, merge_exit: 0, sync_exit: 0 });
    expect(await runJob(fixture.deps, id1)).toBe("ended");
    expect(readJob(fixture.root, id1)?.state).toBe("done");
    expect(NodeFS.existsSync(counterFile)).toBe(false);

    // Case 2: Worker crashed after writing SYNC_EXIT=0 to log, before updating job.json.
    const wt2 = fixture.makeWorktree("feat/recover-with-log", { "r2.txt": "two\n" });
    const id2 = await fixture.submitOk(wt2, "feat/recover-with-log");
    fixture.merged.push(102);
    updateJob(fixture.root, id2, { state: "running", pr: 102, merge_exit: 0 });
    mark(fixture.root, id2, "SYNC_EXIT=0");
    expect(await runJob(fixture.deps, id2)).toBe("ended");
    expect(readJob(fixture.root, id2)?.state).toBe("done");
    expect(readJob(fixture.root, id2)?.sync_exit).toBe(0);
    expect(NodeFS.existsSync(counterFile)).toBe(false);

    // Case 3: Worker crashed immediately after merge before running post-merge sync at all.
    const wt3 = fixture.makeWorktree("feat/recover-needs-sync", { "r3.txt": "three\n" });
    const id3 = await fixture.submitOk(wt3, "feat/recover-needs-sync");
    fixture.merged.push(103);
    updateJob(fixture.root, id3, { state: "running", pr: 103 });
    expect(await runJob(fixture.deps, id3)).toBe("ended");
    expect(readJob(fixture.root, id3)?.state).toBe("done");
    expect(readJob(fixture.root, id3)?.merge_exit).toBe(0);
    expect(readJob(fixture.root, id3)?.sync_exit).toBe(0);
    expect(NodeFS.readFileSync(counterFile, "utf8").trim().split("\n")).toHaveLength(1);
  });

  it("refuses unsafe ship_post_merge paths (../evil.sh and /tmp/evil.sh) without executing them", async () => {
    const trapDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-pm-evil-")),
    );
    cleanups.push(() => NodeFS.rmSync(trapDir, { recursive: true, force: true }));
    const pwnedFile = NodePath.join(trapDir, "pwned");
    const absEvilScript = NodePath.join(trapDir, "evil.sh");
    NodeFS.writeFileSync(
      absEvilScript,
      `#!/usr/bin/env bash\necho pwned > ${JSON.stringify(pwnedFile)}\n`,
      { mode: 0o755 },
    );

    for (const [label, badCmd] of [
      ["traversal", "../evil.sh"],
      ["absolute", absEvilScript],
    ] as const) {
      const fixture = makePostMergeFixture({
        confText: `ship_repo=sync-repo\nship_post_merge=${badCmd}\n`,
      });
      // Also plant ../evil.sh next to primary so traversal would execute if not blocked!
      NodeFS.writeFileSync(
        NodePath.join(fixture.tmp, "evil.sh"),
        `#!/usr/bin/env bash\necho pwned > ${JSON.stringify(pwnedFile)}\n`,
        { mode: 0o755 },
      );

      const wt = fixture.makeWorktree(`feat/bad-${label}`, { "x.txt": `${label}\n` });
      const id = await fixture.submitOk(wt, `feat/bad-${label}`);
      const unwatch = registerWatcher(fixture.root, id, SELF);
      try {
        expect(await runJob(fixture.deps, id)).toBe("ended");
      } finally {
        unwatch();
      }

      const job = readJob(fixture.root, id)!;
      expect(job.state).toBe("done");
      expect(job.sync_exit).toBe(1);
      expect(fixture.markers(id)).toContain("SYNC_EXIT=1");
      expect(readLog(fixture.root, id)).toContain("post-merge refused:");
      expect(NodeFS.existsSync(pwnedFile)).toBe(false);
    }
  });
});

describe("ship-queue version subcommand and install-marscode-tools.sh", () => {
  it("stages, inspects, and prunes worker versions via ship-queue version CLI", async () => {
    const tmp = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-ver-cli-")),
    );
    cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
    const queueRoot = NodePath.join(tmp, "queue");
    const distA = NodePath.join(tmp, "dist-a");
    const distB = NodePath.join(tmp, "dist-b");
    NodeFS.mkdirSync(distA, { recursive: true });
    NodeFS.mkdirSync(distB, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(distA, "bin.mjs"), "console.log('v1');\n");
    NodeFS.writeFileSync(NodePath.join(distB, "bin.mjs"), "console.log('v2');\n");

    const runCli = async (argv: ReadonlyArray<string>) => {
      let stdout = "";
      let stderr = "";
      const code = await runShipQueueCli(argv, {
        io: {
          stdout: (t) => {
            stdout += t;
          },
          stderr: (t) => {
            stderr += t;
          },
          env: { ...process.env, SHIP_QUEUE_ROOT: queueRoot },
          cwd: tmp,
        },
      });
      return { code, stdout, stderr };
    };

    const stage1 = await runCli(["version", "stage", "v1.0.0", "--source-dir", distA, "--json"]);
    expect(stage1.code).toBe(0);
    expect(JSON.parse(stage1.stdout).version).toBe("v1.0.0");

    const stage2 = await runCli(["version", "stage", "v2.0.0", "--source-dir", distB, "--json"]);
    expect(stage2.code).toBe(0);
    expect(JSON.parse(stage2.stdout).version).toBe("v2.0.0");

    const current = await runCli(["version", "current", "--json"]);
    expect(current.code).toBe(0);
    expect(JSON.parse(current.stdout).current.version).toBe("v2.0.0");

    const pruned = await runCli(["version", "prune", "--json"]);
    expect(pruned.code).toBe(0);
    const pruneJson = JSON.parse(pruned.stdout) as { pruned: string[]; kept: string[] };
    expect(pruneJson.pruned).toEqual(["v1.0.0"]);
    expect(pruneJson.kept).toEqual(["v2.0.0"]);
  });

  it("supports scripts/install-marscode-tools.sh --dry-run without mutating target directories", () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const installer = NodePath.join(repoRoot, "scripts", "install-marscode-tools.sh");
    const tmp = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-install-dry-")),
    );
    cleanups.push(() => NodeFS.rmSync(tmp, { recursive: true, force: true }));
    const binDir = NodePath.join(tmp, "bin");
    const libDir = NodePath.join(tmp, "lib");
    const queueRoot = NodePath.join(tmp, "sq");

    const res = NodeChildProcess.spawnSync(
      "bash",
      [installer, "--dry-run", "--bin-dir", binDir, "--lib-dir", libDir, "--queue-root", queueRoot],
      { cwd: repoRoot, encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    for (const expected of [
      "packages/ship-queue/dist/bin.mjs",
      "packages/playbook/dist/bin.mjs",
      "packages/runlog/dist/bin.mjs",
      "packages/fleet/dist/bin.mjs",
      "packages/surface/dist/bin.mjs",
      "marscode-guard",
      "marscode-host-guard",
      "worker version",
    ]) {
      expect(res.stdout).toContain(expected);
    }
    expect(NodeFS.existsSync(binDir)).toBe(false);
    expect(NodeFS.existsSync(libDir)).toBe(false);
    expect(NodeFS.existsSync(queueRoot)).toBe(false);
  });

  it("catches spawn errors before extraction and keeps an already-merged PR DONE with SYNC_EXIT=1", async () => {
    const fixture = makePostMergeFixture({
      confText: "ship_repo=sync-repo\nship_post_merge=scripts/sync.sh\n",
      extraBaseFiles: {
        "scripts/sync.sh": "#!/usr/bin/env bash\necho ok\n",
      },
    });
    const baseRun = fixture.deps.run;
    let mergedHookCalls = 0;
    let postMergePhase = false;
    const deps = {
      ...fixture.deps,
      onMerged: [
        () => {
          mergedHookCalls += 1;
        },
      ],
      forge: {
        ...fixture.deps.forge,
        mergePullRequest: async (
          input: Parameters<typeof fixture.deps.forge.mergePullRequest>[0],
        ) => {
          const res = await fixture.deps.forge.mergePullRequest(input);
          postMergePhase = true;
          return res;
        },
      },
      run: async (input: Parameters<typeof baseRun>[0]) => {
        if (postMergePhase && input.command.endsWith("git") && input.args.includes("fetch")) {
          throw new Error("spawn EAGAIN");
        }
        return baseRun(input);
      },
    };

    const wt = fixture.makeWorktree("feat/spawn-throw", { "s.txt": "spawn throw\n" });
    const id = await fixture.submitOk(wt, "feat/spawn-throw");
    const unwatch = registerWatcher(fixture.root, id, SELF);
    try {
      expect(await runJob(deps, id)).toBe("ended");
    } finally {
      unwatch();
    }

    const job = readJob(fixture.root, id)!;
    expect(job.state).toBe("done");
    expect(job.merge_exit).toBe(0);
    expect(job.sync_exit).toBe(1);
    expect(mergedHookCalls).toBe(1);
    expect(fixture.markers(id)).toContain("SYNC_EXIT=1");
    expect(fixture.markers(id).some((l) => l.startsWith(`DONE job=${id} `))).toBe(true);
    expect(fixture.markers(id).some((l) => l.startsWith("FAILED reason="))).toBe(false);
    expect(readLog(fixture.root, id)).toContain("spawn EAGAIN");
  });

  it("refuses to sync stale base with SYNC_EXIT=1 when post-merge fetch fails", async () => {
    const markerDir = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-pm-stale-")),
    );
    cleanups.push(() => NodeFS.rmSync(markerDir, { recursive: true, force: true }));
    const ranFile = NodePath.join(markerDir, "ran.txt");
    const fixture = makePostMergeFixture({
      confText: "ship_repo=sync-repo\nship_post_merge=scripts/sync.sh\n",
      extraBaseFiles: {
        "scripts/sync.sh": `#!/usr/bin/env bash\necho stale > '${ranFile}'\n`,
      },
    });
    const baseRun = fixture.deps.run;
    let postMergePhase = false;
    const deps = {
      ...fixture.deps,
      forge: {
        ...fixture.deps.forge,
        mergePullRequest: async (
          input: Parameters<typeof fixture.deps.forge.mergePullRequest>[0],
        ) => {
          const res = await fixture.deps.forge.mergePullRequest(input);
          postMergePhase = true;
          return res;
        },
      },
      run: async (input: Parameters<typeof baseRun>[0]) => {
        if (postMergePhase && input.command.endsWith("git") && input.args.includes("fetch")) {
          return { exitCode: 128, stdout: "", stderr: "fatal: unable to access remote\n" };
        }
        return baseRun(input);
      },
    };

    const wt = fixture.makeWorktree("feat/fetch-fails", { "f.txt": "fetch fail\n" });
    const id = await fixture.submitOk(wt, "feat/fetch-fails");
    const unwatch = registerWatcher(fixture.root, id, SELF);
    try {
      expect(await runJob(deps, id)).toBe("ended");
    } finally {
      unwatch();
    }

    const job = readJob(fixture.root, id)!;
    expect(job.state).toBe("done");
    expect(job.sync_exit).toBe(1);
    expect(NodeFS.existsSync(ranFile)).toBe(false);
    expect(fixture.markers(id)).toContain("SYNC_EXIT=1");
    expect(readLog(fixture.root, id)).toContain("refusing to sync stale");
  });
});
