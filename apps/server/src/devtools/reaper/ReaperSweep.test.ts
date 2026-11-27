// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildStorageManifest } from "../StorageManifest.ts";
import { ephemeralRootsFromEntries, sweepEphemeralRoots } from "./ReaperEphemeralSweep.ts";
import {
  inside,
  manifestHistoryRoots,
  PathGuard,
  reapableEphemeralEntries,
} from "./ReaperPathGuard.ts";
import { scanProcessPaths } from "./ReaperProcPaths.ts";
import { sweepHost } from "./ReaperHostSweep.ts";
import {
  isMktempName,
  sweepDevExhaust,
  sweepTmpRoots,
  type SweepContext,
} from "./ReaperTempSweep.ts";

const NOW_MS = Date.parse("2030-06-01T00:00:00.000Z");
const HOUR = 3_600_000;
const DAY = 24 * HOUR;
const uid = process.getuid!();
const platform = HostProcess.Platform.defaultValue();
const cleanups: Array<() => void> = [];

afterEach(() => {
  for (const cleanup of cleanups.splice(0).toReversed()) cleanup();
});

function tempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeAged(file: string, ageMs: number, contents = "x"): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
  age(file, ageMs);
}

function age(target: string, ageMs: number): void {
  const seconds = (NOW_MS - ageMs) / 1000;
  NodeFS.utimesSync(target, seconds, seconds);
}

const ctx = (guard: PathGuard, dryRun = false): SweepContext => ({
  uid,
  nowMs: NOW_MS,
  guard,
  dryRun,
  log: () => undefined,
});

