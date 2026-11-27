// @effect-diagnostics nodeBuiltinImport:off - Push guard using real `git push --dry-run --porcelain` with fail-closed base protection.
import * as NodeChildProcess from "node:child_process";

import type { HostGuardsConfig } from "./hostConfig.ts";
import {
  FALLBACK_BASES,
  formatMergeRefusal,
  inspectRepo,
  isUrlInScope,
  parseGithubSlug,
  type RepoInfo,
} from "./repoScope.ts";

export interface GuardVerdict {
  readonly verdict: "allow" | "deny";
  readonly reason: string;
}

export const ALLOW_VERDICT: GuardVerdict = { verdict: "allow", reason: "" };

const PUSH_VALUE_OPTS = new Set([
  "--repo",
  "--receive-pack",
  "--exec",
  "-o",
  "--push-option",
  "--recurse-submodules",
]);

function runPushGit(
  cwd: string,
  configs: ReadonlyArray<string>,
  args: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  timeoutMs = 60_000,
): { readonly status: number; readonly stdout: string; readonly stderr: string } | null {
  const argv: string[] = ["-C", cwd];
  for (const pair of configs) {
    argv.push("-c", pair);
  }
  const runEnv: NodeJS.ProcessEnv = {
    ...env,
    GIT_TERMINAL_PROMPT: "0",
    GIT_SSH_COMMAND: env.GIT_SSH_COMMAND || "ssh -o BatchMode=yes",
  };
  const res = NodeChildProcess.spawnSync(config.realGit, [...argv, ...args], {
    encoding: "utf8",
    timeout: timeoutMs,
    maxBuffer: 8 * 1024 * 1024,
    env: runEnv,
  });
  if (res.error || res.status === null) return null;
  return { status: res.status, stdout: res.stdout ?? "", stderr: res.stderr ?? "" };
}

function parsePushParts(args: ReadonlyArray<string>): {
  readonly positionals: ReadonlyArray<string>;
  readonly flags: ReadonlySet<string>;
  readonly repoOpt: string | null;
} {
  const positionals: string[] = [];
  const flags = new Set<string>();
  let repoOpt: string | null = null;
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      positionals.push(...args.slice(i + 1));
      break;
    }
    if (a.startsWith("--")) {
      const eq = a.indexOf("=");
      const name = eq === -1 ? a : a.slice(0, eq);
      let value = eq === -1 ? "" : a.slice(eq + 1);
      if (PUSH_VALUE_OPTS.has(name) && eq === -1) {
        value = i + 1 < args.length ? args[i + 1]! : "";
        i += 1;
      }
      if (name === "--repo") repoOpt = value;
      flags.add(name);
    } else if (a.startsWith("-") && a.length > 1) {
      for (let j = 1; j < a.length; j += 1) {
        const ch = a[j]!;
        if (ch === "o") {
          if (j === a.length - 1) i += 1;
          break;
        }
        flags.add(`-${ch}`);
      }
    } else {
      positionals.push(a);
    }
  }
  return { positionals, flags, repoOpt };
}

function readGitConfigKey(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  key: string,
): string {
  const out = runPushGit(cwd, configs, ["config", "--get", key], env, config, 10_000);
  return out && out.status === 0 ? out.stdout.trim() : "";
}

function resolvePushRemote(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  repo: RepoInfo | null,
  args: ReadonlyArray<string>,
): string {
  const { positionals, repoOpt } = parsePushParts(args);
  if (repoOpt) return repoOpt;
  if (positionals.length > 0) return positionals[0]!;
  const cur = repo?.headBranch;
  if (cur) {
    for (const key of [`branch.${cur}.pushRemote`, "remote.pushDefault", `branch.${cur}.remote`]) {
      const val = readGitConfigKey(cwd, configs, env, config, key);
      if (val) return val;
    }
  }
  return "origin";
}

