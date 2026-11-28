// @effect-diagnostics nodeBuiltinImport:off - Real behavioral tests for ci-needs, CI routing, host probes, and MarsCode host payload sync.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { afterEach, describe, expect, it } from "vite-plus/test";

import { validateCiHostsManifest } from "./ciHosts.ts";
import {
  checkPlaywrightNeeds,
  evaluateJobCiNeeds,
  extractLockedVersions,
  filterPlaywrightLockfiles,
  resolveComposeFiles,
  resolveJobCiServices,
} from "./ciNeeds.ts";
import {
  isParkedJobReady,
  routeCiJob,
  type FleetNodeTelemetrySample,
  type FleetTelemetryProvider,
} from "./ciRouter.ts";
import { parseShipDeclaration } from "./declaration.ts";
import { checkCiHosts, isHostOff, setCiHostAvailability } from "./hostProbe.ts";
import { resolveHostSyncPaths, syncCiHostPayload } from "./hostProvision.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { buildRootGrantRequest } from "./rootGrant.ts";

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

describe("ciNeeds lockfiles, Playwright fixture filter + waiver, dynamic needs, and compose services", () => {
  it("parses playwright-core versions across pnpm, npm, yarn, and bun lockfiles", () => {
    const pnpmLock = [
      "lockfileVersion: '9.0'",
      "packages:",
      "  playwright-core@1.51.0:",
      "    resolution: {integrity: sha512-abc}",
    ].join("\n");
    const npmLock = JSON.stringify({
      lockfileVersion: 3,
      packages: { "node_modules/playwright-core": { version: "1.49.2" } },
    });
    const yarnLock = [
      "# yarn lockfile v1",
      "",
      '"playwright-core@^1.50.0":',
      '  version "1.50.1"',
    ].join("\n");
    const bunLock =
      '{"lockfileVersion": 1, "packages": {"playwright-core": ["playwright-core@1.52.0", "", {}]}}';

    expect(extractLockedVersions("playwright-core", "pnpm-lock.yaml", pnpmLock)).toEqual([
      "1.51.0",
    ]);
    expect(extractLockedVersions("playwright-core", "package-lock.json", npmLock)).toEqual([
      "1.49.2",
    ]);
    expect(extractLockedVersions("playwright-core", "yarn.lock", yarnLock)).toEqual(["1.50.1"]);
    expect(extractLockedVersions("playwright-core", "bun.lock", bunLock)).toEqual(["1.52.0"]);
  });

  it("ignores test/fixture/vendor lockfiles and honors exceptions.json Playwright waivers", () => {
    const filtered = filterPlaywrightLockfiles([
      "pnpm-lock.yaml",
      "tests/fixtures/old-app/package-lock.json",
      "vendor/sample/yarn.lock",
      "apps/web/pnpm-lock.yaml",
    ]);
    expect(filtered).toEqual(["pnpm-lock.yaml", "apps/web/pnpm-lock.yaml"]);

    const oldPnpm =
      "lockfileVersion: '9.0'\npackages:\n  playwright-core@1.45.0:\n    resolution: {}\n";
    const freshPnpm =
      "lockfileVersion: '9.0'\npackages:\n  playwright-core@1.52.0:\n    resolution: {}\n";

    // Fixture lockfile with old version is ignored; real root lockfile passes.
    expect(
      checkPlaywrightNeeds({
        repoName: "demo",
        files: {
          "pnpm-lock.yaml": freshPnpm,
          "test/fixtures/legacy/pnpm-lock.yaml": oldPnpm,
        },
        ciPlaywrightVersion: "1.51.0",
      }).ok,
    ).toBe(true);

    // Real root lockfile older than host fails unless waived in exceptions.json.
    const failed = checkPlaywrightNeeds({
      repoName: "demo",
      files: { "pnpm-lock.yaml": oldPnpm },
      ciPlaywrightVersion: "1.51.0",
    });
    expect(failed.ok).toBe(false);
    expect(failed.reason).toContain("1.45.0");

    const dir = mkTempDir("sq-waiver-");
    const exceptionsPath = NodePath.join(dir, "exceptions.json");
    NodeFS.writeFileSync(
      exceptionsPath,
      JSON.stringify({
        repos: { demo: { playbook: { playwright: "temporary pin" } } },
      }),
    );
    const waived = checkPlaywrightNeeds({
      repoName: "demo",
      files: { "pnpm-lock.yaml": oldPnpm },
      ciPlaywrightVersion: "1.51.0",
      exceptionsPath,
    });
    expect(waived.ok).toBe(true);
    expect(waived.waived).toBe(true);
  });

  it("evaluates dynamic ship_ci_needs scripts and merges branch compose services", async () => {
    const dir = mkTempDir("sq-needs-");
    const stepTree = NodePath.join(dir, "base");
    NodeFS.mkdirSync(NodePath.join(stepTree, "scripts"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stepTree, "scripts", "needs.sh"), "echo web\n");

    const manifest = validateCiHostsManifest({
      schema: 1,
      hosts: [{ name: "local", ssh: null, role: "ci", data_root: "~/data" }],
      toolchain: {
        node: { version: ">=22", probe: "node -v", install: null, base: true },
        vp: { version: ">=0.1", probe: "vp --version", install: null },
      },
    }).manifest!;

    const baseDecl = parseShipDeclaration(
      [
        "ship_repo=demo",
        "ship_ci_setting=web vp@>=0.1",
        "ship_ci_needs=scripts/needs.sh",
        "ship_ci_service=postgres",
      ].join("\n"),
    );

    const needs = await evaluateJobCiNeeds({
      decl: baseDecl,
      manifest,
      stepTree,
      worktree: dir,
      baseRef: "origin/main",
      run: nodeProcessRunner,
    });
    expect(needs.ok).toBe(true);
    if (needs.ok) {
      expect(needs.settings).toEqual(["web"]);
      expect(needs.toolSpecs).toEqual(["vp@>=0.1"]);
    }

    const compose = resolveComposeFiles(
      new Set(["docker-compose.yml", "docker-compose.override.yml"]),
    );
    expect(compose.ok).toBe(true);
    if (compose.ok) {
      expect(compose.files).toEqual(["docker-compose.yml", "docker-compose.override.yml"]);
    }

    const services = resolveJobCiServices({
      baseDecl,
      tipConfText: "ship_ci_service=postgres\nship_ci_service=redis\n",
      composeServices: new Set(["postgres", "redis"]),
    });
    expect(services.ok).toBe(true);
    if (services.ok) {
      expect(services.services).toEqual(["postgres", "redis"]);
      expect(services.added).toEqual(["redis"]);
    }
  });
});

