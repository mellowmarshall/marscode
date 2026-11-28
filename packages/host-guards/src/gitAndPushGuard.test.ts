// @effect-diagnostics nodeBuiltinImport:off - Real temporary git repository tests for gitGuard and pushGuard.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { decideGit } from "./gitGuard.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";
import { decidePush } from "./pushGuard.ts";
import { isUrlInScope } from "./repoScope.ts";

function runGit(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_AUTHOR_NAME: "Test Author",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test Author",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return (res.stdout ?? "").trim();
}

function setupRepoFixture(root: string): {
  readonly config: HostGuardsConfig;
  readonly bareOrigin: string;
  readonly primaryDir: string;
  readonly worktreeDir: string;
  readonly outOfScopeDir: string;
} {
  const sourceRoot = NodePath.join(root, "source");
  const dataRoot = NodePath.join(root, "data");
  const stateDir = NodePath.join(root, "state");
  const bareOrigin = NodePath.join(root, "origin.git");
  const primaryDir = NodePath.join(sourceRoot, "demo-app");
  const worktreeDir = NodePath.join(dataRoot, "demo-app", "feat-1");
  const outOfScopeDir = NodePath.join(root, "third-party");

  NodeFS.mkdirSync(sourceRoot, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(dataRoot, "demo-app"), { recursive: true });
  NodeFS.mkdirSync(bareOrigin, { recursive: true });
  NodeFS.mkdirSync(primaryDir, { recursive: true });
  NodeFS.mkdirSync(outOfScopeDir, { recursive: true });

  runGit(bareOrigin, ["init", "--bare", "-b", "main"]);
  runGit(primaryDir, ["init", "-b", "main"]);
  runGit(primaryDir, ["remote", "add", "origin", bareOrigin]);
  NodeFS.writeFileSync(NodePath.join(primaryDir, "README.md"), "# Demo\n", "utf8");
  NodeFS.mkdirSync(NodePath.join(primaryDir, ".githooks"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, ".githooks", "pre-commit"),
    "#!/bin/sh\nexit 0\n",
    {
      mode: 0o755,
    },
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, ".tree-guard.conf"),
    "ship_repo=example-org/demo-app\n",
    "utf8",
  );
  runGit(primaryDir, ["add", "."]);
  runGit(primaryDir, ["commit", "-m", "initial commit"]);
  runGit(primaryDir, ["push", "-u", "origin", "main"]);
  runGit(primaryDir, ["remote", "set-head", "origin", "main"]);
  // Add GitHub push/origin URL rewrite so scope matches example-org/demo-app while dry-run talks to local bare repo.
  runGit(primaryDir, [
    "remote",
    "set-url",
    "origin",
    "https://github.com/example-org/demo-app.git",
  ]);
  runGit(primaryDir, [
    "config",
    `url.${bareOrigin}.insteadOf`,
    "https://github.com/example-org/demo-app.git",
  ]);
  runGit(primaryDir, ["worktree", "add", worktreeDir, "-b", "feat/1"]);

  // Out-of-scope repo
  runGit(outOfScopeDir, ["init", "-b", "main"]);
  runGit(outOfScopeDir, ["remote", "add", "origin", "https://github.com/other-org/other-repo.git"]);
  NodeFS.writeFileSync(NodePath.join(outOfScopeDir, "a.txt"), "hello\n", "utf8");
  runGit(outOfScopeDir, ["add", "."]);
  runGit(outOfScopeDir, ["commit", "-m", "init"]);

  const cfgPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    cfgPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot,
      dataRoot,
      stateDir,
      queueRoot: NodePath.join(dataRoot, ".ship-queue"),
      realGit: "/usr/bin/git",
    }),
    "utf8",
  );
  const config = loadHostConfig({ configPath: cfgPath });
  return { config, bareOrigin, primaryDir, worktreeDir, outOfScopeDir };
}