function collectRemoteUrls(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  remote: string,
): ReadonlyArray<string> {
  const urls = [remote];
  for (const key of ["url", "pushurl"]) {
    const out = runPushGit(
      cwd,
      configs,
      ["config", "--get-all", `remote.${remote}.${key}`],
      env,
      config,
      10_000,
    );
    if (out && out.status === 0) {
      urls.push(...out.stdout.split(/\s+/).filter(Boolean));
    }
  }
  for (const cmd of [
    ["ls-remote", "--get-url", remote],
    ["remote", "get-url", "--push", "--all", remote],
  ]) {
    const out = runPushGit(cwd, configs, cmd, env, config, 10_000);
    if (out && out.status === 0) {
      urls.push(...out.stdout.split(/\s+/).filter(Boolean));
    }
  }
  return urls;
}

function resolveProtectedBases(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  repo: RepoInfo | null,
  urls: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (repo !== null && repo.originHead) {
    const mine = new Set(
      repo.originUrls
        .map((u) => parseGithubSlug(u))
        .filter((s): s is NonNullable<typeof s> => s !== null)
        .map((s) => `${s.owner}/${s.name}`),
    );
    const sameRepo = urls.some((u) => {
      const slug = parseGithubSlug(u);
      return slug !== null && mine.has(`${slug.owner}/${slug.name}`);
    });
    if (sameRepo) return repo.bases();
  }
  for (const url of urls) {
    if (!isUrlInScope(url, config)) continue;
    const out = runPushGit(
      cwd,
      configs,
      ["ls-remote", "--symref", url, "HEAD"],
      env,
      config,
      30_000,
    );
    if (out && out.status === 0) {
      for (const line of out.stdout.split(/\r?\n/)) {
        if (line.startsWith("ref: refs/heads/") && line.endsWith("\tHEAD")) {
          return [line.slice("ref: refs/heads/".length, -"\tHEAD".length)];
        }
      }
    }
  }
  return FALLBACK_BASES;
}

function globMatch(text: string, pattern: string): boolean {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".");
  return new RegExp(`^${escaped}$`).test(text);
}

function dryRunPushRefs(
  cwd: string,
  configs: ReadonlyArray<string>,
  env: NodeJS.ProcessEnv,
  config: HostGuardsConfig,
  args: ReadonlyArray<string>,
): ReadonlyArray<string> | null {
  const out = runPushGit(
    cwd,
    configs,
    ["push", "--dry-run", "--porcelain", "--no-verify", ...args],
    env,
    config,
  );
  if (!out) return null;
  const refs: string[] = [];
  for (const line of out.stdout.split(/\r?\n/)) {
    const parts = line.split("\t");
    const flag = parts[0] ?? "";
    const refPart = parts[1] ?? "";
    if (
      parts.length >= 2 &&
      [" ", "+", "-", "*", "!", "="].includes(flag) &&
      refPart.includes(":")
    ) {
      const colonIdx = refPart.indexOf(":");
      refs.push(refPart.slice(colonIdx + 1));
    }
  }
  if (refs.length > 0 || out.status === 0) return refs;
  return null;
}

export function decidePush(
  args: ReadonlyArray<string>,
  cwd: string,
  env: NodeJS.ProcessEnv,
  configs: ReadonlyArray<string>,
  config: HostGuardsConfig,
): GuardVerdict {
  const repo = inspectRepo(cwd, config, env);
  const remote = resolvePushRemote(cwd, configs, env, config, repo, args);
  const urls = collectRemoteUrls(cwd, configs, env, config, remote);
  if (!urls.some((u) => isUrlInScope(u, config))) {
    return ALLOW_VERDICT;
  }
  const bases = resolveProtectedBases(cwd, configs, env, config, repo, urls);
  const refs = dryRunPushRefs(cwd, configs, env, config, args);
  const target = repo !== null && repo.inScope ? repo : null;
  if (refs === null) {
    return {
      verdict: "deny",
      reason: formatMergeRefusal(
        `git push to ${remote}: git could not say which refs it would move (its dry run failed), and a push to an in-scope remote is never judged blind`,
        target,
        config,
      ),
    };
  }
  for (const ref of refs) {
    for (const base of bases) {
      const baseRef = `refs/heads/${base}`;
      if (ref === baseRef || (ref.includes("*") && globMatch(baseRef, ref))) {
        return {
          verdict: "deny",
          reason: formatMergeRefusal(
            `git push to ${remote} ${base} (the base branch)`,
            target,
            config,
          ),
        };
      }
    }
  }
  return ALLOW_VERDICT;
}