describe("CI capability/arch routing with in-memory telemetry, battery skip, settle window, and parking", () => {
  const fixedNowSec = 1_700_000_500;
  const freshTs = "2023-11-14T22:21:30Z"; // epoch 1700000490 (10s before fixedNowSec)

  function makeManifest() {
    return validateCiHostsManifest({
      schema: 1,
      hosts: [
        { name: "hub", ssh: null, role: "ci", priority: 2, data_root: "~/data" },
        {
          name: "worker-1",
          ssh: "ci-host-1.example",
          role: "ci",
          priority: 1,
          data_root: "~/data",
        },
        { name: "mac-arm", ssh: "mac-arm.example", role: "ci", priority: 3, data_root: "~/data" },
        {
          name: "guest-vm",
          ssh: "guest-vm.example",
          role: "ci",
          priority: 4,
          on: "parent-laptop",
          data_root: "~/data",
        },
      ],
      toolchain: {
        git: { version: ">=2.40", probe: "git --version", install: null, base: true },
        vp: { version: ">=0.1", probe: "vp --version", install: null },
      },
    }).manifest!;
  }

  function sample(
    name: string,
    cpus: number,
    cpuHist: number[],
    power: "ac" | "battery" = "ac",
  ): FleetNodeTelemetrySample {
    const cpuPct = cpuHist[cpuHist.length - 1] ?? 0;
    return {
      host: { name, cpus, cpu_pct: cpuPct, cpu_hist: cpuHist, ts: freshTs },
      status: "ok",
      power,
    };
  }

  it("routes by priority, room limit, active settle-window lease, arch filter, battery skip, and guest parent", () => {
    const queueRoot = mkTempDir("sq-route-");
    const manifest = makeManifest();
    const manifestPath = NodePath.join(queueRoot, "ci-hosts.json");
    NodeFS.writeFileSync(manifestPath, JSON.stringify(manifest));
    const probes = {
      hub: { __os: "linux", __arch: "x86_64", git: "2.43.0", vp: "0.1.18" },
      "worker-1": { __os: "linux", __arch: "x86_64", git: "2.43.0", vp: "0.1.18" },
      "mac-arm": { __os: "darwin", __arch: "arm64", git: "2.43.0", vp: "0.1.18" },
      "guest-vm": { __os: "linux", __arch: "x86_64", git: "2.43.0", vp: "0.1.18" },
    };

    const nodes: Record<string, FleetNodeTelemetrySample> = {
      hub: sample("hub", 8, [5, 5, 5, 5]),
      "worker-1": sample("worker-1", 8, [5, 5, 5, 5]),
      "mac-arm": sample("mac-arm", 8, [5, 5, 5, 5], "battery"),
      "parent-laptop": sample("parent-laptop", 8, [10, 10, 10, 10], "battery"),
    };
    const telemetry: FleetTelemetryProvider = {
      getNodesMap: () => nodes,
      getLocalPower: () => ({ onBattery: "false" }),
    };

    // Priority 1 worker-1 wins when idle.
    const r1 = routeCiJob({
      queueRoot,
      manifest,
      telemetry,
      probesByHost: probes,
      requiredTools: ["vp"],
      activeLeases: [],
      nowEpochSec: fixedNowSec,
    });
    expect(r1.kind).toBe("routed");
    if (r1.kind === "routed") expect(r1.target.host).toBe("worker-1");

    // When worker-1 has 4 active leases within the settle window (limit = floor(8/2) = 4), hub is chosen.
    const r2 = routeCiJob({
      queueRoot,
      manifest,
      telemetry,
      probesByHost: probes,
      requiredTools: ["vp"],
      activeLeases: [
        { jobId: "j1", host: "worker-1", routedAtSec: fixedNowSec - 15, ciDone: false },
        { jobId: "j2", host: "worker-1", routedAtSec: fixedNowSec - 10, ciDone: false },
        { jobId: "j3", host: "worker-1", routedAtSec: fixedNowSec - 5, ciDone: false },
        { jobId: "j4", host: "worker-1", routedAtSec: fixedNowSec - 2, ciDone: false },
      ],
      nowEpochSec: fixedNowSec,
    });
    expect(r2.kind).toBe("routed");
    if (r2.kind === "routed") expect(r2.target.host).toBe("hub");

    // Arch-filtered arm64 job skips mac-arm because it is on battery.
    const rBattery = routeCiJob({
      queueRoot,
      manifest,
      telemetry,
      probesByHost: probes,
      requiredTools: ["vp"],
      requiredArch: ["arm64"],
      activeLeases: [],
      nowEpochSec: fixedNowSec,
    });
    expect(rBattery.kind).toBe("on_battery");
    if (rBattery.kind === "on_battery") expect(rBattery.hosts).toEqual(["mac-arm"]);

    // Switching hub + worker-1 off leaves only guest-vm for x86_64, whose parent is on battery!
    setCiHostAvailability({
      queueRoot,
      hostName: "hub",
      enabled: false,
      manifestPath,
      nowIso: () => freshTs,
    });
    setCiHostAvailability({
      queueRoot,
      hostName: "worker-1",
      enabled: false,
      manifestPath,
      nowIso: () => freshTs,
    });
    const rGuestBattery = routeCiJob({
      queueRoot,
      manifest,
      telemetry,
      probesByHost: probes,
      requiredTools: ["vp"],
      requiredArch: ["x86_64"],
      activeLeases: [],
      nowEpochSec: fixedNowSec,
    });
    expect(rGuestBattery.kind).toBe("on_battery");

    // Switching guest-vm off too parks the job for ci-host-off, and unparks when worker-1 turns back on.
    setCiHostAvailability({
      queueRoot,
      hostName: "guest-vm",
      enabled: false,
      manifestPath,
      nowIso: () => freshTs,
    });
    const rParked = routeCiJob({
      queueRoot,
      manifest,
      telemetry,
      probesByHost: probes,
      requiredTools: ["vp"],
      requiredArch: ["x86_64"],
      activeLeases: [],
      nowEpochSec: fixedNowSec,
    });
    expect(rParked.kind).toBe("park_off");
    if (rParked.kind === "park_off") {
      const park = { for: "ci-host-off" as const, hosts: rParked.hosts, atSec: fixedNowSec };
      expect(isParkedJobReady(queueRoot, manifest, park)).toBe(false);
      setCiHostAvailability({
        queueRoot,
        hostName: "worker-1",
        enabled: true,
        manifestPath,
        nowIso: () => freshTs,
      });
      expect(isParkedJobReady(queueRoot, manifest, park)).toBe(true);
    }
  });
});

