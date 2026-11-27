// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for canonical ci-hosts loader, toolchain env, and root grants.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import {
  extractCiHostEntries,
  isValidSshAlias,
  loadCiHostsManifest,
  normalizeArch,
  readCiHostEntries,
  resolveCiHostsPath,
  validateCiHostsManifest,
} from "./ciHosts.ts";
import {
  compareVersions,
  computeHostLacks,
  evaluateToolState,
  versionMatchesRange,
} from "./ciToolVersion.ts";
import { buildHostProbeScript } from "./hostProbe.ts";
import {
  buildGrantLines,
  buildWslRootLines,
  formatNeedsRootMarks,
  mergeRootCommands,
  validateRootCommand,
} from "./rootGrant.ts";
import { buildLocalStepEnv, buildRemoteStepScript } from "./stepRunner.ts";
import { buildToolchainEnv, buildToolchainPath, buildToolchainShellSetup } from "./toolchainEnv.ts";

const tempDirs: string[] = [];

function mkTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
});

describe("canonical ci-hosts.json loader and validator", () => {
  it("resolves ci-hosts.json in precedence order: override > env > marscode overlay > legacy", () => {
    const dir = mkTempDir("sq-cihosts-");
    const home = NodePath.join(dir, "home");
    const marscodeOverlay = NodePath.join(home, ".local", "lib", "marscode", "ci-hosts.json");
    const legacyLib = NodePath.join(home, ".local", "lib", "ship-queue", "ci-hosts.json");
    const envPath = NodePath.join(dir, "env-ci-hosts.json");
    const overridePath = NodePath.join(dir, "override-ci-hosts.json");
    for (const p of [marscodeOverlay, legacyLib, envPath, overridePath]) {
      NodeFS.mkdirSync(NodePath.dirname(p), { recursive: true });
      NodeFS.writeFileSync(p, '{"schema":1,"hosts":[],"toolchain":{}}');
    }

    expect(
      resolveCiHostsPath({
        homeDir: home,
        env: { SHIP_QUEUE_CI_HOSTS: envPath },
        overridePath,
      }),
    ).toBe(overridePath);

    expect(
      resolveCiHostsPath({
        homeDir: home,
        env: { SHIP_QUEUE_CI_HOSTS: envPath },
      }),
    ).toBe(envPath);

    expect(resolveCiHostsPath({ homeDir: home, env: {} })).toBe(marscodeOverlay);

    NodeFS.rmSync(marscodeOverlay);
    expect(resolveCiHostsPath({ homeDir: home, env: {} })).toBe(legacyLib);
  });

  it("validates the committed infra/ci-host/ci-hosts.example.json manifest cleanly", () => {
    const examplePath = NodePath.resolve(
      import.meta.dirname,
      "../../../infra/ci-host/ci-hosts.example.json",
    );
    const loaded = loadCiHostsManifest({ overridePath: examplePath });
    expect(loaded.ok).toBe(true);
    expect(loaded.errors).toEqual([]);
    expect(loaded.manifest?.hosts.map((h) => h.name)).toEqual(["local", "ci-host-1"]);
    expect(loaded.manifest?.toolchain.vp?.probe).toBe("vp --version");
    expect(loaded.manifest?.toolchain.vp?.install).toContain("ci-vp.sh");
    expect(loaded.manifest?.toolchain.sccache?.probe).toBe("sccache --version");
    expect(loaded.manifest?.toolchain.sccache?.install).toContain("ci-sccache.sh");
  });

  it("rejects malformed hosts, bad SSH aliases, unsafe data_root, and invalid versions", () => {
    const res = validateCiHostsManifest({
      schema: 1,
      hosts: [
        { name: "bad name!", ssh: "-oProxyCommand=evil", role: "ci", data_root: "relative/path" },
        { name: "dup-host", ssh: null, role: "ci", data_root: "~/data" },
        { name: "dup-host", ssh: "dup.example", role: "ci", data_root: "~/data" },
      ],
      toolchain: {
        node: { version: "not-a-range", probe: "node -v", install: null },
      },
    });
    expect(res.ok).toBe(false);
    expect(res.errors.some((e) => e.includes("bad name!"))).toBe(true);
    expect(res.errors.some((e) => e.includes("ssh"))).toBe(true);
    expect(res.errors.some((e) => e.includes("data_root"))).toBe(true);
    expect(res.errors.some((e) => e.includes("dup-host"))).toBe(true);
    expect(res.errors.some((e) => e.includes("version"))).toBe(true);

    expect(isValidSshAlias("ci-host-1.example")).toBe(true);
    expect(isValidSshAlias("-bad-flag")).toBe(false);
    expect(isValidSshAlias("host;rm")).toBe(false);
    expect(normalizeArch("arm64")).toBe("aarch64");
    expect(normalizeArch("amd64")).toBe("x86_64");
  });

  it("reads minimal host lists leniently while rejecting unsafe SSH aliases", () => {
    const dir = mkTempDir("sq-minimal-");
    const p = NodePath.join(dir, "ci-hosts.json");
    NodeFS.writeFileSync(
      p,
      JSON.stringify({
        hosts: [
          { name: "hub", ssh: null, role: "ci" },
          { name: "worker-a", ssh: "worker-a.example", role: "ci", on: "host-a" },
          { name: "bad-host", ssh: "-oStrictHostKeyChecking=no" },
        ],
      }),
    );
    const entries = readCiHostEntries({ overridePath: p });
    expect(entries.map((h) => h.name)).toEqual(["hub", "worker-a"]);
    expect(extractCiHostEntries({ hosts: [{ name: "hub", ssh: null }] })).toHaveLength(1);
  });
});

