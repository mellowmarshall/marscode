// @effect-diagnostics nodeBuiltinImport:off - Hardened git manifest/lockfile reader, report digest builder, and default dependency scanner.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { DEP_REPO_NAME_RE, type DepReportRecord } from "./depsTypes.ts";
import { renovateLookup } from "./depsRenovate.ts";
import { readRegistration } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { computePinDigests, validatePinsSpec } from "./pins.ts";
import type { ProcessRunner } from "./types.ts";

const DEP_FILE_BASENAMES = new Set([
  "package.json",
  // Renovate's npm manager also reads these, at any depth (workspace and Yarn catalogs, registry).
  "pnpm-workspace.yaml",
  ".yarnrc.yml",
  // Legacy Yarn config: the npm extractor reads its registry lines from a sibling or parent.
  ".yarnrc",
  ".npmrc",
  "pnpm-lock.yaml",
  "package-lock.json",
  "npm-shrinkwrap.json",
  "yarn.lock",
  "bun.lock",
  "Cargo.toml",
  "Cargo.lock",
  "pyproject.toml",
  "uv.lock",
  "go.mod",
  "go.sum",
]);

const DEP_EXACT_PATHS = new Set([
  // The Node release Renovate reads besides the manifests: a change to one changes the report
  // digest and invalidates a decision on an older lookup.
  ".nvmrc",
  ".node-version",
  "infra/ci-host/sq_pins.json",
  "infra/ci-host/ci-hosts.json",
  "infra/ci-host/ci-fleet-tools.sh",
]);

/** Pathspecs that select every candidate dependency file; `isTrackedDepPath` still filters them. */
const DEP_PATHSPECS: ReadonlyArray<string> = [
  ...[...DEP_FILE_BASENAMES].map((name) => `:(glob)**/${name}`),
  ...DEP_EXACT_PATHS,
  // Git prunes these trees during the walk (the vendored .repos tree alone holds hundreds of
  // manifests); isTrackedDepPath still filters what comes back.
  ":(exclude,glob).repos/**",
  ":(exclude,glob)**/node_modules/**",
  ":(exclude,glob)**/fixtures/**",
  ":(exclude,glob)**/vendor/**",
];

/** Paths per extraction process: a bounded argument list, a few processes per scan. */
const EXTRACT_BATCH_PATHS = 200;

/**
 * Writes each path's blob at COMMIT into DIR (one file per path, written by git itself), so no
 * blob passes through this process's memory or the runner's output.
 */
async function extractBlobs(
  run: ProcessRunner,
  repoDir: string,
  commit: string,
  paths: ReadonlyArray<string>,
  dir: string,
): Promise<void> {
  for (let at = 0; at < paths.length; at += EXTRACT_BATCH_PATHS) {
    const batch = paths.slice(at, at + EXTRACT_BATCH_PATHS);
    const res = await run({
      command: "bash",
      args: [
        "-c",
        'set -euo pipefail; r=$1; c=$2; d=$3; shift 3; for p in "$@"; do mkdir -p "$d/$(dirname "$p")"; git -C "$r" cat-file blob "$c:$p" > "$d/$p"; done',
        "--",
        repoDir,
        commit,
        dir,
        ...batch,
      ],
      cwd: repoDir,
    });
    if (res.exitCode !== 0) {
      throw new Error(res.stderr.trim() || `git cat-file blob failed at ${commit}`);
    }
  }
}

/** SHA-256 of a file, read as a stream (memory stays bounded for any file size). */
async function sha256File(file: string): Promise<string> {
  const hash = NodeCrypto.createHash("sha256");
  for await (const chunk of NodeFS.createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

const SAFE_GIT_REF_RE = /^[A-Za-z0-9._/@^{}-]+$/;

function isTrackedDepPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.split("/").includes("..")) return false;
  if (DEP_EXACT_PATHS.has(relPath)) return true;
  const parts = relPath.split("/");
  if (
    parts[0] === ".repos" ||
    parts.includes("node_modules") ||
    parts.includes("fixtures") ||
    parts.includes("vendor")
  ) {
    return false;
  }
  return DEP_FILE_BASENAMES.has(parts[parts.length - 1] ?? "");
}