describe("host probe, availability, and MarsCode payload sync", () => {
  it("resolves MarsCode host-sync payload paths (infra/ci-host + bundled packages) and archives/unpacks cleanly", async () => {
    const repoRoot = NodePath.resolve(import.meta.dirname, "../../..");
    const paths = resolveHostSyncPaths(repoRoot);
    expect(paths).toContain("infra/ci-host");
    expect(paths).toContain("packages/runlog");
    expect(paths).toContain("packages/guard-protocol");
    expect(paths).toContain("packages/playbook");

    // Create a tiny real git repo with infra/ci-host and verify syncCiHostPayload archives and pipes base64 tar.
    const fakeRepo = mkTempDir("sq-syncrepo-");
    const run = async (args: string[]) => {
      const r = await nodeProcessRunner({ command: "git", args, cwd: fakeRepo });
      if (r.exitCode !== 0) throw new Error(r.stderr);
    };
    await run(["init", "-b", "main"]);
    await run(["config", "user.email", "test@example.com"]);
    await run(["config", "user.name", "Test User"]);
    NodeFS.mkdirSync(NodePath.join(fakeRepo, "infra", "ci-host"), { recursive: true });
    NodeFS.writeFileSync(
      NodePath.join(fakeRepo, "infra", "ci-host", "ci-vp.sh"),
      "#!/usr/bin/env bash\n",
    );
    await run(["add", "infra/ci-host/ci-vp.sh"]);
    await run(["commit", "-m", "init"]);

    // Prebuilt CLI bundles ride along at packages/<name>/dist/bin.mjs; a missing one refuses the sync.
    const cliBundles = mkTempDir("sq-clibundles-");
    NodeFS.mkdirSync(NodePath.join(cliBundles, "runlog", "dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cliBundles, "runlog", "dist", "bin.mjs"), "// runlog\n");
    const partial = await syncCiHostPayload({
      host: { name: "ci-host-1", ssh: "ci-host-1.example", role: "ci", data_root: "~/data" },
      marscodeRoot: fakeRepo,
      bundleDir: cliBundles,
      deps: { runLocal: nodeProcessRunner },
    });
    expect(partial.ok).toBe(false);
    expect(partial.error).toContain("missing CLI bundle(s) playbook");
    NodeFS.mkdirSync(NodePath.join(cliBundles, "playbook", "dist"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(cliBundles, "playbook", "dist", "bin.mjs"), "// playbook\n");

    let receivedStdin = "";
    const synced = await syncCiHostPayload({
      host: { name: "ci-host-1", ssh: "ci-host-1.example", role: "ci", data_root: "~/data" },
      marscodeRoot: fakeRepo,
      bundleDir: cliBundles,
      deps: {
        runLocal: nodeProcessRunner,
        runRemote: async (_alias, _script, opts) => {
          receivedStdin = opts?.stdin ?? "";
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(synced.ok).toBe(true);
    expect(synced.paths).toEqual([
      "infra/ci-host",
      "packages/runlog/dist/bin.mjs",
      "packages/playbook/dist/bin.mjs",
    ]);
    const shipped = await nodeProcessRunner({
      command: "bash",
      args: ["-c", "base64 -d | tar -t"],
      cwd: fakeRepo,
      stdin: receivedStdin,
    });
    expect(shipped.stdout.split("\n").filter(Boolean)).toEqual(
      expect.arrayContaining([
        "infra/ci-host/ci-vp.sh",
        "packages/runlog/dist/bin.mjs",
        "packages/playbook/dist/bin.mjs",
      ]),
    );

    // The playbook's design scan rides along when its release holds one.
    NodeFS.writeFileSync(
      NodePath.join(cliBundles, "playbook", "dist", "pb_design_scan.mjs"),
      "// scan\n",
    );
    let withScanStdin = "";
    const withScan = await syncCiHostPayload({
      host: { name: "ci-host-1", ssh: "ci-host-1.example", role: "ci", data_root: "~/data" },
      marscodeRoot: fakeRepo,
      bundleDir: cliBundles,
      deps: {
        runLocal: nodeProcessRunner,
        runRemote: async (_alias, _script, opts) => {
          withScanStdin = opts?.stdin ?? "";
          return { exitCode: 0, stdout: "", stderr: "" };
        },
      },
    });
    expect(withScan.paths).toContain("packages/playbook/dist/pb_design_scan.mjs");
    const shippedScan = await nodeProcessRunner({
      command: "bash",
      args: ["-c", "base64 -d | tar -xO packages/playbook/dist/pb_design_scan.mjs"],
      cwd: fakeRepo,
      stdin: withScanStdin,
    });
    expect(shippedScan.stdout).toBe("// scan\n");

    // Rejects option-like sourceRef before calling git archive.
    const badRef = await syncCiHostPayload({
      host: { name: "ci-host-1", ssh: "ci-host-1.example", role: "ci", data_root: "~/data" },
      marscodeRoot: fakeRepo,
      sourceRef: "--output=/tmp/evil.tar",
      deps: { runLocal: nodeProcessRunner },
    });
    expect(badRef.ok).toBe(false);
    expect(badRef.error).toContain("invalid sourceRef");

    // Propagates WSL distro into root grant commands cleanly.
    const wslReq = buildRootGrantRequest(
      { jq: { root: { linux: "/usr/bin/apt-get install -y jq" } } },
      [
        {
          host: "win-wsl",
          ssh: "win-wsl.example",
          home: "/home/ci",
          os: "linux",
          wsl: "Ubuntu",
          tools: ["jq"],
        },
      ],
    );
    expect(wslReq.hosts[0]!.grant[0]).toContain("wsl.exe -d Ubuntu -u root -e");
    expect(wslReq.hosts[0]!.local[0]).toContain("wsl.exe -d Ubuntu -u root -e");
  });

  it("toggles host off/on state and produces schema-1 checkCiHosts output", async () => {
    const queueRoot = mkTempDir("sq-check-");
    const manifestPath = NodePath.join(queueRoot, "ci-hosts.json");
    NodeFS.writeFileSync(
      manifestPath,
      JSON.stringify({
        schema: 1,
        hosts: [{ name: "local", ssh: null, role: "ci", data_root: "~/data" }],
        toolchain: {
          git: { version: ">=2.0", probe: "echo git version 2.45.0", install: null, base: true },
        },
      }),
    );

    expect(isHostOff(queueRoot, "local")).toBe(false);
    setCiHostAvailability({
      queueRoot,
      hostName: "local",
      enabled: false,
      manifestPath,
      nowIso: () => "2023-11-14T22:21:30Z",
    });
    expect(isHostOff(queueRoot, "local")).toBe(true);

    const report = await checkCiHosts({
      queueRoot,
      manifestPath,
      deps: {
        nowMs: () => 1_700_000_000_000,
        runLocal: nodeProcessRunner,
      },
    });
    expect(report.ok).toBe(true);
    expect(report.report?.schema).toBe(1);
    expect(report.report?.hosts).toHaveLength(1);
    expect(report.report?.hosts[0]!.ci_off).toBe(true);
    expect(report.report?.hosts[0]!.reached).toBe(true);
  });
});
