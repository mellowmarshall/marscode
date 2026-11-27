// @effect-diagnostics nodeBuiltinImport:off - In-scope repository discovery, hardened git runner, and default-branch declaration loader.
import * as NodeChildProcess from "node:child_process";
import * as NodePath from "node:path";

import type { HostGuardsConfig } from "./hostConfig.ts";

const TREE_GUARD_CONF = ".tree-guard.conf";
export const FALLBACK_BASES: ReadonlyArray<string> = ["main", "master"];

const GIT_LOCATION_ENV: ReadonlyArray<string> = [
  "GIT_DIR",
  "GIT_WORK_TREE",
  "GIT_COMMON_DIR",
  "GIT_INDEX_FILE",
  "GIT_OBJECT_DIRECTORY",
  "GIT_ALTERNATE_OBJECT_DIRECTORIES",
  "GIT_PREFIX",
];

const GITHUB_URL_RE =
  /^(?:(?:https?|ssh|git|git\+ssh|ssh\+git):\/\/(?:[^@/]+@)?(?:ssh\.)?github\.com\.?(?::\d+)?\/|(?:[^@/]+@)?(?:ssh\.)?github\.com\.?:)\/*([^/]+)\/([^/]+?)(?:\.git)?\/*$/i;

export interface RepoSlug {
  readonly owner: string;
  readonly name: string;
}

export interface RepoInfo {
  readonly top: string;
  readonly commonDir: string;
  readonly gitDir: string;
  readonly primary: string;
  readonly remotes: Readonly<Record<string, ReadonlyArray<string>>>;
  readonly originUrls: ReadonlyArray<string>;
  readonly headBranch: string | null;
  readonly originHead: string | null;
  readonly inScope: boolean;
  readonly slug: string;
  readonly bases: () => ReadonlyArray<string>;
  readonly declaration: () => string | null;
  readonly declaredValues: (key: string) => ReadonlyArray<string>;
  readonly worktreeCount: () => number;
}

function buildHardenedGitEnv(callerEnv?: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = {
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    HOME: process.env.HOME ?? "",
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_NO_REPLACE_OBJECTS: "1",
    GIT_GRAFT_FILE: "/dev/null",
  };
  if (callerEnv) {
    for (const key of GIT_LOCATION_ENV) {
      const val = callerEnv[key];
      if (val) out[key] = val;
    }
  }
  return out;
}

export function runHardenedGit(
  cwd: string,
  args: ReadonlyArray<string>,
  config: HostGuardsConfig,
  callerEnv?: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): string | null {
  const res = NodeChildProcess.spawnSync(
    config.realGit,
    ["-C", cwd, "--no-replace-objects", "-c", "core.fsmonitor=", ...args],
    {
      encoding: "utf8",
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: buildHardenedGitEnv(callerEnv),
    },
  );
  if (res.status !== 0) return null;
  return res.stdout ?? "";
}

export function runHardenedGitBuffer(
  cwd: string,
  args: ReadonlyArray<string>,
  config: HostGuardsConfig,
  callerEnv?: NodeJS.ProcessEnv,
  timeoutMs = 20_000,
): Buffer | null {
  const res = NodeChildProcess.spawnSync(
    config.realGit,
    ["-C", cwd, "--no-replace-objects", "-c", "core.fsmonitor=", ...args],
    {
      timeout: timeoutMs,
      maxBuffer: 8 * 1024 * 1024,
      env: buildHardenedGitEnv(callerEnv),
    },
  );
  if (res.status !== 0) return null;
  return Buffer.isBuffer(res.stdout) ? res.stdout : Buffer.from(res.stdout ?? "", "utf8");
}

export function parseGithubSlug(url: string): RepoSlug | null {
  const match = GITHUB_URL_RE.exec(url.trim());
  if (!match?.[1] || !match[2]) return null;
  return {
    owner: match[1].toLowerCase(),
    name: match[2].toLowerCase(),
  };
}

export function isSlugInScope(
  ownerOrSlug: string,
  config: HostGuardsConfig,
  explicitName?: string,
): boolean {
  let owner: string;
  let name: string;
  if (explicitName === undefined) {
    const cleaned = ownerOrSlug.trim().replace(/^\/+|\/+$/g, "");
    const slash = cleaned.indexOf("/");
    if (slash === -1) return false;
    owner = cleaned.slice(0, slash);
    name = cleaned.slice(slash + 1);
  } else {
    owner = ownerOrSlug;
    name = explicitName;
  }
  owner = owner
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase();
  name = name
    .trim()
    .replace(/^\/+|\/+$/g, "")
    .toLowerCase()
    .replace(/\.git$/, "");
  if (!owner || !name || name.includes("/")) return false;
  if (config.exemptRepos.has(name)) return false;
  return config.orgs.includes(owner);
}

export function isUrlInScope(url: string, config: HostGuardsConfig): boolean {
  const slug = parseGithubSlug(url);
  return slug !== null && isSlugInScope(slug.owner, config, slug.name);
}

function expandInsteadOf(
  cwd: string,
  urls: ReadonlyArray<string>,
  config: HostGuardsConfig,
  callerEnv?: NodeJS.ProcessEnv,
): string[] {
  const out = [...urls];
  // Run git with user config enabled (without GIT_CONFIG_GLOBAL=/dev/null) only to resolve url.*.insteadOf.
  const res = NodeChildProcess.spawnSync(
    config.realGit,
    ["-C", cwd, "--no-replace-objects", "ls-remote", "--get-url", "origin"],
    {
      encoding: "utf8",
      timeout: 5_000,
      env: {
        ...process.env,
        ...callerEnv,
        GIT_TERMINAL_PROMPT: "0",
      },
    },
  );
  if (res.status === 0) {
    const expanded = (res.stdout ?? "").trim();
    if (expanded && !out.includes(expanded)) {
      out.push(expanded);
    }
  }
  return out;
}

export function inspectRepo(
  cwd: string,
  config: HostGuardsConfig,
  callerEnv?: NodeJS.ProcessEnv,
): RepoInfo | null {
  let out = runHardenedGit(
    cwd,
    [
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
      "--absolute-git-dir",
    ],
    config,
    callerEnv,
  );
  if (out === null) {
    out = runHardenedGit(
      cwd,
      [
        "rev-parse",
        "--path-format=absolute",
        "--git-dir",
        "--git-common-dir",
        "--absolute-git-dir",
      ],
      config,
      callerEnv,
    );
    if (out === null) return null;
  }
  const lines = out.split(/\r?\n/).filter((l) => l.length > 0);
  if (lines.length < 3) return null;
  const top = lines[0]!;
  const commonDir = lines[1]!;
  const gitDir = lines[2]!;
  const primary = NodePath.basename(commonDir) === ".git" ? NodePath.dirname(commonDir) : commonDir;

  const remotes: Record<string, string[]> = {};
  const cfgOut =
    runHardenedGit(
      top,
      ["config", "--get-regexp", "^remote\\..*\\.(url|pushurl)$"],
      config,
      callerEnv,
    ) ?? "";
  for (const line of cfgOut.split(/\r?\n/)) {
    const spaceIdx = line.indexOf(" ");
    if (spaceIdx === -1) continue;
    const key = line.slice(0, spaceIdx);
    const val = line.slice(spaceIdx + 1).trim();
    if (!key.startsWith("remote.") || !val) continue;
    const withoutPrefix = key.slice("remote.".length);
    const lastDot = withoutPrefix.lastIndexOf(".");
    if (lastDot === -1) continue;
    const remoteName = withoutPrefix.slice(0, lastDot);
    const list = remotes[remoteName] ?? [];
    list.push(val);
    remotes[remoteName] = list;
  }

  const originUrls = expandInsteadOf(top, remotes.origin ?? [], config, callerEnv);
  if (originUrls.length > 0) {
    remotes.origin = originUrls;
  }

  const headRaw = runHardenedGit(top, ["symbolic-ref", "-q", "--short", "HEAD"], config, callerEnv);
  const headBranch = headRaw?.trim() || null;

  const originHeadRaw = runHardenedGit(
    top,
    ["symbolic-ref", "-q", "--short", "refs/remotes/origin/HEAD"],
    config,
    callerEnv,
  );
  const originHead = originHeadRaw?.trim().replace(/^origin\//, "") || null;

  const inScope = originUrls.some((u) => isUrlInScope(u, config));
  let slug = "?";
  for (const u of originUrls) {
    const parsed = parseGithubSlug(u);
    if (parsed) {
      slug = `${parsed.owner}/${parsed.name}`;
      break;
    }
  }

  let declarationLoaded = false;
  let declarationText: string | null = null;
  const declaration = (): string | null => {
    if (!declarationLoaded) {
      declarationLoaded = true;
      if (originHead) {
        const refSpec = `refs/remotes/origin/${originHead}:${TREE_GUARD_CONF}`;
        const raw = runHardenedGit(top, ["show", "--end-of-options", refSpec], config, callerEnv);
        if (raw && raw.trim().length > 0) {
          declarationText = raw;
        }
      }
    }
    return declarationText;
  };

  const declaredValues = (key: string): ReadonlyArray<string> => {
    const text = declaration();
    if (!text) return [];
    const values: string[] = [];
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      const eq = line.indexOf("=");
      if (eq === -1) continue;
      if (line.slice(0, eq).trim() === key) {
        const val = line.slice(eq + 1).trim();
        if (val) values.push(val);
      }
    }
    return values;
  };

  const worktreeCount = (): number => {
    const listOut =
      runHardenedGit(top, ["worktree", "list", "--porcelain"], config, callerEnv) ?? "";
    return listOut.split(/\r?\n/).filter((l) => l.startsWith("worktree ")).length;
  };

  return {
    top,
    commonDir,
    gitDir,
    primary,
    remotes,
    originUrls,
    headBranch,
    originHead,
    inScope,
    slug,
    bases: () => (originHead ? [originHead] : FALLBACK_BASES),
    declaration,
    declaredValues,
    worktreeCount,
  };
}

export function formatMergeRefusal(
  what: string,
  repo: RepoInfo | null,
  config: HostGuardsConfig,
): string {
  const decl = repo?.declaration();
  const hasShipRepo = decl ? /^\s*ship_repo\s*=\s*\S/m.test(decl) : false;
  if (repo !== null && repo.inScope && repo.originHead && !hasShipRepo) {
    return `host merge guard: ${repo.slug} has no ship declaration, so the queue does not ship it.`;
  }
  const orgLabel = config.orgs.length > 0 ? config.orgs.join("/") : "managed";
  return [
    `host merge guard: refusing ${what}.`,
    `Only the host ship queue's daemon merges into a base branch, in every ${orgLabel} repo. Ship from your own worktree and branch with:`,
    '  ship-queue submit <worktree> <branch> "<title>" <body.md>',
    "and watch the job it prints (ship-queue watch <job>).",
  ].join("\n");
}
