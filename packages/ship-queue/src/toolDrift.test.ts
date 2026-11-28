// @effect-diagnostics nodeBuiltinImport:off - Behavioral tests for eligible-host tool drift detection, single-host stranding, bounded non-root convergence, and CLI subcommands.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import type { CiHostsManifest } from "./ciHosts.ts";
import { runHostsSubcommand } from "./cliSubcommands.ts";
import { dataRootUnderHome } from "./dataRootPolicy.ts";
import { writeProbeFile, type HostExecDeps } from "./hostProbe.ts";
import { setCiHostAvailability } from "./hostOffMarker.ts";
import { writeRegistration } from "./jobStore.ts";
import { collectRepoToolRequirements } from "./repoRequirements.ts";
import { evaluateToolDrift, formatToolDriftReport } from "./toolDrift.ts";
import {
  readToolDriftReconcileState,
  reconcileDueToolDrift,
  reconcileToolDrift,
  releaseInFlightHost,
  tryClaimInFlightHost,
} from "./toolDriftReconcile.ts";

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

const FOUR_HOST_MANIFEST: CiHostsManifest = {
  schema: 1,
  hosts: [
    { name: "ci-x86-1", ssh: null, role: "ci", data_root: "/srv/ci" },
    { name: "ci-x86-2", ssh: "ci-x86-2", role: "ci", data_root: "/srv/ci", sudo: true },
    { name: "ci-x86-3", ssh: "ci-x86-3", role: "ci", data_root: "/srv/ci" },
    { name: "ci-arm-1", ssh: "ci-arm-1", role: "ci", data_root: "/srv/ci" },
  ],
  toolchain: {
    git: { version: ">=2.0", probe: "git --version", install: null, base: true },
    vp: {
      version: ">=0.1",
      probe: "vp --version",
      install: '"$CI_HOST_PAYLOAD/infra/ci-host/ci-vp.sh"',
      base: false,
    },
    docker: {
      version: ">=24.0",
      probe: "docker --version",
      install: null,
      base: false,
      root: { linux: "/usr/bin/apt-get install -y docker.io" },
    },
  },
};

function makeFakeHostEnv(
  stateByHost: Record<string, Record<string, string>>,
  options?: {
    readonly failInstallOn?: ReadonlySet<string>;
    readonly onInstall?: (host: string, script: string) => void;
    readonly nowMs?: () => number;
    readonly nowIso?: () => string;
  },
): {
  readonly deps: HostExecDeps;
  readonly commands: Array<{ readonly host: string; readonly script: string }>;
} {
  const commands: Array<{ readonly host: string; readonly script: string }> = [];
  const handleScript = async (host: string, script: string) => {
    commands.push({ host, script });
    const hostState = stateByHost[host];
    if (!hostState) return { exitCode: 255, stdout: "", stderr: "unreachable" };
    // Probe script prints __os, __arch, __home and tool rows.
    if (script.includes('printf "__os\\t%s\\n"')) {
      const stdout =
        Object.entries(hostState)
          .map(([k, v]) => `${k}\t${v}`)
          .join("\n") + "\n";
      return { exitCode: 0, stdout, stderr: "" };
    }
    // User tool install (ci-vp.sh).
    if (script.includes("ci-vp.sh")) {
      options?.onInstall?.(host, script);
      if (options?.failInstallOn?.has(host)) {
        return { exitCode: 1, stdout: "", stderr: "network error installing vp" };
      }
      hostState.vp = "0.1.18";
      return { exitCode: 0, stdout: "installed vp 0.1.18\n", stderr: "" };
    }
    return { exitCode: 0, stdout: "", stderr: "" };
  };

  return {
    commands,
    deps: {
      nowMs: options?.nowMs ?? (() => 1_760_000_000_000),
      nowIso: options?.nowIso ?? (() => "2026-11-27T12:00:00.000Z"),
      runLocal: async (input) => handleScript("ci-x86-1", input.args[1] ?? ""),
      runRemote: async (alias, script) => handleScript(alias, script),
    },
  };
}

