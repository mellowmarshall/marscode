// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import type { SessionArchiveSettings } from "@t3tools/contracts";
import { afterEach, describe, expect, it } from "@effect/vitest";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { buildStorageManifest } from "../devtools/StorageManifest.ts";
import { clearArchiveProbeCache } from "../usage/usageArchiveFsGuard.ts";
import { runSessionArchivePass, sameBytes, sessionAgeDays } from "./SessionArchiveTiering.ts";

const NOW_MS = Date.parse("2030-06-01T00:00:00.000Z");
const DAY = 86_400_000;
const platform = HostProcess.Platform.defaultValue();
const cleanups: Array<() => void> = [];

afterEach(() => {
  clearArchiveProbeCache();
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(prefix: string): string {
  const dir = NodeFS.realpathSync(NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), prefix)));
  cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

function writeAged(file: string, ageMs: number, contents: string | Buffer): void {
  NodeFS.mkdirSync(NodePath.dirname(file), { recursive: true });
  NodeFS.writeFileSync(file, contents);
  const seconds = (NOW_MS - ageMs) / 1000;
  NodeFS.utimesSync(file, seconds, seconds);
}

function fixture() {
  const home = tempDir("t3-archive-home-");
  const archiveRoot = tempDir("t3-archive-share-");
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
  const rollout = NodePath.join(
    home,
    ".codex/sessions/2029/01/01/rollout-2029-01-01T10-00-00-0199aa00-1111-7222-8333-944455556666.jsonl",
  );
  const claudeOld = NodePath.join(home, ".claude/projects/-work/old.jsonl");
  const claudeOpen = NodePath.join(home, ".claude/projects/-work/open.jsonl");
  const claudeRecent = NodePath.join(home, ".claude/projects/-work/recent.jsonl");
  const codexTmp = NodePath.join(home, ".codex/tmp/git-stale/index");
  // Several MB with a varied tail, so a chunked compare covers more than one read.
  const big = Buffer.concat([Buffer.alloc(2.5 * 1024 * 1024, 7), Buffer.from('{"type":"end"}\n')]);
  writeAged(rollout, 500 * DAY, big);
  writeAged(claudeOld, 200 * DAY, '{"type":"user"}\n');
  writeAged(claudeOpen, 200 * DAY, '{"type":"user","open":true}\n');
  writeAged(claudeRecent, 10 * 60_000, '{"type":"user","recent":true}\n');
  writeAged(codexTmp, 3 * DAY, "x");
  const seconds = (NOW_MS - 3 * DAY) / 1000;
  NodeFS.utimesSync(NodePath.dirname(codexTmp), seconds, seconds);
  return {
    home,
    archiveRoot,
    manifest,
    rollout,
    claudeOld,
    claudeOpen,
    claudeRecent,
    codexTmp,
    big,
  };
}

const settings = (
  archiveRoot: string,
  over: Partial<SessionArchiveSettings> = {},
): SessionArchiveSettings => ({
  mode: "move",
  archiveRoot,
  localKeepDays: 90,
  codexTmpAfterHours: 24,
  shellSnapshotsAfterDays: 7,
  symlinkTiered: false,
  ...over,
});

// Temp folders share a device with their parent, so the tests opt in to a local archive.
const pass = (
  f: ReturnType<typeof fixture>,
  s: SessionArchiveSettings,
  over: Partial<Parameters<typeof runSessionArchivePass>[0]> = {},
) =>
  runSessionArchivePass({
    settings: s,
    manifest: f.manifest,
    host: "testhost",
    homeDir: f.home,
    uid: process.getuid!(),
    platform,
    nowMs: NOW_MS,
    allowLocalArchiveRoot: true,
    ...over,
  });

const hostDirOf = (f: ReturnType<typeof fixture>) => NodePath.join(f.archiveRoot, "testhost");

