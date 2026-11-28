// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Standalone post-merge installer runs from extracted base tree without Effect/node_modules.
// Atomic filesystem, lock, warm-worktree, CLI bundle, and AppImage install operations for marscode-sync.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import { assertMayReplace, WRAPPER_MARKER, wrapperBundlePath } from "./marscode-sync-parity.ts";
import {
  emptySyncState,
  parseSyncState,
  type SyncBinaryTarget,
  type SyncState,
} from "./marscode-sync-plan.ts";

const LOCK_WAIT_TIMEOUT_MS = 5 * 60_000;
const LOCK_POLL_MS = 250;
const EMPTY_LOCK_STALE_MS = 5_000;
const ELF_MAGIC = Buffer.from([0x7f, 0x45, 0x4c, 0x46]);

export function runCmd(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly inheritStdio?: boolean;
  },
): { readonly status: number; readonly stdout: string; readonly stderr: string } {
  const res = NodeChildProcess.spawnSync(command, [...args], {
    cwd: options.cwd,
    env: options.env ?? process.env,
    encoding: "utf8",
    stdio: options.inheritStdio ? "inherit" : "pipe",
  });
  if (res.error) {
    throw new Error(`${command} failed to spawn: ${res.error.message}`);
  }
  return {
    status: res.status ?? 1,
    stdout: res.stdout ?? "",
    stderr: res.stderr ?? "",
  };
}

export function runChecked(
  command: string,
  args: ReadonlyArray<string>,
  options: {
    readonly cwd: string;
    readonly env?: Readonly<Record<string, string | undefined>>;
    readonly inheritStdio?: boolean;
  },
): string {
  const res = runCmd(command, args, options);
  if (res.status !== 0) {
    const detail = `${res.stderr}\n${res.stdout}`.trim();
    throw new Error(
      `${command} ${args.join(" ")} exited ${res.status}${detail ? `: ${detail}` : ""}`,
    );
  }
  return res.stdout;
}

export function findCommandOnPath(name: string, pathEnv: string): string | null {
  for (const dir of pathEnv.split(":").filter(Boolean)) {
    const full = NodePath.join(dir, name);
    try {
      NodeFS.accessSync(full, NodeFS.constants.X_OK);
      if (NodeFS.statSync(full).isFile()) return full;
    } catch {
      continue;
    }
  }
  return null;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === "EPERM";
  }
}

export function acquireSyncLock(lockPath: string): () => void {
  NodeFS.mkdirSync(NodePath.dirname(lockPath), { recursive: true });
  const deadline = Date.now() + LOCK_WAIT_TIMEOUT_MS;
  for (;;) {
    try {
      const fd = NodeFS.openSync(lockPath, "wx", 0o600);
      NodeFS.writeFileSync(
        fd,
        `${JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() })}\n`,
      );
      NodeFS.closeSync(fd);
      return () => {
        try {
          NodeFS.unlinkSync(lockPath);
        } catch {
          // Best-effort unlock.
        }
      };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") throw err;
      try {
        const stat = NodeFS.statSync(lockPath);
        const raw = NodeFS.readFileSync(lockPath, "utf8").trim();
        if (raw.length === 0) {
          if (Date.now() - stat.mtimeMs > EMPTY_LOCK_STALE_MS) {
            NodeFS.unlinkSync(lockPath);
            continue;
          }
        } else {
          const parsed = JSON.parse(raw) as { pid?: number };
          if (typeof parsed.pid === "number" && !isPidAlive(parsed.pid)) {
            NodeFS.unlinkSync(lockPath);
            continue;
          }
        }
      } catch {
        // Lock file may be mid-write or already removed; retry briefly.
      }
      if (Date.now() >= deadline) {
        throw new Error(`marscode-sync: timed out waiting for lock ${lockPath}`, { cause: err });
      }
      sleepSync(LOCK_POLL_MS);
    }
  }
}

export function writeFileAtomic(filePath: string, content: string, mode = 0o644): void {
  NodeFS.mkdirSync(NodePath.dirname(filePath), { recursive: true });
  const tmp = `${filePath}.next.${process.pid}`;
  NodeFS.writeFileSync(tmp, content, { mode });
  NodeFS.chmodSync(tmp, mode);
  NodeFS.renameSync(tmp, filePath);
}

export function readSyncState(statePath: string): SyncState {
  try {
    return parseSyncState(NodeFS.readFileSync(statePath, "utf8"));
  } catch {
    return emptySyncState();
  }
}

export function saveSyncState(statePath: string, state: SyncState): void {
  writeFileAtomic(statePath, `${JSON.stringify(state, null, 2)}\n`, 0o644);
}

