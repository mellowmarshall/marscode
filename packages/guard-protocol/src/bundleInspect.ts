// @effect-diagnostics nodeBuiltinImport:off - Check-first protected-diff inspector for bundled guard approvals.
import * as NodeChildProcess from "node:child_process";
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import {
  canonicalProtectedDiffSha256,
  normalizeRepoSlug,
  normalizeSortedUnique,
} from "./digests.ts";
import { ALWAYS_ONCE_GUARDS, isWholeCommitGate, sanitizeText } from "./protocol.ts";

export interface WireGuardBundle {
  readonly repo: string;
  readonly branch: string;
  readonly pr_or_issue: string;
  readonly gates: ReadonlyArray<{ readonly gate_id: string; readonly reason: string }>;
  readonly protected_paths: ReadonlyArray<string>;
  readonly protected_diff_sha256: string;
  readonly body_sha256: string;
  readonly commit_sha: string;
  readonly diff_preview?: string | undefined;
  readonly summary?: string | undefined;
}

interface ProtectedRule {
  readonly test: (relPath: string) => boolean;
  readonly gateId: string;
  readonly reason: string;
}

const PROTECTED_RULES: ReadonlyArray<ProtectedRule> = [
  {
    test: (p) => p === "host-guards/exceptions.json" || p.endsWith("/exceptions.json"),
    gateId: "allowlist",
    reason: "host-guards exceptions modified",
  },
  {
    test: (p) => p === ".gitleaks.toml" || p === ".gitleaksignore" || p.endsWith("/.gitleaks.toml"),
    gateId: "allowlist",
    reason: "secret-scanner allowlist modified",
  },
  {
    test: (p) =>
      p === "playbook/PLAYBOOK.md" || p === "PLAYBOOK.md" || p === "packages/playbook/PLAYBOOK.md",
    gateId: "playbook-amend",
    reason: "PLAYBOOK.md amended",
  },
  {
    test: (p) => p === "playbook.json",
    gateId: "playbook-declaration",
    reason: "playbook.json modified",
  },
  {
    test: (p) => p.startsWith("host-guards/"),
    gateId: "host-guards",
    reason: "host-guards policy modified",
  },
  {
    test: (p) => p.startsWith(".github/workflows/"),
    gateId: "ci-workflow",
    reason: "CI workflow modified",
  },
];

const BUNDLABLE_GUARDS = new Set(["ship-queue", "playbook"]);
const SAFE_REF_RE = /^[A-Za-z0-9._/@][A-Za-z0-9._/@-]*$/;
const MAX_PROTECTED_FILE_BYTES = 1024 * 1024;

function resolveSystemGit(): string | null {
  for (const cand of ["/usr/bin/git", "/bin/git", "/opt/homebrew/bin/git", "/usr/local/bin/git"]) {
    try {
      const st = NodeFS.statSync(cand);
      if (st.isFile() && (st.mode & 0o111) !== 0 && (st.mode & 0o022) === 0) {
        return cand;
      }
    } catch {
      // try next
    }
  }
  return null;
}

function accountHomeDir(): string {
  try {
    return NodeOS.userInfo().homedir || NodeOS.homedir();
  } catch {
    return NodeOS.homedir();
  }
}

function gitScrubbedEnv(): NodeJS.ProcessEnv {
  return {
    PATH: "/usr/bin:/bin",
    HOME: accountHomeDir(),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
  };
}

function gitBaseArgs(cwd: string): ReadonlyArray<string> {
  return [
    "-C",
    cwd,
    "--no-replace-objects",
    "-c",
    "core.fsmonitor=",
    "-c",
    "core.hooksPath=/dev/null",
    "-c",
    "core.abbrev=40",
    "-c",
    "core.attributesfile=/dev/null",
    "-c",
    "diff.external=",
  ];
}

function runGit(cwd: string, args: ReadonlyArray<string>): string | null {
  const gitBin = resolveSystemGit();
  if (!gitBin) return null;
  const res = NodeChildProcess.spawnSync(gitBin, [...gitBaseArgs(cwd), ...args], {
    encoding: "utf8",
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: gitScrubbedEnv(),
  });
  if (res.status !== 0) return null;
  return res.stdout ?? "";
}

