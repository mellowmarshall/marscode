// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for ghAttribution, gh-run CLI, and gh-shim.sh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { runHostGuardCli } from "./cli.ts";
import { cleanupGhStampTempDirs, prepareStampedGhArgs } from "./ghAttribution.ts";
import { REFUSED_EXIT_CODE } from "./hook.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";

const PKG_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

function runGit(cwd: string, args: ReadonlyArray<string>): void {
  const res = NodeChildProcess.spawnSync("/usr/bin/git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      PATH: "/usr/bin:/bin",
      HOME: cwd,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_CONFIG_GLOBAL: "/dev/null",
    },
  });
  if (res.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
}

function makeFixture(root: string): {
  readonly config: HostGuardsConfig;
  readonly configPath: string;
  readonly repoDir: string;
  readonly fakeGh: string;
  readonly recordPath: string;
} {
  const bare = NodePath.join(root, "origin.git");
  const repoDir = NodePath.join(root, "repo");
  NodeFS.mkdirSync(bare, { recursive: true });
  NodeFS.mkdirSync(repoDir, { recursive: true });
  runGit(bare, ["init", "--bare", "-b", "main"]);
  runGit(repoDir, ["init", "-b", "main"]);
  runGit(repoDir, ["remote", "add", "origin", bare]);
  NodeFS.writeFileSync(
    NodePath.join(repoDir, ".tree-guard.conf"),
    "ship_repo=example-org/demo-app\n",
    "utf8",
  );
  runGit(repoDir, ["add", "."]);
  runGit(repoDir, ["commit", "-m", "init"]);
  runGit(repoDir, ["push", "-u", "origin", "main"]);
  runGit(repoDir, ["remote", "set-head", "origin", "main"]);
  runGit(repoDir, ["remote", "set-url", "origin", "https://github.com/example-org/demo-app.git"]);

  const recordPath = NodePath.join(root, "gh-record.json");
  const fakeGh = NodePath.join(root, "fake-gh");
  NodeFS.writeFileSync(
    fakeGh,
    `#!${process.execPath}
const fs = require("node:fs");
const args = process.argv.slice(2);
if (args[0] === "alias" && args[1] === "list") {
  process.stdout.write("ic:\\tissue create\\npc:\\tpr comment\\n");
  process.exit(0);
}
if (args[0] === "api" && args.includes(".visibility")) {
  process.stdout.write((process.env.FAKE_GH_VISIBILITY ?? "private") + "\\n");
  process.exit(0);
}
const record = { args, files: {} };
for (let i = 0; i < args.length; i += 1) {
  const a = args[i];
  if ((a === "-F" || a === "--body-file" || a === "--input") && i + 1 < args.length) {
    const p = args[i + 1];
    if (fs.existsSync(p)) {
      record.files[p] = {
        content: fs.readFileSync(p, "utf8"),
        mode: fs.statSync(p).mode & 0o777,
      };
    }
  }
}
fs.writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify(record), "utf8");
if (process.env.FAKE_GH_SELF_SIGNAL) {
  process.kill(process.pid, process.env.FAKE_GH_SELF_SIGNAL);
  setTimeout(() => {}, 5000);
  return;
}
if (process.env.FAKE_GH_SLEEP_MS) {
  setTimeout(() => process.exit(0), Number(process.env.FAKE_GH_SLEEP_MS));
  return;
}
const exitCode = Number(process.env.FAKE_GH_EXIT || "0");
process.exit(exitCode);
`,
    { mode: 0o755 },
  );

  const configPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot: NodePath.join(root, "src"),
      dataRoot: NodePath.join(root, "data"),
      stateDir: NodePath.join(root, "state"),
      realGit: "/usr/bin/git",
      realGh: fakeGh,
    }),
    "utf8",
  );
  return {
    config: loadHostConfig({ configPath }),
    configPath,
    repoDir,
    fakeGh,
    recordPath,
  };
}