export function ensureWarmWorktree(primary: string, syncWorktree: string, headSha: string): void {
  const gitMarker = NodePath.join(syncWorktree, ".git");
  let valid = false;
  if (NodeFS.existsSync(gitMarker)) {
    const probe = runCmd("git", ["-C", syncWorktree, "rev-parse", "--is-inside-work-tree"], {
      cwd: primary,
    });
    valid = probe.status === 0 && probe.stdout.trim() === "true";
  }
  if (!valid) {
    if (NodeFS.existsSync(syncWorktree)) {
      runCmd("git", ["-C", primary, "worktree", "remove", "--force", syncWorktree], {
        cwd: primary,
      });
      NodeFS.rmSync(syncWorktree, { recursive: true, force: true });
    }
    runCmd("git", ["-C", primary, "worktree", "prune"], { cwd: primary });
    runChecked("git", ["-C", primary, "worktree", "add", "--detach", "-q", syncWorktree, headSha], {
      cwd: primary,
    });
    return;
  }
  runChecked("git", ["-C", syncWorktree, "checkout", "--detach", "--force", "-q", headSha], {
    cwd: syncWorktree,
  });
  runChecked(
    "git",
    [
      "-C",
      syncWorktree,
      "clean",
      "-fdx",
      "-q",
      "-e",
      "node_modules",
      "-e",
      ".vite-plus",
      "-e",
      "native/resource-monitor/target",
    ],
    { cwd: syncWorktree },
  );
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}

export function atomicInstallNodeCli(
  worktree: string,
  target: SyncBinaryTarget,
  opts: {
    readonly binDir: string;
    readonly libDir: string;
    readonly nodeBin: string;
    readonly log: (msg: string) => void;
  },
): void {
  const bundleSrc = NodePath.join(worktree, target.pkgRel, "dist", "bin.mjs");
  if (!NodeFS.existsSync(bundleSrc)) {
    throw new Error(`marscode-sync: missing built bundle ${bundleSrc}`);
  }
  const releasesDir = NodePath.join(opts.libDir, ".releases");
  NodeFS.mkdirSync(opts.binDir, { recursive: true });
  NodeFS.mkdirSync(releasesDir, { recursive: true });

  const stageDir = NodeFS.mkdtempSync(NodePath.join(releasesDir, `${target.binName}.`));
  const linkTmp = NodePath.join(opts.libDir, `.${target.binName}.next.${process.pid}`);
  const wrapperTmp = NodePath.join(opts.binDir, `.${target.binName}.next.${process.pid}`);
  let committed = false;
  try {
    const distDir = NodePath.join(stageDir, "dist");
    NodeFS.mkdirSync(distDir, { recursive: true });
    NodeFS.writeFileSync(NodePath.join(stageDir, "package.json"), '{"type":"module"}\n', {
      mode: 0o644,
    });
    NodeFS.copyFileSync(bundleSrc, NodePath.join(distDir, "bin.mjs"));
    NodeFS.chmodSync(NodePath.join(distDir, "bin.mjs"), 0o755);

    if (target.id === "surface") {
      const templatesSrc = NodePath.join(worktree, target.pkgRel, "templates");
      if (NodeFS.existsSync(templatesSrc)) {
        NodeFS.cpSync(templatesSrc, NodePath.join(stageDir, "templates"), { recursive: true });
      }
    }

    runChecked(opts.nodeBin, [NodePath.join(distDir, "bin.mjs"), "--help"], { cwd: stageDir });

    const targetLink = NodePath.join(opts.libDir, target.binName);
    assertMayReplace({
      binName: target.binName,
      binPath: NodePath.join(opts.binDir, target.binName),
      bundlePath: wrapperBundlePath(opts.libDir, target.binName),
      stagedBundle: NodePath.join(distDir, "bin.mjs"),
      nodeBin: opts.nodeBin,
      cwd: stageDir,
    });
    if (NodeFS.existsSync(targetLink) && !NodeFS.lstatSync(targetLink).isSymbolicLink()) {
      NodeFS.renameSync(
        targetLink,
        NodePath.join(releasesDir, `${target.binName}.legacy.${process.pid}`),
      );
    }
    NodeFS.rmSync(linkTmp, { force: true });
    NodeFS.symlinkSync(stageDir, linkTmp);
    NodeFS.renameSync(linkTmp, targetLink);

    const wrapper = [
      "#!/usr/bin/env bash",
      WRAPPER_MARKER,
      "set -euo pipefail",
      `node_bin=${shellQuote(opts.nodeBin)}`,
      'if [ ! -x "$node_bin" ]; then',
      '  node_bin="$(command -v node)"',
      "fi",
      `exec "$node_bin" ${shellQuote(wrapperBundlePath(opts.libDir, target.binName))} "$@"`,
      "",
    ].join("\n");
    NodeFS.writeFileSync(wrapperTmp, wrapper, { mode: 0o755 });
    NodeFS.chmodSync(wrapperTmp, 0o755);
    NodeFS.renameSync(wrapperTmp, NodePath.join(opts.binDir, target.binName));
    committed = true;

    for (const entry of NodeFS.readdirSync(releasesDir)) {
      if (!entry.startsWith(`${target.binName}.`)) continue;
      const full = NodePath.join(releasesDir, entry);
      if (full === stageDir) continue;
      NodeFS.rmSync(full, { recursive: true, force: true });
    }
    opts.log(
      `marscode-sync: installed ${NodePath.join(opts.binDir, target.binName)} -> ${targetLink}/dist/bin.mjs`,
    );
  } finally {
    if (!committed) {
      NodeFS.rmSync(stageDir, { recursive: true, force: true });
      NodeFS.rmSync(linkTmp, { force: true });
      NodeFS.rmSync(wrapperTmp, { force: true });
    }
  }
}

