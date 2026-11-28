// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Tests standalone post-merge sync runner modules directly against Node fs.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { afterEach, describe, expect, it } from "vite-plus/test";

import { parseCliArgs } from "./marscode-sync-cli.ts";
import { acquireSyncLock, validateAndSwapAppImage } from "./marscode-sync-install.ts";
import { parityFingerprint } from "./marscode-sync-parity.ts";
import {
  APP_IMAGE_TARGET_ID,
  SYNC_BINARY_TARGETS,
  buildDesktopArtifactEnv,
  parseGlibcVersionFromLdd,
  parseSyncState,
  planSync,
  recordParitySkips,
  type SyncState,
} from "./marscode-sync-plan.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length > 0) cleanups.pop()?.();
});

const ALL_BINS = new Set(SYNC_BINARY_TARGETS.map((t) => t.binName));

function syncedState(sha: string): SyncState {
  const targets: Record<string, string> = { [APP_IMAGE_TARGET_ID]: sha };
  for (const t of SYNC_BINARY_TARGETS) targets[t.id] = sha;
  return { version: 1, installSha: sha, targets };
}

describe("planSync diff-driven target selection", () => {
  it("skips all 7 binaries and builds only the AppImage on a web-only PR", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["apps/web/src/components/chat/AssistantSelectionToolbar.tsx"],
    });

    expect(plan.binaries.every((b) => b.decision.action === "skip")).toBe(true);
    expect(plan.appImage).toEqual({ action: "build", reason: "changed", sinceSha: "sha-1" });
    expect(plan.needsWorktreeUpdate).toBe(true);
    expect(plan.needsInstall).toBe(false);
  });

  it("rebuilds only touched CLIs and their workspace dependents, skipping AppImage on host-guards changes", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["packages/host-guards/src/gitGuard.ts"],
    });

    const built = plan.binaries
      .filter((b) => b.decision.action === "build")
      .map((b) => b.target.id);
    expect(built).toEqual(["marscode-host-guard"]);
    expect(plan.appImage).toEqual({ action: "skip", reason: "unchanged" });
    expect(plan.needsInstall).toBe(false);
  });

  it("retries every CLI with a parity probe when the probes change", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["scripts/ship/marscode-sync-parity.ts"],
    });
    const built = plan.binaries
      .filter((b) => b.decision.action === "build")
      .map((b) => b.target.id);
    expect(built.toSorted()).toEqual(["fleet", "runlog", "surface"]);
  });

  it("retries a parity skip only when its probe fingerprint changes", () => {
    const input = {
      headSha: "sha-2",
      state: { ...syncedState("sha-1"), paritySkips: { playbook: parityFingerprint("playbook") } },
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => [],
    } as const;
    const decisionOf = (fingerprint: (bin: string) => string) =>
      planSync({ ...input, parityFingerprint: fingerprint }).binaries.find(
        (b) => b.target.id === "playbook",
      )?.decision;
    expect(decisionOf(parityFingerprint)).toEqual({ action: "skip", reason: "unchanged" });
    expect(decisionOf(() => "another probe")).toEqual({
      action: "build",
      reason: "parity-probe-changed",
      sinceSha: "sha-1",
    });
  });

  it("records a parity refusal with its fingerprint, and not a probe that did not run", () => {
    const records = { targets: { runlog: "sha-1", playbook: "sha-1" }, paritySkips: {} };
    const byId = (id: string) => SYNC_BINARY_TARGETS.find((t) => t.id === id)!;
    const changed = recordParitySkips(
      records,
      [
        { target: byId("playbook"), retry: false },
        { target: byId("runlog"), retry: true },
      ],
      "sha-2",
      parityFingerprint,
    );
    expect(changed).toBe(true);
    expect(records).toEqual({
      targets: { runlog: "sha-1", playbook: "sha-2" },
      paritySkips: { playbook: parityFingerprint("playbook") },
    });
    expect(
      recordParitySkips(
        records,
        [{ target: byId("runlog"), retry: true }],
        "sha-3",
        parityFingerprint,
      ),
    ).toBe(false);
    expect(records.targets.runlog).toBe("sha-1");
    // The saved state keeps the fingerprints.
    expect(parseSyncState(JSON.stringify({ version: 1, ...records })).paritySkips).toEqual(
      records.paritySkips,
    );
  });

  it("rebuilds playbook when its workspace dependency fleet changes", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["packages/fleet/src/index.ts"],
    });

    const built = plan.binaries
      .filter((b) => b.decision.action === "build")
      .map((b) => b.target.id);
    expect(built).toEqual(["playbook", "fleet"]);
  });

  it("rebuilds transitive consumers when packages/contracts changes", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["packages/contracts/src/index.ts"],
    });

    const built = plan.binaries
      .filter((b) => b.decision.action === "build")
      .map((b) => b.target.id);
    expect(built).toEqual(["ship-queue", "marscode-host-guard"]);
    expect(plan.appImage.action).toBe("build");
  });

  it("skips worktree update completely on docs-only changes", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["docs/user/README.md"],
    });

    expect(plan.needsWorktreeUpdate).toBe(false);
    expect(plan.needsInstall).toBe(false);
    expect(plan.appImage).toEqual({ action: "skip", reason: "unchanged" });
  });

  it("triggers vp install only when pnpm-lock.yaml or package.json changes", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["apps/web/package.json"],
    });

    expect(plan.needsInstall).toBe(true);
    expect(plan.appImage.action).toBe("build");
  });
});