describe("gitGuard and pushGuard against real git repos", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("blocks direct push to base branch via real git push --dry-run and allows feature branch push", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-git-"));
    tempDirs.push(root);
    const { config, worktreeDir, outOfScopeDir } = setupRepoFixture(root);

    // Push to feature branch is allowed
    const featPush = decidePush(["origin", "HEAD:feat/1"], worktreeDir, {}, [], config);
    expect(featPush.verdict).toBe("allow");

    // Push targeting main (base branch) is denied
    const mainPush = decidePush(["origin", "HEAD:main"], worktreeDir, {}, [], config);
    expect(mainPush.verdict).toBe("deny");
    expect(mainPush.reason).toContain("base branch");

    // Push to out-of-scope remote is allowed
    const otherPush = decidePush(["origin", "HEAD:main"], outOfScopeDir, {}, [], config);
    expect(otherPush.verdict).toBe("allow");

    // Unresolvable in-scope remote fails closed (including git+ssh://, ssh+git://, and trailing DNS dot)
    expect(isUrlInScope("git+ssh://git@github.com/example-org/demo-app.git", config)).toBe(true);
    expect(isUrlInScope("ssh+git://git@github.com/example-org/demo-app.git", config)).toBe(true);
    expect(isUrlInScope("https://github.com./example-org/demo-app.git", config)).toBe(true);

    const badRemote = decidePush(
      ["https://github.com/example-org/nonexistent-repo.git", "HEAD:feat/1"],
      worktreeDir,
      {},
      [],
      config,
    );
    expect(badRemote.verdict).toBe("deny");
    expect(badRemote.reason).toContain("never judged blind");

    expect(
      decidePush(
        ["git+ssh://git@github.com/example-org/demo-app.git", "HEAD:main"],
        worktreeDir,
        {},
        [],
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decidePush(
        ["https://github.com./example-org/demo-app.git", "HEAD:main"],
        worktreeDir,
        {},
        [],
        config,
      ).verdict,
    ).toBe("deny");
  });

  it("enforces primary checkout protection, hooks-path integrity, no-verify, SKIP_CI, stash, and aliases", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-git-rules-"));
    tempDirs.push(root);
    const { config, primaryDir, worktreeDir } = setupRepoFixture(root);

    // Direct commit on main in primary checkout is refused
    expect(decideGit(["commit", "-m", "bad"], {}, primaryDir, config).verdict).toBe("deny");
    // Branch switch in primary checkout is refused (except returning to trunk)
    expect(decideGit(["switch", "-c", "feat-x"], {}, primaryDir, config).verdict).toBe("deny");
    expect(decideGit(["checkout", "-b", "feat-x"], {}, primaryDir, config).verdict).toBe("deny");
    expect(decideGit(["branch", "new-branch"], {}, primaryDir, config).verdict).toBe("deny");
    expect(decideGit(["branch", "-a"], {}, primaryDir, config).verdict).toBe("allow");
    expect(decideGit(["switch", "main"], {}, primaryDir, config).verdict).toBe("allow");

    // Normal commit on feature branch in dataRoot worktree is allowed
    expect(decideGit(["commit", "-m", "good"], {}, worktreeDir, config).verdict).toBe("allow");

    // --no-verify, prefix --no-ver, commit -n, and SKIP_CI are refused
    expect(decideGit(["commit", "--no-verify", "-m", "x"], {}, worktreeDir, config).verdict).toBe(
      "deny",
    );
    expect(decideGit(["commit", "--no-ver", "-m", "x"], {}, worktreeDir, config).verdict).toBe(
      "deny",
    );
    expect(decideGit(["commit", "-n", "-m", "x"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["commit", "-anm", "x"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["commit", "-m", "x"], { SKIP_CI: "1" }, worktreeDir, config).verdict).toBe(
      "deny",
    );

    // Hooks path tampering via -c, GIT_CONFIG_*, or git config
    expect(
      decideGit(["-c", "core.hooksPath=/tmp/empty", "commit", "-m", "x"], {}, worktreeDir, config)
        .verdict,
    ).toBe("deny");
    expect(
      decideGit(["config", "core.hooksPath", "/tmp/untracked"], {}, worktreeDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGit(["config", "--unset", "core.hooksPath"], {}, worktreeDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGit(["config", "include.path", "/tmp/evil.cfg"], {}, worktreeDir, config).verdict,
    ).toBe("deny");
    // The first step of the rename two-step is not a guarded key, so it alone is allowed.
    expect(
      decideGit(["config", "foo.hooksPath", "/dev/null"], {}, worktreeDir, config).verdict,
    ).toBe("allow");
    expect(
      decideGit(["config", "-e"], { GIT_EDITOR: "sed -i s/x/y/" }, worktreeDir, config).verdict,
    ).toBe("deny");
    // Reading a guarded key is a read, whatever the flags; a value after the key is a write
    for (const read of [
      ["config", "core.hooksPath"],
      ["config", "--get", "core.hooksPath"],
      ["config", "--local", "core.hooksPath"],
      ["config", "--file", ".gitmodules", "core.hooksPath"],
      ["config", "--type", "path", "core.hooksPath"],
      ["config", "get", "core.hooksPath"],
    ]) {
      expect(decideGit(read, {}, worktreeDir, config).verdict, read.join(" ")).toBe("allow");
    }
    expect(
      decideGit(["config", "core.hooksPath", "core.hooksPath"], {}, worktreeDir, config).verdict,
    ).toBe("deny");
    expect(
      decideGit(["config", "--local", "core.hooksPath", "/dev/null"], {}, worktreeDir, config)
        .verdict,
    ).toBe("deny");
    expect(
      decideGit(["config", "set", "core.hooksPath", "/dev/null"], {}, worktreeDir, config).verdict,
    ).toBe("deny");
    // Probes: option parsing stops at --/--end-of-options; a dash word after the key is a value.
    for (const write of [
      ["config", "--", "core.hooksPath", "-x"],
      ["config", "--", "include.path", "-evil.cfg"],
      ["config", "--local", "--", "core.hooksPath", "-x"],
      ["config", "--end-of-options", "core.hooksPath", "-x"],
      ["config", "--local", "--end-of-options", "include.path", "-evil.cfg"],
      ["config", "core.hooksPath", "-x"],
      ["config", "--show-origin", "core.hooksPath", "/dev/null"],
      ["config", "--", "--get", "core.hooksPath"],
      ["config", "--unknown-flag", "core.hooksPath"],
      // Words after the key are positional: any of them makes it a write.
      ["config", "core.hooksPath", "--local"],
      ["config", "core.hooksPath", "--get"],
      ["config", "core.hooksPath", "--file", "x"],
      ["config", "core.hooksPath", "--type", "path"],
      ["config", "core.hooksPath", "--show-origin"],
      ["config", "--local", "core.hooksPath", "--list"],
      ["config", "--get", "core.hooksPath", "/dev/null"],
      ["config", "--local", "core.hooksPath", ".githooks"],
      // Section edits can turn any key into core.hooksPath or an include: owner-only.
      ["config", "--rename-section", "foo", "core"],
      ["config", "--rename-section", "foo", "include"],
      ["config", "rename-section", "foo", "core"],
      ["config", "foo", "core", "--rename-section"],
      ["config", "--remove-section", "core"],
      ["config", "-e"],
      ["config", "--edit", "--local"],
    ]) {
      expect(decideGit(write, {}, worktreeDir, config).verdict, write.join(" ")).toBe("deny");
    }
    // Setting core.hooksPath to tracked directory containing pre-commit is allowed
    expect(
      decideGit(["config", "core.hooksPath", ".githooks"], {}, worktreeDir, config).verdict,
    ).toBe("allow");

    // Stash in multi-worktree repo: push/pop refused, list/show allowed
    expect(decideGit(["stash", "push"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["stash", "list"], {}, worktreeDir, config).verdict).toBe("allow");

    // Plumbing pushes refused
    expect(decideGit(["send-pack", "origin"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(
      decideGit(["subtree", "push", "--prefix=a", "origin", "main"], {}, worktreeDir, config)
        .verdict,
    ).toBe("deny");

    // Git alias expansion (1-hop, 2-hop chain, alias cycle, and shell alias refusal at depth)
    runGit(worktreeDir, ["config", "alias.sneaky", "!git push origin HEAD:main"]);
    runGit(worktreeDir, ["config", "alias.nvcommit", "commit --no-verify"]);
    runGit(worktreeDir, ["config", "alias.p1", "p2"]);
    runGit(worktreeDir, ["config", "alias.p2", "push origin HEAD:main"]);
    runGit(worktreeDir, ["config", "alias.loop1", "loop2"]);
    runGit(worktreeDir, ["config", "alias.loop2", "loop1"]);
    runGit(worktreeDir, ["config", "alias.shhop", "sneaky"]);
    expect(decideGit(["sneaky"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["nvcommit", "-m", "x"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["p1"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["loop1"], {}, worktreeDir, config).verdict).toBe("deny");
    expect(decideGit(["shhop"], {}, worktreeDir, config).verdict).toBe("deny");

    // Alias expansion preserves --git-dir / --work-tree even when invoked from an out-of-scope cwd
    const outsideDir = NodePath.join(root, "outside");
    NodeFS.mkdirSync(outsideDir, { recursive: true });
    runGit(primaryDir, ["config", "alias.nvc", "commit --no-verify"]);
    expect(
      decideGit(
        [
          `--git-dir=${NodePath.join(primaryDir, ".git")}`,
          `--work-tree=${primaryDir}`,
          "commit",
          "--no-verify",
          "-m",
          "x",
        ],
        {},
        outsideDir,
        config,
      ).verdict,
    ).toBe("deny");
    expect(
      decideGit(
        [
          `--git-dir=${NodePath.join(primaryDir, ".git")}`,
          `--work-tree=${primaryDir}`,
          "nvc",
          "-m",
          "x",
        ],
        {},
        outsideDir,
        config,
      ).verdict,
    ).toBe("deny");
  });
  it("parses git config options the way git does: abbreviated and bundled section edits are owner-only", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-git-cfg-"));
    tempDirs.push(root);
    const { config, worktreeDir } = setupRepoFixture(root);
    const verdict = (args: ReadonlyArray<string>) =>
      decideGit(["config", ...args], {}, worktreeDir, config).verdict;

    // Probe: real git takes the two-step through an abbreviated --rename-section.
    const scratch = NodePath.join(root, "scratch");
    NodeFS.mkdirSync(scratch);
    runGit(scratch, ["init", "-q"]);
    runGit(scratch, ["config", "x.hooksPath", "/dev/null"]);
    runGit(scratch, ["config", "--rename-sec", "x", "core"]);
    expect(runGit(scratch, ["config", "--get", "core.hooksPath"])).toBe("/dev/null");

    // Step one is not a guarded key; step two is, in every spelling git accepts.
    expect(verdict(["x.hooksPath", "/dev/null"])).toBe("allow");
    expect(verdict(["y.path", "/tmp/evil.cfg"])).toBe("allow");
    for (const args of [
      ["--rename-sec", "x", "core"],
      ["--rename-s", "x", "core"],
      ["--rename-section=x", "core"],
      ["--rename-sec", "y", "include"],
      ["--local", "--rename-sec", "y", "include"],
      ["--remove-sec", "core"],
      ["--remove-s", "include"],
      ["--ed"],
      ["--edi"],
      ["-ze"],
      ["-ez"],
      ["-le"],
      ["--local", "-ze"],
      ["x", "core", "--rename-sec"],
      // Ambiguous or unknown options never pass as reads.
      ["--re", "x", "core"],
      ["--fi", ".gitmodules", "--get", "core.hooksPath"],
      ["--unknown", "core.hooksPath"],
      ["--unset-a", "core.hooksPath"],
      ["--repl", "core.hooksPath", "/dev/null"],
      ["--no-local", "core.hooksPath", "/dev/null"],
      ["--file=x", "--add", "include.path", "/tmp/evil.cfg"],
      ["-f", "x", "--add", "include.path", "/tmp/evil.cfg"],
      ["-fx", "--add", "include.path", "/tmp/evil.cfg"],
      ["--add", "includeIf.gitdir:/.path", "/tmp/evil.cfg"],
    ]) {
      expect(verdict(args), args.join(" ")).toBe("deny");
    }
    // Unique prefixes of read options stay reads; -z bundles without a section edit are fine.
    for (const args of [
      ["--get", "core.hooksPath"],
      ["--get-a", "core.hooksPath"],
      ["--show-o", "--get", "core.hooksPath"],
      ["-z", "--get", "core.hooksPath"],
      ["-zl"],
      ["--fil", ".gitmodules", "--get", "core.hooksPath"],
      ["-f.gitmodules", "--get", "core.hooksPath"],
      ["--type=path", "core.hooksPath"],
      ["--name-o", "-l"],
    ]) {
      expect(verdict(args), args.join(" ")).toBe("allow");
    }
  });
});
