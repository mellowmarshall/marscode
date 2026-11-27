// @effect-diagnostics nodeBuiltinImport:off - Behavioral tests for per-job worker version pinning, zero global drain, and hot policy reload.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { createJob, readJob, registerWatcher, updateJob } from "./jobStore.ts";
import {
  createCiHostsReloader,
  createDeclarationReloader,
  createPinsReloader,
  loadHotPolicySnapshot,
  loadRepoDeclarationFromDir,
} from "./policyReload.ts";
import {
  claimLock,
  liveVersionedWorkers,
  liveWorkerForVersion,
  releaseLock,
  versionsLockPath,
  versionWorkerLockPath,
} from "./processLocks.ts";
import { submitJob } from "./submit.ts";
import type { Clock, ProcessInput, ProcessResult, ShipForge, ShipQueueDeps } from "./types.ts";
import { hasOpenJobsForWorker, runDueWork } from "./worker.ts";
import { hasLiveWorkerForJob, launchDetachedWorker } from "./workerLauncher.ts";
import {
  activePinnedVersions,
  currentVersionPath,
  pruneUnreferencedWorkerVersions,
  readCurrentWorkerVersion,
  resolveCurrentWorkerVersion,
  stageWorkerVersion,
} from "./workerVersion.ts";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

function makeClock(): Clock {
  let sec = 0;
  return {
    now: () => {
      const mm = String(Math.floor(sec / 60)).padStart(2, "0");
      const ss = String(sec % 60).padStart(2, "0");
      sec += 1;
      return `2026-11-27T12:${mm}:${ss}.000Z`;
    },
  };
}

function gitSync(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync(
    "git",
    ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...args],
    { cwd, encoding: "utf8" },
  );
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  return res.stdout.trim();
}

