// @effect-diagnostics nodeBuiltinImport:off globalDate:off - Builds the CI host payload's CLI bundles from the exact synced commit, cached per commit.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { expandDataRoot, type CiHostEntry } from "./ciHosts.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { buildToolchainEnv } from "./toolchainEnv.ts";
import type { ProcessRunner } from "./types.ts";

/** Packages whose `dist/bin.mjs` the payload carries: runlog and playbook CLIs, and the host guards. */
export const PAYLOAD_BUNDLE_PACKAGES: ReadonlyArray<string> = ["runlog", "playbook", "host-guards"];

/**
 * The payload path of each bundle, relative to a build directory: each package's CLI, and the
 * playbook's design scan (`ci-marscode-cli.sh` installs it where repos' design evidence runs it).
 */
export const PAYLOAD_BUNDLE_PATHS: ReadonlyArray<string> = [
  ...PAYLOAD_BUNDLE_PACKAGES.map((p) => `packages/${p}/dist/bin.mjs`),
  "packages/playbook/dist/pb_design_scan.mjs",
];

/** Bundles missing (or empty) in a build directory; a usable build has none. */
export function missingPayloadBundles(dir: string): ReadonlyArray<string> {
  return PAYLOAD_BUNDLE_PATHS.filter((rel) => {
    try {
      return NodeFS.statSync(NodePath.join(dir, rel)).size === 0;
    } catch {
      return true;
    }
  });
}

/** Longest one build may take once it holds the lock. */
const BUILD_TIMEOUT_MS = 15 * 60_000;
/** Longest a build waits for another build of the same cache to finish. */
const LOCK_WAIT_S = 15 * 60;
const KEEP_BUILDS = 5;

const CACHE_REL: ReadonlyArray<string> = ["ship-queue-ci", "payload-bundles"];

/** The data root a `payloadBundleCacheDir` result sits under (undefined for any other path). */
function dataRootOf(cacheDir: string): string | undefined {
  const parts = NodePath.resolve(cacheDir).split(NodePath.sep);
  return parts.slice(-2).join("/") === CACHE_REL.join("/")
    ? parts.slice(0, -2).join(NodePath.sep) || NodePath.sep
    : undefined;
}

/** `<local data root>/ship-queue-ci/payload-bundles`, from the manifest's local (ssh: null) host. */
export function payloadBundleCacheDir(
  hosts: ReadonlyArray<CiHostEntry>,
  homeDir: string = NodeOS.homedir(),
): string | null {
  const local = hosts.find((h) => h.ssh === null);
  return local ? NodePath.join(expandDataRoot(local.data_root, homeDir), ...CACHE_REL) : null;
}

/**
 * The bundles for `sha`, built once from a detached worktree of that commit (frozen lockfile,
 * `vp pack` per package) and kept under `<cacheDir>/<sha>`. A bundle therefore always matches
 * the source it ships with. The newest few builds are kept.
 */
