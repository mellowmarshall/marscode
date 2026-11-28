// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for installGuard, treeGuard, portsGuard, releaseGuard, cloudCliGuard, shellScan, hook, shimDepth, and git-shim.sh.
import * as NodeChildProcess from "node:child_process";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeURL from "node:url";
import { afterAll, afterEach, describe, expect, it } from "vite-plus/test";

import { runHostGuardCli } from "./cli.ts";
import { decideCloudCli } from "./cloudCliGuard.ts";
import { checkHookCommandLine, REFUSED_EXIT_CODE, runPreToolUseHook } from "./hook.ts";
import { loadHostConfig, type HostGuardsConfig } from "./hostConfig.ts";
import { decideInstallShellCommand, extractPackageScript } from "./installGuard.ts";
import { computePortsEnvUpdate, decidePortsCheck, runPortsSessionHook } from "./portsGuard.ts";
import type { ProcFsReader } from "./procFs.ts";
import { decideReleaseGuard } from "./releaseGuard.ts";
import { simpleCommands, splitShellSegments } from "./shellScan.ts";
import { checkShimDepth } from "./shimDepth.ts";
import { decideTreeGuard } from "./treeGuard.ts";

const PKG_ROOT = NodePath.resolve(NodePath.dirname(NodeURL.fileURLToPath(import.meta.url)), "..");

// install.sh copies the CLI bundle. Build it once into a temp dir, so a test run on a fresh
// checkout neither needs a prior build nor writes dist/ into the checkout.
let guardBundle: string | undefined;
function buildGuardBundle(): string {
  if (guardBundle) return guardBundle;
  const outDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-bundle-"));
  const vp = NodePath.join(PKG_ROOT, "..", "..", "node_modules", ".bin", "vp");
  const res = NodeChildProcess.spawnSync(vp, ["pack", "--out-dir", outDir], {
    cwd: PKG_ROOT,
    encoding: "utf8",
  });
  if (res.status !== 0) throw new Error(`vp pack failed: ${res.stderr}${res.stdout}`);
  guardBundle = NodePath.join(outDir, "bin.mjs");
  return guardBundle;
}
afterAll(() => {
  if (guardBundle) NodeFS.rmSync(NodePath.dirname(guardBundle), { recursive: true, force: true });
});

function runGit(cwd: string, args: ReadonlyArray<string>): string {
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
  return (res.stdout ?? "").trim();
}

function makeFullFixture(root: string): {
  readonly config: HostGuardsConfig;
  readonly configPath: string;
  readonly primaryDir: string;
  readonly worktreeDir: string;
  readonly bareOrigin: string;
} {
  const sourceRoot = NodePath.join(root, "src");
  const dataRoot = NodePath.join(root, "data");
  const stateDir = NodePath.join(root, "state");
  const bareOrigin = NodePath.join(root, "origin.git");
  const primaryDir = NodePath.join(sourceRoot, "demo-app");
  const worktreeDir = NodePath.join(dataRoot, "demo-app", "feat-1");

  NodeFS.mkdirSync(sourceRoot, { recursive: true });
  NodeFS.mkdirSync(NodePath.join(dataRoot, "demo-app"), { recursive: true });
  NodeFS.mkdirSync(bareOrigin, { recursive: true });
  NodeFS.mkdirSync(primaryDir, { recursive: true });

  runGit(bareOrigin, ["init", "--bare", "-b", "main"]);
  runGit(primaryDir, ["init", "-b", "main"]);
  runGit(primaryDir, ["remote", "add", "origin", bareOrigin]);

  NodeFS.mkdirSync(NodePath.join(primaryDir, "scripts", "drills"), { recursive: true });
  NodeFS.mkdirSync(NodePath.join(primaryDir, "apps", "api"), { recursive: true });
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "scripts", "drills", "run.sh"),
    "#!/bin/bash\nexit 0\n",
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "scripts", "release-store.sh"),
    "#!/bin/bash\nexit 0\n",
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "scripts", "release-ota.mjs"),
    "console.log('ota');\n",
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "scripts", "deploy-api.sh"),
    "#!/bin/bash\nexit 0\n",
    { mode: 0o755 },
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "apps", "api", "fly.toml"),
    'app = "example-api"\n',
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "playbook.json"),
    JSON.stringify({ contracts: { fleet: { file: "fleet-shape.json" } } }),
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, "fleet-shape.json"),
    JSON.stringify({
      apps: {
        mobile: {
          mobile: {
            release: {
              store: "scripts/release-store.sh",
              ota: ["scripts/release-ota.mjs"],
            },
          },
        },
        api: {
          fly: { app: "example-api", config: "apps/api/fly.toml" },
          deploy: { drill: "scripts/deploy-api.sh" },
          doppler: { project: "example-api" },
        },
      },
    }),
  );
  NodeFS.writeFileSync(
    NodePath.join(primaryDir, ".tree-guard.conf"),
    "ship_repo=example-org/demo-app\nshared_db_run=ci-local.sh\n",
  );
  NodeFS.writeFileSync(NodePath.join(primaryDir, "ci-local.sh"), "#!/bin/bash\nexit 0\n", {
    mode: 0o755,
  });

  runGit(primaryDir, ["add", "."]);
  runGit(primaryDir, ["commit", "-m", "initial commit"]);
  runGit(primaryDir, ["push", "-u", "origin", "main"]);
  runGit(primaryDir, ["remote", "set-head", "origin", "main"]);
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

  const configPath = NodePath.join(root, "host-guards.json");
  NodeFS.writeFileSync(
    configPath,
    JSON.stringify({
      orgs: ["example-org"],
      sourceRoot,
      dataRoot,
      stateDir,
      queueRoot: NodePath.join(dataRoot, ".ship-queue"),
      realGit: "/usr/bin/git",
      realGh: "/usr/bin/gh",
      cloudCliPolicy: {
        blockDirectFlyDeploy: true,
        blockDirectFlySecrets: true,
        blockDirectDopplerWrites: true,
        protectedDopplerProjects: ["example-api"],
      },
    }),
  );
  const config = loadHostConfig({ configPath });
  return { config, configPath, primaryDir, worktreeDir, bareOrigin };
}

