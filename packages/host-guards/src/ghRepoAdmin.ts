// @effect-diagnostics nodeBuiltinImport:off - Repo administration (settings, rename, create, delete, transfer, keys, forks into orgs) is owner-only in managed orgs.
import { resolveEnvGhRepoSlug } from "./ghArgParse.ts";
import type { HostGuardsConfig } from "./hostConfig.ts";
import { ALLOW_VERDICT, type GuardVerdict } from "./pushGuard.ts";
import { inspectRepo, isSlugInScope, parseRepoSlugArg } from "./repoScope.ts";

const ADMIN_SUBS = new Set(["create", "new", "edit", "rename", "delete", "archive", "unarchive"]);
/** `gh repo` flags that take a value, across the admin subcommands (and global ones). */
const VALUE_FLAGS = new Set([
  "-R",
  "--repo",
  "--hostname",
  "-d",
  "--description",
  "-h",
  "--homepage",
  "--default-branch",
  "--add-topic",
  "--remove-topic",
  "--visibility",
  "-t",
  "--team",
  "--title",
  "-p",
  "--template",
  "-g",
  "--gitignore",
  "-l",
  "--license",
  "-s",
  "--source",
  "-r",
  "--remote",
  "--remote-name",
  "--org",
  "--fork-name",
  "-k",
  "--key",
]);
const BOOL_FLAGS = new Set([
  "-y",
  "--yes",
  "--confirm",
  "--private",
  "--public",
  "--internal",
  "--push",
  "-c",
  "--clone",
  "--include-all-branches",
  "--default-branch-only",
  "--allow-write",
  "--disable-issues",
  "--disable-wiki",
]);
const BOOL_FLAG_PREFIXES = ["--enable-", "--allow-", "--delete-branch-on-merge", "--accept-"];
/** A repo name with no owner: the account `gh` is logged in as, which cannot be known offline. */
const BARE_NAME_RE = /^[A-Za-z0-9_.-]+$/;

export function repoAdminRefusal(what: string): GuardVerdict {
  return {
    verdict: "deny",
    reason: `host repo guard: repo settings change: owner approval required (${what}).`,
  };
}

/** `gh api` REST calls under `repos/<o>/<r>` that change a managed repo's settings or access. */
export function isRepoAdminApiCall(method: string, rest: string): boolean {
  if (method === "GET") return false;
  if (rest === "") return true;
  if (method === "POST" && (rest === "transfer" || rest === "keys")) return true;
  return (method === "PUT" || method === "DELETE") && /^collaborators\/[^/]+$/.test(rest);
}

/**
 * `gh api` calls that create a repo in a managed org whatever repo they start from: user repos
 * (the account's owner is unknown offline), forks with `organization`, and template generation.
 */
export function createsManagedRepo(
  method: string,
  path: string,
  fields: Readonly<Record<string, string>>,
  config: HostGuardsConfig,
): boolean {
  if (method !== "POST") return false;
  if (path === "user/repos") return true;
  const managedOrg = (org: string | undefined) =>
    org !== undefined && config.orgs.includes(org.trim().toLowerCase());
  const orgCreate = /^orgs\/([^/]+)\/repos$/.exec(path);
  if (orgCreate) return managedOrg(orgCreate[1]);
  const repoAction = /^repos\/[^/]+\/[^/]+\/(forks|generate)$/.exec(path);
  if (repoAction?.[1] === "forks") return managedOrg(fields.organization);
  if (repoAction?.[1] === "generate") return !fields.owner || managedOrg(fields.owner);
  return false;
}

interface ParsedRepoArgs {
  readonly repoFlag: string | null;
  readonly orgFlag: string | null;
  readonly positionals: ReadonlyArray<string>;
  readonly unknownFlag: string | null;
  readonly allowWrite: boolean;
}

