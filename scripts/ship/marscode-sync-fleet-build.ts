// Builds and caches the shared linux-x64 standalone t3 archive once per commit for fleet rollout.
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodeFS from "node:fs";
// @effect-diagnostics-next-line nodeBuiltinImport:off -- standalone post-merge script runs from the extracted step tree without Effect or node_modules (#81).
import * as NodePath from "node:path";

import { chooseFleetVersion, type FleetArtifactRecord } from "./marscode-sync-fleet-config.ts";
import { assertValidSha, assertValidVersion } from "./marscode-sync-fleet-scripts.ts";
import type { CommandRunner } from "./marscode-sync-fleet.ts";

const RESOURCE_MONITOR_TARGET = "x86_64-unknown-linux-gnu";
const RELEASE_PACKAGE_FILES = [
  "apps/server/package.json",
  "apps/desktop/package.json",
  "apps/web/package.json",
  "packages/contracts/package.json",
] as const;

export function utcDate(): string {
  // @effect-diagnostics-next-line globalDate:off -- standalone post-merge script has no Effect clock (#81).
  return new Date().toISOString().slice(0, 10).replace(/-/g, "");
}

export function utcSecondsOfDay(): number {
  // @effect-diagnostics-next-line globalDate:off -- standalone post-merge script has no Effect clock (#81).
  const now = new Date();
  return now.getUTCHours() * 3600 + now.getUTCMinutes() * 60 + now.getUTCSeconds() + 1;
}

export function readDesktopVersionAtSha(input: {
  readonly primary: string;
  readonly worktree: string;
  readonly headSha: string;
  readonly runner: CommandRunner;
}): string {
  const fromGit = input.runner.runCmd(
    "git",
    ["-C", input.primary, "show", `${input.headSha}:apps/desktop/package.json`],
    { cwd: input.primary },
  );
  if (fromGit.status === 0 && fromGit.stdout.trim().length > 0) {
    return (JSON.parse(fromGit.stdout) as { version: string }).version;
  }
  const candidate = NodeFS.existsSync(NodePath.join(input.worktree, "apps/desktop/package.json"))
    ? NodePath.join(input.worktree, "apps/desktop/package.json")
    : NodePath.join(input.primary, "apps/desktop/package.json");
  return (JSON.parse(NodeFS.readFileSync(candidate, "utf8")) as { version: string }).version;
}

/**
 * Builds and smoke-tests the linux-x64 standalone t3 archive once per commit and caches it under
 * `<dataRoot>/fleet-artifacts/<headSha>/` so deferred or offline hosts do not trigger rebuilds.
 */
export function ensureLinuxServerArchive(input: {
  readonly primary: string;
  readonly worktree: string;
  readonly dataRoot: string;
  readonly headSha: string;
  readonly previousArtifact?: FleetArtifactRecord | undefined;
  readonly env: Readonly<Record<string, string>>;
  readonly log: (message: string) => void;
  readonly date?: string | undefined;
  readonly runner: CommandRunner;
}): FleetArtifactRecord {
  const sha = assertValidSha(input.headSha);
  if (
    input.previousArtifact?.sha === sha &&
    NodeFS.existsSync(input.previousArtifact.archivePath)
  ) {
    input.log(
      `marscode-sync: reusing cached linux-x64 archive ${input.previousArtifact.version} at ${sha.slice(0, 10)}`,
    );
    return input.previousArtifact;
  }

  const version = assertValidVersion(
    chooseFleetVersion({
      desktopVersion: readDesktopVersionAtSha({
        primary: input.primary,
        worktree: input.worktree,
        headSha: sha,
        runner: input.runner,
      }),
      previousVersion: input.previousArtifact?.version,
      date: input.date ?? utcDate(),
      minSeq: input.date === undefined ? utcSecondsOfDay() : undefined,
    }),
  );

  const artifactsRoot = NodePath.join(input.dataRoot, "fleet-artifacts");
  const outDir = NodePath.join(artifactsRoot, sha);
  const stagingDir = NodePath.join(artifactsRoot, `.staging-${sha}-${process.pid}`);
  NodeFS.mkdirSync(stagingDir, { recursive: true });

  const runInWorktree = (command: string, args: ReadonlyArray<string>) =>
    input.runner.runChecked(command, args, {
      cwd: input.worktree,
      env: input.env,
      inheritStdio: true,
    });

  try {
    try {
      runInWorktree("node", ["scripts/update-release-package-versions.ts", version]);
      runInWorktree("vp", ["run", "--filter", "t3", "build"]);
      runInWorktree("node", [
        "scripts/apply-web-brand-assets.ts",
        "nightly",
        "apps/server/dist/client",
      ]);
      runInWorktree("node", ["apps/server/scripts/cli.ts", "build-exe"]);
      runInWorktree("cargo", [
        "build",
        "--locked",
        "--release",
        "--manifest-path",
        "native/resource-monitor/Cargo.toml",
        "--target",
        RESOURCE_MONITOR_TARGET,
      ]);
      const monitorDir = NodePath.join(stagingDir, "resource-monitor");
      NodeFS.mkdirSync(monitorDir, { recursive: true });
      NodeFS.copyFileSync(
        NodePath.join(
          input.worktree,
          "native/resource-monitor/target",
          RESOURCE_MONITOR_TARGET,
          "release/t3-resource-monitor",
        ),
        NodePath.join(monitorDir, "t3-resource-monitor"),
      );
      runInWorktree("node", [
        "scripts/build-cli-archive.ts",
        "--platform",
        "linux",
        "--arch",
        "x64",
        "--version",
        version,
        "--output-dir",
        stagingDir,
        "--resource-monitor-dir",
        monitorDir,
      ]);
    } finally {
      input.runner.runCmd(
        "git",
        ["-C", input.worktree, "checkout", "--", ...RELEASE_PACKAGE_FILES],
        {
          cwd: input.worktree,
        },
      );
    }

    const archiveName = `t3-${version}-linux-x64.tar.gz`;
    const stagedArchive = NodePath.join(stagingDir, archiveName);
    if (!NodeFS.existsSync(stagedArchive)) {
      throw new Error(`marscode-sync: built archive missing at ${stagedArchive}`);
    }
    runInWorktree("node", [
      "scripts/smoke-cli-archive.ts",
      "--archive",
      stagedArchive,
      "--expect-version",
      version,
    ]);

    NodeFS.rmSync(outDir, { recursive: true, force: true });
    NodeFS.mkdirSync(outDir, { recursive: true });
    const finalArchive = NodePath.join(outDir, archiveName);
    NodeFS.renameSync(stagedArchive, finalArchive);

    for (const entry of NodeFS.readdirSync(artifactsRoot)) {
      if (entry !== sha && !entry.startsWith(".staging-")) {
        NodeFS.rmSync(NodePath.join(artifactsRoot, entry), { recursive: true, force: true });
      }
    }

    return { sha, version, archivePath: finalArchive };
  } finally {
    NodeFS.rmSync(stagingDir, { recursive: true, force: true });
  }
}