function makeDrillProcFs(options: {
  readonly exe: string;
  readonly argv: ReadonlyArray<string>;
  readonly cwd: string;
  readonly env?: Readonly<Record<string, string>>;
  readonly statOverrides?: Readonly<
    Record<
      string,
      {
        readonly dev: number;
        readonly ino: number;
        readonly uid: number;
        readonly mode: number;
        readonly isFile: boolean;
      } | null
    >
  >;
  readonly realpathOverrides?: Readonly<Record<string, string>>;
}): ProcFsReader {
  const defaultSystemFiles = new Set([
    "/usr/bin/bash",
    "/bin/bash",
    "/usr/local/bin/bash",
    "/usr/bin/sh",
    "/bin/sh",
    "/usr/bin/dash",
    "/bin/dash",
    "/usr/bin/node",
    "/bin/node",
    "/usr/local/bin/node",
  ]);
  const defaultSystemDirs = new Set([
    "/usr/local/sbin",
    "/usr/local/bin",
    "/usr/sbin",
    "/usr/bin",
    "/sbin",
    "/bin",
  ]);
  return {
    hasProc: () => true,
    selfPid: () => 500,
    currentUid: () => 1000,
    readText: (filePath) => {
      if (filePath === "/proc/500/stat" || filePath === "/proc/self/stat") {
        return "500 (node) S 400 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 111";
      }
      if (filePath === "/proc/400/stat") {
        return "400 (drill) S 1 1 1 0 0 0 0 0 0 0 0 0 0 0 0 0 0 0 100";
      }
      if (filePath === "/proc/400/cmdline") {
        return `${options.argv.join("\0")}\0`;
      }
      if (filePath === "/proc/400/environ") {
        const kv = Object.entries(options.env ?? {}).map(([k, v]) => `${k}=${v}`);
        return kv.length > 0 ? `${kv.join("\0")}\0` : "";
      }
      return null;
    },
    readLink: (linkPath) => {
      if (linkPath === "/proc/400/exe") return options.exe;
      if (linkPath === "/proc/400/cwd") return options.cwd;
      return null;
    },
    readDir: () => [],
    stat: (target) => {
      if (options.statOverrides && Object.hasOwn(options.statOverrides, target)) {
        return options.statOverrides[target] ?? null;
      }
      if (defaultSystemFiles.has(target)) {
        return { dev: 1, ino: 10, uid: 0, mode: 0o100755, isFile: true };
      }
      if (defaultSystemDirs.has(target)) {
        return { dev: 1, ino: 20, uid: 0, mode: 0o040755, isFile: false };
      }
      return null;
    },
    lstat: () => null,
    realpath: (p) => options.realpathOverrides?.[p] ?? p,
    canonicalHome: () => "/home/testuser",
  };
}

