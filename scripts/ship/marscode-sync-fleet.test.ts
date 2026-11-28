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
  FLEET_ROLLOUT_TARGET_ID,
  chooseFleetVersion,
  parseFleetConfig,
  type FleetHostConfig,
} from "./marscode-sync-fleet-config.ts";
import {
  assertValidSha,
  assertValidVersion,
  buildLinuxActivateScript,
  buildLinuxStageProbeScript,
  buildMacDeployScript,
  remotePathExpr,
} from "./marscode-sync-fleet-scripts.ts";
import {
  loadFleetHostsForSync,
  readFleetConfig,
  runFleetSync,
  type CommandRunner,
} from "./marscode-sync-fleet.ts";
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

function makeTempDir(prefix: string): string {
  const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeExecutable(filePath: string, content: string): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  NodeFS.writeFileSync(filePath, content, { mode: 0o755 });
}

function runPython(code: string, args: ReadonlyArray<string>): void {
  const res = NodeChildProcess.spawnSync("python3", ["-c", code, ...args], { encoding: "utf8" });
  if (res.status !== 0) {
    throw new Error(`python3 fixture failed: ${res.stderr}`);
  }
}

describe("fleet-deploy.json parsing, validation, and safe loading", () => {
  it("parses valid entries, returns [] when absent, and honors --skip-fleet / invalid JSON policy", () => {
    const dir = makeTempDir("marscode-fleet-cfg-");
    expect(readFleetConfig(NodePath.join(dir, "missing.json"))).toEqual([]);

    const parsed = parseFleetConfig(JSON.stringify({ schema: 1, hosts: SAMPLE_HOSTS }));
    expect(parsed).toEqual(SAMPLE_HOSTS);

    const badPath = NodePath.join(dir, "bad.json");
    NodeFS.writeFileSync(badPath, "{not-json");
    const warnings: string[] = [];
    expect(
      loadFleetHostsForSync({
        configPath: badPath,
        skipFleet: true,
        warn: (m) => warnings.push(m),
      }),
    ).toEqual([]);
    expect(warnings).toEqual([]);

    expect(
      loadFleetHostsForSync({
        configPath: badPath,
        skipFleet: false,
        warn: (m) => warnings.push(m),
      }),
    ).toEqual([]);
    expect(warnings.some((w) => w.includes("ignoring invalid fleet config"))).toBe(true);

    expect(() =>
      loadFleetHostsForSync({
        configPath: badPath,
        skipFleet: false,
        only: new Set(["fleet"]),
        warn: () => {},
      }),
    ).toThrow();
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
  it("increments nightly sequence monotonically and resets on the next day", () => {
    const v1 = chooseFleetVersion({ desktopVersion: "0.1.11", date: "20261128" });
    expect(v1).toBe("0.1.12-nightly.20261128.1");
    const v2 = chooseFleetVersion({
      desktopVersion: "0.1.11",
      previousVersion: v1,
      date: "20261128",
    });
    expect(v2).toBe("0.1.12-nightly.20261128.2");
    expect(
      chooseFleetVersion({ desktopVersion: "0.1.11", previousVersion: v2, date: "20261129" }),
    ).toBe("0.1.12-nightly.20261129.1");
  });

  it("plans desktop-only changes for macos-arm64-app only and supports --only filters", () => {
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
    expect(
      Object.fromEntries(plan.fleet.hosts.map((e) => [e.host.name, e.decision.action])),
    ).toEqual({ "worker-a": "skip", "wsl-box": "skip", "mac-laptop": "build" });
    expect(plan.fleet.needsLinuxBuild).toBe(false);
    expect(plan.needsWorktreeUpdate).toBe(false);

    // Server trust checks in packages/host-guards/ must trigger linux-x64-server rollout.
    const guardPlan = planSync({
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
      listChangedFiles: () => ["packages/host-guards/src/queueTrust.ts"],
    });
    expect(
      Object.fromEntries(guardPlan.fleet.hosts.map((e) => [e.host.name, e.decision.action])),
    ).toEqual({ "worker-a": "build", "wsl-box": "build", "mac-laptop": "skip" });

    const singleHost = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: true,
      skipApp: false,
      only: new Set(["wsl-box"]),
      fleetHosts: SAMPLE_HOSTS,
      desktopHost: { eligible: true },
      listChangedFiles: () => [],
    });
    expect(
      Object.fromEntries(singleHost.fleet.hosts.map((e) => [e.host.name, e.decision.action])),
    ).toEqual({ "worker-a": "skip", "wsl-box": "build", "mac-laptop": "skip" });

    const allFleet = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: true,
      skipApp: false,
      only: new Set([FLEET_ROLLOUT_TARGET_ID]),
      fleetHosts: SAMPLE_HOSTS,
      desktopHost: { eligible: true },
      listChangedFiles: () => [],
    });
    expect(allFleet.fleet.hosts.every((e) => e.decision.action === "build")).toBe(true);
  });

  it("coalesces bursts, round-trips fleet state, and parses CLI flags", () => {
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

    const parsed = parseSyncState(
      JSON.stringify({
        ...syncedState("sha-1"),
        fleetArtifact: {
          sha: "sha-1",
          version: "0.1.12-nightly.20261128.1",
          archivePath: "/data/fleet/t3.tar.gz",
        },
      }),
    );
    expect(parsed.fleetArtifact?.version).toBe("0.1.12-nightly.20261128.1");
    expect(parsed.fleetHosts?.["worker-a"]?.sha).toBe("sha-1");

    const dir = makeTempDir("marscode-cli-fleet-");
    const primary = NodePath.join(dir, "repo");
    const dataRoot = NodePath.join(dir, "data");
    NodeFS.mkdirSync(primary);
    NodeFS.mkdirSync(dataRoot);
    const cli = parseCliArgs(
      [
        "--primary",
        primary,
        "--data-root",
        dataRoot,
        "--skip-fleet",
        "--fleet-config",
        NodePath.join(dir, "custom.json"),
      ],
      primary,
    );
    expect(cli.skipFleet).toBe(true);
    expect(cli.fleetConfigPath).toBe(NodePath.join(dir, "custom.json"));
    expect(remotePathExpr("~/Dev/marscode")).toBe("\"$HOME\"/'Dev/marscode'");
    expect(() => assertValidVersion("1.2.3;evil")).toThrow(/invalid fleet version/);
    expect(() => assertValidSha("bad-sha!")).toThrow(/invalid commit sha/);
  });
});