function realRunner(input: ProcessInput): Promise<ProcessResult> {
  return new Promise((resolve) => {
    const args =
      input.command === "git"
        ? ["-c", "core.hooksPath=/dev/null", "-c", "commit.gpgsign=false", ...input.args]
        : [...input.args];
    const child = NodeChildProcess.spawn(input.command, args, {
      cwd: input.cwd,
      env: input.env,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (c: Buffer) => {
      stdout += c.toString("utf8");
    });
    child.stderr.on("data", (c: Buffer) => {
      stderr += c.toString("utf8");
    });
    if (input.stdin !== undefined) child.stdin.write(input.stdin);
    child.stdin.end();
    child.on("close", (code) => resolve({ exitCode: code ?? 1, stdout, stderr }));
    child.on("error", (err) => resolve({ exitCode: 1, stdout, stderr: err.message }));
  });
}

function createFixtureRepo(baseDir: string, slug: string) {
  const [owner, name] = slug.split("/");
  const remote = NodePath.join(baseDir, "remotes", owner!, `${name!}.git`);
  NodeFS.mkdirSync(remote, { recursive: true });
  gitSync(remote, ["init", "-q", "--bare", "-b", "main"]);
  const primary = NodePath.join(baseDir, "repos", name!);
  NodeFS.mkdirSync(NodePath.dirname(primary), { recursive: true });
  gitSync(baseDir, ["clone", "-q", remote, primary]);
  gitSync(primary, ["config", "user.name", "Fixture Author"]);
  gitSync(primary, ["config", "user.email", "author@example.invalid"]);
  NodeFS.writeFileSync(NodePath.join(primary, "README.md"), `# ${name}\n`);
  NodeFS.writeFileSync(
    NodePath.join(primary, ".tree-guard.conf"),
    `ship_repo=${slug}\nship_ci_tool=node@>=20\n`,
  );
  gitSync(primary, ["add", "README.md", ".tree-guard.conf"]);
  gitSync(primary, ["commit", "-q", "-m", "initial commit"]);
  gitSync(primary, ["push", "-q", "origin", "HEAD:refs/heads/main"]);

  const addBranch = (branch: string, fileName: string, content: string) => {
    const wt = NodePath.join(baseDir, "worktrees", name!, branch.replaceAll("/", "-"));
    NodeFS.mkdirSync(NodePath.dirname(wt), { recursive: true });
    gitSync(primary, ["worktree", "add", "-q", "-b", branch, wt, "origin/main"]);
    NodeFS.writeFileSync(NodePath.join(wt, fileName), content);
    gitSync(wt, ["add", fileName]);
    gitSync(wt, ["commit", "-q", "-m", `add ${fileName}`]);
    return wt;
  };

  return { remote, primary, addBranch };
}

function makeFakeForge(
  remotesByRepo: Readonly<Record<string, string>>,
  hooks?: { readonly onMergeStart?: (repo: string) => Promise<void> },
): ShipForge {
  let nextPr = 1;
  const openPrs = new Map<string, number>();
  const mergedPrs = new Set<string>();
  return {
    async findOpenPullRequest({ repo, head }) {
      const n = openPrs.get(`${repo}:${head}`);
      return n ? { number: n } : null;
    },
    async createPullRequest({ repo, head }) {
      const n = nextPr++;
      openPrs.set(`${repo}:${head}`, n);
      return { number: n };
    },
    async isPullRequestMerged({ repo, number }) {
      return mergedPrs.has(`${repo}#${number}`);
    },
    async mergePullRequest({ cwd, repo, number, headSha, title }) {
      await hooks?.onMergeStart?.(repo);
      const remote = remotesByRepo[repo];
      if (!remote) return { exitCode: 1, message: `unknown remote for ${repo}` };
      // Fast-forward/squash simulation into bare remote main.
      const cloneDir = NodePath.join(NodePath.dirname(cwd), `.forge-merge-${number}`);
      gitSync(NodePath.dirname(cwd), ["clone", "-q", remote, cloneDir]);
      gitSync(cloneDir, ["config", "user.name", "Fixture Forge"]);
      gitSync(cloneDir, ["config", "user.email", "forge@example.invalid"]);
      gitSync(cloneDir, ["checkout", "-q", "main"]);
      gitSync(cloneDir, ["merge", "-q", "--squash", headSha]);
      gitSync(cloneDir, ["commit", "-q", "-m", `${title} (#${number})`]);
      gitSync(cloneDir, ["push", "-q", "origin", "HEAD:refs/heads/main"]);
      NodeFS.rmSync(cloneDir, { recursive: true, force: true });
      mergedPrs.add(`${repo}#${number}`);
      return { exitCode: 0, message: `merged #${number}` };
    },
  };
}

function createFakeBundle(baseDir: string, name: string, marker: string): string {
  const dir = NodePath.join(baseDir, "src-bundles", name);
  NodeFS.mkdirSync(dir, { recursive: true });
  NodeFS.writeFileSync(NodePath.join(dir, "cli.mjs"), `// bundle ${marker}\nprocess.exit(0);\n`, {
    mode: 0o755,
  });
  return dir;
}

describe("per-job worker version pinning and zero global upgrade drain", () => {
  it("runs repo B immediately on v2 + hot-reloaded declaration while repo A stays in-flight on v1, and prunes v1 only after completion", async () => {
    const tmp = mkTempDir("sq-upgrade-pin-");
    const root = NodePath.join(tmp, "queue");
    const repoA = createFixtureRepo(tmp, "acme-fixture/repo-a");
    const repoB = createFixtureRepo(tmp, "acme-fixture/repo-b");
    const clock = makeClock();

    const bundleV1Src = createFakeBundle(tmp, "v1", "v1");
    const bundleV2Src = createFakeBundle(tmp, "v2", "v2");
    const v1 = stageWorkerVersion({
      root,
      version: "v1.0.0",
      sourceDir: bundleV1Src,
      entryRelPath: "cli.mjs",
      clock,
    });
    expect(readCurrentWorkerVersion(root)?.version).toBe("v1.0.0");

    // Gate repo A mid-merge so it remains actively in-flight while we upgrade to v2 and ship repo B.
    let releaseRepoAMerge!: () => void;
    let repoAInFlight!: () => void;
    const repoAStarted = new Promise<void>((resolve) => {
      repoAInFlight = resolve;
    });
    const repoAMergeGate = new Promise<void>((resolve) => {
      releaseRepoAMerge = resolve;
    });

    const livePids = new Set<number>([1001, 2002, 3003]);
    const isAlive = (id: { readonly pid: number }) => livePids.has(id.pid);

    const forge = makeFakeForge(
      {
        "acme-fixture/repo-a": repoA.remote,
        "acme-fixture/repo-b": repoB.remote,
      },
      {
        onMergeStart: async (repo) => {
          if (repo === "acme-fixture/repo-a") {
            repoAInFlight();
            await repoAMergeGate;
          }
        },
      },
    );

    const makeDeps = (
      pid: number,
      workerVersion: { readonly version: string; readonly entryPath: string },
    ): ShipQueueDeps => ({
      root,
      run: realRunner,
      forge,
      guard: { inspect: () => undefined, check: async () => ({ ok: true }) },
      secretScan: async () => [],
      clock,
      isProcessAlive: isAlive,
      self: { pid, startTicks: String(pid * 10) },
      watcherWaitMs: 60_000,
      workerVersion,
    });

    const depsV1 = makeDeps(1001, v1);
    const wtA = repoA.addBranch("feat/10-alpha", "alpha.txt", "alpha\n");
    const subA = await submitJob(depsV1, {
      worktree: wtA,
      branch: "feat/10-alpha",
      title: "Alpha on v1",
      body: "Ships alpha.\n\nCloses #10\n",
      identity: { thread: "thread-a" },
    });
    expect(subA.ok).toBe(true);
    if (!subA.ok) return;
    expect(subA.record.worker_version).toBe("v1.0.0");
    expect(subA.record.worker_entry).toBe(v1.entryPath);
    const unwatchA = registerWatcher(root, subA.id, { pid: 3003, startTicks: "30030" });

    // Claim v1 worker lock and start draining repo A in-flight on v1.
    expect(claimLock(versionWorkerLockPath(root, v1.version), depsV1.self, isAlive)).toBe(true);
    const repoADrain = runDueWork(depsV1);
    await repoAStarted;

    // While repo A is STILL in-flight on v1, stage v2 and update repo B's declaration!
    const v2 = stageWorkerVersion({
      root,
      version: "v2.0.0",
      sourceDir: bundleV2Src,
      entryRelPath: "cli.mjs",
      clock,
    });
    expect(readCurrentWorkerVersion(root)?.version).toBe("v2.0.0");

    const declReloaderB = createDeclarationReloader(repoB.primary);
    expect(declReloaderB.reload().declaration.ciTools).toEqual(["node@>=20"]);
    NodeFS.writeFileSync(
      NodePath.join(repoB.primary, ".tree-guard.conf"),
      "ship_repo=acme-fixture/repo-b\nship_ci_tool=node@>=20\nship_ci_tool=vp@>=0.1\n",
    );
    const updatedDeclB = declReloaderB.reload();
    expect(updatedDeclB.changed).toBe(true);
    expect(updatedDeclB.declaration.ciTools).toEqual(["node@>=20", "vp@>=0.1"]);

    // Submit repo B on v2 while v1 is still running repo A.
    const depsV2 = makeDeps(2002, v2);
    const wtB = repoB.addBranch("feat/11-beta", "beta.txt", "beta\n");
    const subB = await submitJob(depsV2, {
      worktree: wtB,
      branch: "feat/11-beta",
      title: "Beta on v2",
      body: "Ships beta.\n\nCloses #11\n",
      identity: { thread: "thread-b" },
    });
    expect(subB.ok).toBe(true);
    if (!subB.ok) return;
    expect(subB.record.worker_version).toBe("v2.0.0");
    expect(subB.record.worker_entry).toBe(v2.entryPath);
    const unwatchB = registerWatcher(root, subB.id, { pid: 3003, startTicks: "30030" });

    // Confirm launchDetachedWorker spawns v2 immediately despite live v1 worker (zero global drain lock!).
    const launchV2 = launchDetachedWorker({
      root,
      cliPath: v2.entryPath,
      env: { PATH: process.env.PATH, SHIP_QUEUE_NO_SYSTEMD: "1" },
      isAlive,
      platform: "linux",
      jobId: subB.id,
      workerVersion: v2,
    });
    expect(launchV2.kind).toBe("spawned");
    expect(launchV2.version).toBe("v2.0.0");

    // V2 runs repo B to DONE immediately while repo A is still paused mid-merge on v1!
    const resB = await runDueWork(depsV2);
    expect(resB.ended).toEqual([subB.id]);
    expect(readJob(root, subB.id)?.state).toBe("done");
    expect(readJob(root, subB.id)?.worker_version).toBe("v2.0.0");
    expect(readJob(root, subA.id)?.state).toBe("running");

    // Pruning while repo A is still in-flight on v1 MUST keep v1!
    expect(activePinnedVersions(root, isAlive)).toEqual(new Set(["v1.0.0", "v2.0.0"]));
    const pruneMidFlight = pruneUnreferencedWorkerVersions({ root, isAlive });
    expect(pruneMidFlight.pruned).toEqual([]);
    expect(pruneMidFlight.kept).toEqual(["v1.0.0", "v2.0.0"]);

    // Now let repo A finish on v1 and release v1's worker lock.
    releaseRepoAMerge();
    const resA = await repoADrain;
    expect(resA.ended).toEqual([subA.id]);
    expect(readJob(root, subA.id)?.state).toBe("done");
    expect(readJob(root, subA.id)?.worker_version).toBe("v1.0.0");
    expect(hasOpenJobsForWorker(root, v1.version, v2.version)).toBe(false);

    releaseLock(versionWorkerLockPath(root, v1.version), depsV1.self);
    livePids.delete(1001);
    unwatchA();
    unwatchB();

    // Now v1 is unreferenced and safely pruned while v2 remains intact.
    const pruneAfter = pruneUnreferencedWorkerVersions({ root, isAlive });
    expect(pruneAfter.pruned).toEqual(["v1.0.0"]);
    expect(pruneAfter.kept).toEqual(["v2.0.0"]);
    expect(NodeFS.existsSync(v1.entryPath)).toBe(false);
    expect(NodeFS.existsSync(v2.entryPath)).toBe(true);
  });

  it("preserves per-repo FIFO order across version boundaries (v2 waits for v1 head on same repo, v1 never steals v2 tail)", async () => {
    const tmp = mkTempDir("sq-upgrade-fifo-");
    const root = NodePath.join(tmp, "queue");
    const repoA = createFixtureRepo(tmp, "acme-fixture/repo-fifo");
    const clock = makeClock();

    const v1 = stageWorkerVersion({
      root,
      version: "v1",
      sourceDir: createFakeBundle(tmp, "fifo-v1", "v1"),
      entryRelPath: "cli.mjs",
      clock,
    });
    const forge = makeFakeForge({ "acme-fixture/repo-fifo": repoA.remote });
    const isAlive = () => true;
    const makeDeps = (
      pid: number,
      workerVersion: { readonly version: string; readonly entryPath: string },
    ): ShipQueueDeps => ({
      root,
      run: realRunner,
      forge,
      guard: { inspect: () => undefined, check: async () => ({ ok: true }) },
      secretScan: async () => [],
      clock,
      isProcessAlive: isAlive,
      self: { pid, startTicks: String(pid) },
      watcherWaitMs: 60_000,
      workerVersion,
    });

    const depsV1 = makeDeps(4001, v1);
    const wt1 = repoA.addBranch("feat/1-first", "one.txt", "1\n");
    const sub1 = await submitJob(depsV1, {
      worktree: wt1,
      branch: "feat/1-first",
      title: "First on v1",
      body: "First.\n\nCloses #1\n",
      identity: { thread: "t1" },
    });
    expect(sub1.ok).toBe(true);
    if (!sub1.ok) return;

    const v2 = stageWorkerVersion({
      root,
      version: "v2",
      sourceDir: createFakeBundle(tmp, "fifo-v2", "v2"),
      entryRelPath: "cli.mjs",
      clock,
    });
    const depsV2 = makeDeps(4002, v2);
    const wt2 = repoA.addBranch("feat/2-second", "two.txt", "2\n");
    const sub2 = await submitJob(depsV2, {
      worktree: wt2,
      branch: "feat/2-second",
      title: "Second on v2",
      body: "Second.\n\nCloses #2\n",
      identity: { thread: "t2" },
    });
    expect(sub2.ok).toBe(true);
    if (!sub2.ok) return;

    const unw1 = registerWatcher(root, sub1.id, { pid: 5000, startTicks: "5000" });
    const unw2 = registerWatcher(root, sub2.id, { pid: 5000, startTicks: "5000" });

    // V2 runs first: must NOT jump ahead of v1 head job on the same repo!
    const earlyV2 = await runDueWork(depsV2);
    expect(earlyV2.ended).toEqual([]);
    expect(readJob(root, sub2.id)?.state).toBe("queued");

    // V1 runs: lands job #1 and MUST stop before job #2 (v2)!
    const passV1 = await runDueWork(depsV1);
    expect(passV1.ended).toEqual([sub1.id]);
    expect(readJob(root, sub1.id)?.state).toBe("done");
    expect(readJob(root, sub2.id)?.state).toBe("queued");

    // Now v2 lands job #2 cleanly on top of job #1.
    const passV2 = await runDueWork(depsV2);
    expect(passV2.ended).toEqual([sub2.id]);
    expect(readJob(root, sub2.id)?.state).toBe("done");
    expect(readJob(root, sub2.id)?.worker_version).toBe("v2");

    unw1();
    unw2();
  });
});

describe("hot-reloadable ci-hosts.json, repo declarations, and sq_pins.json", () => {
  it("reloads ci-hosts.json, .tree-guard.conf/playbook.json, and sq_pins.json immediately without restart or stale caches", () => {
    const tmp = mkTempDir("sq-hot-reload-");
    const manifestPath = NodePath.join(tmp, "ci-hosts.json");
    const repoDir = NodePath.join(tmp, "sample-repo");
    const pinsPath = NodePath.join(tmp, "sq_pins.json");
    NodeFS.mkdirSync(repoDir, { recursive: true });

    const baseManifest = {
      schema: 1,
      hosts: [{ name: "ci-x86-1", ssh: null, role: "ci", data_root: "~/data" }],
      toolchain: {
        git: { version: ">=2.0", probe: "git --version", install: null, base: true },
      },
    };
    NodeFS.writeFileSync(manifestPath, JSON.stringify(baseManifest));

    const hostsReloader = createCiHostsReloader({ overridePath: manifestPath });
    const h1 = hostsReloader.reload();
    expect(h1.ok).toBe(true);
    expect(h1.changed).toBe(true);
    expect(h1.generation).toBe(1);
    expect(Object.keys(h1.manifest?.toolchain ?? {})).toEqual(["git"]);

    // Unchanged read does not bump generation.
    const h1Again = hostsReloader.reload();
    expect(h1Again.changed).toBe(false);
    expect(h1Again.generation).toBe(1);

    // Mutate ci-hosts.json in place (add second host + vp tool) -> immediately detected.
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        ...baseManifest,
        hosts: [
          ...baseManifest.hosts,
          { name: "ci-x86-2", ssh: "ci-x86-2", role: "ci", data_root: "~/data" },
        ],
        toolchain: {
          ...baseManifest.toolchain,
          vp: { version: ">=0.1", probe: "vp --version", install: "ci-vp.sh", base: false },
        },
      }),
    );
    const h2 = hostsReloader.reload();
    expect(h2.ok).toBe(true);
    expect(h2.changed).toBe(true);
    expect(h2.generation).toBe(2);
    expect(h2.manifest?.hosts.map((h) => h.name)).toEqual(["ci-x86-1", "ci-x86-2"]);
    expect("vp" in (h2.manifest?.toolchain ?? {})).toBe(true);

    // Repo declaration hot reload: .tree-guard.conf -> updated by playbook.json ci block.
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".tree-guard.conf"),
      "ship_repo=acme-fixture/sample\nship_ci_tool=node@>=20\n",
    );
    const declReloader = createDeclarationReloader(repoDir);
    const d1 = declReloader.reload();
    expect(d1.changed).toBe(true);
    expect(d1.declaration.ciTools).toEqual(["node@>=20"]);
    expect(declReloader.reload().changed).toBe(false);

    NodeFS.writeFileSync(
      NodePath.join(repoDir, "playbook.json"),
      JSON.stringify({ ci: { tools: ["node@>=22", "vp@>=0.1"], arch: ["x86_64"] } }),
    );
    const d2 = declReloader.reload();
    expect(d2.changed).toBe(true);
    expect(d2.generation).toBe(2);
    expect(d2.declaration.ciTools).toEqual(["node@>=22", "vp@>=0.1"]);
    expect(d2.declaration.ciArch).toEqual(["x86_64"]);

    // Pins hot reload.
    const makePinDoc = (depName: string) => ({
      schema: 1,
      unsigned: { vp: "upstream tarball checksum only" },
      pins: [
        {
          name: "vp",
          file: "infra/ci-host/ci-vp.sh",
          lines: ["VP_VER="],
          datasource: "npm",
          depName,
          match: 'VP_VER="(?<currentValue>[^"]+)"',
          assets: { linux_x86_64: "vp-linux-x64.tgz" },
          sums: { kind: "npm" },
          writer: { kind: "none" },
        },
      ],
    });
    NodeFS.writeFileSync(pinsPath, JSON.stringify(makePinDoc("vite-plus")));
    const pinsReloader = createPinsReloader(pinsPath);
    const p1 = pinsReloader.reload();
    expect(p1.ok).toBe(true);
    expect(p1.changed).toBe(true);
    expect(p1.spec?.pins[0]?.depName).toBe("vite-plus");
    expect(pinsReloader.reload().changed).toBe(false);

    // Same-millisecond rewrite with identical byte length is still caught by content digest.
    NodeFS.writeFileSync(pinsPath, JSON.stringify(makePinDoc("vite-next")));
    const p2 = pinsReloader.reload();
    expect(p2.ok).toBe(true);
    expect(p2.changed).toBe(true);
    expect(p2.generation).toBe(2);
    expect(p2.spec?.pins[0]?.depName).toBe("vite-next");

    const snap = loadHotPolicySnapshot({
      ciHosts: { overridePath: manifestPath },
      repoDir,
      pinsPath,
    });
    expect(snap.ciHosts?.ok).toBe(true);
    expect(snap.declaration?.declaration.ciTools).toEqual(["node@>=22", "vp@>=0.1"]);
    expect(snap.pins?.spec?.pins[0]?.depName).toBe("vite-next");
  });

  it("rejects traversal worker_version, escaping worker_entry, and symlink-escaping bundles, and coordinates pruning under versions lock", () => {
    const tmp = mkTempDir("sq-security-pin-");
    const root = NodePath.join(tmp, "queue");
    const clock = makeClock();
    const evilScript = NodePath.join(tmp, "evil.mjs");
    NodeFS.writeFileSync(evilScript, "process.exit(99);\n", { mode: 0o755 });

    // Traversal version ids are rejected across locks, staging, and launching.
    expect(() => versionWorkerLockPath(root, "../escape")).toThrow(/Invalid worker version/);
    expect(() => versionWorkerLockPath(root, "v1/../../evil")).toThrow(/Invalid worker version/);
    expect(liveWorkerForVersion(root, "../escape", () => true)).toBeNull();
    expect(() =>
      stageWorkerVersion({ root, version: "../escape", entryPath: evilScript, clock }),
    ).toThrow(/Invalid worker version/);

    // Symlink-escaping sourceDir bundle is rejected cleanly and leaves no version directory behind.
    const symlinkBundle = NodePath.join(tmp, "symlink-src");
    NodeFS.mkdirSync(symlinkBundle, { recursive: true });
    NodeFS.symlinkSync(evilScript, NodePath.join(symlinkBundle, "cli.mjs"));
    expect(() =>
      stageWorkerVersion({
        root,
        version: "v-escape",
        sourceDir: symlinkBundle,
        entryRelPath: "cli.mjs",
        clock,
      }),
    ).toThrow(/escapes/);
    expect(NodeFS.existsSync(NodePath.join(root, "versions", "v-escape"))).toBe(false);

    // Stage legitimate v1 and v2 bundles.
    const v1 = stageWorkerVersion({
      root,
      version: "v1",
      sourceDir: createFakeBundle(tmp, "sec-v1", "v1"),
      entryRelPath: "cli.mjs",
      clock,
    });
    const v2 = stageWorkerVersion({
      root,
      version: "v2",
      sourceDir: createFakeBundle(tmp, "sec-v2", "v2"),
      entryRelPath: "cli.mjs",
      clock,
    });

    // Tampered SHIP_QUEUE_WORKER_ENTRY and tampered current.json pointing outside version bundle are ignored.
    const fallbackCli = NodePath.join(tmp, "trusted-cli.mjs");
    NodeFS.writeFileSync(fallbackCli, "// trusted\n", { mode: 0o755 });
    const envResolved = resolveCurrentWorkerVersion({
      root,
      fallbackCliPath: fallbackCli,
      env: { SHIP_QUEUE_WORKER_VERSION: "v2", SHIP_QUEUE_WORKER_ENTRY: evilScript },
    });
    expect(envResolved.entryPath).toBe(v2.entryPath);
    expect(envResolved.entryPath).not.toBe(evilScript);

    NodeFS.writeFileSync(
      currentVersionPath(root),
      JSON.stringify({ version: "v2", entryPath: evilScript }),
    );
    expect(readCurrentWorkerVersion(root)).toBeNull();
    // Restore valid current.json pointing to v2.
    stageWorkerVersion({
      root,
      version: "v2",
      sourceDir: createFakeBundle(tmp, "sec-v2-restore", "v2"),
      entryRelPath: "cli.mjs",
      clock,
    });

    // Explicit unsafe workerVersion passed to launchDetachedWorker is refused.
    expect(() =>
      launchDetachedWorker({
        root,
        cliPath: fallbackCli,
        env: { PATH: process.env.PATH, SHIP_QUEUE_NO_SYSTEMD: "1" },
        isAlive: () => false,
        platform: "linux",
        workerVersion: { version: "v2", entryPath: evilScript },
      }),
    ).toThrow(/Refused unsafe worker/);

    // Concurrent versions lock held by a live process blocks pruning (closes stage/submit TOCTOU).
    const livePids = new Set<number>([7777]);
    const isAlive = (id: { readonly pid: number }) => livePids.has(id.pid);
    expect(claimLock(versionsLockPath(root), { pid: 7777, startTicks: "7777" }, isAlive)).toBe(
      true,
    );
    const blockedPrune = pruneUnreferencedWorkerVersions({
      root,
      isAlive,
      self: { pid: 8888, startTicks: "8888" },
    });
    expect(blockedPrune.skippedLocked).toBe(true);
    expect(blockedPrune.pruned).toEqual([]);
    expect(blockedPrune.kept).toEqual(["v1", "v2"]);
    expect(NodeFS.existsSync(v1.entryPath)).toBe(true);

    // Dead stale versioned worker locks are pruned on read by liveVersionedWorkers.
    expect(
      claimLock(versionWorkerLockPath(root, "v1"), { pid: 9999, startTicks: "9999" }, isAlive),
    ).toBe(true);
    expect(liveVersionedWorkers(root, isAlive)).toEqual([]);
    expect(NodeFS.existsSync(versionWorkerLockPath(root, "v1"))).toBe(false);

    releaseLock(versionsLockPath(root), { pid: 7777, startTicks: "7777" });
    const unblockedPrune = pruneUnreferencedWorkerVersions({
      root,
      isAlive,
      self: { pid: 8888, startTicks: "8888" },
    });
    expect(unblockedPrune.pruned).toEqual(["v1"]);
    expect(unblockedPrune.kept).toEqual(["v2"]);
  });

  it("prevents unpinned job stranding behind an older worker and re-pins jobs whose worker_entry vanished", () => {
    const tmp = mkTempDir("sq-repin-");
    const root = NodePath.join(tmp, "queue");
    const clock = makeClock();

    const v1 = stageWorkerVersion({
      root,
      version: "v1",
      sourceDir: createFakeBundle(tmp, "rp-v1", "v1"),
      entryRelPath: "cli.mjs",
      clock,
    });
    const v2 = stageWorkerVersion({
      root,
      version: "v2",
      sourceDir: createFakeBundle(tmp, "rp-v2", "v2"),
      entryRelPath: "cli.mjs",
      clock,
    });

    const livePids = new Set<number>([6100]);
    const isAlive = (id: { readonly pid: number }) => livePids.has(id.pid);
    // V1 worker is alive on another repo, while V2 is current and not running yet.
    expect(
      claimLock(versionWorkerLockPath(root, "v1"), { pid: 6100, startTicks: "6100" }, isAlive),
    ).toBe(true);

    const { id: unpinnedId } = createJob(
      root,
      {
        repo: "acme-fixture/unpinned",
        primary: tmp,
        worktree: tmp,
        branch: "feat/unpinned",
        base_branch: "main",
        remote: "origin",
        title: "Unpinned",
        head_sha: "abc123",
      },
      "Closes #1\n",
      clock,
    );
    // Unpinned job must NOT be treated as covered by the older V1 worker when V2 is staged!
    expect(hasLiveWorkerForJob({ root, jobId: unpinnedId, isAlive })).toBe(false);

    // Job pinned to V1 whose entrypoint was removed on disk gets re-pinned to V2 on launch!
    const { id: missingEntryId } = createJob(
      root,
      {
        repo: "acme-fixture/missing-entry",
        primary: tmp,
        worktree: tmp,
        branch: "feat/missing-entry",
        base_branch: "main",
        remote: "origin",
        title: "Missing entry",
        head_sha: "def456",
        worker_version: "v1",
        worker_entry: v1.entryPath,
      },
      "Closes #2\n",
      clock,
    );
    NodeFS.rmSync(v1.entryPath, { force: true });
    // Even if V2 worker is already running, launching for missingEntryId re-pins job.json to v2!
    livePids.add(6200);
    expect(
      claimLock(versionWorkerLockPath(root, "v2"), { pid: 6200, startTicks: "6200" }, isAlive),
    ).toBe(true);

    const res = launchDetachedWorker({
      root,
      cliPath: v2.entryPath,
      env: { PATH: process.env.PATH, SHIP_QUEUE_NO_SYSTEMD: "1" },
      isAlive,
      platform: "linux",
      jobId: missingEntryId,
    });
    expect(res.kind).toBe("already-running");
    expect(res.version).toBe("v2");
    const repinned = readJob(root, missingEntryId);
    expect(repinned?.worker_version).toBe("v2");
    expect(repinned?.worker_entry).toBe(v2.entryPath);
    expect(hasOpenJobsForWorker(root, "v2", "v2")).toBe(true);

    // Tampered traversal worker_version in job.json also triggers re-pinning to trusted v2.
    updateJob(root, missingEntryId, { worker_version: "../evil", worker_entry: "/etc/passwd" });
    expect(hasLiveWorkerForJob({ root, jobId: missingEntryId, isAlive })).toBe(false);
    launchDetachedWorker({
      root,
      cliPath: v2.entryPath,
      env: { PATH: process.env.PATH, SHIP_QUEUE_NO_SYSTEMD: "1" },
      isAlive,
      platform: "linux",
      jobId: missingEntryId,
    });
    expect(readJob(root, missingEntryId)?.worker_version).toBe("v2");
  });

  it("refuses escaping symlinks and oversized policy files in single-fd policyReload loaders", () => {
    const tmp = mkTempDir("sq-policy-bounds-");
    const repoDir = NodePath.join(tmp, "repo");
    NodeFS.mkdirSync(repoDir, { recursive: true });
    const outsideSecret = NodePath.join(tmp, "outside.conf");
    NodeFS.writeFileSync(outsideSecret, "ship_repo=leaked/repo\nship_ci_tool=vp@>=0.1\n");
    NodeFS.symlinkSync(outsideSecret, NodePath.join(repoDir, ".tree-guard.conf"));

    const loaded = loadRepoDeclarationFromDir(repoDir);
    expect(loaded.confPath).toBeNull();
    expect(loaded.declaration.repo).toBe("");
    expect(loaded.declaration.ciTools).toEqual([]);
    expect(
      loaded.declaration.warnings.some((w) => w.includes("outside repository directory")),
    ).toBe(true);

    const bigManifest = NodePath.join(tmp, "big-ci-hosts.json");
    NodeFS.writeFileSync(bigManifest, JSON.stringify({ schema: 1, note: "x".repeat(4096) }));
    const bounded = createCiHostsReloader({ overridePath: bigManifest, maxBytes: 512 }).reload();
    expect(bounded.ok).toBe(false);
    expect(bounded.errors[0]).toContain("exceeds maximum size");
  });
});