function runGitBuffer(cwd: string, args: ReadonlyArray<string>): Buffer | null {
  const gitBin = resolveSystemGit();
  if (!gitBin) return null;
  const res = NodeChildProcess.spawnSync(gitBin, [...gitBaseArgs(cwd), ...args], {
    timeout: 5_000,
    maxBuffer: 8 * 1024 * 1024,
    env: gitScrubbedEnv(),
  });
  if (res.status !== 0) return null;
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? "", "utf8");
}

function isSafeRefName(ref: string): boolean {
  return (
    ref.length > 0 &&
    ref.length <= 200 &&
    !ref.startsWith("-") &&
    !ref.includes("..") &&
    SAFE_REF_RE.test(ref)
  );
}

function classifyProtectedPath(relPath: string): ProtectedRule | null {
  if (relPath.startsWith("node_modules/") || relPath.includes("/node_modules/")) {
    return null;
  }
  for (const rule of PROTECTED_RULES) {
    if (rule.test(relPath)) return rule;
  }
  return null;
}

function resolveBaseRef(worktree: string, explicitBase?: string): string | null {
  if (explicitBase !== undefined) {
    const trimmed = explicitBase.trim();
    if (!isSafeRefName(trimmed)) return null;
    const verified = runGit(worktree, ["rev-parse", "--verify", "--quiet", `${trimmed}^{commit}`]);
    return verified && verified.trim().length > 0 ? trimmed : null;
  }
  for (const ref of [
    "refs/remotes/origin/main",
    "refs/remotes/origin/master",
    "refs/heads/main",
    "refs/heads/master",
  ]) {
    const verified = runGit(worktree, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`]);
    if (verified && verified.trim().length > 0) return ref;
  }
  return null;
}

function extractPrOrIssue(branch: string, explicitPr?: string): string {
  if (explicitPr && explicitPr.trim()) return sanitizeText(explicitPr, 64);
  const match = /(?:^|[/\-_])(?:issue|pr|fix|feat)[/-]?(\d+)\b/i.exec(branch);
  return match?.[1] ? `#${match[1]}` : "";
}

function detectWholeCommitFlags(command: ReadonlyArray<string>): ReadonlyArray<string> {
  const gates: string[] = [];
  for (const arg of command) {
    const lower = arg.trim().toLowerCase();
    if (
      lower === "--no-review" ||
      lower.startsWith("--no-review=") ||
      lower === "--skip-review" ||
      lower.startsWith("--skip-review=")
    ) {
      gates.push("no-review");
    }
    if (lower === "--unproven" || lower.startsWith("--unproven=")) {
      gates.push("unproven");
    }
    if (
      lower === "--skip-ci-run-judge" ||
      lower.startsWith("--skip-ci-run-judge=") ||
      lower === "--skip-ci-judge" ||
      lower.startsWith("--skip-ci-judge=")
    ) {
      gates.push("ci-run-judge");
    }
  }
  return normalizeSortedUnique(gates);
}

function sha256Buffer(buf: Buffer): string {
  return NodeCrypto.createHash("sha256").update(buf).digest("hex");
}

/**
 * Compares raw on-disk working-tree bytes against raw base blobs (bypassing git clean filters,
 * attributes, and ignore rules) for `playbook` mode. Fails closed (`null`) on symlinks or >1 MiB.
 */
function buildRawWorktreeProtectedDiff(
  topLevel: string,
  mergeBase: string,
  candidatePaths: ReadonlyArray<string>,
): { readonly paths: ReadonlyArray<string>; readonly diffText: string } | null {
  const changedPaths: string[] = [];
  const sections: string[] = [];

  for (const relPath of normalizeSortedUnique(candidatePaths)) {
    const baseBlob = runGitBuffer(topLevel, ["cat-file", "blob", `${mergeBase}:${relPath}`]);
    const absPath = NodePath.join(topLevel, relPath);
    let diskBytes: Buffer | null = null;
    try {
      const st = NodeFS.lstatSync(absPath);
      if (st.isSymbolicLink() || !st.isFile() || st.size > MAX_PROTECTED_FILE_BYTES) {
        return null;
      }
      diskBytes = NodeFS.readFileSync(absPath);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") return null;
      diskBytes = null;
    }

    if (baseBlob === null && diskBytes === null) continue;
    if (baseBlob !== null && diskBytes !== null && baseBlob.equals(diskBytes)) continue;

    changedPaths.push(relPath);
    const baseHash = baseBlob ? sha256Buffer(baseBlob) : "absent";
    const diskHash = diskBytes ? sha256Buffer(diskBytes) : "deleted";
    const bodyPreview = (diskBytes ?? Buffer.alloc(0))
      .toString("utf8")
      .split(/\r?\n/)
      .slice(0, 40)
      .map((line) => `+${line}`)
      .join("\n");
    sections.push(
      `diff --git a/${relPath} b/${relPath}\nbase-blob: ${baseHash}\nworktree-raw: ${diskHash}\n${bodyPreview}`,
    );
  }

  return { paths: changedPaths, diffText: sections.join("\n") };
}

function listPlaybookCandidateProtectedPaths(topLevel: string, mergeBase: string): string[] {
  const committedRaw = runGit(topLevel, ["diff", "--name-only", `${mergeBase}..HEAD`]) ?? "";
  const trackedRaw = runGit(topLevel, ["ls-files"]) ?? "";
  // Omit `--exclude-standard` so `.git/info/exclude` and `.gitignore` cannot hide protected files.
  const untrackedFixedRaw =
    runGit(topLevel, [
      "ls-files",
      "--others",
      "--",
      "host-guards",
      ".github/workflows",
      "playbook/PLAYBOOK.md",
      "packages/playbook/PLAYBOOK.md",
      "PLAYBOOK.md",
      "playbook.json",
      ".gitleaks.toml",
      ".gitleaksignore",
    ]) ?? "";
  const untrackedNestedRaw =
    runGit(topLevel, [
      "ls-files",
      "--others",
      "--exclude=node_modules",
      "--exclude=.git",
      "--",
      ":(glob)**/exceptions.json",
      ":(glob)**/.gitleaks.toml",
    ]) ?? "";
  const all = normalizeSortedUnique([
    ...committedRaw.split(/\r?\n/),
    ...trackedRaw.split(/\r?\n/),
    ...untrackedFixedRaw.split(/\r?\n/),
    ...untrackedNestedRaw.split(/\r?\n/),
  ]);
  return all.filter((p) => classifyProtectedPath(p) !== null);
}

/**
 * Inspects a git worktree to build a check-first content-digest bundle spec for `ship-queue`
 * or `playbook` overrides. Returns `undefined` for always-once guards or when git metadata
 * or protected-file diffs cannot be bound unambiguously.
 */
export function inspectWorktreeBundle(input: {
  readonly guard: string;
  readonly command: ReadonlyArray<string>;
  readonly cwd: string;
  readonly worktree?: string | undefined;
  readonly branch?: string | undefined;
  readonly baseRef?: string | undefined;
  readonly prOrIssue?: string | undefined;
  readonly summary?: string | undefined;
}): WireGuardBundle | undefined {
  const guardNorm = input.guard.trim().toLowerCase();
  if (ALWAYS_ONCE_GUARDS.has(guardNorm) || !BUNDLABLE_GUARDS.has(guardNorm)) {
    return undefined;
  }

  let candidateWt = input.worktree?.trim() || "";
  let candidateBranch = input.branch?.trim() || "";
  if (!candidateWt && guardNorm === "ship-queue" && input.command.length >= 2) {
    const offset =
      input.command[0] === "ship-queue" || input.command[0]?.endsWith("/ship-queue") ? 1 : 0;
    const verb = input.command[offset];
    if (verb === "submit" || verb === "preflight") {
      candidateWt = input.command[offset + 1] ?? "";
      candidateBranch = candidateBranch || (input.command[offset + 2] ?? "");
    }
  }
  const rawWorktree = candidateWt
    ? NodePath.isAbsolute(candidateWt)
      ? candidateWt
      : NodePath.resolve(input.cwd, candidateWt)
    : input.cwd;
  if (!rawWorktree || rawWorktree.startsWith("-") || !NodeFS.existsSync(rawWorktree)) {
    return undefined;
  }

  const topLevel = runGit(rawWorktree, ["rev-parse", "--show-toplevel"])?.trim();
  if (!topLevel) return undefined;

  // Refuse shallow repos or repos with grafts/replace refs so merge-base/blobs cannot be skewed.
  if (runGit(topLevel, ["rev-parse", "--is-shallow-repository"])?.trim() === "true") {
    return undefined;
  }
  const gitCommonDir = runGit(topLevel, ["rev-parse", "--git-common-dir"])?.trim();
  if (gitCommonDir) {
    const absGitCommon = NodePath.resolve(topLevel, gitCommonDir);
    if (
      NodeFS.existsSync(NodePath.join(absGitCommon, "shallow")) ||
      NodeFS.existsSync(NodePath.join(absGitCommon, "info", "grafts"))
    ) {
      return undefined;
    }
  }

  const remoteUrl = runGit(topLevel, ["remote", "get-url", "origin"])?.trim() ?? "";
  const repo = normalizeRepoSlug(remoteUrl) || NodePath.basename(topLevel).toLowerCase();
  const headBranch = runGit(topLevel, ["rev-parse", "--abbrev-ref", "HEAD"])?.trim() || "";
  if (!headBranch || headBranch === "HEAD" || !isSafeRefName(headBranch)) return undefined;
  if (candidateBranch && candidateBranch !== headBranch) return undefined;
  const branch = headBranch;

  const commitSha = runGit(topLevel, ["rev-parse", "HEAD"])?.trim().toLowerCase() ?? "";
  if (!repo || !/^[0-9a-f]{40}$/.test(commitSha)) return undefined;

  const baseRef = resolveBaseRef(topLevel, input.baseRef);
  if (!baseRef) return undefined;
  const mergeBase = runGit(topLevel, ["merge-base", baseRef, "HEAD"])?.trim().toLowerCase() ?? "";
  if (!/^[0-9a-f]{40}$/.test(mergeBase)) return undefined;

  let sortedPaths: ReadonlyArray<string>;
  let diffText: string;

  if (guardNorm === "playbook") {
    const candidates = listPlaybookCandidateProtectedPaths(topLevel, mergeBase);
    const rawDiff = buildRawWorktreeProtectedDiff(topLevel, mergeBase, candidates);
    if (!rawDiff || rawDiff.paths.length === 0 || rawDiff.diffText.length === 0) {
      return undefined;
    }
    sortedPaths = rawDiff.paths;
    diffText = rawDiff.diffText;
  } else {
    const committedNamesRaw = runGit(topLevel, ["diff", "--name-only", `${mergeBase}..HEAD`]) ?? "";
    const committedProtected = normalizeSortedUnique(
      committedNamesRaw.split(/\r?\n/).filter((p) => classifyProtectedPath(p) !== null),
    );
    if (committedProtected.length === 0) return undefined;
    const committedDiff = runGit(topLevel, [
      "diff",
      "--no-textconv",
      "--no-ext-diff",
      "--full-index",
      "--no-color",
      "--no-renames",
      "--binary",
      `${mergeBase}..HEAD`,
      "--",
      ...committedProtected,
    ]);
    if (committedDiff === null || committedDiff.length === 0) return undefined;
    sortedPaths = committedProtected;
    diffText = committedDiff;
  }

  const gateMap = new Map<string, string>();
  for (const relPath of sortedPaths) {
    const rule = classifyProtectedPath(relPath);
    if (rule && !gateMap.has(rule.gateId)) {
      gateMap.set(rule.gateId, rule.reason);
    }
  }
  for (const wcGate of detectWholeCommitFlags(input.command)) {
    if (isWholeCommitGate(wcGate)) {
      gateMap.set(wcGate, `whole-commit flag (${wcGate})`);
    }
  }

  const protectedDiffSha256 = canonicalProtectedDiffSha256(diffText);
  const gates = Array.from(gateMap.entries())
    .toSorted(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([gate_id, reason]) => ({ gate_id, reason }));

  const previewLines = diffText.split(/\r?\n/).slice(0, 60).join("\n");
  const diffPreview = previewLines.length > 2000 ? `${previewLines.slice(0, 1999)}…` : previewLines;

  return {
    repo,
    branch,
    pr_or_issue: extractPrOrIssue(branch, input.prOrIssue),
    gates,
    protected_paths: sortedPaths,
    protected_diff_sha256: protectedDiffSha256,
    body_sha256: "",
    commit_sha: commitSha,
    diff_preview: diffPreview,
    ...(input.summary ? { summary: sanitizeText(input.summary, 180) } : {}),
  };
}