describe("real POSIX shell execution of remote Linux and macOS scripts", () => {
  it("runs Linux probe and activate script against real SQLite states (active, live collision, locked, missing table, corrupt, idle)", () => {
    const dir = makeTempDir("marscode-linux-sh-");
    const t3Home = NodePath.join(dir, "t3home");
    const stubBin = NodePath.join(dir, "bin");
    const version = "0.1.12-nightly.20261128.1";
    const oldSha = "1111111111111111111111111111111111111111";
    const newSha = "2222222222222222222222222222222222222222";
    const verDir = NodePath.join(t3Home, "runtime/versions", version);
    const readyDir = NodePath.join(t3Home, "runtime/versions", `.marscode-ready-${newSha}`);
    const dbPath = NodePath.join(t3Home, "userdata/statev2.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(dbPath), { recursive: true });
    NodeFS.mkdirSync(verDir, { recursive: true });
    const updateLog = NodePath.join(dir, "t3-update.log");
    writeExecutable(
      NodePath.join(verDir, "t3"),
      `#!/bin/sh\necho "OLD $*" >> ${JSON.stringify(updateLog)}\nexit 0\n`,
    );
    NodeFS.writeFileSync(NodePath.join(verDir, ".install-complete"), `${version}\n`);
    NodeFS.writeFileSync(NodePath.join(verDir, ".marscode-sha"), `${oldSha}\n`);
    // Build a real tarball for newSha to exercise version-collision unpacking without touching live verDir.
    const tarballSrc = NodePath.join(dir, "tar-src/t3-bundle");
    writeExecutable(
      NodePath.join(tarballSrc, "t3"),
      `#!/bin/sh\nif [ "$1" = "--version" ]; then echo ${version}; exit 0; fi\necho "NEW $*" >> ${JSON.stringify(updateLog)}\nexit 0\n`,
    );
    const archivePath = NodePath.join(dir, "new-release.tar.gz");
    const tarRes = NodeChildProcess.spawnSync(
      "tar",
      ["-czf", archivePath, "-C", NodePath.join(dir, "tar-src"), "t3-bundle"],
      { encoding: "utf8" },
    );
    expect(tarRes.status).toBe(0);

    writeExecutable(
      NodePath.join(stubBin, "systemctl"),
      '#!/bin/sh\nif [ "$2" = "cat" ]; then exit 0; fi\nif [ "$2" = "is-active" ]; then [ "${3:-}" = "--quiet" ] || echo active; exit 0; fi\nexit 0\n',
    );
    const env = { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ""}` };

    // 1. Stale SHA for same version string must report NEED_STAGE.
    const probeStale = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxStageProbeScript({ version, headSha: newSha, t3Home }),
      encoding: "utf8",
      env,
    });
    expect(probeStale.status).toBe(0);
    expect(probeStale.stdout.trim()).toBe("NEED_STAGE");

    // 2. Active run + same-version collision: unpacks into immutable readyDir and leaves live verDir untouched.
    runPython(
      `import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE orchestration_v2_projection_runs (run_id TEXT, status TEXT)")
c.execute("INSERT INTO orchestration_v2_projection_runs VALUES ('r1', 'running')")
c.commit(); c.close()`,
      [dbPath],
    );
    const collisionRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxActivateScript({
        version,
        headSha: newSha,
        t3Home,
        remoteArchivePath: archivePath,
      }),
      encoding: "utf8",
      env,
    });
    expect(collisionRes.status).toBe(0);
    expect(collisionRes.stdout.trim()).toBe("DEFERRED active_runs=1");
    expect(NodeFS.existsSync(updateLog)).toBe(false);
    // Live version dir still holds oldSha; newSha sits in readyDir so probe now says STAGED.
    expect(NodeFS.readFileSync(NodePath.join(verDir, ".marscode-sha"), "utf8").trim()).toBe(oldSha);
    expect(NodeFS.readFileSync(NodePath.join(readyDir, ".marscode-sha"), "utf8").trim()).toBe(
      newSha,
    );
    const probeReady = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxStageProbeScript({ version, headSha: newSha, t3Home }),
      encoding: "utf8",
      env,
    });
    expect(probeReady.stdout.trim()).toBe("STAGED");

    // 3. Real locked SQLite DB (BEGIN EXCLUSIVE held by another process) must defer as active_runs_unknown.
    const lockReady = NodePath.join(dir, "db.locked");
    const locker = NodeChildProcess.spawn(
      "python3",
      [
        "-c",
        `import sqlite3, sys, time
c = sqlite3.connect(sys.argv[1], isolation_level=None)
c.execute("BEGIN EXCLUSIVE")
open(sys.argv[2], "w").write("1")
time.sleep(10)`,
        dbPath,
        lockReady,
      ],
      { stdio: "ignore" },
    );
    cleanups.push(() => {
      try {
        locker.kill("SIGKILL");
      } catch {
        // already exited
      }
    });
    for (let i = 0; i < 150 && !NodeFS.existsSync(lockReady); i += 1) {
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
    }
    expect(NodeFS.existsSync(lockReady)).toBe(true);
    const lockedRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxActivateScript({ version, headSha: newSha, t3Home }),
      encoding: "utf8",
      env,
    });
    locker.kill("SIGKILL");
    expect(lockedRes.status).toBe(0);
    expect(lockedRes.stdout.trim()).toBe("DEFERRED active_runs_unknown");

    // 4. Corrupt SQLite file also defers as active_runs_unknown.
    const corruptPath = NodePath.join(dir, "t3corrupt");
    const corruptVerDir = NodePath.join(corruptPath, "runtime/versions", version);
    NodeFS.mkdirSync(NodePath.join(corruptPath, "userdata"), { recursive: true });
    NodeFS.mkdirSync(corruptVerDir, { recursive: true });
    writeExecutable(NodePath.join(corruptVerDir, "t3"), "#!/bin/sh\nexit 0\n");
    NodeFS.writeFileSync(NodePath.join(corruptVerDir, ".install-complete"), `${version}\n`);
    NodeFS.writeFileSync(NodePath.join(corruptVerDir, ".marscode-sha"), `${newSha}\n`);
    NodeFS.writeFileSync(NodePath.join(corruptPath, "userdata/statev2.sqlite"), "not-a-sqlite-db");
    const corruptRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxActivateScript({ version, headSha: newSha, t3Home: corruptPath }),
      encoding: "utf8",
      env,
    });
    expect(corruptRes.status).toBe(0);
    expect(corruptRes.stdout.trim()).toBe("DEFERRED active_runs_unknown");

    // 5. Missing orchestration_v2_projection_runs table on a fresh DB counts as 0 active runs and activates.
    const freshPath = NodePath.join(dir, "t3fresh");
    const freshVerDir = NodePath.join(freshPath, "runtime/versions", version);
    const freshDb = NodePath.join(freshPath, "userdata/statev2.sqlite");
    NodeFS.mkdirSync(NodePath.dirname(freshDb), { recursive: true });
    NodeFS.mkdirSync(freshVerDir, { recursive: true });
    writeExecutable(NodePath.join(freshVerDir, "t3"), "#!/bin/sh\nexit 0\n");
    NodeFS.writeFileSync(NodePath.join(freshVerDir, ".install-complete"), `${version}\n`);
    NodeFS.writeFileSync(NodePath.join(freshVerDir, ".marscode-sha"), `${newSha}\n`);
    runPython(
      `import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("CREATE TABLE unrelated (id INTEGER)")
c.commit(); c.close()`,
      [freshDb],
    );
    const freshRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxActivateScript({ version, headSha: newSha, t3Home: freshPath }),
      encoding: "utf8",
      env,
    });
    expect(freshRes.status).toBe(0);
    expect(freshRes.stdout.trim()).toBe(`ACTIVATED ${version}`);

    // 6. Once the active run completes, readyDir swaps into verDir and activates the NEW binary.
    runPython(
      `import sqlite3, sys
c = sqlite3.connect(sys.argv[1])
c.execute("UPDATE orchestration_v2_projection_runs SET status = 'completed'")
c.commit(); c.close()`,
      [dbPath],
    );
    const idleRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: buildLinuxActivateScript({ version, headSha: newSha, t3Home }),
      encoding: "utf8",
      env,
    });
    expect(idleRes.status).toBe(0);
    expect(idleRes.stdout.trim()).toBe(`ACTIVATED ${version}`);
    expect(NodeFS.readFileSync(NodePath.join(verDir, ".marscode-sha"), "utf8").trim()).toBe(newSha);
    expect(NodeFS.readFileSync(updateLog, "utf8")).toContain(
      `NEW update ${version} --yes --allow-downgrade`,
    );
  });

  it("runs macOS script against real ps (no self-match), exercises real slow quit + reopen, stale lock, and failed checkout", () => {
    const dir = makeTempDir("marscode-mac-sh-");
    const repo = NodePath.join(dir, "repo");
    const dataRoot = NodePath.join(dir, "data");
    const t3Home = NodePath.join(dir, "t3home");
    const appsDir = NodePath.join(dir, "Applications");
    const appPath = NodePath.join(appsDir, "T3 Code (Nightly).app");
    const stubBin = NodePath.join(dir, "bin");
    const sha = "0123456789abcdef0123456789abcdef01234567";
    const version = "0.1.12-nightly.20261128.1";

    NodeFS.mkdirSync(NodePath.join(repo, ".git"), { recursive: true });
    NodeFS.mkdirSync(NodePath.join(appPath, "Contents/MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(appPath, "version.txt"), "old");
    const stagedBundle = NodePath.join(dataRoot, "staged-app", sha, "app.bundle");
    NodeFS.mkdirSync(NodePath.join(stagedBundle, "Contents/MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stagedBundle, "version.txt"), "new-real-ps");
    // Stale lock with dead PID must recover automatically.
    NodeFS.mkdirSync(NodePath.join(dataRoot, ".sync.lock"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(dataRoot, ".sync.lock/pid"), "999999999\n");

    const quitLog = NodePath.join(dir, "quit.log");
    const openLog = NodePath.join(dir, "open.log");
    writeExecutable(NodePath.join(stubBin, "ditto"), '#!/bin/sh\ncp -R "$1" "$2"\n');
    writeExecutable(
      NodePath.join(stubBin, "osascript"),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(quitLog)}\nexit 0\n`,
    );
    writeExecutable(
      NodePath.join(stubBin, "open"),
      `#!/bin/sh\necho "$*" >> ${JSON.stringify(openLog)}\nexit 0\n`,
    );

    // 1. Run against REAL system `ps` (not stubbed): idle non-running app with `(Nightly)` must NOT self-match.
    const realPsEnv = { ...process.env, PATH: `${stubBin}:${process.env.PATH ?? ""}` };
    const script = buildMacDeployScript({ headSha: sha, version, repo, dataRoot, appPath, t3Home });
    const idleRealPs = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: realPsEnv,
    });
    expect(idleRealPs.status).toBe(0);
    expect(idleRealPs.stdout.trim()).toBe(`ACTIVATED ${version}`);
    expect(NodeFS.readFileSync(NodePath.join(appPath, "version.txt"), "utf8")).toBe("new-real-ps");
    expect(NodeFS.existsSync(quitLog)).toBe(false);
    expect(NodeFS.existsSync(openLog)).toBe(false);

    // 2. Real slow quit: app stays running past all 30 poll cycles (fast sleep stub) -> defers with
    // `.reopen-app` marker intact; then once the app finishes closing, the next run swaps AND reopens it.
    NodeFS.mkdirSync(NodePath.join(stagedBundle, "Contents/MacOS"), { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stagedBundle, "version.txt"), "new-after-slow-quit");
    const runningFlag = NodePath.join(dir, "app.running");
    NodeFS.writeFileSync(runningFlag, "1");
    writeExecutable(NodePath.join(stubBin, "sleep"), "#!/bin/sh\nexit 0\n");
    writeExecutable(
      NodePath.join(stubBin, "ps"),
      `#!/bin/sh\nif [ -f ${JSON.stringify(runningFlag)} ]; then echo ${JSON.stringify(`${appPath}/Contents/MacOS/T3 Code (Nightly)`)}; fi\n`,
    );

    const slowQuitRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: realPsEnv,
    });
    expect(slowQuitRes.status).toBe(0);
    expect(slowQuitRes.stdout.trim()).toBe("DEFERRED app_still_running");
    expect(NodeFS.readFileSync(quitLog, "utf8")).toContain("T3 Code (Nightly)");
    expect(NodeFS.existsSync(NodePath.join(dataRoot, ".reopen-app"))).toBe(true);
    expect(NodeFS.readFileSync(NodePath.join(appPath, "version.txt"), "utf8")).toBe("new-real-ps");

    // App finishes closing after the timeout; next sync swaps and reopens because of .reopen-app.
    NodeFS.rmSync(runningFlag);
    const secondRunRes = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: script,
      encoding: "utf8",
      env: realPsEnv,
    });
    expect(secondRunRes.status).toBe(0);
    expect(secondRunRes.stdout.trim()).toBe(`ACTIVATED ${version}`);
    expect(NodeFS.readFileSync(NodePath.join(appPath, "version.txt"), "utf8")).toBe(
      "new-after-slow-quit",
    );
    expect(NodeFS.readFileSync(openLog, "utf8")).toContain(appPath);
    expect(NodeFS.existsSync(NodePath.join(dataRoot, ".reopen-app"))).toBe(false);

    // 3. Failed git checkout in the build child `sh -eu` must abort instead of building an older commit.
    const badSha = "9999999999999999999999999999999999999999";
    const failScript = buildMacDeployScript({
      headSha: badSha,
      version,
      repo,
      dataRoot,
      appPath,
      t3Home,
    });
    const failBuild = NodeChildProcess.spawnSync("sh", ["-s"], {
      input: failScript,
      encoding: "utf8",
      env: realPsEnv,
    });
    expect(failBuild.status).not.toBe(0);
    expect(NodeFS.existsSync(NodePath.join(dataRoot, "staged-app", badSha))).toBe(false);
  });
});