describe("installGuard, treeGuard, portsGuard, releaseGuard, cloudCliGuard, shellScan, hook, shimDepth, and shims", () => {
  const tempDirs: string[] = [];

  afterEach(() => {
    for (const dir of tempDirs.splice(0)) {
      NodeFS.rmSync(dir, { recursive: true, force: true });
    }
  });

  it("enforces installGuard rules under sourceRoot while allowing dataRoot and global installs", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-install-"));
    tempDirs.push(root);
    const { config, primaryDir, worktreeDir } = makeFullFixture(root);

    expect(decideInstallShellCommand("pnpm install", primaryDir, config).verdict).toBe("deny");
    expect(decideInstallShellCommand("npm ci", primaryDir, config).verdict).toBe("deny");
    expect(decideInstallShellCommand("yarn", primaryDir, config).verdict).toBe("deny");
    expect(decideInstallShellCommand("bun add zod", primaryDir, config).verdict).toBe("deny");
    expect(decideInstallShellCommand("vp install", primaryDir, config).verdict).toBe("deny");
    expect(decideInstallShellCommand("pip install requests", primaryDir, config).verdict).toBe(
      "deny",
    );
    expect(decideInstallShellCommand("python3 -m venv .venv", primaryDir, config).verdict).toBe(
      "deny",
    );
    expect(
      decideInstallShellCommand(`git worktree add ${primaryDir}-wt -b feat-x`, primaryDir, config)
        .verdict,
    ).toBe("deny");

    // Global installs and dataRoot installs are allowed
    expect(decideInstallShellCommand("npm install -g typescript", primaryDir, config).verdict).toBe(
      "allow",
    );
    expect(decideInstallShellCommand("pip3 install --user ruff", primaryDir, config).verdict).toBe(
      "allow",
    );
    expect(decideInstallShellCommand("pnpm install", worktreeDir, config).verdict).toBe("allow");
    expect(
      decideInstallShellCommand(`git worktree add ${worktreeDir}-2 -b feat-2`, primaryDir, config)
        .verdict,
    ).toBe("allow");

    expect(extractPackageScript("pnpm", ["test:unit"], worktreeDir).script).toBe("test:unit");
    expect(extractPackageScript("npm", ["run", "verify"], worktreeDir).script).toBe("verify");
  });

  it("enforces treeGuard freshness, dirty gate refusal, dirty unit test pass, and loadavg limit", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-tree-"));
    tempDirs.push(root);
    const { config, primaryDir, worktreeDir } = makeFullFixture(root);

    // Primary checkout under sourceRoot is refused
    expect(decideTreeGuard({ kind: "gate", cwd: primaryDir }, config).verdict).toBe("deny");

    // Clean rebased worktree passes gate
    expect(decideTreeGuard({ kind: "gate", cwd: worktreeDir }, config).verdict).toBe("allow");

    // Dirty worktree refuses gate but allows unit test
    NodeFS.writeFileSync(NodePath.join(worktreeDir, "dirty.txt"), "wip\n");
    expect(decideTreeGuard({ kind: "gate", cwd: worktreeDir }, config).verdict).toBe("deny");
    expect(decideTreeGuard({ kind: "test", cwd: worktreeDir }, config).verdict).toBe("allow");
    NodeFS.unlinkSync(NodePath.join(worktreeDir, "dirty.txt"));

    // High loadavg blocks shared_db_run gate (via programmatic loadavgPath DI)
    const highLoadFile = NodePath.join(root, "loadavg");
    NodeFS.writeFileSync(highLoadFile, "12.50 10.00 8.00 2/100 999\n");
    expect(
      decideTreeGuard(
        { kind: "auto", args: ["./ci-local.sh"], cwd: worktreeDir, loadavgPath: highLoadFile },
        config,
        {},
      ).verdict,
    ).toBe("deny");

    // Advance origin/main so worktree is stale -> refused
    NodeFS.writeFileSync(NodePath.join(primaryDir, "upstream.txt"), "new\n");
    runGit(primaryDir, ["add", "upstream.txt"]);
    runGit(primaryDir, ["commit", "-m", "upstream advance"]);
    runGit(primaryDir, ["push", "origin", "main"]);
    runGit(worktreeDir, ["fetch", "origin"]);
    expect(decideTreeGuard({ kind: "test", cwd: worktreeDir }, config).verdict).toBe("deny");

    // Non-interpreter ancestor (`find scripts/drills/run.sh -exec vitest`) must NOT bypass treeGuard!
    const findBypassProc = makeDrillProcFs({
      exe: "/usr/bin/find",
      argv: ["find", "scripts/drills/run.sh", "-exec", "vitest"],
      cwd: worktreeDir,
    });
    expect(
      decideTreeGuard({ kind: "test", cwd: worktreeDir }, config, {}, findBypassProc).verdict,
    ).toBe("deny");

    // Verified bash ancestor running committed scripts/drills/run.sh with clean env passes
    const validDrillProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/drills/run.sh"],
      cwd: worktreeDir,
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(
      decideTreeGuard({ kind: "test", cwd: worktreeDir }, config, {}, validDrillProc).verdict,
    ).toBe("allow");
  });

  it("enforces portsGuard ledger, docker/server bind checks, and SessionStart hook output", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-ports-"));
    tempDirs.push(root);
    const checkout = NodePath.join(root, "wt-a");
    NodeFS.mkdirSync(checkout, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(checkout, ".env.ports"),
      "# demo-checkout\nWEB_PORT=4101\nAPI_PORT=4102\n",
    );

    const envUpdate = computePortsEnvUpdate(checkout, {
      HG_PORTS_DIR: "/other/wt",
      HG_PORTS_NAMES: "OLD_PORT CUSTOM_PORT",
      HG_PORTS_VALUES: "OLD_PORT=4999 CUSTOM_PORT=4998",
      OLD_PORT: "4999",
      CUSTOM_PORT: "7777",
    });
    expect(envUpdate.set.WEB_PORT).toBe("4101");
    expect(envUpdate.set.API_PORT).toBe("4102");
    expect(envUpdate.unset).toContain("OLD_PORT");
    // Caller-modified CUSTOM_PORT is preserved
    expect(envUpdate.unset).not.toContain("CUSTOM_PORT");

    expect(decidePortsCheck(["docker", "run", "-p", "4101:80", "nginx"], checkout).verdict).toBe(
      "allow",
    );
    expect(decidePortsCheck(["docker", "run", "-p", "4555:80", "nginx"], checkout).verdict).toBe(
      "deny",
    );

    const envFile = NodePath.join(root, "claude.env");
    const sess = runPortsSessionHook({
      agent: "claude",
      stdinText: JSON.stringify({ cwd: checkout }),
      cwd: root,
      env: { CLAUDE_ENV_FILE: envFile },
    });
    expect(sess.exitCode).toBe(0);
    expect(sess.stdout).toContain("ports (demo-checkout): WEB_PORT=4101 API_PORT=4102");
    expect(NodeFS.readFileSync(envFile, "utf8")).toContain("export WEB_PORT=4101");
  });

  it("enforces releaseGuard and cloudCliGuard with verified default-branch drills and preload rejection", () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-rel-"));
    tempDirs.push(root);
    const { config, worktreeDir } = makeFullFixture(root);

    // EAS reads pass; writes denied outside drill
    expect(decideReleaseGuard(["build:list"], worktreeDir, config).verdict).toBe("allow");
    expect(decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config).verdict).toBe(
      "deny",
    );
    expect(decideReleaseGuard(["update", "--branch", "preview"], worktreeDir, config).verdict).toBe(
      "deny",
    );

    // Verified store drill ancestor allows `eas build`
    const validStoreProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/release-store.sh"],
      cwd: worktreeDir,
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, validStoreProc)
        .verdict,
    ).toBe("allow");
    // Preload env BASH_ENV, LD_PRELOAD, or unsafe /tmp in PATH invalidates drill
    const preloadStoreProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/release-store.sh"],
      cwd: worktreeDir,
      env: { BASH_ENV: "/tmp/evil.sh" },
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, preloadStoreProc)
        .verdict,
    ).toBe("deny");

    const ldPreloadProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/release-store.sh"],
      cwd: worktreeDir,
      env: { LD_PRELOAD: "/tmp/evil.so" },
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, ldPreloadProc)
        .verdict,
    ).toBe("deny");

    const tmpPathProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/release-store.sh"],
      cwd: worktreeDir,
      env: { PATH: "/tmp/evil:/usr/bin:/bin" },
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, tmpPathProc).verdict,
    ).toBe("deny");

    // Untrusted absolute PATH directory (e.g. writable agent dir) invalidates drill; trusted system PATH passes
    const writablePathProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/release-store.sh"],
      cwd: worktreeDir,
      env: { PATH: `${worktreeDir}:/usr/bin:/bin` },
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, writablePathProc)
        .verdict,
    ).toBe("deny");

    const cleanSystemPathProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/release-store.sh"],
      cwd: worktreeDir,
      env: { PATH: "/usr/local/bin:/usr/bin:/bin" },
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, cleanSystemPathProc)
        .verdict,
    ).toBe("allow");

    // Spoofed interpreter binary path (e.g. python3 copied to /data/x/node), deleted exe, or non-root/writable exe are rejected
    const spoofedNodeProc = makeDrillProcFs({
      exe: NodePath.join(worktreeDir, "node"),
      argv: ["node", "scripts/release-ota.mjs"],
      cwd: worktreeDir,
      statOverrides: {
        [NodePath.join(worktreeDir, "node")]: {
          dev: 1,
          ino: 99,
          uid: 1000,
          mode: 0o100755,
          isFile: true,
        },
      },
    });
    expect(
      decideReleaseGuard(["update", "--branch", "preview"], worktreeDir, config, spoofedNodeProc)
        .verdict,
    ).toBe("deny");

    const writableNodeProc = makeDrillProcFs({
      exe: "/usr/bin/node",
      argv: ["node", "scripts/release-ota.mjs"],
      cwd: worktreeDir,
      statOverrides: {
        "/usr/bin/node": { dev: 1, ino: 10, uid: 0, mode: 0o100777, isFile: true },
      },
    });
    expect(
      decideReleaseGuard(["update", "--branch", "preview"], worktreeDir, config, writableNodeProc)
        .verdict,
    ).toBe("deny");

    const deletedNodeProc = makeDrillProcFs({
      exe: "/usr/bin/node (deleted)",
      argv: ["node", "scripts/release-ota.mjs"],
      cwd: worktreeDir,
    });
    expect(
      decideReleaseGuard(["update", "--branch", "preview"], worktreeDir, config, deletedNodeProc)
        .verdict,
    ).toBe("deny");

    // Ubuntu /bin/sh -> /usr/bin/dash (root-owned, 0755) works for .sh drills
    const dashStoreProc = makeDrillProcFs({
      exe: "/usr/bin/dash",
      argv: ["sh", "scripts/release-store.sh"],
      cwd: worktreeDir,
    });
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, dashStoreProc)
        .verdict,
    ).toBe("allow");

    // Configured realNode in owner policy is accepted when non-group/world-writable
    const customNodePath = "/home/testuser/.nvm/versions/node/v24.0.0/bin/node";
    const configWithRealNode = { ...config, realNode: customNodePath };
    const configuredNodeProc = makeDrillProcFs({
      exe: customNodePath,
      argv: ["node", "scripts/release-ota.mjs"],
      cwd: worktreeDir,
      statOverrides: {
        [customNodePath]: { dev: 1, ino: 55, uid: 1000, mode: 0o100755, isFile: true },
      },
    });
    expect(
      decideReleaseGuard(
        ["update", "--branch", "preview"],
        worktreeDir,
        configWithRealNode,
        configuredNodeProc,
      ).verdict,
    ).toBe("allow");

    // Verified OTA drill ancestor allows `eas update` but NOT `eas build`
    const validOtaProc = makeDrillProcFs({
      exe: "/usr/bin/node",
      argv: ["node", "scripts/release-ota.mjs"],
      cwd: worktreeDir,
    });
    expect(
      decideReleaseGuard(["update", "--branch", "preview"], worktreeDir, config, validOtaProc)
        .verdict,
    ).toBe("allow");
    expect(
      decideReleaseGuard(["build", "--platform", "ios"], worktreeDir, config, validOtaProc).verdict,
    ).toBe("deny");

    // Cloud CLI guard (config + fleet-shape.json)
    expect(
      decideCloudCli(["fly", "status", "-a", "example-api"], worktreeDir, config).verdict,
    ).toBe("allow");
    expect(
      decideCloudCli(["fly", "deploy", "-a", "example-api"], worktreeDir, config).verdict,
    ).toBe("deny");
    expect(
      decideCloudCli(["fly", "deploy", "-c", "apps/api/fly.toml"], worktreeDir, config).verdict,
    ).toBe("deny");
    expect(
      decideCloudCli(
        ["doppler", "secrets", "set", "FOO=bar", "-p", "example-api"],
        worktreeDir,
        config,
      ).verdict,
    ).toBe("deny");

    const validDeployProc = makeDrillProcFs({
      exe: "/usr/bin/bash",
      argv: ["bash", "scripts/deploy-api.sh"],
      cwd: worktreeDir,
    });
    expect(
      decideCloudCli(["fly", "deploy", "-a", "example-api"], worktreeDir, config, validDeployProc)
        .verdict,
    ).toBe("allow");
  });

  it("handles shellScan, PreToolUse hook, shimDepth, and real git-shim.sh fast-path & guard routing", async () => {
    const root = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "hg-shim-"));
    tempDirs.push(root);
    const { config, configPath, worktreeDir } = makeFullFixture(root);

    // shellScan heredoc immunity & nested bash -c extraction
    const heredocCmd = "cat <<'EOF'\ngit commit --no-verify\nEOF\necho ok";
    const cmds = simpleCommands(heredocCmd);
    expect(cmds.some((c) => c[0] === "git")).toBe(false);
    expect(
      splitShellSegments("cd /tmp && (cd /var && pwd) && echo done").length,
    ).toBeGreaterThanOrEqual(4);

    // PreToolUse hook refuses nested secret/no-verify and ignores heredocs
    const runtime = {
      config,
      env: {},
      socketPath: "",
      testMode: true,
      writeErr: () => {},
    };
    expect(await checkHookCommandLine(heredocCmd, worktreeDir, runtime)).toBe(0);
    expect(
      await checkHookCommandLine('bash -c "git commit --no-verify -m x"', worktreeDir, runtime),
    ).toBe(REFUSED_EXIT_CODE);
    expect(
      await runPreToolUseHook(
        JSON.stringify({
          tool_name: "Bash",
          tool_input: { command: "curl -H 'Authorization: Bearer tok123' https://example.com" },
          cwd: worktreeDir,
        }),
        worktreeDir,
        runtime,
      ),
    ).toBe(REFUSED_EXIT_CODE);

    // shimDepth refuses at depth >= 2 with exit 126 and hops > 32
    const shimA = NodePath.join(root, "shim-a");
    NodeFS.writeFileSync(shimA, "#!/bin/sh\n");
    const first = checkShimDepth(shimA, "/usr/bin/git", {});
    expect(first.ok).toBe(true);
    const recursive = checkShimDepth(shimA, shimA, {
      HG_SHIM_DEPTH: "1",
      HG_SHIM_NEXT: shimA,
      HG_SHIM_CHAIN: shimA,
    });
    expect(recursive.ok).toBe(false);
    if (!recursive.ok) expect(recursive.exitCode).toBe(126);

    const tooManyHops = checkShimDepth(shimA, "/usr/bin/git", { HG_SHIM_HOPS: "32" });
    expect(tooManyHops.ok).toBe(false);

    // Real git-shim.sh fast-path vs guard routing test
    const markerFile = NodePath.join(root, "guard-was-called");
    const fakeGuardWrapper = NodePath.join(root, "fake-host-guard");
    NodeFS.writeFileSync(
      fakeGuardWrapper,
      `#!/bin/bash
printf '%s\\n' "$*" > '${markerFile}'
exit ${REFUSED_EXIT_CODE}
`,
      { mode: 0o755 },
    );
    const renderedGitShim = NodePath.join(root, "git");
    const shimTemplate = NodeFS.readFileSync(
      NodePath.join(PKG_ROOT, "shims", "git-shim.sh"),
      "utf8",
    )
      .replaceAll("@REAL_GIT@", "/usr/bin/git")
      .replaceAll("@HOST_GUARD@", fakeGuardWrapper)
      .replaceAll("@SHIM_DEPTH@", NodePath.join(PKG_ROOT, "shims", "shim-depth.sh"));
    NodeFS.writeFileSync(renderedGitShim, shimTemplate, { mode: 0o755 });

    // Fast-path `git status` must NOT invoke marscode-host-guard!
    const fastRes = NodeChildProcess.spawnSync(renderedGitShim, ["status", "--short"], {
      cwd: worktreeDir,
      encoding: "utf8",
      env: { PATH: "/usr/bin:/bin" },
    });
    expect(fastRes.status).toBe(0);
    expect(NodeFS.existsSync(markerFile)).toBe(false);

    // Mutating `git commit --no-verify` MUST invoke marscode-host-guard with `git-check -- ...` and refuse with exit 2!
    const guardedRes = NodeChildProcess.spawnSync(
      renderedGitShim,
      ["commit", "--no-verify", "-m", "skip"],
      {
        cwd: worktreeDir,
        encoding: "utf8",
        env: { PATH: "/usr/bin:/bin" },
      },
    );
    expect(guardedRes.status).toBe(REFUSED_EXIT_CODE);
    expect(NodeFS.existsSync(markerFile)).toBe(true);
    expect(NodeFS.readFileSync(markerFile, "utf8").trim()).toBe(
      "git-check -- commit --no-verify -m skip",
    );

    // In-process CLI git-check with programmatic configPath refuses the exact same command
    const cliGitCode = await runHostGuardCli(
      ["git-check", "--", "commit", "--no-verify", "-m", "skip"],
      {
        cwd: worktreeDir,
        env: {},
        configPath,
        socketPath: "",
        testMode: true,
        out: () => {},
        err: () => {},
      },
    );
    expect(cliGitCode).toBe(REFUSED_EXIT_CODE);

    // CLI self-check JSON output
    const outLines: string[] = [];
    const cliCode = await runHostGuardCli(["self-check", "--json"], {
      cwd: worktreeDir,
      env: {},
      configPath,
      socketPath: "",
      testMode: true,
      out: (line) => outLines.push(line),
      err: () => {},
    });
    expect(cliCode).toBe(0);
    const selfReport = JSON.parse(outLines.join("\n")) as { pythonRequired: boolean; ok: boolean };
    expect(selfReport.ok).toBe(true);
    expect(selfReport.pythonRequired).toBe(false);
  });

  it("keeps a real binary at a shim destination even when PATH chooses another one", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-keep-"));
    tempDirs.push(root);
    const fakeHome = NodePath.join(root, "home");
    const prefix = NodePath.join(fakeHome, ".local");
    const binGit = NodePath.join(prefix, "bin", "git");
    const realDir = NodePath.join(prefix, "lib", "marscode", "host-guards", "real");
    NodeFS.mkdirSync(NodePath.join(prefix, "bin"), { recursive: true });
    const install = (path: string) =>
      NodeChildProcess.spawnSync(
        "bash",
        [
          NodePath.join(PKG_ROOT, "scripts", "install.sh"),
          "--prefix",
          prefix,
          "--real-node",
          process.execPath,
        ],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: path,
            HOST_GUARDS_BUNDLE: buildGuardBundle(),
          },
          encoding: "utf8",
        },
      );
    // Run 1: the user's own git at the shim destination, first on PATH: it is kept as real/git,
    // and both the shim and the guard config record that copy.
    const ownGit = "#!/bin/sh\necho own-git\n";
    NodeFS.writeFileSync(binGit, ownGit, { mode: 0o755 });
    const first = install(`${prefix}/bin:/usr/bin:/bin`);
    expect(first.status, first.stderr).toBe(0);
    const keptGit = NodePath.join(realDir, "git");
    expect(NodeFS.readFileSync(keptGit, "utf8")).toBe(ownGit);
    expect(NodeFS.readFileSync(binGit, "utf8")).toContain(`REAL_GIT='${keptGit}'`);
    const config = NodePath.join(prefix, "lib", "marscode", "host-guards.json");
    expect((JSON.parse(NodeFS.readFileSync(config, "utf8")) as { realGit: string }).realGit).toBe(
      keptGit,
    );
    // Run 2: another binary replaced the shim, and /usr/bin/git comes first on PATH. The shim runs
    // /usr/bin/git, the recorded real/git is unchanged, and the other binary is kept beside it.
    const stray = "#!/bin/sh\necho stray\n";
    NodeFS.rmSync(binGit);
    NodeFS.writeFileSync(binGit, stray, { mode: 0o755 });
    const second = install(`/usr/bin:/bin:${prefix}/bin`);
    expect(second.status, second.stderr).toBe(0);
    expect(NodeFS.readFileSync(binGit, "utf8")).toContain("REAL_GIT='/usr/bin/git'");
    expect(NodeFS.readFileSync(keptGit, "utf8")).toBe(ownGit);
    const displaced = NodeFS.readdirSync(realDir).filter((f) => f.startsWith("git.displaced."));
    expect(displaced).toHaveLength(1);
    expect(NodeFS.readFileSync(NodePath.join(realDir, displaced[0]!), "utf8")).toBe(stray);
    // Run 3: another file replaced the shim again, and $BIN_DIR comes first on PATH. The kept
    // real/git still wins, so the shim and config keep running it; the new file is kept aside.
    const stray2 = "#!/bin/sh\necho stray-two\n";
    NodeFS.rmSync(binGit);
    NodeFS.writeFileSync(binGit, stray2, { mode: 0o755 });
    const third = install(`${prefix}/bin:/usr/bin:/bin`);
    expect(third.status, third.stderr).toBe(0);
    expect(NodeFS.readFileSync(keptGit, "utf8")).toBe(ownGit);
    expect(NodeFS.readFileSync(binGit, "utf8")).toContain(`REAL_GIT='${keptGit}'`);
    const kept = NodeFS.readdirSync(realDir)
      .filter((f) => f.startsWith("git.displaced."))
      .map((f) => NodeFS.readFileSync(NodePath.join(realDir, f), "utf8"));
    expect(kept).toContain(stray2);
    // A user's own wrapper that mentions host-guards is a real binary, not a shim: it is kept as
    // real/gh, and a reinstall's cleanup of stray shims in real/ leaves it in place.
    const wrapper =
      '#!/bin/bash -p\n# my gh wrapper; see host-guards docs\nexec /usr/bin/gh "$@"\n';
    const binGh = NodePath.join(prefix, "bin", "gh");
    NodeFS.writeFileSync(binGh, wrapper, { mode: 0o755 });
    expect(install(`${prefix}/bin:/usr/bin:/bin`).status).toBe(0);
    expect(install(`${prefix}/bin:/usr/bin:/bin`).status).toBe(0);
    expect(NodeFS.readFileSync(NodePath.join(realDir, "gh"), "utf8")).toBe(wrapper);
    expect(NodeFS.readFileSync(binGh, "utf8")).toContain(
      `REAL_GH='${NodePath.join(realDir, "gh")}'`,
    );
  });

  it("treats older devtools guards as shims, keeps displaced binaries apart, and never writes into a linked directory", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-legacy-"));
    tempDirs.push(root);
    const fakeHome = NodePath.join(root, "home");
    const prefix = NodePath.join(fakeHome, ".local");
    const bin = NodePath.join(prefix, "bin");
    const guards = NodePath.join(prefix, "guards");
    const lib = NodePath.join(prefix, "lib");
    const realDir = NodePath.join(lib, "marscode", "host-guards", "real");
    const realBin = NodePath.join(root, "realbin");
    const stub = NodePath.join(root, "stub");
    for (const dir of [bin, guards, realDir, realBin, stub])
      NodeFS.mkdirSync(dir, { recursive: true });
    for (const name of ["fly", "pnpm", "npm"]) {
      NodeFS.writeFileSync(NodePath.join(realBin, name), `#!/bin/sh\necho real-${name}\n`, {
        mode: 0o755,
      });
    }
    // The devtools install wrote these guards: a link to its Python install guard for each package
    // manager, and a marker wrapper for each cloud CLI.
    const pyGuard = NodePath.join(lib, "home-dev-install-guard.py");
    NodeFS.writeFileSync(pyGuard, "#!/usr/bin/python3 -IB\nprint('guard')\n", { mode: 0o755 });
    NodeFS.symlinkSync(pyGuard, NodePath.join(bin, "pnpm"));
    const cliGuard =
      "#!/usr/bin/env bash\n# managed by devtools/host-guards: the EXP config and deploy guard for every AI CLI\n" +
      `exec /usr/bin/python3 -IB ${lib}/exp-cli-guard.py "$0" "$@"\n`;
    NodeFS.writeFileSync(NodePath.join(guards, "fly"), cliGuard, { mode: 0o755 });
    // An earlier faulty run kept the same guards in real/: the cleanup drops them.
    NodeFS.writeFileSync(NodePath.join(realDir, "fly"), cliGuard, { mode: 0o755 });
    NodeFS.symlinkSync(pyGuard, NodePath.join(realDir, "pnpm"));
    // A link to a directory where the npm shim goes.
    const userDir = NodePath.join(root, "user-dir");
    NodeFS.mkdirSync(userDir);
    NodeFS.symlinkSync(userDir, NodePath.join(bin, "npm"));
    // Every install in this test happens in the same second.
    NodeFS.writeFileSync(NodePath.join(stub, "date"), "#!/bin/sh\necho 1700000000\n", {
      mode: 0o755,
    });
    const install = () =>
      NodeChildProcess.spawnSync(
        "bash",
        [
          NodePath.join(PKG_ROOT, "scripts", "install.sh"),
          "--prefix",
          prefix,
          "--real-node",
          process.execPath,
        ],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: `${stub}:${guards}:${bin}:${realBin}:/usr/bin:/bin`,
            HOST_GUARDS_BUNDLE: buildGuardBundle(),
          },
          encoding: "utf8",
        },
      );
    const first = install();
    expect(first.status, first.stderr).toBe(0);
    // The shims run the real binaries, never a devtools guard (which would loop back to the shim).
    expect(NodeFS.readFileSync(NodePath.join(guards, "fly"), "utf8")).toContain(
      `REAL='${realBin}/fly'`,
    );
    expect(NodeFS.readFileSync(NodePath.join(bin, "pnpm"), "utf8")).toContain(
      `REAL='${realBin}/pnpm'`,
    );
    expect(NodeFS.existsSync(NodePath.join(realDir, "fly"))).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(realDir, "pnpm"))).toBe(false);
    // The npm shim replaced the link (it was not written into the directory), which is kept aside.
    expect(NodeFS.lstatSync(NodePath.join(bin, "npm")).isSymbolicLink()).toBe(false);
    expect(NodeFS.readFileSync(NodePath.join(bin, "npm"), "utf8")).toContain(
      `REAL='${realBin}/npm'`,
    );
    expect(NodeFS.readdirSync(userDir)).toEqual([]);
    const keptNpm = NodeFS.readdirSync(realDir).filter((f) => f.startsWith("npm.displaced."));
    expect(keptNpm).toHaveLength(1);
    expect(NodeFS.readlinkSync(NodePath.join(realDir, keptNpm[0]!))).toBe(userDir);
    // Two binaries at the git shim's place, in installs within one second, are both kept: the
    // first one this run chose (real/git), the next two beside it (git.displaced.*), with the
    // same timestamp.
    const binGit = NodePath.join(bin, "git");
    for (const text of [
      "#!/bin/sh\necho stray-x\n",
      "#!/bin/sh\necho stray-y\n",
      "#!/bin/sh\necho stray-z\n",
    ]) {
      NodeFS.rmSync(binGit, { force: true });
      NodeFS.writeFileSync(binGit, text, { mode: 0o755 });
      const res = install();
      expect(res.status, res.stderr).toBe(0);
    }
    const keptGit = NodeFS.readdirSync(realDir)
      .filter((f) => f === "git" || f.startsWith("git."))
      .map((f) => NodeFS.readFileSync(NodePath.join(realDir, f), "utf8"));
    expect(keptGit).toEqual(
      expect.arrayContaining([
        "#!/bin/sh\necho stray-x\n",
        "#!/bin/sh\necho stray-y\n",
        "#!/bin/sh\necho stray-z\n",
      ]),
    );
  });

  it("keeps a tool alias working when it links one shim destination to another (fly -> flyctl)", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-alias-"));
    tempDirs.push(root);
    const fakeHome = NodePath.join(root, "home");
    const prefix = NodePath.join(fakeHome, ".local");
    const guards = NodePath.join(prefix, "guards");
    NodeFS.mkdirSync(guards, { recursive: true });
    // flyctl's own install: a real flyctl and fly as a relative link to it, both in guards/.
    NodeFS.writeFileSync(
      NodePath.join(guards, "flyctl"),
      '#!/bin/sh\necho "flyctl ran as ${0##*/} $*"\n',
      {
        mode: 0o755,
      },
    );
    NodeFS.symlinkSync("flyctl", NodePath.join(guards, "fly"));
    const env = {
      ...process.env,
      HOME: fakeHome,
      PATH: `${guards}:${prefix}/bin:/usr/local/bin:/usr/bin:/bin`,
      HOST_GUARDS_BUNDLE: buildGuardBundle(),
    };
    const install = () =>
      NodeChildProcess.spawnSync(
        "bash",
        [
          NodePath.join(PKG_ROOT, "scripts", "install.sh"),
          "--prefix",
          prefix,
          "--org",
          "example-org",
          "--real-node",
          process.execPath,
        ],
        { env, encoding: "utf8" },
      );
    const runBoth = () =>
      ["fly", "flyctl"].map((name) =>
        NodeChildProcess.spawnSync(NodePath.join(guards, name), ["version"], {
          env,
          encoding: "utf8",
        }),
      );
    for (const pass of [1, 2]) {
      const res = install();
      expect(res.status, `install ${pass}: ${res.stderr}`).toBe(0);
      const [fly, flyctl] = runBoth();
      expect(fly!.status, `fly after install ${pass}: ${fly!.stderr}`).toBe(0);
      expect(fly!.stdout).toContain("flyctl ran as fly version");
      expect(flyctl!.status, `flyctl after install ${pass}: ${flyctl!.stderr}`).toBe(0);
      expect(flyctl!.stdout).toContain("flyctl ran as flyctl version");
    }
    // fly's kept binary is flyctl's bytes, not a link back into guards/ (where a shim now is).
    const keptFly = NodePath.join(prefix, "lib", "marscode", "host-guards", "real", "fly");
    expect(NodeFS.lstatSync(keptFly).isSymbolicLink()).toBe(false);
  });

  it("keeps git working when the first git on PATH is an outside link to the binary at its shim destination", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-extlink-"));
    tempDirs.push(root);
    const fakeHome = NodePath.join(root, "home");
    const prefix = NodePath.join(fakeHome, ".local");
    const binGit = NodePath.join(prefix, "bin", "git");
    const outside = NodePath.join(root, "outside-bin");
    NodeFS.mkdirSync(NodePath.join(prefix, "bin"), { recursive: true });
    NodeFS.mkdirSync(outside, { recursive: true });
    // The real git lives at the shim destination, and an outside directory first on PATH links to it.
    NodeFS.writeFileSync(binGit, '#!/bin/sh\necho "own git $*"\n', { mode: 0o755 });
    NodeFS.symlinkSync(binGit, NodePath.join(outside, "git"));
    const env = {
      ...process.env,
      HOME: fakeHome,
      PATH: `${outside}:${prefix}/bin:/usr/bin:/bin`,
      HOST_GUARDS_BUNDLE: buildGuardBundle(),
    };
    for (const pass of [1, 2]) {
      const res = NodeChildProcess.spawnSync(
        "bash",
        [
          NodePath.join(PKG_ROOT, "scripts", "install.sh"),
          "--prefix",
          prefix,
          "--org",
          "example-org",
          "--real-node",
          process.execPath,
        ],
        { env, encoding: "utf8" },
      );
      expect(res.status, `install ${pass}: ${res.stderr}`).toBe(0);
      // Through the shim and through the outside link, git still reaches the real binary.
      for (const git of [binGit, NodePath.join(outside, "git")]) {
        const run = NodeChildProcess.spawnSync(git, ["--version"], { env, encoding: "utf8" });
        expect(run.status, `${git} after install ${pass}: ${run.stderr}`).toBe(0);
        expect(run.stdout).toContain("own git --version");
      }
    }
    const config = JSON.parse(
      NodeFS.readFileSync(NodePath.join(prefix, "lib", "marscode", "host-guards.json"), "utf8"),
    ) as { realGit: string };
    expect(config.realGit).toBe(
      NodePath.join(prefix, "lib", "marscode", "host-guards", "real", "git"),
    );
  });

  it("refuses an install whose existing guard config names other roots than the host's", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-roots-"));
    tempDirs.push(root);
    const fakeHome = NodePath.join(root, "home");
    const prefix = NodePath.join(fakeHome, ".local");
    const dataRoot = NodePath.join(root, "srv-ci");
    NodeFS.mkdirSync(dataRoot, { recursive: true });
    NodeFS.mkdirSync(NodePath.join(fakeHome, "Dev"), { recursive: true });
    // The data root is reached through a home link, as on hosts whose data moved out of /home.
    NodeFS.symlinkSync(dataRoot, NodePath.join(fakeHome, "Dev-data"));
    const install = (args: ReadonlyArray<string>) =>
      NodeChildProcess.spawnSync(
        "bash",
        [
          NodePath.join(PKG_ROOT, "scripts", "install.sh"),
          "--prefix",
          prefix,
          "--real-node",
          process.execPath,
          ...args,
        ],
        {
          env: {
            ...process.env,
            HOME: fakeHome,
            PATH: "/usr/local/bin:/usr/bin:/bin",
            HOST_GUARDS_BUNDLE: buildGuardBundle(),
          },
          encoding: "utf8",
        },
      );
    const first = install([
      "--org",
      "example-org",
      "--source-root",
      "~/Dev",
      "--data-root",
      "~/Dev-data",
    ]);
    expect(first.status, first.stderr).toBe(0);
    // The same roots, spelled as the provision gives them (the link resolved), pass.
    const same = install([
      "--source-root",
      NodePath.join(fakeHome, "Dev"),
      "--data-root",
      dataRoot,
    ]);
    expect(same.status, same.stderr).toBe(0);
    // Another data root fails, names the file and key to fix, and leaves the config unchanged.
    const config = NodePath.join(prefix, "lib", "marscode", "host-guards.json");
    const before = NodeFS.readFileSync(config, "utf8");
    const other = install([
      "--source-root",
      NodePath.join(fakeHome, "Dev"),
      "--data-root",
      "/data/Dev",
    ]);
    expect(other.status).toBe(1);
    expect(other.stderr).toContain(
      `dataRoot in ${config} is ~/Dev-data, but this host's root is /data/Dev`,
    );
    expect(NodeFS.readFileSync(config, "utf8")).toBe(before);
  });

  it("installs atomically via install.sh, migrates legacy hooks, never overwrites existing config, and passes self-probes", () => {
    const tmpRoot = NodeFS.existsSync("/tmp") ? "/tmp" : NodeOS.tmpdir();
    const root = NodeFS.mkdtempSync(NodePath.join(tmpRoot, "hg-inst-"));
    tempDirs.push(root);
    const fakeHome = NodePath.join(root, "home");
    const prefix = NodePath.join(fakeHome, ".local");
    NodeFS.mkdirSync(NodePath.join(fakeHome, ".claude"), { recursive: true });
    // Seed a legacy Python hook alongside a custom user hook
    const claudeSettings = NodePath.join(fakeHome, ".claude", "settings.json");
    NodeFS.writeFileSync(
      claudeSettings,
      JSON.stringify({
        hooks: {
          PreToolUse: [
            {
              matcher: "Bash",
              hooks: [
                {
                  type: "command",
                  command: "/usr/bin/python3 -IB /old/host_guard.py hook",
                  timeout: 60,
                },
                { type: "command", command: "/usr/local/bin/my-custom-hook", timeout: 10 },
              ],
            },
          ],
        },
      }),
    );

    const installScript = NodePath.join(PKG_ROOT, "scripts", "install.sh");
    const env = {
      ...process.env,
      HOME: fakeHome,
      PATH: `/usr/local/bin:/usr/bin:/bin`,
      HOST_GUARDS_BUNDLE: buildGuardBundle(),
    };

    // 1. Dry-run creates nothing
    const dryRes = NodeChildProcess.spawnSync(
      "bash",
      [
        installScript,
        "--dry-run",
        "--prefix",
        prefix,
        "--real-node",
        process.execPath,
        "--real-git",
        "/usr/bin/git",
      ],
      { env, encoding: "utf8" },
    );
    expect(dryRes.status).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(prefix, "bin", "marscode-host-guard"))).toBe(false);

    // 2. Real install into temp prefix
    const realRes = NodeChildProcess.spawnSync(
      "bash",
      [
        installScript,
        "--prefix",
        prefix,
        "--org",
        "example-org",
        "--real-node",
        process.execPath,
        "--real-git",
        "/usr/bin/git",
      ],
      { env, encoding: "utf8" },
    );
    expect(realRes.status).toBe(0);
    expect(
      NodeFS.existsSync(NodePath.join(prefix, "lib", "marscode", "host-guards", "bin.mjs")),
    ).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(prefix, "bin", "git"))).toBe(true);

    // Verify legacy Python hook removed, marscode-host-guard hook added, and custom hook preserved
    const updatedClaude = JSON.parse(NodeFS.readFileSync(claudeSettings, "utf8")) as {
      hooks: {
        PreToolUse: Array<{ hooks: Array<{ command: string }> }>;
        SessionStart: Array<{ hooks: Array<{ command: string }> }>;
      };
    };
    const preCmds = updatedClaude.hooks.PreToolUse.flatMap((e) => e.hooks.map((h) => h.command));
    expect(preCmds.some((c) => c.includes("host_guard.py"))).toBe(false);
    expect(preCmds.some((c) => c.includes("marscode-host-guard hook"))).toBe(true);
    expect(preCmds).toContain("/usr/local/bin/my-custom-hook");

    // 3. Installed wrapper scrubs NODE_OPTIONS, NODE_PATH, NODE_EXTRA_CA_CERTS
    const wrapperPath = NodePath.join(prefix, "bin", "marscode-host-guard");
    expect(NodeFS.readFileSync(wrapperPath, "utf8")).toContain(
      "unset NODE_OPTIONS NODE_PATH NODE_EXTRA_CA_CERTS",
    );
    const scrubbedRes = NodeChildProcess.spawnSync(wrapperPath, ["version"], {
      env: { ...env, NODE_OPTIONS: "--require /nonexistent/evil.cjs" },
      encoding: "utf8",
    });
    expect(scrubbedRes.status).toBe(0);

    // 4. Re-running install must NOT overwrite existing user config
    const cfgFile = NodePath.join(prefix, "lib", "marscode", "host-guards.json");
    const sentinel = JSON.stringify({
      orgs: ["custom-keep-me"],
      sourceRoot: "~/Dev",
      dataRoot: "~/Dev-data",
    });
    NodeFS.writeFileSync(cfgFile, sentinel);
    const secondRes = NodeChildProcess.spawnSync(
      "bash",
      [
        installScript,
        "--no-hooks",
        "--prefix",
        prefix,
        "--real-node",
        process.execPath,
        "--real-git",
        "/usr/bin/git",
      ],
      { env, encoding: "utf8" },
    );
    expect(secondRes.status).toBe(0);
    expect(NodeFS.readFileSync(cfgFile, "utf8")).toBe(sentinel);

    // 5. Symlinked settings.json preserves symlink target and original mode (0640)
    const symlinkTarget = NodePath.join(root, "real-claude-settings.json");
    NodeFS.writeFileSync(symlinkTarget, "{}\n", { mode: 0o640 });
    NodeFS.chmodSync(symlinkTarget, 0o640);
    NodeFS.unlinkSync(claudeSettings);
    NodeFS.symlinkSync(symlinkTarget, claudeSettings);
    const symlinkRes = NodeChildProcess.spawnSync(
      "bash",
      [
        installScript,
        "--prefix",
        prefix,
        "--real-node",
        process.execPath,
        "--real-git",
        "/usr/bin/git",
      ],
      { env, encoding: "utf8" },
    );
    expect(symlinkRes.status).toBe(0);
    expect(NodeFS.lstatSync(claudeSettings).isSymbolicLink()).toBe(true);
    expect(NodeFS.statSync(symlinkTarget).mode & 0o777).toBe(0o640);

    // 6. Malformed settings.json fails loudly and is NOT overwritten
    const brokenText = "{ broken json";
    NodeFS.writeFileSync(symlinkTarget, brokenText, "utf8");
    const brokenRes = NodeChildProcess.spawnSync(
      "bash",
      [
        installScript,
        "--prefix",
        prefix,
        "--real-node",
        process.execPath,
        "--real-git",
        "/usr/bin/git",
      ],
      { env, encoding: "utf8" },
    );
    expect(brokenRes.status).not.toBe(0);
    expect(NodeFS.readFileSync(symlinkTarget, "utf8")).toBe(brokenText);
  });
});