describe.skipIf(platform !== "linux" && platform !== "darwin")("session archive tiering", () => {
  it("dates a Codex rollout by its file name before its mtime", () => {
    expect(sessionAgeDays("rollout-2030-05-01T09-00-00-x.jsonl", NOW_MS, NOW_MS)).toBeCloseTo(
      30.5,
      1,
    );
    expect(sessionAgeDays("a.jsonl", NOW_MS - 3 * DAY, NOW_MS)).toBe(3);
  });

  it("moves verified old sessions behind links, skips open and recent ones, and sweeps Codex temp", async () => {
    const f = fixture();
    const hold = NodeFS.openSync(f.claudeOpen, "r");
    cleanups.push(() => NodeFS.closeSync(hold));

    const entries = await pass(f, settings(f.archiveRoot, { symlinkTiered: true }));

    const hostDir = hostDirOf(f);
    const rolloutCopy = NodePath.join(
      hostDir,
      "codex",
      NodePath.relative(NodePath.join(f.home, ".codex/sessions"), f.rollout),
    );
    expect(NodeFS.readlinkSync(NodePath.join(f.home, ".local/state/session-archive/remote"))).toBe(
      hostDir,
    );
    expect(NodeFS.lstatSync(f.rollout).isSymbolicLink()).toBe(true);
    expect(NodeFS.readlinkSync(f.rollout)).toBe(rolloutCopy);
    expect(NodeFS.readFileSync(f.rollout).equals(f.big)).toBe(true);
    expect(NodeFS.statSync(rolloutCopy).mtimeMs).toBeCloseTo(NOW_MS - 500 * DAY, -1);
    expect(NodeFS.lstatSync(f.rollout).mtimeMs).toBeCloseTo(NOW_MS - 500 * DAY, -1);
    expect(NodeFS.lstatSync(f.claudeOld).isSymbolicLink()).toBe(true);
    expect(NodeFS.lstatSync(f.claudeOpen).isFile()).toBe(true);
    expect(NodeFS.lstatSync(f.claudeRecent).isFile()).toBe(true);
    expect(NodeFS.existsSync(NodePath.join(hostDir, "claude", "-work", "recent.jsonl"))).toBe(
      false,
    );
    expect(NodeFS.existsSync(NodePath.dirname(f.codexTmp))).toBe(false);
    expect(
      NodeFS.readdirSync(NodePath.dirname(f.claudeOld)).filter((n) => n.startsWith(".")),
    ).toEqual([]);

    const summary = entries.find((e) => e.path === hostDir);
    expect(summary?.outcome).toBe("removed");
    expect(summary?.files).toBe(2);
    expect(summary?.reason).toContain("1 open sessions skipped");
    expect(entries.some((e) => e.reason.startsWith("Removed 1 stale Codex temp"))).toBe(true);
    expect(entries.filter((e) => e.outcome === "failed")).toEqual([]);
  });

  it("refuses to move a session whose archive copy differs by a byte", async () => {
    const f = fixture();
    const copy = NodePath.join(f.archiveRoot, "testhost", "claude", "-work", "old.jsonl");
    const original = NodeFS.readFileSync(f.claudeOld);
    const tampered = Buffer.from(original);
    tampered[3] = tampered[3]! ^ 1;
    writeAged(copy, 200 * DAY, tampered);

    const entries = await pass(f, settings(f.archiveRoot));

    expect(NodeFS.lstatSync(f.claudeOld).isFile()).toBe(true);
    expect(NodeFS.readFileSync(f.claudeOld).equals(original)).toBe(true);
    expect(entries.find((e) => e.outcome === "failed" && e.path === f.claudeOld)?.reason).toContain(
      "no longer matches",
    );
    expect(await sameBytes(f.claudeOld, copy)).toBe(false);
  });

  it("mirror mode copies and verifies but keeps every session local", async () => {
    const f = fixture();

    await pass(f, settings(f.archiveRoot, { mode: "mirror" }));

    const copy = NodePath.join(f.archiveRoot, "testhost", "claude", "-work", "old.jsonl");
    expect(NodeFS.lstatSync(f.claudeOld).isFile()).toBe(true);
    expect(NodeFS.lstatSync(f.rollout).isFile()).toBe(true);
    expect(await sameBytes(f.claudeOld, copy)).toBe(true);
  });

  it("keeps sessions local and still sweeps temp when the archive is unavailable", async () => {
    const f = fixture();
    const offline = NodePath.join(f.archiveRoot, "unmounted", "agent-sessions");

    const entries = await pass(f, settings(offline));

    expect(NodeFS.lstatSync(f.rollout).isFile()).toBe(true);
    expect(NodeFS.existsSync(NodePath.dirname(f.codexTmp))).toBe(false);
    expect(entries.find((e) => e.path === offline)?.reason).toContain("unavailable");
  });

  it("does nothing while off or without an archive folder", async () => {
    const f = fixture();
    expect(await pass(f, settings("", {}))).toEqual([]);
    expect(await pass(f, settings(f.archiveRoot, { mode: "off" }))).toEqual([]);
    expect(NodeFS.existsSync(NodePath.dirname(f.codexTmp))).toBe(true);
  });

  it("by default takes a verified session off local disk without leaving a link", async () => {
    const f = fixture();

    const entries = await pass(f, settings(f.archiveRoot));

    const copy = NodePath.join(hostDirOf(f), "claude", "-work", "old.jsonl");
    expect(NodeFS.existsSync(f.claudeOld)).toBe(false);
    expect(NodeFS.existsSync(f.rollout)).toBe(false);
    expect(NodeFS.readFileSync(copy, "utf8")).toBe('{"type":"user"}\n');
    expect(entries.find((e) => e.path === hostDirOf(f))?.files).toBe(3);
  });

  it("refuses an archive folder that is not a mounted share unless allowed", async () => {
    const f = fixture();

    const entries = await pass(f, settings(f.archiveRoot), { allowLocalArchiveRoot: false });

    expect(entries.at(-1)?.reason).toContain("not a mounted share");
    expect(NodeFS.existsSync(hostDirOf(f))).toBe(false);
    expect(NodeFS.lstatSync(f.claudeOld).isFile()).toBe(true);
  });

  it("removes and archives nothing when the live-process scan failed or saw nothing", async () => {
    const f = fixture();

    for (const scan of [null, { paths: new Set<string>(), otherProcesses: 0 }]) {
      const entries = await pass(f, settings(f.archiveRoot), { processScan: async () => scan });
      expect(entries).toHaveLength(1);
      expect(entries[0]?.reason).toContain("Could not read live processes");
    }

    expect(NodeFS.existsSync(NodePath.dirname(f.codexTmp))).toBe(true);
    expect(NodeFS.lstatSync(f.claudeOld).isFile()).toBe(true);
    expect(NodeFS.existsSync(hostDirOf(f))).toBe(false);
  });

  it("stops before any move when the share changes device mid-pass", async () => {
    const f = fixture();
    let unmounted = false;
    const deviceOf = async (target: string) => {
      const dev = NodeFS.statSync(target, { throwIfNoEntry: false })?.dev;
      return dev === undefined ? null : unmounted ? dev + 1 : dev;
    };

    const entries = await pass(f, settings(f.archiveRoot), {
      archiveDeviceOf: deviceOf,
      afterCopy: async () => {
        unmounted = true;
      },
    });

    expect(NodeFS.lstatSync(f.claudeOld).isFile()).toBe(true);
    expect(NodeFS.lstatSync(f.rollout).isFile()).toBe(true);
    expect(entries.find((e) => e.outcome === "failed")?.reason).toContain("changed or went away");
  });

  it.skipIf(platform === "win32")(
    "never removes a session that is its own archive copy",
    async () => {
      const f = fixture();
      const archived = NodePath.join(hostDirOf(f), "claude");
      const projects = NodePath.join(f.home, ".claude", "projects");
      NodeFS.mkdirSync(hostDirOf(f));
      NodeFS.renameSync(projects, archived);
      NodeFS.symlinkSync(archived, projects);
      const original = NodeFS.readFileSync(f.claudeOld);

      const entries = await pass(f, settings(f.archiveRoot));

      expect(NodeFS.readFileSync(f.claudeOld).equals(original)).toBe(true);
      expect(entries.find((e) => e.path === hostDirOf(f))?.reason).toContain(
        "2 already the archive copy",
      );
    },
  );

  it("keeps a session written between its copy and its move", async () => {
    const f = fixture();

    const entries = await pass(f, settings(f.archiveRoot), {
      afterCopy: async () => {
        NodeFS.appendFileSync(f.claudeOld, '{"type":"assistant"}\n');
      },
    });

    expect(NodeFS.lstatSync(f.claudeOld).isFile()).toBe(true);
    expect(NodeFS.readFileSync(f.claudeOld, "utf8")).toContain("assistant");
    expect(NodeFS.existsSync(f.rollout)).toBe(false);
    expect(entries.find((e) => e.path === hostDirOf(f))?.reason).toContain("1 changed since copy");
  });
});