describe("AppImage burst coalescing and headless host gating", () => {
  it("defers AppImage when SHIP_QUEUE_JOBS_BEHIND > 0 and builds on the final commit of a multi-PR burst", () => {
    // Commit 1 touches apps/web while another PR is queued behind it.
    const burstFirst = planSync({
      headSha: "sha-web",
      state: syncedState("sha-base"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 1,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: () => ["apps/web/src/index.css"],
    });
    expect(burstFirst.appImage).toEqual({
      action: "skip",
      reason: "burst-coalesced",
      detail: "jobs_behind=1",
    });

    // Commit 2 touches only docs, but because appSha stayed at sha-base, diff sha-base..sha-docs
    // still includes apps/web/src/index.css and rebuilds the AppImage once for the whole burst.
    const burstFinal = planSync({
      headSha: "sha-docs",
      state: syncedState("sha-base"),
      existingBinaries: ALL_BINS,
      appImageExists: true,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: true },
      listChangedFiles: (fromSha) =>
        fromSha === "sha-base" ? ["apps/web/src/index.css", "README.md"] : ["README.md"],
    });
    expect(burstFinal.appImage).toEqual({
      action: "build",
      reason: "changed",
      sinceSha: "sha-base",
    });
  });

  it("skips AppImage cleanly on non-desktop/headless hosts", () => {
    const plan = planSync({
      headSha: "sha-2",
      state: syncedState("sha-1"),
      existingBinaries: ALL_BINS,
      appImageExists: false,
      hasNodeModules: true,
      jobsBehind: 0,
      force: false,
      skipApp: false,
      desktopHost: { eligible: false, reason: "cargo not found on PATH" },
      listChangedFiles: () => ["apps/desktop/src/main.ts"],
    });

    expect(plan.appImage).toEqual({
      action: "skip",
      reason: "non-desktop-host",
      detail: "cargo not found on PATH",
    });
    expect(plan.needsWorktreeUpdate).toBe(false);
  });
});

