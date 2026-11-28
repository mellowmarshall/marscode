// @effect-diagnostics nodeBuiltinImport:off - Hardened git manifest/lockfile reader, report digest builder, and default dependency scanner.
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";

import {
  DEP_REPO_NAME_RE,
  type DepReportRecord,
  type DepRepoState,
  type DepUpdateItem,
} from "./depsTypes.ts";
import { readRegistration } from "./jobStore.ts";
import { nodeProcessRunner } from "./nodeProcess.ts";
import { computePinDigests, validatePinsSpec } from "./pins.ts";
import type { ProcessRunner } from "./types.ts";

const DEP_FILE_BASENAMES = new Set([
  "package.json",
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
  "infra/ci-host/sq_pins.json",
  "infra/ci-host/ci-hosts.json",
  "infra/ci-host/ci-fleet-tools.sh",
]);

const SAFE_GIT_REF_RE = /^[A-Za-z0-9._/@^{}-]+$/;

function isTrackedDepPath(relPath: string): boolean {
  if (!relPath || relPath.startsWith("/") || relPath.split("/").includes("..")) return false;
  if (DEP_EXACT_PATHS.has(relPath)) return true;
  const parts = relPath.split("/");
  if (parts.includes("node_modules") || parts.includes("fixtures") || parts.includes("vendor")) {
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
}): Promise<{ readonly commit: string; readonly files: Readonly<Record<string, string>> }> {
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

  const ls = await run({
    command: "git",
    args: ["-C", input.repoDir, "ls-tree", "-r", "-z", "--name-only", "--end-of-options", commit],
    cwd: input.repoDir,
  });
  if (ls.exitCode !== 0) {
    throw new Error(ls.stderr.trim() || `git ls-tree failed at ${commit}`);
  }

  const trackedPaths = ls.stdout
    .split("\0")
    .filter((p) => p.length > 0 && isTrackedDepPath(p))
    .toSorted();

  const files: Record<string, string> = {};
  const pinSourceTexts: Record<string, string> = {};
  for (const relPath of trackedPaths) {
    const blob = await run({
      command: "git",
      args: ["-C", input.repoDir, "cat-file", "-p", `${commit}:${relPath}`],
      cwd: input.repoDir,
    });
    if (blob.exitCode !== 0) {
      throw new Error(blob.stderr.trim() || `git cat-file failed for ${relPath}`);
    }
    files[relPath] = NodeCrypto.createHash("sha256").update(blob.stdout).digest("hex");
    if (DEP_EXACT_PATHS.has(relPath)) {
      pinSourceTexts[relPath] = blob.stdout;
    }
  }

  const pinsRaw = pinSourceTexts["infra/ci-host/sq_pins.json"];
  if (pinsRaw) {
    const spec = validatePinsSpec(JSON.parse(pinsRaw) as unknown, "infra/ci-host/sq_pins.json");
    Object.assign(files, computePinDigests(pinSourceTexts, spec));
  }

  return { commit, files };
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
 * Default git-backed dependency scanner used when no external Renovate scanner is injected.
 * Reads tracked manifests/lockfiles and pins at `origin/main` (or `main`/`HEAD`) and emits a real report.
 */
export async function defaultScanRepo(input: {
  readonly queueRoot: string;
  readonly repo: string;
  readonly checkout?: string | undefined;
  readonly previousState?: DepRepoState | undefined;
  readonly nowEpochSec: number;
  readonly run?: ProcessRunner | undefined;
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

  const { commit, files } = await readRepoDependencyFilesAtRef({ repoDir: targetDir, ref, run });
  const prevFiles = input.previousState?.report?.files;
  const updates: DepUpdateItem[] = [];
  if (prevFiles && Object.keys(prevFiles).length > 0) {
    const allKeys = [...new Set([...Object.keys(prevFiles), ...Object.keys(files)])].toSorted();
    for (const file of allKeys) {
      const prevHash = prevFiles[file] ?? "absent";
      const nextHash = files[file] ?? "absent";
      if (prevHash !== nextHash) {
        updates.push({
          packageFile: file,
          depName: file,
          currentValue: prevHash.slice(0, 12),
          newValue: nextHash.slice(0, 12),
          releaseTimestamp: null,
        });
      }
    }
  }

  const idSeed = stableJsonValue({ repo: input.repo, commit, files, at: input.nowEpochSec });
  const idSuffix = NodeCrypto.createHash("sha256").update(idSeed).digest("hex").slice(0, 16);
  return {
    id: `${input.repo}:${idSuffix}`,
    status: updates.length > 0 ? "pending" : "clean",
    created: input.nowEpochSec,
    files,
    updates,
    source: { kind: input.checkout ? "checkout" : "main", commit },
  };
}