export function stageShipQueueVersion(
  headSha: string,
  opts: { readonly binDir: string; readonly libDir: string; readonly queueRoot: string },
): void {
  const bundlePath = NodePath.join(opts.libDir, "ship-queue", "dist", "bin.mjs");
  const binHash = NodeCrypto.createHash("sha256")
    .update(NodeFS.readFileSync(bundlePath))
    .digest("hex")
    .slice(0, 12);
  const version = `v-${headSha.slice(0, 8)}-${binHash}`;
  const shipQueueBin = NodePath.join(opts.binDir, "ship-queue");
  const env = { ...process.env, SHIP_QUEUE_ROOT: opts.queueRoot };
  runChecked(
    shipQueueBin,
    [
      "version",
      "stage",
      version,
      "--source-dir",
      NodePath.dirname(bundlePath),
      "--entry",
      "bin.mjs",
    ],
    { cwd: opts.libDir, env, inheritStdio: true },
  );
  runCmd(shipQueueBin, ["version", "prune"], { cwd: opts.libDir, env, inheritStdio: true });
}

export function validateAndSwapAppImage(input: {
  readonly sourcePath: string;
  readonly destPath: string;
  readonly shaPath: string;
  readonly sha: string;
  readonly skipVersionProbe?: boolean;
}): void {
  if (!NodeFS.existsSync(input.sourcePath)) {
    throw new Error(`marscode-sync: built AppImage missing at ${input.sourcePath}`);
  }
  const stat = NodeFS.statSync(input.sourcePath);
  if (!stat.isFile() || stat.size < 4) {
    throw new Error(`marscode-sync: invalid AppImage file ${input.sourcePath}`);
  }
  const header = Buffer.alloc(4);
  const fd = NodeFS.openSync(input.sourcePath, "r");
  try {
    NodeFS.readSync(fd, header, 0, 4, 0);
  } finally {
    NodeFS.closeSync(fd);
  }
  if (!header.equals(ELF_MAGIC)) {
    throw new Error(`marscode-sync: ${input.sourcePath} is not a valid ELF AppImage`);
  }

  NodeFS.mkdirSync(NodePath.dirname(input.destPath), { recursive: true });
  const tmpPath = NodePath.join(
    NodePath.dirname(input.destPath),
    `.${NodePath.basename(input.destPath)}.tmp.${process.pid}`,
  );
  try {
    NodeFS.copyFileSync(input.sourcePath, tmpPath);
    NodeFS.chmodSync(tmpPath, 0o755);
    if (!input.skipVersionProbe) {
      const probe = NodeChildProcess.spawnSync(tmpPath, ["--appimage-version"], {
        encoding: "utf8",
      });
      if (probe.status !== 0) {
        throw new Error(
          `marscode-sync: AppImage --appimage-version failed (${probe.status}): ${probe.stderr || probe.stdout}`,
        );
      }
    }
    NodeFS.renameSync(tmpPath, input.destPath);
    writeFileAtomic(input.shaPath, `${input.sha}\n`, 0o644);
  } catch (err) {
    NodeFS.rmSync(tmpPath, { force: true });
    throw err;
  }
}

export function findBuiltAppImage(worktree: string): string {
  const releaseDir = NodePath.join(worktree, "release");
  if (!NodeFS.existsSync(releaseDir)) {
    throw new Error(`marscode-sync: release directory missing at ${releaseDir}`);
  }
  const matches = NodeFS.readdirSync(releaseDir)
    .filter((name) => name.endsWith("-x86_64.AppImage"))
    .toSorted();
  const artifact = matches[matches.length - 1];
  if (!artifact) {
    throw new Error(`marscode-sync: no *-x86_64.AppImage found under ${releaseDir}`);
  }
  return NodePath.join(releaseDir, artifact);
}