export async function buildPayloadBundles(input: {
  readonly marscodeRoot: string;
  readonly sha: string;
  readonly cacheDir: string;
  readonly run?: ProcessRunner | undefined;
}): Promise<{ readonly ok: boolean; readonly dir: string; readonly error?: string | undefined }> {
  const dir = NodePath.join(input.cacheDir, input.sha);
  if (!/^[0-9a-f]{40,64}$/.test(input.sha)) {
    return { ok: false, dir, error: `not a commit id: ${JSON.stringify(input.sha)}` };
  }
  if (NodeFS.existsSync(NodePath.join(dir, ".complete"))) {
    if (missingPayloadBundles(dir).length === 0) {
      // A cache hit counts as use, so the newest-first prune keeps commits that are still synced.
      const at = new Date();
      NodeFS.utimesSync(dir, at, at);
      return { ok: true, dir };
    }
    // A cached build that lost a bundle is not a build: drop it and build again.
    NodeFS.rmSync(dir, { recursive: true, force: true });
  }
  const run = input.run ?? nodeProcessRunner;
  const script = [
    "set -euo pipefail",
    "root=$1; sha=$2; cache=$3; keep=$4; lockwait=$5; shift 5",
    'mkdir -p "$cache"',
    // One build at a time per cache: concurrent installs race on the managed toolchain download
    // and fall back to the wrong package manager. A waiter reuses the build that finished first.
    'exec 9> "$cache/.lock"',
    "locked=0",
    'if command -v flock > /dev/null 2>&1; then flock -w "$lockwait" 9 || { echo "another payload bundle build held the lock for $lockwait s" >&2; exit 1; }; locked=1; fi',
    // Only the lock holder clears what a killed build left (its .build.* directory and worktree
    // record): while it holds the lock no other build can be running, whatever its age.
    'if [ "$locked" = 1 ]; then rm -rf "$cache"/.build.*; git -C "$root" worktree prune > /dev/null 2>&1 || true; fi',
    '[ ! -f "$cache/$sha/.complete" ] || exit 0',
    'w=$(mktemp -d "$cache/.build.XXXXXX")',
    // Remove the build first, then drop its worktree record: a kill mid-trap leaves at most a
    // record whose directory is gone, which the next build's prune clears.
    'trap \'rm -rf "$w"; git -C "$root" worktree prune >/dev/null 2>&1 || true\' EXIT',
    'git -C "$root" worktree add --detach --quiet "$w/src" "$sha"',
    'cd "$w/src"',
    // Install with exactly the pnpm the repo pins (packageManager), from Vite+'s managed store:
    // `vp install` silently falls back to whatever pnpm is on PATH when it cannot use its own.
    'pm=$(sed -n \'s/.*"packageManager": *"pnpm@\\([0-9][0-9.]*\\)[+"].*/\\1/p\' package.json | head -n 1)',
    '[ -n "$pm" ] || { echo "package.json pins no pnpm packageManager" >&2; exit 1; }',
    'pnpm_bin="${VP_HOME:-$HOME/.vite-plus}/package_manager/pnpm/$pm/pnpm/bin/pnpm"',
    // A newly pinned pnpm is fetched into this Vite+ home (vp resolves the repo's packageManager).
    '[ -x "$pnpm_bin" ] || vp --version > /dev/null 2>&1 || true',
    '[ -x "$pnpm_bin" ] || { echo "pnpm $pm is not in the Vite+ store at VP_HOME=$VP_HOME ($pnpm_bin)" >&2; exit 1; }',
    '[ "$("$pnpm_bin" --version 2>/dev/null)" = "$pm" ] || { echo "$pnpm_bin is not pnpm $pm" >&2; exit 1; }',
    'CI=1 VP_GIT_HOOKS=0 "$pnpm_bin" install --frozen-lockfile > "$w/install.log" 2>&1 || { tail -n 20 "$w/install.log" >&2; exit 1; }',
    'IFS=" " read -r -a outputs <<< "$1"; shift',
    'for p in "$@"; do',
    '  (cd "packages/$p" && vp pack > "$w/pack-$p.log" 2>&1) || { tail -n 20 "$w/pack-$p.log" >&2; exit 1; }',
    "done",
    // Every payload file is copied by its exact path; a missing one fails the build.
    'for f in "${outputs[@]}"; do mkdir -p "$w/out/$(dirname "$f")" && cp "$f" "$w/out/$f"; done',
    'touch "$w/out/.complete"',
    // A concurrent build of the same commit may have won the rename; either result is complete.
    'mv -T "$w/out" "$cache/$sha" 2>/dev/null || [ -f "$cache/$sha/.complete" ]',
    'ls -1t "$cache" | tail -n +"$((keep + 1))" | while IFS= read -r old; do rm -rf "${cache:?}/$old"; done',
  ].join("\n");
  const res = await run({
    command: "bash",
    args: [
      "-c",
      script,
      "--",
      input.marscodeRoot,
      input.sha,
      input.cacheDir,
      String(KEEP_BUILDS),
      String(LOCK_WAIT_S),
      PAYLOAD_BUNDLE_PATHS.join(" "),
      ...PAYLOAD_BUNDLE_PACKAGES,
    ],
    cwd: input.marscodeRoot,
    // The pnpm store lives on the data root, beside the build, so installs hard-link from it.
    env: buildToolchainEnv(process.env, { dataRoot: dataRootOf(input.cacheDir) }),
    replaceEnv: true,
    timeoutMs: BUILD_TIMEOUT_MS + LOCK_WAIT_S * 1000,
  });
  if (res.exitCode !== 0 || !NodeFS.existsSync(NodePath.join(dir, ".complete"))) {
    const tail = res.stderr.trim().split("\n").slice(-5).join(" | ");
    return {
      ok: false,
      dir,
      error: `bundle build for ${input.sha} failed: ${tail || `exit ${res.exitCode}`}`,
    };
  }
  const missing = missingPayloadBundles(dir);
  if (missing.length > 0) {
    return { ok: false, dir, error: `bundle build for ${input.sha} lacks ${missing.join(", ")}` };
  }
  return { ok: true, dir };
}
