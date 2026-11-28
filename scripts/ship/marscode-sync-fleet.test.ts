// @effect-diagnostics-next-line nodeBuiltinImport:off -- tests standalone post-merge sync runner directly against Node child_process (#81).
import * as NodeChildProcess from "node:child_process";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- tests standalone post-merge sync runner directly against Node fs (#81).
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- tests standalone post-merge sync runner directly against Node path (#81).
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseCliArgs } from "./marscode-sync-cli.ts";
import {
  chooseFleetVersion,
  parseFleetConfig,
  type FleetHostConfig,
} from "./marscode-sync-fleet-config.ts";
import {
  assertValidSha,
  assertValidVersion,
  buildLinuxActivateScript,
  buildMacDeployScript,
  remotePathExpr,
} from "./marscode-sync-fleet-scripts.ts";
import { readFleetConfig, runFleetSync, type CommandRunner } from "./marscode-sync-fleet.ts";
import {
  APP_IMAGE_TARGET_ID,
  SYNC_BINARY_TARGETS,
  parseSyncState,
  planSync,
  type SyncState,
} from "./marscode-sync-plan.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ALL_BINS = new Set(SYNC_BINARY_TARGETS.map((t) => t.binName));

const SAMPLE_HOSTS: ReadonlyArray<FleetHostConfig> = [
  { name: "worker-a", ssh: "worker-a", kind: "linux-x64-server" },
  { name: "wsl-box", ssh: "wsl-box", kind: "linux-x64-server" },
  {
    name: "mac-laptop",
    ssh: "mac-laptop",
    kind: "macos-arm64-app",
    repo: "~/Dev/marscode",
    dataRoot: "~/.local/share/marscode-sync",
    appPath: "/Applications/T3 Code (Nightly).app",
  },
];

function syncedState(sha: string): SyncState {
  const targets: Record<string, string> = { [APP_IMAGE_TARGET_ID]: sha };
  for (const t of SYNC_BINARY_TARGETS) targets[t.id] = sha;
  return {
    version: 1,
    installSha: sha,
    targets,
    fleetHosts: {
      "worker-a": { sha, version: "0.1.12-nightly.20261128.1" },
      "wsl-box": { sha, version: "0.1.12-nightly.20261128.1" },
      "mac-laptop": { sha, version: "0.1.12-nightly.20261128.1" },
    },
  };
}

describe("fleet-deploy.json parsing and validation", () => {
  it("parses valid linux-x64-server and macos-arm64-app entries and returns [] when absent", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-fleet-cfg-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    expect(readFleetConfig(NodePath.join(dir, "missing.json"))).toEqual([]);

    const parsed = parseFleetConfig(JSON.stringify({ schema: 1, hosts: SAMPLE_HOSTS }));
    expect(parsed).toEqual(SAMPLE_HOSTS);
  });

  it("rejects ssh option injection, shell metacharacters, duplicate names, and unknown kinds", () => {
    expect(() =>
      parseFleetConfig(
        JSON.stringify({
          schema: 1,
          hosts: [{ name: "bad", ssh: "-oProxyCommand=evil", kind: "linux-x64-server" }],
        }),
      ),
    ).toThrow(/invalid ssh target/);

    expect(() =>
      parseFleetConfig(
        JSON.stringify({
          schema: 1,
          hosts: [{ name: "bad", ssh: "host;rm -rf /", kind: "linux-x64-server" }],
        }),
      ),
    ).toThrow(/invalid ssh target/);

    expect(() =>
      parseFleetConfig(
        JSON.stringify({
          schema: 1,
          hosts: [
            { name: "dup", ssh: "a", kind: "linux-x64-server" },
            { name: "dup", ssh: "b", kind: "linux-x64-server" },
          ],
        }),
      ),
    ).toThrow(/duplicate fleet host name/);

    expect(() =>
      parseFleetConfig(
        JSON.stringify({
          schema: 1,
          hosts: [{ name: "win", ssh: "win-box", kind: "windows-x64" }],
        }),
      ),
    ).toThrow(/unsupported kind/);
  });
});