describe("ghAttribution, gh-run, and gh-shim.sh", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  const agentEnv: NodeJS.ProcessEnv = {
    CLAUDECODE: "1",
    CLAUDE_SESSION_ID: "sess-abc",
    T3CODE_THREAD_ID: "thread-xyz",
  };

  it("leaves human invocations completely unstamped and stamps in-scope agent high-level gh commands", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-attr-"));
    tempDirs.push(root);
    const { config, repoDir } = makeFixture(root);

    // Human interactive caller: untouched
    const humanRes = prepareStampedGhArgs(
      ["issue", "comment", "7", "-b", "Human note"],
      repoDir,
      config,
      { env: {}, testMode: true },
    );
    expect(humanRes.stamped).toBe(false);
    expect(humanRes.args).toEqual(["issue", "comment", "7", "-b", "Human note"]);

    // Agent caller across all body flag syntaxes (-b, --body, -b=, --body=, -b<val>) including `new`
    const flagCases: ReadonlyArray<ReadonlyArray<string>> = [
      ["issue", "create", "-t", "Bug", "-b", "Repro"],
      ["issue", "new", "-t", "Bug", "-b", "New issue"],
      ["issue", "comment", "7", "--body", "Update"],
      ["issue", "edit", "7", "--body=Edited"],
      ["pr", "create", "-t", "Feat", "-b=PR text"],
      ["pr", "new", "-t", "Feat", "-b", "New PR text"],
      ["pr", "comment", "7", "-bShort"],
      ["pr", "review", "7", "--approve", "-b", "LGTM"],
      ["pr", "edit", "7", "--body", "Revised"],
    ];
    for (const argv of flagCases) {
      const res = prepareStampedGhArgs(argv, repoDir, config, {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
      });
      expect(res.stamped).toBe(true);
      const joined = res.args.join(" ");
      expect(joined).toContain("Co-authored-by: Claude Code <claude-code@agents.local>");
      expect(joined).toContain("Agent Session: sess-abc");
      expect(joined).toContain("Agent Thread: thread-xyz");

      // Idempotency
      const second = prepareStampedGhArgs(res.args, repoDir, config, {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
      });
      expect(second.stamped).toBe(false);
      expect(second.args).toEqual(res.args);
    }

    // Out-of-scope repo and skip flags (--fill, --fill-first, --fill-verbose, --web, missing body) stay unstamped
    const skipCases: ReadonlyArray<ReadonlyArray<string>> = [
      ["issue", "comment", "7", "-R", "other-org/other-repo", "-b", "External"],
      ["pr", "create", "--fill"],
      ["pr", "create", "--fill-first", "-b", "Ignored"],
      ["pr", "create", "--fill-verbose"],
      ["issue", "create", "--web", "-b", "Browser"],
      ["pr", "review", "7", "--approve"],
      ["issue", "close", "7"],
    ];
    for (const argv of skipCases) {
      const res = prepareStampedGhArgs(argv, repoDir, config, {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
      });
      expect(res.stamped).toBe(false);
      expect(res.args).toEqual(argv);
    }
  });

  it("handles -F / --body-file from disk and stdin with 0600 temp files and stamps allowlisted gh api endpoints", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-attr-api-"));
    tempDirs.push(root);
    const { config, repoDir } = makeFixture(root);

    // -F <file> creates a 0600 temp file and does not modify original file
    const bodyFile = NodePath.join(root, "body.md");
    NodeFS.writeFileSync(bodyFile, "Original markdown body.\n", "utf8");
    const fileRes = prepareStampedGhArgs(
      ["issue", "comment", "9", "-F", bodyFile],
      repoDir,
      config,
      {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
      },
    );
    expect(fileRes.stamped).toBe(true);
    expect(fileRes.tempDirs).toHaveLength(1);
    const stampedFilePath = fileRes.args[4]!;
    expect(stampedFilePath).not.toBe(bodyFile);
    expect(NodeFS.statSync(stampedFilePath).mode & 0o777).toBe(0o600);
    expect(NodeFS.readFileSync(stampedFilePath, "utf8")).toContain("Agent Thread: thread-xyz");
    expect(NodeFS.readFileSync(bodyFile, "utf8")).toBe("Original markdown body.\n");
    cleanupGhStampTempDirs(fileRes.tempDirs);
    expect(NodeFS.existsSync(stampedFilePath)).toBe(false);

    // --body-file - reads stdin and writes 0600 temp file
    const stdinRes = prepareStampedGhArgs(
      ["pr", "comment", "9", "--body-file=-"],
      repoDir,
      config,
      {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
        stdin: "From stdin",
      },
    );
    expect(stdinRes.stamped).toBe(true);
    expect(stdinRes.consumedStdin).toBe(true);
    const stdinTmp = stdinRes.args[3]!.slice("--body-file=".length);
    expect(NodeFS.readFileSync(stdinTmp, "utf8")).toContain("From stdin");
    expect(NodeFS.readFileSync(stdinTmp, "utf8")).toContain("Agent Session: sess-abc");
    cleanupGhStampTempDirs(stdinRes.tempDirs);

    // Allowlisted gh api endpoints (-f body=, -F body=@file, --input json), including comment edit & review replies
    const apiEndpoints: ReadonlyArray<ReadonlyArray<string>> = [
      ["api", "-X", "POST", "repos/example-org/demo-app/issues", "-f", "title=T", "-f", "body=B"],
      ["api", "repos/{owner}/{repo}/issues/5/comments", "-f", "body=Comment"],
      ["api", "-X", "PATCH", "repos/example-org/demo-app/issues/5", "-f", "body=Patched"],
      [
        "api",
        "-X",
        "PATCH",
        "repos/example-org/demo-app/issues/comments/99",
        "-f",
        "body=EditComment",
      ],
      ["api", "-X", "POST", "repos/example-org/demo-app/pulls", "-f", "body=PR"],
      ["api", "-X", "POST", "repos/example-org/demo-app/pulls/5/comments", "-F", "body=Line"],
      [
        "api",
        "-X",
        "POST",
        "repos/example-org/demo-app/pulls/5/comments/99/replies",
        "-f",
        "body=ReviewReply",
      ],
      ["api", "-X", "POST", "repos/example-org/demo-app/pulls/5/reviews", "-f", "body=Rev"],
      ["api", "-X", "PATCH", "repos/example-org/demo-app/pulls/5", "-f", "body=EditPR"],
    ];
    for (const argv of apiEndpoints) {
      const res = prepareStampedGhArgs(argv, repoDir, config, {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
      });
      expect(res.stamped).toBe(true);
      expect(res.args.join(" ")).toContain("Agent Thread: thread-xyz");
    }

    // --input JSON body stamping
    const jsonIn = NodePath.join(root, "in.json");
    NodeFS.writeFileSync(jsonIn, JSON.stringify({ title: "Hi", body: "JSON body" }), "utf8");
    const jsonRes = prepareStampedGhArgs(
      ["api", "-X", "POST", "repos/example-org/demo-app/issues", "--input", jsonIn],
      repoDir,
      config,
      { env: agentEnv, allowEnvThreadId: true, testMode: true },
    );
    expect(jsonRes.stamped).toBe(true);
    const stampedJsonPath = jsonRes.args[5]!;
    const parsed = JSON.parse(NodeFS.readFileSync(stampedJsonPath, "utf8")) as {
      title: string;
      body: string;
    };
    expect(parsed.title).toBe("Hi");
    expect(parsed.body).toContain("JSON body");
    expect(parsed.body).toContain("Agent Thread: thread-xyz");
    cleanupGhStampTempDirs(jsonRes.tempDirs);

    // Non-allowlisted endpoint & PATCH without body stay untouched
    expect(
      prepareStampedGhArgs(
        ["api", "-X", "POST", "repos/example-org/demo-app/releases", "-f", "body=Release notes"],
        repoDir,
        config,
        { env: agentEnv, allowEnvThreadId: true, testMode: true },
      ).stamped,
    ).toBe(false);
    expect(
      prepareStampedGhArgs(
        ["api", "-X", "PATCH", "repos/example-org/demo-app/issues/5", "-f", "state=closed"],
        repoDir,
        config,
        { env: agentEnv, allowEnvThreadId: true, testMode: true },
      ).stamped,
    ).toBe(false);
  });

  it("executes real gh via gh-run with stamped args, temp cleanup, exit code preservation, and gh-shim.sh fast-path", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-gh-run-"));
    tempDirs.push(root);
    const { configPath, repoDir, fakeGh, recordPath } = makeFixture(root);

    // 1. gh-run refuses direct gh pr create with exit code 2
    const blockedCode = await runHostGuardCli(
      ["gh-run", "--real-gh", fakeGh, "--", "pr", "create", "-t", "Direct", "-b", "Nope"],
      {
        cwd: repoDir,
        env: agentEnv,
        configPath,
        socketPath: "",
        allowEnvThreadId: true,
        testMode: true,
        out: () => {},
        err: () => {},
      },
    );
    expect(blockedCode).toBe(REFUSED_EXIT_CODE);
    expect(NodeFS.existsSync(recordPath)).toBe(false);

    // 2. gh-run stamps -b with tricky shell characters, preserves non-zero exit code (7), and cleans up -F temp file
    const bodyFile = NodePath.join(root, "comment.md");
    NodeFS.writeFileSync(bodyFile, "Body with 'single' & \"double\" & $(echo no)\n", "utf8");
    const runCode = await runHostGuardCli(
      ["gh-run", "--real-gh", fakeGh, "--", "issue", "comment", "12", "-F", bodyFile],
      {
        cwd: repoDir,
        env: { ...agentEnv, FAKE_GH_EXIT: "7" },
        configPath,
        socketPath: "",
        allowEnvThreadId: true,
        testMode: true,
        out: () => {},
        err: () => {},
      },
    );
    expect(runCode).toBe(7);
    const recorded = JSON.parse(NodeFS.readFileSync(recordPath, "utf8")) as {
      args: string[];
      files: Record<string, { content: string; mode: number }>;
    };
    const tmpUsed = recorded.args[4]!;
    expect(tmpUsed).not.toBe(bodyFile);
    expect(recorded.files[tmpUsed]?.mode).toBe(0o600);
    expect(recorded.files[tmpUsed]?.content).toContain(
      "Body with 'single' & \"double\" & $(echo no)",
    );
    expect(recorded.files[tmpUsed]?.content).toContain("Agent Thread: thread-xyz");
    // Temp file cleaned up in finally block!
    expect(NodeFS.existsSync(tmpUsed)).toBe(false);

    // 3. gh-run allows gh issue close unstamped
    const closeCode = await runHostGuardCli(
      ["gh-run", "--real-gh", fakeGh, "--", "issue", "close", "12"],
      {
        cwd: repoDir,
        env: agentEnv,
        configPath,
        socketPath: "",
        allowEnvThreadId: true,
        testMode: true,
        out: () => {},
        err: () => {},
      },
    );
    expect(closeCode).toBe(0);
    const closeRecorded = JSON.parse(NodeFS.readFileSync(recordPath, "utf8")) as { args: string[] };
    expect(closeRecorded.args).toEqual(["issue", "close", "12"]);

    // 4. gh-shim.sh fast-paths read-only `gh pr view` without invoking marscode-host-guard,
    //    and routes `gh issue comment` to `marscode-host-guard gh-run --real-gh ... -- ...`
    const guardMarker = NodePath.join(root, "guard-marker.txt");
    const fakeGuard = NodePath.join(root, "fake-guard");
    NodeFS.writeFileSync(
      fakeGuard,
      `#!/bin/bash
printf '%s\\n' "$*" > ${JSON.stringify(guardMarker)}
exit 0
`,
      { mode: 0o755 },
    );
    const renderedGhShim = NodePath.join(root, "gh");
    const shimText = NodeFS.readFileSync(NodePath.join(PKG_ROOT, "shims", "gh-shim.sh"), "utf8")
      .replaceAll("@REAL_GH@", fakeGh)
      .replaceAll("@HOST_GUARD@", fakeGuard)
      .replaceAll("@SHIM_DEPTH@", NodePath.join(PKG_ROOT, "shims", "shim-depth.sh"));
    NodeFS.writeFileSync(renderedGhShim, shimText, { mode: 0o755 });

    const fastView = NodeChildProcess.spawnSync(renderedGhShim, ["pr", "view", "12"], {
      cwd: repoDir,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(fastView.status).toBe(0);
    expect(NodeFS.existsSync(guardMarker)).toBe(false);

    const routedComment = NodeChildProcess.spawnSync(
      renderedGhShim,
      ["issue", "comment", "12", "-b", "hello"],
      {
        cwd: repoDir,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    expect(routedComment.status).toBe(0);
    expect(NodeFS.readFileSync(guardMarker, "utf8").trim()).toBe(
      `gh-run --real-gh ${fakeGh} -- issue comment 12 -b hello`,
    );
  });

  it("stamps GH_REPO fallback, non-shell gh aliases, and returns 128+signal while cleaning up temp files on signal", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-attr-hardening-"));
    tempDirs.push(root);
    const { config, configPath, repoDir, fakeGh, recordPath } = makeFixture(root);

    // B6-B7: GH_REPO stamps from an out-of-scope cwd (both high-level and gh api {owner}/{repo})
    const ghRepoAgentEnv = { ...agentEnv, GH_REPO: "example-org/demo-app" };
    const envIssue = prepareStampedGhArgs(
      ["issue", "create", "-t", "Env Bug", "-b", "From out-of-scope cwd"],
      root,
      config,
      { env: ghRepoAgentEnv, allowEnvThreadId: true, testMode: true },
    );
    expect(envIssue.stamped).toBe(true);
    expect(envIssue.args.join(" ")).toContain("Agent Thread: thread-xyz");

    const envApi = prepareStampedGhArgs(
      ["api", "-X", "POST", "repos/{owner}/{repo}/issues", "-f", "body=Via GH_REPO"],
      root,
      config,
      { env: ghRepoAgentEnv, allowEnvThreadId: true, testMode: true },
    );
    expect(envApi.stamped).toBe(true);
    expect(envApi.args.join(" ")).toContain("Agent Thread: thread-xyz");

    // N3: Non-shell gh aliases (`ic` -> `issue create`, `pc` -> `pr comment`) expand and stamp
    const aliasIssue = prepareStampedGhArgs(
      ["ic", "-t", "Aliased", "-b", "Via alias"],
      repoDir,
      config,
      {
        env: agentEnv,
        allowEnvThreadId: true,
        testMode: true,
      },
    );
    expect(aliasIssue.stamped).toBe(true);
    expect(aliasIssue.args.slice(0, 2)).toEqual(["issue", "create"]);
    expect(aliasIssue.args.join(" ")).toContain("Agent Thread: thread-xyz");

    const aliasPrComment = prepareStampedGhArgs(["pc", "12", "-b", "PR comment"], repoDir, config, {
      env: agentEnv,
      allowEnvThreadId: true,
      testMode: true,
    });
    expect(aliasPrComment.stamped).toBe(true);
    expect(aliasPrComment.args.slice(0, 2)).toEqual(["pr", "comment"]);
    expect(aliasPrComment.args.join(" ")).toContain("Agent Thread: thread-xyz");

    // N4: Child terminated by SIGTERM returns 128 + SIGTERM and cleans up 0600 temp file
    const bodyFile = NodePath.join(root, "sig-body.md");
    NodeFS.writeFileSync(bodyFile, "Body before signal.\n", "utf8");
    const sigCode = await runHostGuardCli(
      ["gh-run", "--real-gh", fakeGh, "--", "issue", "comment", "12", "-F", bodyFile],
      {
        cwd: repoDir,
        env: { ...agentEnv, FAKE_GH_SELF_SIGNAL: "SIGTERM" },
        configPath,
        socketPath: "",
        allowEnvThreadId: true,
        testMode: true,
        out: () => {},
        err: () => {},
      },
    );
    expect(sigCode).toBe(128 + NodeOS.constants.signals.SIGTERM);
    const sigRecorded = JSON.parse(NodeFS.readFileSync(recordPath, "utf8")) as { args: string[] };
    const sigTmp = sigRecorded.args[4]!;
    expect(sigTmp).not.toBe(bodyFile);
    expect(NodeFS.existsSync(sigTmp)).toBe(false);

    // N4: Parent SIGTERM cleans up 0600 temp file and forwards SIGTERM to running gh child
    NodeFS.unlinkSync(recordPath);
    const sleepPromise = runHostGuardCli(
      ["gh-run", "--real-gh", fakeGh, "--", "issue", "comment", "12", "-F", bodyFile],
      {
        cwd: repoDir,
        env: { ...agentEnv, FAKE_GH_SLEEP_MS: "5000" },
        configPath,
        socketPath: "",
        allowEnvThreadId: true,
        testMode: true,
        out: () => {},
        err: () => {},
      },
    );
    await expect.poll(() => NodeFS.existsSync(recordPath)).toBe(true);
    const sleepRecorded = JSON.parse(NodeFS.readFileSync(recordPath, "utf8")) as { args: string[] };
    const sleepTmp = sleepRecorded.args[4]!;
    expect(NodeFS.existsSync(sleepTmp)).toBe(true);

    process.emit("SIGTERM", "SIGTERM");
    const forwardedCode = await sleepPromise;
    expect(forwardedCode).toBe(128 + NodeOS.constants.signals.SIGTERM);
    expect(NodeFS.existsSync(sleepTmp)).toBe(false);
  });
});