describe("runFleetSync orchestration and extracted-tree startup", () => {
  it("builds once, reuses cache, catches per-host throws without blocking later hosts (H3)", () => {
    const dir = makeTempDir("marscode-fleet-run-");
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

    let archiveBuilds = 0;
    const runner: CommandRunner = {
      runChecked: (command, args) => {
        if (command === "node" && args[0] === "scripts/build-cli-archive.ts") {
          archiveBuilds += 1;
          const outDir = args[args.indexOf("--output-dir") + 1]!;
          const ver = args[args.indexOf("--version") + 1]!;
          NodeFS.writeFileSync(NodePath.join(outDir, `t3-${ver}-linux-x64.tar.gz`), "fake-tarball");
        }
        return "";
      },
      runCmd: (command, args, options) => {
        if (command === "git") return { status: 0, stdout: "", stderr: "" };
        if (command === "rsync") return { status: 0, stdout: "", stderr: "" };
        if (command === "ssh") {
          const target = args[args.indexOf("--") + 1] ?? "";
          // Verify sh -s stdin invocation (M1).
          expect(args.slice(-2)).toEqual(["sh", "-s"]);
          const script = options.input ?? "";
          if (target === "worker-a") {
            throw new Error("simulated maxBuffer exceeded");
          }
          if (target === "wsl-box") {
            return script.includes("NEED_STAGE")
              ? { status: 0, stdout: "NEED_STAGE\n", stderr: "" }
              : { status: 0, stdout: "ACTIVATED 0.1.12-nightly.20261128.1\n", stderr: "" };
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
    expect(synced).toEqual({ "wsl-box": "0.1.12-nightly.20261128.1" });
    expect(warns.some((w) => w.includes("worker-a") && w.includes("maxBuffer"))).toBe(true);
    expect(warns.some((w) => w.includes("mac-laptop") && w.includes("unreachable"))).toBe(true);

    // Second run reuses cached archive without rebuilding.
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
    const isolated = makeTempDir("marscode-ship-extract-");
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
