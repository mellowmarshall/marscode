// @effect-diagnostics nodeBuiltinImport:off - Hardened git manifest/lockfile reader, report digest builder, and default dependency scanner.
import * as NodeChildProcess from "node:child_process";
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

/**
 * Streams each path's blob at COMMIT from one `git cat-file --batch` process into its own file
 * under DIR, hashing it on the way: one git query for all paths, and memory bounded by a read
 * chunk, never by a file. Returns each path's SHA-256.
 */
async function extractBlobs(
  repoDir: string,
  commit: string,
  paths: ReadonlyArray<string>,
  dir: string,
): Promise<Record<string, string>> {
  const digests: Record<string, string> = {};
  const child = NodeChildProcess.spawn("git", ["-C", repoDir, "cat-file", "--batch"], {
    cwd: repoDir,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = (stderr + chunk.toString("utf8")).slice(-2000);
  });
  const exited = new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? 1));
  });
  child.stdin.end(paths.map((relPath) => `${commit}:${relPath}`).join("\n") + "\n");

  let index = 0;
  let header = Buffer.alloc(0);
  let remaining = -1; // bytes of the current blob still to come; -1 while reading a header
  let fd = -1;
  let hash: NodeCrypto.Hash | undefined;
  const finishBlob = () => {
    NodeFS.closeSync(fd);
    fd = -1;
    digests[paths[index]!] = hash!.digest("hex");
    index += 1;
  };
  try {
    for await (const piece of child.stdout) {
      let chunk = piece as Buffer;
      while (chunk.length > 0) {
        if (remaining < 0) {
          const eol = chunk.indexOf(0x0a);
          if (eol < 0) {
            header = Buffer.concat([header, chunk]);
            chunk = Buffer.alloc(0);
            continue;
          }
          const line = Buffer.concat([header, chunk.subarray(0, eol)]).toString("utf8");
          header = Buffer.alloc(0);
          chunk = chunk.subarray(eol + 1);
          const relPath = paths[index];
          const match = /^[0-9a-f]+ blob (\d+)$/.exec(line);
          if (relPath === undefined || !match) {
            throw new Error(
              `git cat-file --batch could not read ${relPath ?? "past the last path"}: ${line}`,
            );
          }
          const target = NodePath.join(dir, relPath);
          NodeFS.mkdirSync(NodePath.dirname(target), { recursive: true });
          fd = NodeFS.openSync(target, "w");
          hash = NodeCrypto.createHash("sha256");
          remaining = Number(match[1]);
        }
        if (remaining > 0) {
          const take = Math.min(remaining, chunk.length);
          const part = chunk.subarray(0, take);
          NodeFS.writeSync(fd, part);
          hash!.update(part);
          remaining -= take;
          chunk = chunk.subarray(take);
        }
        // After a blob's bytes, git writes one newline before the next header.
        if (remaining === 0 && chunk.length > 0) {
          if (chunk[0] !== 0x0a) throw new Error("git cat-file --batch output is malformed");
          chunk = chunk.subarray(1);
          finishBlob();
          remaining = -1;
        }
      }
    }
    // The last blob's newline may have arrived alone at the end of a chunk boundary.
    if (remaining === 0 && fd >= 0) finishBlob();
  } finally {
    if (fd >= 0) NodeFS.closeSync(fd);
    if (child.exitCode === null) child.kill();
  }
  const code = await exited;
  if (code !== 0) throw new Error(stderr.trim() || `git cat-file --batch exited ${code}`);
  if (index !== paths.length) {
    throw new Error(`git cat-file --batch returned ${index} of ${paths.length} dependency files`);
  }
  return digests;
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
  // The path list goes to a file, never through the runner's capped stdout, so a repository
  // with megabytes of dependency paths is never read as a shorter list.
  const listDir = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-deps-paths-"));
  let listing: string;
  try {
    const listFile = NodePath.join(listDir, "paths");
    const ls = await run({
      command: "bash",
      args: [
        "-c",
        'r=$1; out=$2; shift 2; exec git -C "$r" diff-tree -r -z --name-only --no-commit-id "$@" > "$out"',
        "--",
        input.repoDir,
        listFile,
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
    listing = NodeFS.readFileSync(listFile, "utf8");
  } finally {
    NodeFS.rmSync(listDir, { recursive: true, force: true });
  }

  const trackedPaths = listing
    .split("\0")
    .filter((p) => p.length > 0 && isTrackedDepPath(p))
    .toSorted();

  const files: Record<string, string> = {};
  const pinSourceTexts: Record<string, string> = {};
  if (trackedPaths.length === 0) return { commit, files, paths: trackedPaths };

  // Blobs go straight to files and are hashed as streams, so a scan's memory stays bounded
  // however large or many the dependency files are. The tree is removed on any failure, and
  // otherwise unless the caller takes it (keepTree).
  const tree = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-deps-tree-"));
  let handedOver = false;
  try {
    Object.assign(files, await extractBlobs(input.repoDir, commit, trackedPaths, tree));
    for (const relPath of trackedPaths) {
      // The pin sources are three small fixed files.
      if (DEP_EXACT_PATHS.has(relPath)) {
        pinSourceTexts[relPath] = NodeFS.readFileSync(NodePath.join(tree, relPath), "utf8");
      }
    }
    // A committed pin file is always validated, even an empty one: a pin file that does not
    // parse fails the scan instead of silently dropping every tool pin from the lookup.
    const pinsRaw = pinSourceTexts["infra/ci-host/sq_pins.json"];
    if (pinsRaw !== undefined) {
      const spec = validatePinsSpec(JSON.parse(pinsRaw) as unknown, "infra/ci-host/sq_pins.json");
      Object.assign(files, computePinDigests(pinSourceTexts, spec));
    }
    handedOver = Boolean(input.keepTree);
    return {
      commit,
      files,
      paths: trackedPaths,
      ...(input.keepTree ? { tree } : {}),
      ...(pinsRaw !== undefined ? { pinsText: pinsRaw } : {}),
    };
  } finally {
    if (!handedOver) NodeFS.rmSync(tree, { recursive: true, force: true });
  }
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