describe("eligible-host tool drift detection and single-host stranding", () => {
  it("detects single-host stranding across same-arch x86_64 hosts while excluding aarch64 peers and off hosts", () => {
    const tmp = mkTempDir("sq-drift-eval-");
    const queueRoot = NodePath.join(tmp, "queue");
    const repoDir = NodePath.join(tmp, "app-repo");
    NodeFS.mkdirSync(repoDir, { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".tree-guard.conf"),
      "ship_repo=acme-fixture/web-app\nship_ci_tool=vp@>=0.1\n",
    );
    writeRegistration(queueRoot, "acme-fixture/web-app", {
      primary: repoDir,
      remoteUrl: "https://example.invalid/acme-fixture/web-app.git",
    });

    const repos = collectRepoToolRequirements({ queueRoot });
    expect(repos).toHaveLength(1);
    expect(repos[0]?.requiredTools).toEqual(["vp@>=0.1"]);

    const report = evaluateToolDrift({
      queueRoot,
      manifest: FOUR_HOST_MANIFEST,
      probesByHost: {
        "ci-x86-1": { __os: "linux", __arch: "x86_64", git: "2.45.0", vp: "0.1.18" },
        "ci-x86-2": { __os: "linux", __arch: "x86_64", git: "2.45.0", vp: "missing" },
        "ci-x86-3": { __os: "linux", __arch: "x86_64", git: "2.45.0", vp: "missing" },
        "ci-arm-1": { __os: "linux", __arch: "aarch64", git: "2.45.0", vp: "missing" },
      },
      repos,
      at: "2026-11-27T12:00:00.000Z",
    });

    expect(report.hasDrift).toBe(true);
    expect(report.hasSingleHostStranding).toBe(true);
    expect(report.repos[0]).toMatchObject({
      repo: "acme-fixture/web-app",
      satisfyingHosts: ["ci-x86-1"],
      driftedSameArchHosts: ["ci-x86-2", "ci-x86-3"],
      strandedOnSingleHost: true,
      zeroSatisfyingHosts: false,
      strandedHost: "ci-x86-1",
    });
    // aarch64 host is NOT flagged as x86_64 same-arch drift for this repo!
    expect(report.hosts.map((h) => h.host)).toEqual(["ci-x86-2", "ci-x86-3"]);
    expect(report.hosts[0]?.autoProvisionableTools).toEqual(["vp"]);
    expect(report.hosts[0]?.rootRequiredTools).toEqual([]);
    expect(formatToolDriftReport(report)).toContain(
      "STRANDED repo=acme-fixture/web-app host=ci-x86-1",
    );

    // Turning ci-x86-3 off moves it into offHosts rather than active drift.
    const manifestPath = NodePath.join(tmp, "ci-hosts.json");
    NodeFS.writeFileSync(manifestPath, JSON.stringify(FOUR_HOST_MANIFEST));
    setCiHostAvailability({
      queueRoot,
      hostName: "ci-x86-3",
      enabled: false,
      reason: "maintenance",
      manifestPath,
      nowIso: () => "2026-11-27T12:00:00.000Z",
    });
    const afterOff = evaluateToolDrift({
      queueRoot,
      manifest: FOUR_HOST_MANIFEST,
      probesByHost: {
        "ci-x86-1": { __os: "linux", __arch: "x86_64", git: "2.45.0", vp: "0.1.18" },
        "ci-x86-2": { __os: "linux", __arch: "x86_64", git: "2.45.0", vp: "missing" },
        "ci-x86-3": { __os: "linux", __arch: "x86_64", git: "2.45.0", vp: "missing" },
        "ci-arm-1": { __os: "linux", __arch: "aarch64", git: "2.45.0", vp: "missing" },
      },
      repos,
      at: "2026-11-27T12:00:00.000Z",
    });
    expect(afterOff.offHosts).toEqual(["ci-x86-3"]);
    expect(afterOff.hosts.map((h) => h.host)).toEqual(["ci-x86-2"]);
  });

  it("converges missing non-root tools automatically, NEVER runs root commands, and enforces backoff + sweep cadence", async () => {
    const tmp = mkTempDir("sq-drift-reconcile-");
    const queueRoot = NodePath.join(tmp, "queue");
    const manifestPath = NodePath.join(tmp, "ci-hosts.json");
    const repoDir = NodePath.join(tmp, "app-repo");
    NodeFS.mkdirSync(repoDir, { recursive: true });
    NodeFS.writeFileSync(manifestPath, JSON.stringify(FOUR_HOST_MANIFEST));
    // Repo requires BOTH user-level `vp` and root-only `docker` on x86_64!
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".tree-guard.conf"),
      "ship_repo=acme-fixture/full-app\nship_ci_tool=vp@>=0.1\nship_ci_tool=docker@>=24.0\nship_ci_arch=x86_64\n",
    );
    writeRegistration(queueRoot, "acme-fixture/full-app", {
      primary: repoDir,
      remoteUrl: "https://example.invalid/acme-fixture/full-app.git",
    });

    const hostState: Record<string, Record<string, string>> = {
      "ci-x86-1": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "0.1.18",
        docker: "26.0.0",
      },
      "ci-x86-2": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "missing",
        docker: "missing",
      },
      "ci-x86-3": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "missing",
        docker: "26.0.0",
      },
      "ci-arm-1": {
        __os: "linux",
        __arch: "aarch64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "missing",
        docker: "missing",
      },
    };

    let nowMs = 1_760_000_000_000;
    const failSet = new Set<string>(["ci-x86-3"]);
    const fake = makeFakeHostEnv(hostState, {
      failInstallOn: failSet,
      nowMs: () => nowMs,
      nowIso: () => "2026-11-27T12:00:00.000Z",
    });

    // Pass 1: ci-x86-2 installs vp (user tool) and NEVER runs apt-get/sudo for docker; ci-x86-3 fails and enters backoff.
    const pass1 = await reconcileToolDrift({
      queueRoot,
      manifestPath,
      maxHostsPerPass: 2,
      minRetryBackoffMs: 300_000,
      deps: fake.deps,
    });
    expect(pass1.attempted).toEqual(["ci-x86-2", "ci-x86-3"]);
    expect(pass1.provisioned).toEqual([{ host: "ci-x86-2", tools: ["vp"] }]);
    expect(pass1.failed).toHaveLength(1);
    expect(pass1.failed[0]?.host).toBe("ci-x86-3");
    // Root-required tool `docker` on ci-x86-2 (even though sudo: true!) was NEVER executed!
    expect(pass1.skippedRootRequired).toEqual([{ host: "ci-x86-2", tools: ["docker"] }]);
    expect(
      fake.commands.some((c) => c.script.includes("apt-get") || c.script.includes("sudo")),
    ).toBe(false);

    // Due-sweep cadence check immediately after pass 1 skips with zero SSH calls.
    const cmdCountBefore = fake.commands.length;
    const dueSkip = await reconcileDueToolDrift({
      queueRoot,
      manifestPath,
      sweepIntervalMs: 300_000,
      deps: fake.deps,
    });
    expect(dueSkip.skipped).toBe(true);
    expect(dueSkip.skipReason).toBe("interval");
    expect(fake.commands.length).toBe(cmdCountBefore);

    // Advance 60s (< 300s backoff): ci-x86-3 is still in backoff and skipped.
    nowMs += 60_000;
    const pass2 = await reconcileToolDrift({
      queueRoot,
      manifestPath,
      minRetryBackoffMs: 300_000,
      deps: fake.deps,
    });
    expect(pass2.skippedBackoff).toEqual(["ci-x86-3"]);
    expect(pass2.attempted).toEqual([]);

    // Advance past backoff + clear transient failure: ci-x86-3 converges and clears single-host stranding!
    nowMs += 300_000;
    failSet.delete("ci-x86-3");
    const pass3 = await reconcileToolDrift({
      queueRoot,
      manifestPath,
      minRetryBackoffMs: 300_000,
      deps: fake.deps,
    });
    expect(pass3.ok).toBe(true);
    expect(pass3.provisioned).toEqual([{ host: "ci-x86-3", tools: ["vp"] }]);
    // Now both ci-x86-1 and ci-x86-3 satisfy full-app -> no longer stranded on a single host!
    expect(pass3.after?.hasSingleHostStranding).toBe(false);
    expect(pass3.after?.repos[0]?.satisfyingHosts).toEqual(["ci-x86-1", "ci-x86-3"]);
    expect(readToolDriftReconcileState(queueRoot).hosts["ci-x86-3"]?.consecutiveFailures).toBe(0);
  });

  it("fails `hosts check` for a host whose data root is under a home directory", async () => {
    const tmp = mkTempDir("sq-dataroot-");
    const queueRoot = NodePath.join(tmp, "queue");
    const manifestPath = NodePath.join(tmp, "ci-hosts.json");
    // The check reads the declared data_root, not the probed $HOME.
    const healthy = {
      __os: "linux",
      __arch: "x86_64",
      __home: "/home/ci",
      git: "2.45.0",
      vp: "0.1.18",
      docker: "26.0.0",
    };
    const fake = makeFakeHostEnv({
      "ci-x86-1": healthy,
      "ci-x86-2": healthy,
      "ci-x86-3": healthy,
      "ci-arm-1": { ...healthy, __arch: "aarch64" },
    });
    const check = async (manifest: CiHostsManifest) => {
      NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
      const out: string[] = [];
      const code = await runHostsSubcommand(
        queueRoot,
        ["check"],
        {
          stdout: (t) => out.push(t),
          stderr: (t) => out.push(t),
          env: { SHIP_QUEUE_CI_HOSTS: manifestPath },
          cwd: tmp,
        },
        fake.deps,
      );
      return { code, out: out.join("") };
    };
    const clean = await check(FOUR_HOST_MANIFEST);
    expect(clean.out).not.toContain("data_root under a home directory");
    const homed = await check({
      ...FOUR_HOST_MANIFEST,
      hosts: FOUR_HOST_MANIFEST.hosts.map((h) =>
        h.name === "ci-x86-3" ? { ...h, data_root: "~/Dev-data" } : h,
      ),
    });
    expect(homed.code).toBe(1);
    expect(homed.out).toContain(
      "ci-x86-3 (ci-x86-3): reached\n  needs-root: data_root under a home directory: ~/Dev-data",
    );
    expect(dataRootUnderHome("/home/ci/data")).toBe(true);
    expect(dataRootUnderHome("/Users/ci/data")).toBe(true);
    expect(dataRootUnderHome("//home/ci")).toBe(true);
    expect(dataRootUnderHome("/root/ci")).toBe(true);
    expect(dataRootUnderHome("/var/home/ci")).toBe(true);
    expect(dataRootUnderHome("/users/ci")).toBe(true);
    expect(dataRootUnderHome("/home2/ci")).toBe(false);
    expect(dataRootUnderHome("/srv/ci")).toBe(false);
    expect(dataRootUnderHome("/data/Dev")).toBe(false);
  });

  it("wires `ship-queue hosts drift [--json] [--reconcile]` and `hosts check --drift` CLI subcommands", async () => {
    const tmp = mkTempDir("sq-drift-cli-");
    const queueRoot = NodePath.join(tmp, "queue");
    const manifestPath = NodePath.join(tmp, "ci-hosts.json");
    const repoDir = NodePath.join(tmp, "cli-repo");
    NodeFS.mkdirSync(repoDir, { recursive: true });
    NodeFS.writeFileSync(manifestPath, JSON.stringify(FOUR_HOST_MANIFEST));
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".tree-guard.conf"),
      "ship_repo=acme-fixture/cli-app\nship_ci_tool=vp@>=0.1\nship_ci_arch=x86_64\n",
    );
    writeRegistration(queueRoot, "acme-fixture/cli-app", {
      primary: repoDir,
      remoteUrl: "https://example.invalid/acme-fixture/cli-app.git",
    });

    const hostState: Record<string, Record<string, string>> = {
      "ci-x86-1": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "0.1.18",
        docker: "26.0.0",
      },
      "ci-x86-2": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "missing",
        docker: "26.0.0",
      },
      "ci-x86-3": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "0.1.18",
        docker: "26.0.0",
      },
      "ci-arm-1": {
        __os: "linux",
        __arch: "aarch64",
        __home: "/srv/ci",
        git: "2.45.0",
        vp: "missing",
        docker: "26.0.0",
      },
    };
    const fake = makeFakeHostEnv(hostState);
    const runCli = async (args: ReadonlyArray<string>) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runHostsSubcommand(
        queueRoot,
        args,
        {
          stdout: (t) => out.push(t),
          stderr: (t) => err.push(t),
          env: { SHIP_QUEUE_CI_HOSTS: manifestPath },
          cwd: tmp,
        },
        fake.deps,
      );
      return { code, stdout: out.join(""), stderr: err.join("") };
    };

    // Detect drift via `hosts drift --json`.
    const driftBefore = await runCli(["drift", "--json"]);
    expect(driftBefore.code).toBe(1);
    const parsedBefore = JSON.parse(driftBefore.stdout) as {
      readonly hasDrift: boolean;
      readonly hosts: ReadonlyArray<{ readonly host: string }>;
    };
    expect(parsedBefore.hasDrift).toBe(true);
    expect(parsedBefore.hosts.map((h) => h.host)).toEqual(["ci-x86-2"]);

    // `hosts check --drift --json` embeds tool_drift.
    writeProbeFile(NodePath.join(queueRoot, "hosts", "ci-x86-2.probe"), hostState["ci-x86-2"]!);
    const checkWithDrift = await runCli(["check", "--drift", "--json"]);
    expect(checkWithDrift.code).toBe(1);
    const parsedCheck = JSON.parse(checkWithDrift.stdout) as {
      readonly tool_drift?: { readonly hasDrift: boolean };
    };
    expect(parsedCheck.tool_drift?.hasDrift).toBe(true);

    // Reconcile via `hosts drift --reconcile --json` -> exits 0 once aligned!
    const reconciled = await runCli(["drift", "--reconcile", "--json"]);
    expect(reconciled.code).toBe(0);
    const parsedRec = JSON.parse(reconciled.stdout) as {
      readonly ok: boolean;
      readonly after: { readonly hasDrift: boolean };
    };
    expect(parsedRec.ok).toBe(true);
    expect(parsedRec.after.hasDrift).toBe(false);
  });

  it("upgrades stricter repo version ranges, skips empty 0-tool installs, and respects shared in-flight host dedup", async () => {
    const tmp = mkTempDir("sq-drift-strict-");
    const queueRoot = NodePath.join(tmp, "queue");
    const manifestPath = NodePath.join(tmp, "ci-hosts.json");
    const repoDir = NodePath.join(tmp, "strict-repo");
    NodeFS.mkdirSync(repoDir, { recursive: true });

    const manifest: CiHostsManifest = {
      schema: 1,
      hosts: [
        { name: "ci-x86-1", ssh: null, role: "ci", data_root: "~/data" },
        { name: "ci-x86-2", ssh: "ci-x86-2", role: "ci", data_root: "~/data" },
        { name: "ci-x86-3", ssh: "ci-x86-3", role: "ci", data_root: "~/data" },
      ],
      toolchain: {
        git: { version: ">=2.0", probe: "git --version", install: null, base: true },
        node: {
          version: ">=20.0",
          probe: "node --version",
          install: '"$CI_HOST_PAYLOAD/infra/ci-host/ci-node.sh"',
          base: true,
        },
      },
    };
    NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
    // Repo requires node@>=22.0, stricter than manifest's >=20.0!
    NodeFS.writeFileSync(
      NodePath.join(repoDir, ".tree-guard.conf"),
      "ship_repo=acme-fixture/strict-node\nship_ci_tool=node@>=22.0\nship_ci_arch=x86_64\n",
    );
    writeRegistration(queueRoot, "acme-fixture/strict-node", {
      primary: repoDir,
      remoteUrl: "https://example.invalid/acme-fixture/strict-node.git",
    });

    const hostState: Record<string, Record<string, string>> = {
      "ci-x86-1": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        node: "22.14.0",
      },
      "ci-x86-2": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        node: "20.11.0",
      },
      "ci-x86-3": {
        __os: "linux",
        __arch: "x86_64",
        __home: "/srv/ci",
        git: "2.45.0",
        node: "20.11.0",
      },
    };

    // Drift evaluation must report state="missing" (not "ok") against the repo's stricter >=22.0 range!
    const evalBefore = evaluateToolDrift({
      queueRoot,
      manifest,
      probesByHost: hostState,
      repos: collectRepoToolRequirements({ queueRoot }),
      at: "2026-11-27T12:00:00.000Z",
    });
    expect(evalBefore.hasSingleHostStranding).toBe(true);
    const x86Two = evalBefore.hosts.find((h) => h.host === "ci-x86-2");
    expect(x86Two?.missing[0]).toMatchObject({
      tool: "node",
      spec: "node@>=20.0 >=22.0",
      have: "20.11.0",
      state: "missing",
      autoProvisionable: true,
    });

    // Claim ci-x86-3 as in-flight externally (e.g. manual provision) -> reconcile skips it cleanly.
    expect(tryClaimInFlightHost(queueRoot, "ci-x86-3")).toBe(true);
    const installedHosts: string[] = [];
    const execHost = async (host: string, script: string) => {
      if (script.includes('printf "__os\\t%s\\n"')) {
        return {
          exitCode: 0,
          stdout: `${Object.entries(hostState[host]!)
            .map(([k, v]) => `${k}\t${v}`)
            .join("\n")}\n`,
          stderr: "",
        };
      }
      if (script.includes("ci-node.sh")) {
        installedHosts.push(host);
        hostState[host]!.node = "22.14.0";
        return { exitCode: 0, stdout: "installed node 22.14.0\n", stderr: "" };
      }
      return { exitCode: 0, stdout: "", stderr: "" };
    };
    const deps: HostExecDeps = {
      nowMs: () => 1_760_000_000_000,
      nowIso: () => "2026-11-27T12:00:00.000Z",
      runLocal: async (input) => execHost("ci-x86-1", input.args[1] ?? ""),
      runRemote: async (alias, script) => execHost(alias, script),
    };

    try {
      const rec = await reconcileToolDrift({ queueRoot, manifestPath, deps });
      expect(rec.ok).toBe(true);
      expect(rec.skippedInFlight).toEqual(["ci-x86-3"]);
      expect(installedHosts).toEqual(["ci-x86-2"]);
      expect(rec.provisioned).toEqual([{ host: "ci-x86-2", tools: ["node"] }]);
    } finally {
      releaseInFlightHost(queueRoot, "ci-x86-3");
    }

    // 0-tool install case: stale cached probe shows 20.11.0, but live probe during provision already has 22.14.0.
    writeProbeFile(NodePath.join(queueRoot, "hosts", "ci-x86-3.probe"), {
      __os: "linux",
      __arch: "x86_64",
      __home: "/srv/ci",
      git: "2.45.0",
      node: "20.11.0",
    });
    hostState["ci-x86-3"]!.node = "22.14.0";
    const zeroInstall = await reconcileToolDrift({
      queueRoot,
      manifestPath,
      freshProbe: false,
      deps: {
        ...deps,
        // Make cached probe fresh (< 300s TTL) so before-check uses cached 20.11.0 while provision's fresh probe sees 22.14.0.
        nowMs: () =>
          NodeFS.statSync(NodePath.join(queueRoot, "hosts", "ci-x86-3.probe")).mtimeMs + 1_000,
      },
    });
    expect(zeroInstall.ok).toBe(true);
    expect(zeroInstall.attempted).toEqual(["ci-x86-3"]);
    expect(zeroInstall.provisioned).toEqual([]);
  });
});