describe("unified toolchain PATH/env builder parity", () => {
  it("shares the exact same toolchain directories including ~/.vite-plus/bin across probes, local steps, and remote steps", () => {
    const home = "/tmp/test-home";
    const dataRoot = "/tmp/test-data";
    const pathValue = buildToolchainPath("/usr/bin:/bin", { homeDir: home });
    expect(pathValue.split(":")).toContain(`${home}/.vite-plus/bin`);
    expect(pathValue.split(":")).toContain(`${home}/.local/share/ship-queue-ci/bin`);
    expect(pathValue.split(":")).toContain(`${home}/.cargo/bin`);

    const env = buildToolchainEnv(
      { PATH: "/usr/bin:/bin" },
      {
        homeDir: home,
        dataRoot,
        worktreeDir: "/tmp/test-data/demo/wt-a",
        sccacheSocketPath: "/tmp/sq-sc-job-1.sock",
        hasSccache: true,
      },
    );
    expect(env.VP_HOME).toBe(`${home}/.local/share/ship-queue-ci/vite-plus`);
    expect(env.SHIP_QUEUE_DATA_ROOT).toBe(dataRoot);
    expect(env.UV_PYTHON_PREFERENCE).toBe("only-managed");
    expect(env.TURBO_CACHE_DIR).toBe(`${dataRoot}/turbo-cache`);
    expect(env.UV_CACHE_DIR).toBe(`${dataRoot}/uv-cache`);
    expect(env.RUSTC_WRAPPER).toBe("sccache");
    expect(env.SCCACHE_DIR).toBe(`${dataRoot}/sccache`);
    expect(env.SCCACHE_IDLE_TIMEOUT).toBe("60");
    expect(env.SCCACHE_CLIENT_SIDE).toBe("1");
    expect(env.SCCACHE_SERVER_UDS).toBe("/tmp/sq-sc-job-1.sock");
    expect(env.SCCACHE_BASEDIRS).toBe(`/tmp/test-data/demo/wt-a:${dataRoot}`);
    expect(env.SCCACHE_BASEDIRS_VERBATIM_ENV_DEPS).toBe("CARGO_MANIFEST_DIR,CARGO_MANIFEST_PATH");

    const envWithCustomWrapper = buildToolchainEnv(
      { PATH: "/usr/bin:/bin", RUSTC_WRAPPER: "/opt/custom-wrapper" },
      { homeDir: home, dataRoot, hasSccache: true },
    );
    expect(envWithCustomWrapper.RUSTC_WRAPPER).toBe("/opt/custom-wrapper");
    expect(envWithCustomWrapper.SCCACHE_DIR).toBeUndefined();

    const envWithoutSccache = buildToolchainEnv(
      { PATH: "/usr/bin:/bin" },
      { homeDir: home, dataRoot, hasSccache: false },
    );
    expect(envWithoutSccache.TURBO_CACHE_DIR).toBe(`${dataRoot}/turbo-cache`);
    expect(envWithoutSccache.UV_CACHE_DIR).toBe(`${dataRoot}/uv-cache`);
    expect(envWithoutSccache.RUSTC_WRAPPER).toBeUndefined();
    expect(envWithoutSccache.SCCACHE_DIR).toBeUndefined();

    const baseShellSetup = buildToolchainShellSetup();
    const stepShellSetup = buildToolchainShellSetup({ dataRootShell: "$HOME/Dev-data" });
    expect(baseShellSetup).toContain("$HOME/.vite-plus/bin");
    expect(baseShellSetup).toContain("VP_HOME=");
    expect(stepShellSetup).toContain('TURBO_CACHE_DIR="$HOME/Dev-data/turbo-cache"');
    expect(stepShellSetup).toContain('UV_CACHE_DIR="$HOME/Dev-data/uv-cache"');
    expect(stepShellSetup).toContain('SCCACHE_DIR="$HOME/Dev-data/sccache"');
    expect(stepShellSetup).toContain("SCCACHE_CLIENT_SIDE=1");
    expect(stepShellSetup).toContain("CARGO_MANIFEST_DIR,CARGO_MANIFEST_PATH");
    expect(stepShellSetup).not.toContain("OUT_DIR");
    expect(stepShellSetup).not.toContain("'");

    const manifest = validateCiHostsManifest({
      schema: 1,
      hosts: [{ name: "local", ssh: null, role: "ci", data_root: "~/Dev-data" }],
      toolchain: {
        vp: { version: ">=0.1", probe: "vp --version", install: null, base: true },
      },
    }).manifest!;

    const probeScript = buildHostProbeScript(manifest);
    const stepCtx = {
      jobId: "job-1",
      repo: "demo",
      primary: "/tmp/demo",
      worktree: "/tmp/demo-wt",
      branch: "feat/test",
      baseRef: "origin/main",
      baseSha: "a".repeat(40),
      queueRoot: "/tmp/sq",
      stepTree: "/tmp/base",
      dataRoot,
    };
    const localStepEnv = buildLocalStepEnv({
      mode: "ci",
      ctx: stepCtx,
      baseEnv: { PATH: "/usr/bin:/bin" },
      homeDir: home,
    });
    const remoteStepScript = buildRemoteStepScript({
      remoteWorktree: "/tmp/remote-wt",
      remoteDataRootDeclared: "~/Dev-data",
      ctx: stepCtx,
      cmdline: "scripts/ci.sh",
    });

    // Probe and remote step BOTH embed the exact same unified toolchain shell setup with $HOME/.vite-plus/bin.
    expect(probeScript).toContain(baseShellSetup);
    expect(remoteStepScript).toContain(stepShellSetup);
    expect(remoteStepScript).toContain(baseShellSetup);
    // Local step PATH contains the exact same ~/.vite-plus/bin and VP_HOME.
    expect(localStepEnv.PATH?.split(":")).toContain(`${home}/.vite-plus/bin`);
    expect(localStepEnv.VP_HOME).toBe(env.VP_HOME);
    expect(localStepEnv.TURBO_CACHE_DIR).toBe(`${dataRoot}/turbo-cache`);
    expect(localStepEnv.UV_CACHE_DIR).toBe(`${dataRoot}/uv-cache`);
    expect(remoteStepScript).toContain("CARGO_INCREMENTAL=0");
    expect(remoteStepScript).toContain("SCCACHE_BASEDIRS='/tmp/remote-wt:'\"$HOME/Dev-data\"");
    expect(remoteStepScript).toContain("SCCACHE_SERVER_UDS='/tmp/sq-sc-job-1.sock'");

    // When sccache is installed in PATH, CI mode isolates per-job socket + worktree basedir and disables incremental compilation.
    const fakeBinDir = mkTempDir("sq-sccache-bin-");
    const fakeSccache = NodePath.join(fakeBinDir, "sccache");
    NodeFS.writeFileSync(fakeSccache, "#!/bin/sh\necho sccache 0.20.1\n", { mode: 0o755 });
    const ciWithSccache = buildLocalStepEnv({
      mode: "ci",
      ctx: stepCtx,
      baseEnv: { PATH: `${fakeBinDir}:/usr/bin:/bin` },
      homeDir: home,
    });
    expect(ciWithSccache.RUSTC_WRAPPER).toBe("sccache");
    expect(ciWithSccache.CARGO_INCREMENTAL).toBe("0");
    expect(ciWithSccache.SCCACHE_CLIENT_SIDE).toBe("1");
    expect(ciWithSccache.SCCACHE_SERVER_UDS).toBe("/tmp/sq-sc-job-1.sock");
    expect(ciWithSccache.SCCACHE_BASEDIRS).toBe(`${stepCtx.worktree}:${dataRoot}`);

    // Custom RUSTC_WRAPPER is preserved untouched without forcing CARGO_INCREMENTAL=0.
    const ciWithCustomWrapper = buildLocalStepEnv({
      mode: "ci",
      ctx: stepCtx,
      baseEnv: { PATH: `${fakeBinDir}:/usr/bin:/bin`, RUSTC_WRAPPER: "/opt/custom" },
      homeDir: home,
    });
    expect(ciWithCustomWrapper.RUSTC_WRAPPER).toBe("/opt/custom");
    expect(ciWithCustomWrapper.CARGO_INCREMENTAL).toBeUndefined();
    expect(ciWithCustomWrapper.SCCACHE_DIR).toBeUndefined();
  });
});