function parseRepoArgs(
  args: ReadonlyArray<string>,
  fromIndex: number,
  sub: string,
): ParsedRepoArgs {
  let repoFlag: string | null = null;
  let orgFlag: string | null = null;
  let unknownFlag: string | null = null;
  let allowWrite = false;
  const positionals: string[] = [];
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i]!;
    if (a === "--") {
      if (i >= fromIndex) positionals.push(...args.slice(i + 1));
      break;
    }
    if (!a.startsWith("-") || a === "-") {
      if (i > fromIndex) positionals.push(a);
      continue;
    }
    const eq = a.startsWith("--") ? a.indexOf("=") : -1;
    const name = eq === -1 ? a : a.slice(0, eq);
    const attachedR = !a.startsWith("--") && a.startsWith("-R") && a.length > 2;
    let value: string | null = null;
    if (attachedR) {
      value = a.slice(2).replace(/^=/, "");
    } else if (VALUE_FLAGS.has(name) && !(sub === "edit" && name === "--template")) {
      value = eq !== -1 ? a.slice(eq + 1) : (args[i + 1] ?? "");
      if (eq === -1) i += 1;
    } else if (
      BOOL_FLAGS.has(name) ||
      BOOL_FLAG_PREFIXES.some((p) => name.startsWith(p)) ||
      (sub === "edit" && name === "--template")
    ) {
      if (name === "--allow-write") allowWrite = true;
      continue;
    } else {
      unknownFlag ??= a;
      continue;
    }
    if (attachedR || name === "-R" || name === "--repo") repoFlag = value;
    if (name === "--org") orgFlag = value;
  }
  return { repoFlag, orgFlag, positionals, unknownFlag, allowWrite };
}

/**
 * `gh repo create|edit|rename|delete|archive|fork --org|deploy-key add --allow-write` on a
 * managed repo. The target resolves as gh does (`-R`, then `GH_REPO`, then the cwd repo) and a
 * positional slug counts too; an unknown flag or an owner that cannot be known fails closed.
 */
export function decideGhRepoAdmin(
  args: ReadonlyArray<string>,
  words: ReadonlyArray<string>,
  subIndex: number,
  cwd: string,
  config: HostGuardsConfig,
  env: NodeJS.ProcessEnv,
): GuardVerdict {
  const sub = words[1] ?? "";
  const deployKeyAdd = sub === "deploy-key" && words[2] === "add";
  if (!ADMIN_SUBS.has(sub) && sub !== "fork" && !deployKeyAdd) return ALLOW_VERDICT;
  const parsed = parseRepoArgs(args, subIndex, sub);
  const what = `gh repo ${deployKeyAdd ? "deploy-key add" : sub}`;

  if (sub === "fork") {
    if (!parsed.orgFlag) return ALLOW_VERDICT;
    return config.orgs.includes(parsed.orgFlag.trim().toLowerCase())
      ? repoAdminRefusal(`${what} --org ${parsed.orgFlag}`)
      : ALLOW_VERDICT;
  }
  if (deployKeyAdd && !parsed.allowWrite) return ALLOW_VERDICT;
  if (parsed.unknownFlag)
    return repoAdminRefusal(`${what} with unrecognised flag ${parsed.unknownFlag}`);

  const candidates: string[] = [];
  const addSlug = (raw: string | null) => {
    const slug = raw ? parseRepoSlugArg(raw) : null;
    if (slug) candidates.push(slug);
    return slug !== null;
  };
  const explicit = addSlug(parsed.repoFlag);
  const envSlug = resolveEnvGhRepoSlug(env);
  if (envSlug) candidates.push(envSlug);
  // rename's positional is the new name; deploy-key add's is the key file.
  const repoPositional = sub !== "rename" && !deployKeyAdd ? parsed.positionals[0] : undefined;
  const positionalSlug = repoPositional !== undefined && addSlug(repoPositional);
  if (sub === "create" || sub === "new") {
    if (!positionalSlug && !explicit) return repoAdminRefusal(what);
    if (repoPositional !== undefined && BARE_NAME_RE.test(repoPositional))
      return repoAdminRefusal(what);
  }
  if (!explicit && !positionalSlug && !envSlug) {
    const here = inspectRepo(cwd, config, env);
    if (here && here.inScope) candidates.push(here.slug);
  }
  const managed = candidates.find((slug) => isSlugInScope(slug, config));
  return managed ? repoAdminRefusal(`${what} ${managed}`) : ALLOW_VERDICT;
}