describe("fleet version selection and diff planning", () => {
  it("increments nightly sequence monotonically on the same day and resets on the next day", () => {
    const v1 = chooseFleetVersion({ desktopVersion: "0.1.11", date: "20261128" });
    expect(v1).toBe("0.1.12-nightly.20261128.1");

    const v2 = chooseFleetVersion({
      desktopVersion: "0.1.11",
      previousVersion: v1,
      date: "20261128",
    });
    expect(v2).toBe("0.1.12-nightly.20261128.2");

    const v3 = chooseFleetVersion({
      desktopVersion: "0.1.11",
      previousVersion: v2,
      date: "20261129",
    });
    expect(v3).toBe("0.1.12-nightly.20261129.1");
  });

  it("plans only macos-arm64-app on desktop-only changes without triggering a local linux worktree build", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: true,
      fleetHosts: SAMPLE_HOSTS,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["apps/desktop/src/main.ts"],
    });

    const decisions = Object.fromEntries(
      plan.fleet.hosts.map((entry) => [entry.host.name, entry.decision.action]),
    );
    expect(decisions).toEqual({ "worker-a": "skip", "wsl-box": "skip", "mac-laptop": "build" });
    expect(plan.fleet.needsLinuxBuild).toBe(false);
    expect(plan.fleet.anyHostToSync).toBe(true);
    expect(plan.needsWorktreeUpdate).toBe(false);
  });

  it("coalesces fleet rollout during bursts and retries hosts that did not advance", () => {
    const burst = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 2,
      force: false,
      skipApp: false,
      fleetHosts: SAMPLE_HOSTS,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["apps/server/src/server.ts"],
    });
    expect(burst.fleet.anyHostToSync).toBe(false);
    expect(burst.fleet.hosts.every((h) => h.decision.reason === "burst-coalesced")).toBe(true);

    // Round-trip persisted fleetArtifact & fleetHosts state.
    const serialized = JSON.stringify({
      ...syncedState("sha-1"),
      fleetArtifact: {
        sha: "sha-1",
        version: "0.1.12-nightly.20261128.1",
        archivePath:
          "/data/Dev/marscode/fleet-artifacts/sha-1/t3-0.1.12-nightly.20261128.1-linux-x64.tar.gz",
      },
    });
    const parsed = parseSyncState(serialized);
    expect(parsed.fleetArtifact?.version).toBe("0.1.12-nightly.20261128.1");
    expect(parsed.fleetHosts?.["worker-a"]?.sha).toBe("sha-1");
  });

  it("parses --skip-fleet and --fleet-config CLI options", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-cli-fleet-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const primary = NodePath.join(dir, "repo");
    const dataRoot = NodePath.join(dir, "data");
    NodeFS.mkdirSync(primary);
    NodeFS.mkdirSync(dataRoot);

    const parsed = parseCliArgs(
      [
        "--primary",
        primary,
        "--data-root",
        dataRoot,
        "--skip-fleet",
        "--fleet-config",
        NodePath.join(dir, "custom-fleet.json"),
      ],
      primary,
    );
    expect(parsed.skipFleet).toBe(true);
    expect(parsed.fleetConfigPath).toBe(NodePath.join(dir, "custom-fleet.json"));
  });
});