describe("tool version comparison, lacks, and root grants", () => {
  it("evaluates ranges, versions, and per-host lacks accurately", () => {
    expect(compareVersions("22.14.0", "22.2.0")).toBeGreaterThan(0);
    expect(versionMatchesRange("0.1.18", ">=0.1 <0.2")).toBe(true);
    expect(versionMatchesRange("0.2.0", ">=0.1 <0.2")).toBe(false);
    expect(versionMatchesRange("5.9.3", "=5.9.3")).toBe(true);

    const manifest = validateCiHostsManifest({
      schema: 1,
      hosts: [
        { name: "local", ssh: null, role: "ci", data_root: "~/data" },
        { name: "ci-1", ssh: "ci-1.example", role: "ci", data_root: "~/data" },
      ],
      toolchain: {
        git: { version: ">=2.40", probe: "git --version", install: null, base: true },
        vp: { version: ">=0.1", probe: "vp --version", install: "echo vp" },
        xcode: { version: ">=15", probe: "xcodebuild -version", install: null, os: ["darwin"] },
      },
    }).manifest!;

    expect(evaluateToolState("vp", manifest.toolchain, { __os: "linux", vp: "0.1.18" })).toBe("ok");
    expect(evaluateToolState("vp", manifest.toolchain, { __os: "linux", vp: "0.0.9" })).toBe(
      "missing",
    );
    expect(
      evaluateToolState("xcode", manifest.toolchain, { __os: "linux", xcode: "missing" }),
    ).toBe("not-for-host");

    const probe = {
      __os: "linux",
      __arch: "x86_64",
      __home: "/home/ci",
      git: "2.43.0",
      vp: "missing",
    };
    expect(computeHostLacks(manifest, probe, "base")).toEqual([]);
    expect(computeHostLacks(manifest, probe, "all")).toEqual(["vp@>=0.1 (has missing)"]);
  });

  it("validates, merges, and formats root grant lines for sudo and WSL", () => {
    expect(validateRootCommand("/usr/bin/apt-get install -y jq")).toBeNull();
    expect(validateRootCommand("apt-get install -y jq")).not.toBeNull();
    expect(validateRootCommand("/usr/bin/apt-get install -y jq; rm -rf /")).not.toBeNull();
    expect(
      mergeRootCommands([
        "/usr/bin/apt-get install -y jq",
        "/usr/bin/apt-get install -y curl",
        "/usr/bin/systemctl restart docker",
      ]),
    ).toEqual(["/usr/bin/apt-get install -y jq curl", "/usr/bin/systemctl restart docker"]);

    const lines = buildGrantLines("ci-host-1.example", ["/usr/bin/apt-get install -y jq"]);
    expect(lines.join("\n")).toContain("sudo");
    expect(buildWslRootLines("Ubuntu", ["/usr/bin/apt-get install -y jq"])[0]).toContain("wsl.exe");
    const marks = formatNeedsRootMarks("job-1", {
      request: "abc123def456",
      hosts: [
        {
          host: "ci-host-1",
          ssh: "ci-host-1.example",
          tools: ["jq"],
          grant: lines,
          local: lines,
        },
      ],
    });
    expect(marks.join("\n")).toContain("NEEDS_ROOT job=job-1 host=ci-host-1");
  });
});
