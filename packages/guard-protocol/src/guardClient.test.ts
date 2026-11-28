// @effect-diagnostics nodeBuiltinImport:off - End-to-end unit & integration tests for guard-protocol client, CLI, bundle inspector, and Python bridge.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { inspectWorktreeBundle } from "./bundleInspect.ts";
import { runGuardCli } from "./cli.ts";
import {
  checkGuardGrant,
  identifyGuardThread,
  peekGuardGrant,
  requestGuardGrant,
  resolveGuardSocketPath,
} from "./client.ts";
import { ensureGuardSigningKeyPair, signBundleGrant } from "./signing.ts";

const PKG_DIR = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");
const tempDirs: string[] = [];

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function git(cwd: string, args: ReadonlyArray<string>): string {
  const res = NodeChildProcess.spawnSync("git", ["-C", cwd, ...args], {
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test",
      GIT_AUTHOR_EMAIL: "test@example.com",
      GIT_COMMITTER_NAME: "Test",
      GIT_COMMITTER_EMAIL: "test@example.com",
    },
  });
  if (res.status !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${res.stderr}`);
  }
  return res.stdout.trim();
}

function makeTempGitRepo(): string {
  const repoDir = makeTempDir("marscode-guard-repo-");
  git(repoDir, ["init", "-b", "main"]);
  git(repoDir, ["remote", "add", "origin", "https://github.com/acme-fixture/sample-repo.git"]);
  NodeFS.mkdirSync(NodePath.join(repoDir, "host-guards"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repoDir, "playbook"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(repoDir, "src"), { recursive: true });
  NodeFS.writeFileSync(NodePath.join(repoDir, "host-guards", "exceptions.json"), '{"rules":[]}\n');
  NodeFS.writeFileSync(NodePath.join(repoDir, "playbook", "PLAYBOOK.md"), "# Playbook\n");
  NodeFS.writeFileSync(NodePath.join(repoDir, "src", "app.ts"), "export const v = 1;\n");
  git(repoDir, ["add", "."]);
  git(repoDir, ["commit", "-m", "initial"]);
  git(repoDir, ["checkout", "-b", "feat/42-guard-test"]);
  return repoDir;
}

async function startMockBroker(
  handler: (req: Record<string, unknown>) => Record<string, unknown>,
): Promise<{
  readonly sockPath: string;
  readonly received: Array<Record<string, unknown>>;
  readonly close: () => Promise<void>;
}> {
  const dir = makeTempDir("marscode-sock-");
  NodeFS.chmodSync(dir, 0o700);
  const sockPath = NodePath.join(dir, "t3-guard-grant.sock");
  const received: Array<Record<string, unknown>> = [];
  const server = NodeNet.createServer((conn) => {
    let buf = "";
    conn.on("data", (chunk) => {
      buf += chunk.toString("utf8");
      const nl = buf.indexOf("\n");
      if (nl === -1) return;
      const parsed = JSON.parse(buf.slice(0, nl)) as Record<string, unknown>;
      received.push(parsed);
      conn.end(`${JSON.stringify(handler(parsed))}\n`);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(sockPath, () => {
      NodeFS.chmodSync(sockPath, 0o600);
      resolve();
    });
  });
  return {
    sockPath,
    received,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve());
      }),
  };
}

function spawnAsync(
  cmd: string,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
): Promise<{ readonly status: number | null; readonly stdout: string; readonly stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = NodeChildProcess.spawn(cmd, args, { env });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d: Buffer) => {
      stdout += d.toString("utf8");
    });
    child.stderr.on("data", (d: Buffer) => {
      stderr += d.toString("utf8");
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("inspectWorktreeBundle", () => {
  it("keeps protected_diff_sha256 stable across unrelated commits and enforces branch/flag/once-guard rules", () => {
    const repoDir = makeTempGitRepo();

    // Clean branch -> no protected paths -> undefined
    expect(
      inspectWorktreeBundle({
        guard: "ship-queue",
        command: ["submit", repoDir, "feat/42-guard-test"],
        cwd: repoDir,
      }),
    ).toBeUndefined();

    // Edit protected file + commit
    NodeFS.writeFileSync(
      NodePath.join(repoDir, "host-guards", "exceptions.json"),
      '{"rules":["allow-test"]}\n',
    );
    git(repoDir, ["add", "host-guards/exceptions.json"]);
    git(repoDir, ["commit", "-m", "update exceptions"]);

    const first = inspectWorktreeBundle({
      guard: "ship-queue",
      command: ["submit", repoDir, "feat/42-guard-test"],
      cwd: NodeOS.tmpdir(),
    });
    expect(first).toBeDefined();
    expect(first?.repo).toBe("acme-fixture/sample-repo");
    expect(first?.branch).toBe("feat/42-guard-test");
    expect(first?.pr_or_issue).toBe("#42");
    expect(first?.protected_paths).toEqual(["host-guards/exceptions.json"]);
    expect(first?.gates.map((g) => g.gate_id)).toEqual(["allowlist"]);
    expect(first?.protected_diff_sha256).toMatch(/^[0-9a-f]{64}$/);

    // Branch mismatch against checked-out HEAD must fail closed (M1)
    expect(
      inspectWorktreeBundle({
        guard: "ship-queue",
        command: ["submit", repoDir, "feat/99-other-branch"],
        cwd: NodeOS.tmpdir(),
      }),
    ).toBeUndefined();

    // Edit an unrelated file and commit -> protected_diff_sha256 must stay identical
    NodeFS.writeFileSync(NodePath.join(repoDir, "src", "app.ts"), "export const v = 2;\n");
    git(repoDir, ["add", "src/app.ts"]);
    git(repoDir, ["commit", "-m", "fix app"]);

    const second = inspectWorktreeBundle({
      guard: "ship-queue",
      command: ["ship-queue", "submit", repoDir, "feat/42-guard-test"],
      cwd: NodeOS.tmpdir(),
    });
    expect(second?.protected_diff_sha256).toBe(first?.protected_diff_sha256);
    expect(second?.commit_sha).not.toBe(first?.commit_sha);

    // Edit protected file again -> digest MUST change
    NodeFS.writeFileSync(
      NodePath.join(repoDir, "host-guards", "exceptions.json"),
      '{"rules":["allow-test","second"]}\n',
    );
    git(repoDir, ["add", "host-guards/exceptions.json"]);
    git(repoDir, ["commit", "-m", "second exception"]);

    const third = inspectWorktreeBundle({
      guard: "ship-queue",
      command: ["submit", repoDir, "feat/42-guard-test"],
      cwd: repoDir,
    });
    expect(third?.protected_diff_sha256).not.toBe(first?.protected_diff_sha256);

    // Whole-commit flags including `--flag=value` forms are detected (M3)
    const withFlags = inspectWorktreeBundle({
      guard: "ship-queue",
      command: [
        "submit",
        repoDir,
        "feat/42-guard-test",
        "--no-review=1",
        "--skip-ci-run-judge=true",
        "--unproven=yes",
      ],
      cwd: repoDir,
    });
    expect(withFlags?.gates.map((g) => g.gate_id)).toContain("no-review");
    expect(withFlags?.gates.map((g) => g.gate_id)).toContain("ci-run-judge");
    expect(withFlags?.gates.map((g) => g.gate_id)).toContain("unproven");

    // Always-once guards are never bundled
    for (const onceGuard of ["git-push", "deps-decide", "home-dev-install", "fly-deploy", "argv"]) {
      expect(
        inspectWorktreeBundle({
          guard: onceGuard,
          command: [onceGuard, repoDir],
          cwd: repoDir,
        }),
      ).toBeUndefined();
    }
  });

  it("inspects tracked and untracked protected files for playbook guard and ignores GIT_* env poisoning", () => {
    const repoDir = makeTempGitRepo();
    NodeFS.writeFileSync(
      NodePath.join(repoDir, "playbook", "PLAYBOOK.md"),
      "# Playbook\n\nNew section.\n",
    );
    NodeFS.writeFileSync(NodePath.join(repoDir, "playbook.json"), '{"version":1}\n');

    const prevGitDir = process.env.GIT_DIR;
    const prevConfigCount = process.env.GIT_CONFIG_COUNT;
    const prevConfigKey = process.env.GIT_CONFIG_KEY_0;
    const prevConfigVal = process.env.GIT_CONFIG_VALUE_0;
    process.env.GIT_DIR = "/nonexistent/poison-git-dir";
    process.env.GIT_CONFIG_COUNT = "1";
    process.env.GIT_CONFIG_KEY_0 = "diff.external";
    process.env.GIT_CONFIG_VALUE_0 = "/bin/false";
    try {
      const bundle = inspectWorktreeBundle({
        guard: "playbook",
        command: ["playbook", "check"],
        cwd: repoDir,
      });
      expect(bundle).toBeDefined();
      expect(bundle?.protected_paths).toEqual(["playbook.json", "playbook/PLAYBOOK.md"]);
      expect(bundle?.gates.map((g) => g.gate_id)).toEqual([
        "playbook-amend",
        "playbook-declaration",
      ]);
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      if (prevConfigCount === undefined) delete process.env.GIT_CONFIG_COUNT;
      else process.env.GIT_CONFIG_COUNT = prevConfigCount;
      if (prevConfigKey === undefined) delete process.env.GIT_CONFIG_KEY_0;
      else process.env.GIT_CONFIG_KEY_0 = prevConfigKey;
      if (prevConfigVal === undefined) delete process.env.GIT_CONFIG_VALUE_0;
      else process.env.GIT_CONFIG_VALUE_0 = prevConfigVal;
    }
  });

  it("defeats git replace (N1), clean filters (N2), and .git/info/exclude hiding (N3)", () => {
    const repoDir = makeTempGitRepo();

    // Commit a protected change and capture its honest digest
    NodeFS.writeFileSync(
      NodePath.join(repoDir, "host-guards", "exceptions.json"),
      '{"rules":["real-change"]}\n',
    );
    git(repoDir, ["add", "host-guards/exceptions.json"]);
    git(repoDir, ["commit", "-m", "real change"]);
    const honestSq = inspectWorktreeBundle({
      guard: "ship-queue",
      command: ["submit", repoDir, "feat/42-guard-test"],
      cwd: repoDir,
    });
    expect(honestSq).toBeDefined();

    // N1: create a benign blob and `git replace` the real blob with it
    const realBlob = git(repoDir, ["rev-parse", "HEAD:host-guards/exceptions.json"]);
    const benignBlob = git(repoDir, ["rev-parse", "main:host-guards/exceptions.json"]);
    git(repoDir, ["replace", realBlob, benignBlob]);
    const afterReplaceSq = inspectWorktreeBundle({
      guard: "ship-queue",
      command: ["submit", repoDir, "feat/42-guard-test"],
      cwd: repoDir,
    });
    expect(afterReplaceSq?.protected_diff_sha256).toBe(honestSq?.protected_diff_sha256);
    expect(afterReplaceSq?.diff_preview).toContain("real-change");

    // N2: configure a git clean filter that rewrites the working tree file to look benign
    git(repoDir, ["config", "filter.hide.clean", 'printf \'{"rules":["real-change"]}\\n\'']);
    NodeFS.mkdirSync(NodePath.join(repoDir, ".git", "info"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".git", "info", "attributes"),
      "host-guards/exceptions.json filter=hide\n",
    );
    const pbHonest = inspectWorktreeBundle({
      guard: "playbook",
      command: ["playbook", "check"],
      cwd: repoDir,
    });
    NodeFS.writeFileSync(
      NodePath.join(repoDir, "host-guards", "exceptions.json"),
      '{"rules":["EVIL-ON-DISK"]}\n',
    );
    const pbAfterEvil = inspectWorktreeBundle({
      guard: "playbook",
      command: ["playbook", "check"],
      cwd: repoDir,
    });
    expect(pbAfterEvil).toBeDefined();
    expect(pbAfterEvil?.protected_diff_sha256).not.toBe(pbHonest?.protected_diff_sha256);
    expect(pbAfterEvil?.diff_preview).toContain("EVIL-ON-DISK");

    // N3: hide an untracked .github/workflows/x.yml via .git/info/exclude
    NodeFS.writeFileSync(NodePath.join(repoDir, ".git", "info", "exclude"), ".github/\n");
    NodeFS.mkdirSync(NodePath.join(repoDir, ".github", "workflows"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".github", "workflows", "x.yml"),
      "name: hidden-workflow\n",
    );
    const pbWithExcluded = inspectWorktreeBundle({
      guard: "playbook",
      command: ["playbook", "check"],
      cwd: repoDir,
    });
    expect(pbWithExcluded?.protected_paths).toContain(".github/workflows/x.yml");
    expect(pbWithExcluded?.gates.map((g) => g.gate_id)).toContain("ci-workflow");
  });
});

describe("guard-protocol Unix socket client & CLI", () => {
  it("blocks production env spoofing (HOST_GUARDS_TEST, XDG_RUNTIME_DIR, T3CODE_HOME) and validates grant replies", async () => {
    const broker = await startMockBroker((req) => {
      if (req.op === "identify") return { ok: true, thread_id: "thread-abc" };
      if (req.op === "peek") return { ok: true };
      if (req.guard === "bad-no-id") return { ok: true };
      if (req.guard === "bad-approver") {
        return { ok: true, grant_id: "t3g_1", approved_by: "agent" };
      }
      if (req.guard === "bad-ctrl") {
        return { ok: true, grant_id: "t3g_\n1", approved_by: "human" };
      }
      return {
        ok: true,
        grant_id: "t3g_test_1",
        scope: req.bundle ? "bundle" : "once",
        reason: "approved in test",
        approved_by: "human",
        thread_id: "thread-abc",
      };
    });

    try {
      // HOST_GUARDS_TEST=1 alone MUST NOT unlock custom sockets without explicit allowTestOverride (H3)
      expect(
        resolveGuardSocketPath({
          HOST_GUARDS_TEST: "1",
          T3_GUARD_GRANT_SOCKET: broker.sockPath,
        }),
      ).toBeNull();

      // Spoofed XDG_RUNTIME_DIR + T3CODE_HOME pointing to a fake server-runtime.json must be ignored (H3)
      const spoofHome = makeTempDir("marscode-spoof-home-");
      NodeFS.chmodSync(spoofHome, 0o700);
      NodeFS.writeFileSync(
        NodePath.join(spoofHome, "server-runtime.json"),
        JSON.stringify({ pid: process.pid }),
        { mode: 0o600 },
      );
      const resolvedSpoof = resolveGuardSocketPath({
        XDG_RUNTIME_DIR: NodePath.dirname(broker.sockPath),
        T3CODE_HOME: spoofHome,
      });
      expect(resolvedSpoof).not.toBe(broker.sockPath);

      // With BOTH allowTestOverride=true AND HOST_GUARDS_TEST=1, test socket works
      const testEnv = { HOST_GUARDS_TEST: "1", T3_GUARD_GRANT_SOCKET: broker.sockPath };
      expect(resolveGuardSocketPath(testEnv, { allowTestOverride: true })).toBe(broker.sockPath);

      const id = await identifyGuardThread({ env: testEnv, allowTestOverride: true });
      expect(id).toEqual({ ok: true, threadId: "thread-abc" });

      const peeked = await peekGuardGrant({
        guard: "ship-queue",
        command: ["submit", "/tmp/wt", "feat/1"],
        cwd: NodeOS.tmpdir(),
        env: testEnv,
        allowTestOverride: true,
      });
      expect(peeked).toBe(true);

      const checked = await checkGuardGrant({
        guard: "ship-queue",
        command: ["submit", "/tmp/wt", "feat/1"],
        cwd: NodeOS.tmpdir(),
        env: testEnv,
        allowTestOverride: true,
      });
      expect(checked.ok).toBe(true);
      expect(checked.grantId).toBe("t3g_test_1");

      // Invalid grant replies must fail closed (H3)
      for (const badGuard of ["bad-no-id", "bad-approver", "bad-ctrl"]) {
        const bad = await checkGuardGrant({
          guard: badGuard,
          command: ["cmd"],
          cwd: NodeOS.tmpdir(),
          env: testEnv,
          allowTestOverride: true,
        });
        expect(bad.ok).toBe(false);
        expect(bad.errCode).toBe("protocol");
      }

      const requested = await requestGuardGrant({
        guard: "ship-queue",
        command: ["submit", "/tmp/wt", "feat/1"],
        cwd: NodeOS.tmpdir(),
        refusal: "protected file modified",
        proposedReason: "testing request",
        env: testEnv,
        allowTestOverride: true,
      });
      expect(requested.ok).toBe(true);
    } finally {
      await broker.close();
    }
  });

  it("verifies signed bundle grants offline via CLI `verify` and validates `--timeout`", async () => {
    const keyDir = makeTempDir("marscode-keys-");
    const kp = ensureGuardSigningKeyPair(keyDir);
    const pubKeyFile = NodePath.join(keyDir, "test-grant.pub");
    NodeFS.writeFileSync(pubKeyFile, kp.publicKeyPem, "utf8");
    const payload = {
      v: 1 as const,
      grantId: "t3g_verify_1",
      bundleKey: "bundle-key-test",
      threadId: "thread-1",
      repo: "acme-fixture/sample-repo",
      branch: "feat/42-guard-test",
      prOrIssue: "#42",
      guard: "ship-queue",
      gateIds: ["allowlist"],
      protectedPaths: ["host-guards/exceptions.json"],
      protectedDiffSha256: "a".repeat(64),
      bodySha256: "",
      approvedAt: "2026-06-01T00:00:00.000Z",
      expiresAt: "2099-06-08T00:00:00.000Z",
      approvedVia: "web-ui",
    };
    const sig = signBundleGrant(payload, kp.privateKeyPem);

    expect(
      await runGuardCli([
        "verify",
        "--pubkey",
        pubKeyFile,
        "--payload",
        JSON.stringify(payload),
        "--sig",
        sig,
      ]),
    ).toBe(0);

    expect(
      await runGuardCli([
        "verify",
        "--pubkey",
        pubKeyFile,
        "--payload",
        JSON.stringify({ ...payload, repo: "other/repo" }),
        "--sig",
        sig,
      ]),
    ).toBe(1);

    const expiredPayload = { ...payload, expiresAt: "2020-01-01T00:00:00.000Z" };
    const expiredSig = signBundleGrant(expiredPayload, kp.privateKeyPem);
    expect(
      await runGuardCli([
        "verify",
        "--pubkey",
        pubKeyFile,
        "--payload",
        JSON.stringify(expiredPayload),
        "--sig",
        expiredSig,
      ]),
    ).toBe(1);

    // Invalid --timeout must return exit 64 instead of silently defaulting
    expect(
      await runGuardCli(["override", "ship-queue", "refusal", "--timeout", "abc", "--", "submit"]),
    ).toBe(64);
  });

  it("installs when `node` on PATH is a link to a launcher that is node only under that name", () => {
    const root = makeTempDir("marscode-install-launcher-");
    const toolDir = NodePath.join(root, "tools");
    const binDir = NodePath.join(root, "bin");
    const libDir = NodePath.join(root, "lib");
    NodeFS.mkdirSync(toolDir, { recursive: true });
    // A multi-call launcher: it runs node when it is called `node`, and fails under its own name.
    const launcher = NodePath.join(toolDir, "launcher");
    NodeFS.writeFileSync(
      launcher,
      `#!/bin/sh\ncase "$(basename "$0")" in\n  node) exec '${process.execPath}' "$@" ;;\n  *) echo "error: Command '$1' not found" >&2; exit 2 ;;\nesac\n`,
      { mode: 0o755 },
    );
    NodeFS.symlinkSync(launcher, NodePath.join(toolDir, "node"));
    const installer = NodePath.join(PKG_DIR, "scripts", "install-guards.sh");
    const res = NodeChildProcess.spawnSync(
      "bash",
      [installer, "--bin-dir", binDir, "--lib-dir", libDir],
      { encoding: "utf8", env: { ...process.env, PATH: `${toolDir}:/usr/bin:/bin` } },
    );
    expect(res.status, res.stderr).toBe(0);
    // The installed wrapper runs the real node binary, not the launcher.
    const wrapper = NodeFS.readFileSync(NodePath.join(binDir, "marscode-guard"), "utf8");
    expect(wrapper).toContain(process.execPath);
    expect(wrapper).not.toContain(launcher);
    const help = NodeChildProcess.spawnSync(NodePath.join(binDir, "marscode-guard"), ["--help"], {
      encoding: "utf8",
    });
    expect(help.stdout + help.stderr).toContain("marscode-guard <override|");
  });

  it("installs safely, scrubs NODE_OPTIONS, and interoperates end-to-end with Python bridge", async () => {
    const installRoot = makeTempDir("marscode-install-");
    const binDir = NodePath.join(installRoot, "bin");
    const libDir = NodePath.join(installRoot, "lib");
    const installer = NodePath.join(PKG_DIR, "scripts", "install-guards.sh");

    // Missing --bin-dir arg must fail cleanly with exit 64
    const badArgRes = NodeChildProcess.spawnSync("bash", [installer, "--bin-dir"], {
      encoding: "utf8",
    });
    expect(badArgRes.status).toBe(64);

    // Default install does NOT clobber legacy hg_t3_grant.py (M5)
    const defaultInstall = NodeChildProcess.spawnSync(
      "bash",
      [installer, "--bin-dir", binDir, "--lib-dir", libDir],
      { encoding: "utf8" },
    );
    expect(defaultInstall.status, defaultInstall.stderr).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(binDir, "marscode-guard"))).toBe(true);
    expect(
      NodeFS.existsSync(NodePath.join(libDir, "marscode-guard", "hg_t3_grant_bridge.py")),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(libDir, "hg_t3_grant.py"))).toBe(false);

    // Explicit --install-legacy-bridge installs hg_t3_grant.py
    const legacyInstall = NodeChildProcess.spawnSync(
      "bash",
      [installer, "--bin-dir", binDir, "--lib-dir", libDir, "--install-legacy-bridge"],
      { encoding: "utf8" },
    );
    expect(legacyInstall.status, legacyInstall.stderr).toBe(0);
    const cliBin = NodePath.join(binDir, "marscode-guard");
    expect(NodeFS.existsSync(NodePath.join(libDir, "hg_t3_grant.py"))).toBe(true);

    // NODE_OPTIONS injection MUST be scrubbed by the installed wrapper (H2)
    const nodeOptRes = await spawnAsync(cliBin, ["--help"], {
      ...process.env,
      NODE_OPTIONS: "--import=data:text/javascript,process.exit(99)",
    });
    expect(nodeOptRes.status, nodeOptRes.stderr).toBe(0);

    const repoDir = makeTempGitRepo();
    NodeFS.writeFileSync(
      NodePath.join(repoDir, "host-guards", "exceptions.json"),
      '{"rules":["bridge-test"]}\n',
    );
    git(repoDir, ["add", "host-guards/exceptions.json"]);
    git(repoDir, ["commit", "-m", "bridge exception"]);

    const broker = await startMockBroker((req) => ({
      ok: true,
      grant_id: "t3g_py_bridge",
      scope: req.bundle ? "bundle" : "once",
      reason: "bridge ok",
      approved_by: "human",
      thread_id: "thread-py",
    }));

    try {
      const pyScript = `
import json, os, sys
sys.path.insert(0, sys.argv[1])
import hg_t3_grant

repo_dir, tmp_dir = sys.argv[2], sys.argv[3]

# 1. owner-check MUST ALWAYS hit the broker (no temp-install bypass, H1)
g_oc, err_oc = hg_t3_grant.check_with_err(
    "owner-check",
    ["bash", os.path.join(tmp_dir, "playbook", "install.sh"), os.path.join(tmp_dir, "bin"), os.path.join(tmp_dir, "lib")],
    tmp_dir,
)

# 2. ship-queue submit attaches check-first bundle even with NODE_OPTIONS poisoned (H2)
g_sq, err_sq = hg_t3_grant.check_with_err(
    "ship-queue",
    ["submit", repo_dir, "feat/42-guard-test"],
    tmp_dir,
)

print(json.dumps({"oc": g_oc, "sq": g_sq, "errs": [err_oc, err_sq]}))
`;
      const pyRes = await spawnAsync("python3", ["-c", pyScript, libDir, repoDir, installRoot], {
        ...process.env,
        HOST_GUARDS_TEST: "1",
        T3_GUARD_GRANT_SOCKET: broker.sockPath,
        MARSCODE_GUARD_BIN: cliBin,
        NODE_OPTIONS: "--import=data:text/javascript,process.exit(99)",
      });
      expect(pyRes.status, pyRes.stderr).toBe(0);
      const out = JSON.parse(pyRes.stdout) as {
        oc: { grant_id: string } | null;
        sq: { grant_id: string; scope?: string } | null;
        errs: string[];
      };
      expect(out.errs).toEqual(["", ""]);
      expect(out.oc?.grant_id).toBe("t3g_py_bridge");
      expect(out.sq?.grant_id).toBe("t3g_py_bridge");
      expect(out.sq?.scope).toBe("bundle");

      // Both owner-check AND ship-queue must hit the broker
      expect(broker.received).toHaveLength(2);
      expect(broker.received[0]?.guard).toBe("owner-check");
      expect(broker.received[1]?.guard).toBe("ship-queue");
      const sentBundle = broker.received[1]?.bundle as {
        repo?: string;
        protected_paths?: string[];
        protected_diff_sha256?: string;
      };
      expect(sentBundle?.repo).toBe("acme-fixture/sample-repo");
      expect(sentBundle?.protected_paths).toEqual(["host-guards/exceptions.json"]);
      expect(sentBundle?.protected_diff_sha256).toMatch(/^[0-9a-f]{64}$/);
    } finally {
      await broker.close();
    }
  });
});