describe.skipIf(platform !== "linux" && platform !== "darwin")("reaper sweeps", () => {
  it("sweeps stale ephemeral manifest roots and never touches history roots", async () => {
    const home = tempDir("t3-reaper-home-");
    const manifest = buildStorageManifest({
      baseDir: NodePath.join(home, ".t3"),
      stateDir: NodePath.join(home, ".t3", "userdata"),
      worktreesDir: NodePath.join(home, ".t3", "worktrees"),
      dbPath: NodePath.join(home, ".t3", "userdata", "statev2.sqlite"),
      attachmentsDir: NodePath.join(home, ".t3", "userdata", "attachments"),
      logsDir: NodePath.join(home, ".t3", "userdata", "logs"),
      browserArtifactsDir: NodePath.join(home, ".t3", "userdata", "browser-artifacts"),
      homeDir: home,
      env: {},
      now: "2030-06-01T00:00:00.000Z",
    });
    const staleTmp = NodePath.join(home, ".codex", "tmp", "git-old", "index");
    const freshTmp = NodePath.join(home, ".codex", "tmp", "git-new", "index");
    const staleSnapshot = NodePath.join(home, ".claude", "shell-snapshots", "snapshot-old.sh");
    const oldSession = NodePath.join(
      home,
      ".codex",
      "sessions",
      "2030",
      "01",
      "01",
      "rollout-a.jsonl",
    );
    const oldTranscript = NodePath.join(home, ".claude", "projects", "-slug", "a.jsonl");
    writeAged(staleTmp, 3 * DAY);
    age(NodePath.dirname(staleTmp), 3 * DAY);
    writeAged(freshTmp, HOUR);
    writeAged(staleSnapshot, 30 * DAY);
    writeAged(oldSession, 400 * DAY);
    writeAged(oldTranscript, 400 * DAY);
    const historyRoots = await manifestHistoryRoots(manifest);

    const totals = await sweepEphemeralRoots(
      ephemeralRootsFromEntries(reapableEphemeralEntries(manifest)),
      { ...ctx(new PathGuard(historyRoots)), homeDir: home, historyRoots },
    );

    expect(totals.removed).toBe(2);
    expect(NodeFS.existsSync(NodePath.dirname(staleTmp))).toBe(false);
    expect(NodeFS.existsSync(staleSnapshot)).toBe(false);
    expect(NodeFS.existsSync(freshTmp)).toBe(true);
    expect(NodeFS.readFileSync(oldSession, "utf8")).toBe("x");
    expect(NodeFS.readFileSync(oldTranscript, "utf8")).toBe("x");
  });

  it("skips an ephemeral root that lies inside a history root", async () => {
    const home = tempDir("t3-reaper-nested-");
    const history = NodePath.join(home, "agent", "sessions");
    const nested = NodePath.join(history, "cache");
    const victim = NodePath.join(nested, "transcript.jsonl");
    writeAged(victim, 30 * DAY);

    const totals = await sweepEphemeralRoots([{ path: nested, maxAgeHours: 1, label: "cache" }], {
      ...ctx(new PathGuard([history])),
      homeDir: home,
      historyRoots: [history],
    });

    expect(totals.removed).toBe(0);
    expect(NodeFS.existsSync(victim)).toBe(true);
  });

  it("refuses a stale temp folder while a live process holds a unix socket in it", async () => {
    const root = tempDir("t3-reaper-tmp-");
    const socketDir = NodePath.join(root, "com.example.App.abc123");
    const staleDir = NodePath.join(root, "playwright-old");
    NodeFS.mkdirSync(socketDir);
    writeAged(NodePath.join(staleDir, "trace.zip"), 3 * DAY);
    age(staleDir, 3 * DAY);
    const socketPath = NodePath.join(socketDir, "SingletonSocket");
    const server = NodeNet.createServer();
    await new Promise<void>((resolve) => server.listen(socketPath, resolve));
    age(socketPath, 3 * DAY);
    age(socketDir, 3 * DAY);

    // Other processes on this host may sit in /tmp itself; keep only what this test holds.
    const liveUnder = async () =>
      [...((await scanProcessPaths({ uid, platform }))?.paths ?? [])].filter((p) =>
        inside(p, root),
      );
    const live = await liveUnder();
    expect(live).toContain(socketPath);
    const held = await sweepTmpRoots([root], ctx(new PathGuard(live)));

    expect(held.skippedActive).toBe(1);
    expect(held.dirs).toBe(1);
    expect(NodeFS.existsSync(socketPath)).toBe(true);
    expect(NodeFS.existsSync(staleDir)).toBe(false);

    await new Promise<void>((resolve) => server.close(() => resolve()));
    NodeFS.rmSync(socketPath, { force: true });
    age(socketDir, 3 * DAY);
    const released = await sweepTmpRoots([root], ctx(new PathGuard(await liveUnder())));
    expect(released.dirs).toBe(1);
    expect(NodeFS.existsSync(socketDir)).toBe(false);
  });

  it("removes only stale no-git exhaust under /data/Dev-style repo folders", async () => {
    const devRoot = tempDir("t3-reaper-dev-");
    const repo = NodePath.join(devRoot, "app");
    const stale = NodePath.join(repo, "scratch-run");
    const withGit = NodePath.join(repo, "audit-wt");
    const recent = NodePath.join(repo, "bench-today");
    const shared = NodePath.join(repo, "tools");
    const evidenceRun = NodePath.join(repo, "evidence", "run-1");
    const mktemp = NodePath.join(repo, "tmp.Ab12Cd");
    const golden = NodePath.join(repo, "fixtures.golden");
    writeAged(NodePath.join(stale, "out.log"), 10 * DAY);
    writeAged(NodePath.join(withGit, ".git", "HEAD"), 10 * DAY);
    writeAged(NodePath.join(recent, "out.log"), HOUR);
    writeAged(NodePath.join(shared, "bin"), 30 * DAY);
    writeAged(NodePath.join(evidenceRun, "shot.png"), 10 * DAY);
    writeAged(NodePath.join(mktemp, "f"), 2 * DAY);
    writeAged(NodePath.join(golden, "f"), 30 * DAY);
    for (const dir of [
      stale,
      withGit,
      NodePath.join(withGit, ".git"),
      shared,
      evidenceRun,
      mktemp,
      golden,
    ]) {
      age(dir, 10 * DAY);
    }

    const removed = await sweepDevExhaust(devRoot, ctx(new PathGuard([])));

    expect(removed).toBe(3);
    expect(NodeFS.existsSync(stale)).toBe(false);
    expect(NodeFS.existsSync(evidenceRun)).toBe(false);
    expect(NodeFS.existsSync(mktemp)).toBe(false);
    expect(NodeFS.existsSync(withGit)).toBe(true);
    expect(NodeFS.existsSync(recent)).toBe(true);
    expect(NodeFS.existsSync(shared)).toBe(true);
    expect(NodeFS.existsSync(golden)).toBe(true);
  });

  it("counts without removing in a dry run", async () => {
    const root = tempDir("t3-reaper-dry-");
    const stale = NodePath.join(root, "old.txt");
    writeAged(stale, 3 * DAY);

    const counted = await sweepTmpRoots([root], ctx(new PathGuard([]), true));

    expect(counted.files).toBe(1);
    expect(NodeFS.existsSync(stale)).toBe(true);
  });
  it("never walks or removes across a mount point", async () => {
    const root = tempDir("t3-reaper-mount-");
    const mounted = NodePath.join(root, "share-mount");
    const holder = NodePath.join(root, "holds-mount");
    const plain = NodePath.join(root, "plain-old");
    writeAged(NodePath.join(mounted, "data.bin"), 3 * DAY);
    writeAged(NodePath.join(holder, "inner", "data.bin"), 3 * DAY);
    writeAged(NodePath.join(plain, "data.bin"), 3 * DAY);
    for (const dir of [mounted, holder, NodePath.join(holder, "inner"), plain]) age(dir, 3 * DAY);
    // Stand in two mounts: the folder itself, and a folder one level inside another.
    const foreign = new Set([mounted, NodePath.join(holder, "inner")]);
    const deviceOf = async (target: string) => {
      const dev = NodeFS.lstatSync(target, { throwIfNoEntry: false })?.dev;
      return dev === undefined ? null : foreign.has(target) ? dev + 1 : dev;
    };

    const swept = await sweepTmpRoots([root], { ...ctx(new PathGuard([])), deviceOf });

    expect(swept.dirs).toBe(1);
    expect(NodeFS.existsSync(plain)).toBe(false);
    expect(NodeFS.existsSync(NodePath.join(mounted, "data.bin"))).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(holder, "inner", "data.bin"))).toBe(true);

    const ephemeral = await sweepEphemeralRoots([{ path: root, maxAgeHours: 1, label: "tmp" }], {
      ...ctx(new PathGuard([])),
      deviceOf,
      homeDir: tempDir("t3-reaper-mount-home-"),
      historyRoots: [],
    });
    expect(ephemeral.removed).toBe(0);
    expect(NodeFS.existsSync(NodePath.join(holder, "inner", "data.bin"))).toBe(true);
  });

  it("refuses every file sweep when the live-process scan failed or saw nothing", async () => {
    const home = tempDir("t3-reaper-host-");
    const tmpRoot = NodePath.join(home, "tmp");
    const devRoot = NodePath.join(home, "dev");
    const staleTmp = NodePath.join(tmpRoot, "old.txt");
    const exhaust = NodePath.join(devRoot, "app", "scratch-run");
    writeAged(staleTmp, 3 * DAY);
    writeAged(NodePath.join(exhaust, "out.log"), 10 * DAY);
    age(exhaust, 10 * DAY);
    const manifest = buildStorageManifest({
      baseDir: NodePath.join(home, ".t3"),
      stateDir: NodePath.join(home, ".t3", "userdata"),
      worktreesDir: NodePath.join(home, ".t3", "worktrees"),
      dbPath: NodePath.join(home, ".t3", "userdata", "statev2.sqlite"),
      attachmentsDir: NodePath.join(home, ".t3", "userdata", "attachments"),
      logsDir: NodePath.join(home, ".t3", "userdata", "logs"),
      browserArtifactsDir: NodePath.join(home, ".t3", "userdata", "browser-artifacts"),
      homeDir: home,
      env: {},
      now: "2030-06-01T00:00:00.000Z",
    });
    const run = (scan: Parameters<typeof sweepHost>[0]["scan"]) =>
      sweepHost({
        scan,
        historyRoots: [],
        manifest,
        policyRules: [],
        tmpRoots: [tmpRoot],
        devRoots: [devRoot],
        uid,
        nowMs: NOW_MS,
        homeDir: home,
        log: () => undefined,
      });

    expect((await run(null)).refused).toBe("the live-process scan failed");
    expect((await run({ paths: new Set(), otherProcesses: 0 })).refused).toBe(
      "read no process but this one",
    );
    expect(NodeFS.existsSync(staleTmp)).toBe(true);
    expect(NodeFS.existsSync(exhaust)).toBe(true);

    const trusted = await run({ paths: new Set(["/proc/1/fake"]), otherProcesses: 4 });
    expect(trusted.refused).toBeNull();
    expect(trusted.tmp.removed).toBe(1);
    expect(trusted.exhaust).toBe(1);
    expect(NodeFS.existsSync(staleTmp)).toBe(false);
  });

  it("treats only random mktemp suffixes as mktemp, never words in any case", () => {
    for (const name of ["tmp.Ab12Cd", "tmp.x7k2qp", "tmp.aBcDeF"])
      expect(isMktempName(name)).toBe(true);
    for (const name of [
      "fixtures.golden",
      "fixtures.Golden",
      "db.Backup",
      "ui.ASSETS",
      "a.backup",
    ]) {
      expect(isMktempName(name)).toBe(false);
    }
  });
});