describe("remote shell scripts and fleet sync orchestration", () => {
  it("generates read-only SQLite checks, safe quoting, and argv-based osascript quit", () => {
    expect(remotePathExpr("~/Dev/marscode")).toBe("\"$HOME\"/'Dev/marscode'");
    expect(() => assertValidVersion("1.2.3;evil")).toThrow(/invalid fleet version/);
    expect(() => assertValidSha("not-a-sha!")).toThrow(/invalid commit sha/);

    const linuxScript = buildLinuxActivateScript({
      version: "0.1.12-nightly.20261128.1",
      t3Home: "~/.t3",
      remoteArchivePath: "/tmp/t3.tar.gz",
    });
    expect(linuxScript).toContain('sqlite3.connect(f"file:{db}?mode=ro", uri=True)');
    expect(linuxScript).toContain("statev2.sqlite");
    expect(linuxScript).toContain("update '0.1.12-nightly.20261128.1' --yes --allow-downgrade");
    expect(linuxScript).toContain("systemctl --user cat t3code.service");

    const macScript = buildMacDeployScript({
      headSha: "0123456789abcdef0123456789abcdef01234567",
      version: "0.1.12-nightly.20261128.1",
      repo: "~/Dev/marscode",
      dataRoot: "~/.local/share/marscode-sync",
      appPath: "/Applications/T3 Code (Nightly).app",
      t3Home: "~/.t3",
    });
    expect(macScript).toContain("tell application (item 1 of argv) to quit");
    expect(macScript).toContain("-- 'T3 Code (Nightly)'");
    expect(macScript).toContain("--platform mac --target dir --arch arm64");
    expect(macScript).toContain('sqlite3.connect(f"file:{db}?mode=ro", uri=True)');
  });

  it("builds the linux archive once, reuses it from cache, and isolates per-host failures", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-fleet-run-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const worktree = NodePath.join(dir, "worktree");
    const dataRoot = NodePath.join(dir, "data");
    NodeFS.mkdirSync(NodePath.join(worktree, "apps/desktop"), { recursive: true });
    NodeFS.mkdirSync(
      NodePath.join(worktree, "native/resource-monitor/target/x86_64-unknown-linux-gnu/release"),
      { recursive: true },
    );
    NodeFS.writeFileSync(
      NodePath.join(worktree, "apps/desktop/package.json"),
      JSON.stringify({ version: "0.1.11" }),
    );
    NodeFS.writeFileSync(
      NodePath.join(
        worktree,
        "native/resource-monitor/target/x86_64-unknown-linux-gnu/release/t3-resource-monitor",
      ),
      "monitor-bin",
    );
    NodeFS.mkdirSync(dataRoot, { recursive: true });

    const calls: Array<string> = [];
    let archiveBuilds = 0;
    const runner: CommandRunner = {
      runChecked: (command, args) => {
        calls.push(`${command} ${args[0] ?? ""}`);
        if (command === "node" && args[0] === "scripts/build-cli-archive.ts") {
          archiveBuilds += 1;
          const outIdx = args.indexOf("--output-dir");
          const verIdx = args.indexOf("--version");
          const outDir = args[outIdx + 1]!;
          const ver = args[verIdx + 1]!;
          NodeFS.writeFileSync(NodePath.join(outDir, `t3-${ver}-linux-x64.tar.gz`), "fake-tarball");
        }
        return "";
      },
      runCmd: (command, args) => {
        calls.push(`${command} ${args[0] ?? ""}`);
        if (command === "git") return { status: 0, stdout: "", stderr: "" };
        if (command === "rsync") return { status: 0, stdout: "", stderr: "" };
        if (command === "ssh") {
          const target = args[args.indexOf("--") + 1] ?? "";
          const script = args[args.length - 1] ?? "";
          if (target === "worker-a") {
            return script.includes("NEED_STAGE")
              ? { status: 0, stdout: "NEED_STAGE\n", stderr: "" }
              : { status: 0, stdout: "ACTIVATED 0.1.12-nightly.20261128.1\n", stderr: "" };
          }
          if (target === "wsl-box") {
            return script.includes("NEED_STAGE")
              ? { status: 0, stdout: "NEED_STAGE\n", stderr: "" }
              : { status: 0, stdout: "DEFERRED active_runs=2\n", stderr: "" };
          }
          if (target === "mac-laptop") {
            return { status: 255, stdout: "", stderr: "Operation timed out" };
          }
        }
        return { status: 1, stdout: "", stderr: "unexpected command" };
      },
    };

    const sha = "abcdef0123456789abcdef0123456789abcdef01";
    const logs: string[] = [];
    const warns: string[] = [];
    const synced: Record<string, string> = {};
    let builtArtifact: { sha: string; version: string; archivePath: string } | undefined;

    const planned = SAMPLE_HOSTS.map((host) => ({
      host,
      decision: { action: "build" as const, reason: "initial" as const, sinceSha: null },
    }));

    runFleetSync({
      planned,
      needsLinuxBuild: true,
      primary: worktree,
      worktree,
      dataRoot,
      headSha: sha,
      env: {},
      log: (msg) => logs.push(msg),
      warn: (msg) => warns.push(msg),
      onArtifactBuilt: (artifact) => {
        builtArtifact = artifact;
      },
      onHostSynced: (name, record) => {
        synced[name] = record.version;
      },
      date: "20261128",
      runner,
    });

    expect(archiveBuilds).toBe(1);
    expect(builtArtifact?.version).toBe("0.1.12-nightly.20261128.1");
    expect(NodeFS.existsSync(builtArtifact!.archivePath)).toBe(true);
    expect(synced).toEqual({ "worker-a": "0.1.12-nightly.20261128.1" });
    expect(logs.some((l) => l.includes("wsl-box") && l.includes("deferred (active_runs=2)"))).toBe(
      true,
    );
    expect(warns.some((w) => w.includes("mac-laptop") && w.includes("unreachable"))).toBe(true);

    // Second run at the same commit reuses the cached archive without rebuilding.
    runFleetSync({
      planned: [planned[1]!],
      needsLinuxBuild: true,
      primary: worktree,
      worktree,
      dataRoot,
      headSha: sha,
      previousArtifact: builtArtifact,
      env: {},
      log: (msg) => logs.push(msg),
      warn: (msg) => warns.push(msg),
      onArtifactBuilt: () => {},
      onHostSynced: () => {},
      date: "20261128",
      runner,
    });
    expect(archiveBuilds).toBe(1);
  });

  it("loads marscode-sync.ts cleanly from an isolated extracted scripts/ship directory", () => {
    const isolated = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-ship-extract-"));
    cleanups.push(() => NodeFS.rmSync(isolated, { recursive: true, force: true }));
    const shipDir = import.meta.dirname;
    for (const file of NodeFS.readdirSync(shipDir)) {
      if (file.endsWith(".ts") && !file.endsWith(".test.ts")) {
        NodeFS.copyFileSync(NodePath.join(shipDir, file), NodePath.join(isolated, file));
      }
    }
    const res = NodeChildProcess.spawnSync(
      process.execPath,
      [NodePath.join(isolated, "marscode-sync.ts"), "--help"],
      { cwd: isolated, encoding: "utf8" },
    );
    expect(res.status).toBe(0);
    expect(res.stdout).toContain("--fleet-config");
    expect(res.stdout).toContain("--skip-fleet");
  });
});