describe("desktop build env & atomic AppImage swap", () => {
  it("parses host glibc version and scrubs CARGO_TARGET_DIR while pinning custom TMPDIR", () => {
    expect(parseGlibcVersionFromLdd("ldd (Ubuntu GLIBC 2.43-2ubuntu2.7) 2.43\nCopyright...")).toBe(
      "2.43",
    );
    expect(parseGlibcVersionFromLdd("musl libc (x86_64)")).toBeNull();

    const env = buildDesktopArtifactEnv(
      {
        PATH: "/usr/bin:/bin",
        CARGO_TARGET_DIR: "/var/cache/cargo-target",
        T3CODE_DESKTOP_OUTPUT_DIR: "/tmp/custom-release",
        T3CODE_DESKTOP_MOCK_UPDATES: "1",
      },
      {
        homeDir: "/home/dev",
        tmpDir: "/var/tmp/marscode-sync/.tmp",
        hostGlibcVersion: "2.43",
      },
    );

    expect(env.CARGO_TARGET_DIR).toBeUndefined();
    expect(env.T3CODE_DESKTOP_OUTPUT_DIR).toBeUndefined();
    expect(env.T3CODE_DESKTOP_MOCK_UPDATES).toBeUndefined();
    expect(env.TMPDIR).toBe("/var/tmp/marscode-sync/.tmp");
    expect(env.T3CODE_LINUX_GLIBC_CEILING).toBe("2.43");
    expect(env.VP_GIT_HOOKS).toBe("0");
    expect(env.PATH).toContain("/home/dev/.cargo/bin");
    expect(env.PATH).toContain("/home/dev/.vite-plus/bin");
  });

  it("rejects non-ELF files and atomically swaps valid AppImages without disrupting open file descriptors", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-sync-swap-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));

    const destPath = NodePath.join(dir, "MarsCode-main.AppImage");
    const shaPath = NodePath.join(dir, ".MarsCode-main.AppImage.sha");
    const oldBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("OLD_APP")]);
    NodeFS.writeFileSync(destPath, oldBytes, { mode: 0o755 });

    // Hold an open file descriptor to the running AppImage inode.
    const openFd = NodeFS.openSync(destPath, "r");
    cleanups.push(() => NodeFS.closeSync(openFd));

    // Corrupt non-ELF file must fail without modifying existing binary.
    const badSrc = NodePath.join(dir, "bad.AppImage");
    NodeFS.writeFileSync(badSrc, "not-an-elf-binary");
    expect(() =>
      validateAndSwapAppImage({
        sourcePath: badSrc,
        destPath,
        shaPath,
        sha: "badsha",
        skipVersionProbe: true,
      }),
    ).toThrow(/not a valid ELF AppImage/);
    expect(NodeFS.readFileSync(destPath)).toEqual(oldBytes);

    // Valid ELF file replaces destination atomically via rename(2).
    const goodSrc = NodePath.join(dir, "good.AppImage");
    const newBytes = Buffer.concat([Buffer.from([0x7f, 0x45, 0x4c, 0x46]), Buffer.from("NEW_APP")]);
    NodeFS.writeFileSync(goodSrc, newBytes);
    validateAndSwapAppImage({
      sourcePath: goodSrc,
      destPath,
      shaPath,
      sha: "abcdef1234567890",
      skipVersionProbe: true,
    });

    expect(NodeFS.readFileSync(destPath)).toEqual(newBytes);
    expect(NodeFS.readFileSync(shaPath, "utf8").trim()).toBe("abcdef1234567890");
    // The open handle still reads the previous inode intact (atomic rename, not truncate-in-place).
    const readBack = Buffer.alloc(oldBytes.length);
    NodeFS.readSync(openFd, readBack, 0, oldBytes.length, 0);
    expect(readBack).toEqual(oldBytes);
  });

  it("recovers stale PID and aged empty lockfiles automatically", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-sync-lock-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const lockPath = NodePath.join(dir, ".sync.lock");
    NodeFS.writeFileSync(lockPath, JSON.stringify({ pid: 999_999_999 }));

    const release = acquireSyncLock(lockPath);
    try {
      const held = JSON.parse(NodeFS.readFileSync(lockPath, "utf8")) as { pid: number };
      expect(held.pid).toBe(process.pid);
    } finally {
      release();
    }
    expect(NodeFS.existsSync(lockPath)).toBe(false);

    // Aged empty lockfile (crash between open and write) must also recover.
    NodeFS.writeFileSync(lockPath, "");
    const past = new Date(0);
    NodeFS.utimesSync(lockPath, past, past);
    const release2 = acquireSyncLock(lockPath);
    try {
      const held = JSON.parse(NodeFS.readFileSync(lockPath, "utf8")) as { pid: number };
      expect(held.pid).toBe(process.pid);
    } finally {
      release2();
    }
  });

  it("rejects missing explicit --data-root and mismatched --bin-dir/--prefix", () => {
    const dir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "marscode-sync-cli-"));
    cleanups.push(() => NodeFS.rmSync(dir, { recursive: true, force: true }));
    const primary = NodePath.join(dir, "repo");
    const dataRoot = NodePath.join(dir, "data");
    NodeFS.mkdirSync(primary);
    NodeFS.mkdirSync(dataRoot);

    expect(() =>
      parseCliArgs(["--primary", primary, "--data-root", NodePath.join(dir, "missing")], primary),
    ).toThrow(/--data-root does not exist/);

    expect(() =>
      parseCliArgs(
        [
          "--primary",
          primary,
          "--data-root",
          dataRoot,
          "--prefix",
          NodePath.join(dir, "p1"),
          "--bin-dir",
          NodePath.join(dir, "p2", "bin"),
        ],
        primary,
      ),
    ).toThrow(/--bin-dir.*must equal/);

    const derived = parseCliArgs(
      [
        "--primary",
        primary,
        "--data-root",
        dataRoot,
        "--bin-dir",
        NodePath.join(dir, "custom", "bin"),
      ],
      primary,
    );
    expect(derived.prefix).toBe(NodePath.join(dir, "custom"));
  });
});
