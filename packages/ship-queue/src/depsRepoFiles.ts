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

/** Splits `git cat-file --batch` output (`<oid> blob <size>\n<bytes>\n` per request) by path. */
function parseCatFileBatch(out: Buffer, paths: ReadonlyArray<string>): ReadonlyMap<string, Buffer> {
  const blobs = new Map<string, Buffer>();
  let at = 0;
  for (const relPath of paths) {
    const eol = out.indexOf(0x0a, at);
    if (eol < 0) throw new Error(`git cat-file --batch output ended before ${relPath}`);
    const header = out.subarray(at, eol).toString("utf8");
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(header);
    if (!match) throw new Error(`git cat-file --batch could not read ${relPath}: ${header}`);
    const size = Number(match[1]);
    const start = eol + 1;
    if (start + size > out.length)
      throw new Error(`git cat-file --batch output truncated at ${relPath}`);
    blobs.set(relPath, out.subarray(start, start + size));
    at = start + size + 1;
  }
  return blobs;
}

/** Target bytes of blob content per `git cat-file --batch` call (a larger blob reads alone). */
const CAT_FILE_BATCH_BYTES = 3 * 1024 * 1024;

async function readBlobsBatched(
  run: ProcessRunner,
  repoDir: string,
  commit: string,
  paths: ReadonlyArray<string>,
): Promise<ReadonlyMap<string, Buffer>> {
  const requests = paths.map((relPath) => `${commit}:${relPath}`).join("\n") + "\n";
  const check = await run({
    command: "git",
    args: ["-C", repoDir, "cat-file", "--batch-check"],
    cwd: repoDir,
    stdin: requests,
  });
  if (check.exitCode !== 0)
    throw new Error(check.stderr.trim() || "git cat-file --batch-check failed");
  const sizes = check.stdout.split("\n").filter(Boolean);
  const chunks: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  paths.forEach((relPath, index) => {
    const match = /^[0-9a-f]+ blob (\d+)$/.exec(sizes[index] ?? "");
    if (!match) throw new Error(`git cat-file --batch-check could not read ${relPath}`);
    const size = Number(match[1]);
    // The target bounds a batch, not a file: a larger blob (a big lockfile) gets a batch of its
    // own. Its bytes go to a file, so the runner's output cap never applies to it.
    if (current.length > 0 && currentBytes + size > CAT_FILE_BATCH_BYTES) {
      chunks.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(relPath);
    currentBytes += size;
  });
  if (current.length > 0) chunks.push(current);

  // Blob bytes go to a file, never through the runner's UTF-8 decoded stdout, so any file
  // content (not only valid UTF-8) is read exactly.
  const blobs = new Map<string, Buffer>();
  const work = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "sq-deps-blobs-"));
  try {
    const outFile = NodePath.join(work, "batch.out");
    for (const chunk of chunks) {
      const batch = await run({
        command: "bash",
        args: ["-c", 'git -C "$1" cat-file --batch > "$2"', "--", repoDir, outFile],
        cwd: repoDir,
        stdin: chunk.map((relPath) => `${commit}:${relPath}`).join("\n") + "\n",
      });
      if (batch.exitCode !== 0) {
        throw new Error(batch.stderr.trim() || "git cat-file --batch failed");
      }
      for (const [relPath, content] of parseCatFileBatch(NodeFS.readFileSync(outFile), chunk)) {
        blobs.set(relPath, content);
      }
    }
  } finally {
    NodeFS.rmSync(work, { recursive: true, force: true });
  }
  return blobs;
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
}): Promise<{
  readonly commit: string;
  readonly files: Readonly<Record<string, string>>;
  readonly paths: ReadonlyArray<string>;
  /** The exact bytes digested above, by path: what the lookup is given, never re-extracted. */
  readonly blobs: ReadonlyMap<string, Uint8Array>;
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
  if (trackedPaths.length === 0) return { commit, files, paths: trackedPaths, blobs: new Map() };

  // Batched object reads (a few processes, not one per file), each under the runner's output cap.
  const blobs = await readBlobsBatched(run, input.repoDir, commit, trackedPaths);
  for (const relPath of trackedPaths) {
    const content = blobs.get(relPath)!;
    files[relPath] = NodeCrypto.createHash("sha256").update(content).digest("hex");
    if (DEP_EXACT_PATHS.has(relPath)) {
      pinSourceTexts[relPath] = content.toString("utf8");
    }
  }

  const pinsRaw = pinSourceTexts["infra/ci-host/sq_pins.json"];
  if (pinsRaw) {
    const spec = validatePinsSpec(JSON.parse(pinsRaw) as unknown, "infra/ci-host/sq_pins.json");
    Object.assign(files, computePinDigests(pinSourceTexts, spec));
  }

  return {
    commit,
    files,
    paths: trackedPaths,
    blobs,
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

  const { commit, files, blobs, pinsText } = await readRepoDependencyFilesAtRef({
    repoDir: targetDir,
    ref,
    run,
  });
  // Available updates come from the pinned Renovate CLI, never from comparing local digests.
  const lookup = await (input.lookup ?? renovateLookup)({ files: blobs, pinsText, run });
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