function stableJsonValue(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJsonValue(item)).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .toSorted(([a], [b]) => a.localeCompare(b));
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableJsonValue(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** Computes a deterministic SHA-256 hex digest binding owner approval to a report's exact content. */
export function computeReportDigest(report: DepReportRecord): string {
  const payload = {
    id: report.id,
    status: report.status,
    created: report.created,
    source: report.source ?? null,
    files: report.files ?? {},
    updates: report.updates ?? [],
  };
  return NodeCrypto.createHash("sha256").update(stableJsonValue(payload)).digest("hex");
}

/**
 * Resolves the registered primary checkout for `repo`: `<queueRoot>/repos/<repo>/registration.json`
 * (what `ship-queue submit` writes), else the legacy `<queueRoot>/repos/<repo>/primary` file.
 */
export function resolveRegisteredRepoPrimary(queueRoot: string, repo: string): string | null {
  if (!DEP_REPO_NAME_RE.test(repo)) return null;
  const registered = readRegistration(queueRoot, repo)?.primary;
  let target = typeof registered === "string" ? registered.trim() : "";
  if (!target) {
    try {
      target = NodeFS.readFileSync(
        NodePath.join(queueRoot, "repos", repo, "primary"),
        "utf8",
      ).trim();
    } catch {
      return null;
    }
  }
  if (!target || !NodePath.isAbsolute(target)) return null;
  try {
    return NodeFS.statSync(target).isDirectory() ? target : null;
  } catch {
    return null;
  }
}

function validateGitRef(ref: string): string {
  const trimmed = ref.trim();
  if (!trimmed || trimmed.startsWith("-") || !SAFE_GIT_REF_RE.test(trimmed)) {
    throw new Error(`unsafe git ref: ${JSON.stringify(ref)}`);
  }
  return trimmed;
}

/** Reads SHA-256 digests of tracked dependency manifests/lockfiles (and pins) at `ref` in `repoDir`. */
export async function readRepoDependencyFilesAtRef(input: {
  readonly repoDir: string;
  readonly ref: string;
  readonly run?: ProcessRunner | undefined;
  /**
   * Keep the extracted files: the result's `tree` holds the exact bytes digested, by repo path,
   * and the caller removes it. Without it, the files are removed before this returns.
   */
  readonly keepTree?: boolean | undefined;
}): Promise<{
  readonly commit: string;
  readonly files: Readonly<Record<string, string>>;
  readonly paths: ReadonlyArray<string>;
  /** With `keepTree`: a directory holding each path's exact digested bytes. */
  readonly tree?: string | undefined;
  readonly pinsText?: string | undefined;
}> {
  const run = input.run ?? nodeProcessRunner;
  const ref = validateGitRef(input.ref);

  const rev = await run({
    command: "git",
    args: ["-C", input.repoDir, "rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`],
    cwd: input.repoDir,
  });
  if (rev.exitCode !== 0) {
    throw new Error(rev.stderr.trim() || `git ref '${ref}' not found in ${input.repoDir}`);
  }
  const commit = rev.stdout.trim();

  // Enumerate only dependency paths: diff the commit against the empty tree with glob
  // pathspecs (ls-tree takes no pathspec magic), instead of listing the whole tree.
  const emptyTree = await run({
    command: "git",
    args: ["-C", input.repoDir, "hash-object", "-t", "tree", "/dev/null"],
    cwd: input.repoDir,
  });
  if (emptyTree.exitCode !== 0) {
    throw new Error(emptyTree.stderr.trim() || "git hash-object failed");
  }
  const ls = await run({
    command: "git",
    args: [
      "-C",
      input.repoDir,
      "diff-tree",
      "-r",
      "-z",
      "--name-only",
      "--no-commit-id",
      emptyTree.stdout.trim(),
      commit,
      "--",
      ...DEP_PATHSPECS,
    ],
    cwd: input.repoDir,
  });
  if (ls.exitCode !== 0) {
    throw new Error(ls.stderr.trim() || `git diff-tree failed at ${commit}`);
  }

  const trackedPaths = ls.stdout
    .split("\0")
    .filter((p) => p.length > 0 && isTrackedDepPath(p))
    .toSorted();

  const files: Record<string, string> = {};
  const pinSourceTexts: Record<string, string> = {};
  if (trackedPaths.length === 0) return { commit, files, paths: trackedPaths };

  // Blobs go straight to files and are hashed as streams, so a scan's memory stays bounded
  // however large or many the dependency files are.
  const tree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-deps-tree-"));
  try {
    await extractBlobs(run, input.repoDir, commit, trackedPaths, tree);
    for (const relPath of trackedPaths) {
      files[relPath] = await sha256File(NodePath.join(tree, relPath));
      // The pin sources are three small fixed files.
      if (DEP_EXACT_PATHS.has(relPath)) {
        pinSourceTexts[relPath] = NodeFS.readFileSync(NodePath.join(tree, relPath), "utf8");
      }
    }
  } catch (error) {
    NodeFS.rmSync(tree, { recursive: true, force: true });
    throw error;
  }
  if (!input.keepTree) NodeFS.rmSync(tree, { recursive: true, force: true });

  const pinsRaw = pinSourceTexts["infra/ci-host/sq_pins.json"];
  if (pinsRaw) {
    const spec = validatePinsSpec(JSON.parse(pinsRaw) as unknown, "infra/ci-host/sq_pins.json");
    Object.assign(files, computePinDigests(pinSourceTexts, spec));
  }

  return {
    commit,
    files,
    paths: trackedPaths,
    ...(input.keepTree ? { tree } : {}),
    ...(pinsRaw ? { pinsText: pinsRaw } : {}),
  };
}

/** Default `readCurrentFiles` reader for `decideShipQueueDeps` backed by registered repo primary checkouts. */
export async function readRegisteredRepoDependencyFiles(input: {
  readonly queueRoot: string;
  readonly repo: string;
  readonly ref: string;
  readonly run?: ProcessRunner | undefined;
}): Promise<Readonly<Record<string, string>>> {
  const primary = resolveRegisteredRepoPrimary(input.queueRoot, input.repo);
  if (!primary) {
    throw new Error(`repository '${input.repo}' has no registered primary checkout`);
  }
  const res = await readRepoDependencyFilesAtRef({
    repoDir: primary,
    ref: input.ref,
    run: input.run,
  });
  return res.files;
}

/**
 * Default dependency scanner: digests the tracked manifests, lockfiles and pins at the base ref,
 * and asks the pinned Renovate CLI which updates are available.
 */
export async function defaultScanRepo(input: {
  readonly queueRoot: string;
  readonly repo: string;
  readonly checkout?: string | undefined;
  readonly nowEpochSec: number;
  readonly run?: ProcessRunner | undefined;
  readonly lookup?: typeof renovateLookup | undefined;
}): Promise<DepReportRecord> {
  const run = input.run ?? nodeProcessRunner;
  const targetDir = input.checkout
    ? NodePath.resolve(input.checkout)
    : resolveRegisteredRepoPrimary(input.queueRoot, input.repo);
  if (!targetDir) {
    throw new Error(`repository '${input.repo}' has no registered primary checkout`);
  }

  let ref = "HEAD";
  if (!input.checkout) {
    const checkOrigin = await run({
      command: "git",
      args: ["-C", targetDir, "rev-parse", "--verify", "--end-of-options", "origin/main^{commit}"],
      cwd: targetDir,
    });
    ref = checkOrigin.exitCode === 0 ? "origin/main" : "HEAD";
  }

  const { commit, files, paths, tree, pinsText } = await readRepoDependencyFilesAtRef({
    repoDir: targetDir,
    ref,
    run,
    keepTree: true,
  });
  // Available updates come from the pinned Renovate CLI, never from comparing local digests.
  let lookup: Awaited<ReturnType<typeof renovateLookup>>;
  try {
    lookup = await (input.lookup ?? renovateLookup)({ tree: tree ?? "", paths, pinsText, run });
  } finally {
    if (tree) NodeFS.rmSync(tree, { recursive: true, force: true });
  }
  const updates = lookup.updates;

  const idSeed = stableJsonValue({ repo: input.repo, commit, files, at: input.nowEpochSec });
  const idSuffix = NodeCrypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 16);
  return {
    id: `${input.repo}:${idSuffix}`,
    // A lookup that failed for any dependency never reads as clean: the gate admits only "clean".
    status: lookup.incomplete.length > 0 ? "incomplete" : updates.length > 0 ? "pending" : "clean",
    created: input.nowEpochSec,
    files,
    updates,
    ...(lookup.incomplete.length > 0
      ? {
          incomplete: lookup.incomplete,
          error: `${lookup.incomplete.length} dependency lookup(s) failed; the report cannot be clean`,
        }
      : {}),
    source: { kind: input.checkout ? "checkout" : "main", commit },
  };
}
