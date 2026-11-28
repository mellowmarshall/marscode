// @effect-diagnostics nodeBuiltinImport:off - the project prefix hashes the repo name.
// What a job's CI services are (`ship_ci_service`, `ship_ci_env`): the compose project, files, and
// service names the job starts, the image pins they must carry, and the tools routing asks for.
import * as NodeCrypto from "node:crypto";

import { COMPOSE_FILES, COMPOSE_OVERRIDES, resolveComposeFiles } from "./ciNeeds.ts";
import { parseShipDeclaration, type ShipDeclaration } from "./declaration.ts";
import { git, gitOut } from "./gitQueries.ts";
import type { ProcessRunner } from "./types.ts";

const SERVICE_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
/** The tools a service job needs on its host: the engine, and its compose plugin. */
export const SERVICE_TOOLS: ReadonlyArray<string> = ["docker", "docker-compose"];

/**
 * The services one job starts, in its own compose project (`sq-<repo>-<job>`, the legacy queue's
 * name). `required` must be services of the compose configuration; `optional` are base services
 * the branch drops from its declaration, which still start while its compose configuration keeps
 * them (the legacy rule: the base's list is the floor until the change merges).
 */
export interface CiServicePlan {
  readonly project: string;
  /** Every project of this repo starts with it; a leftover one is stopped before a new start. */
  readonly projectPrefix: string;
  readonly composeFiles: ReadonlyArray<string>;
  readonly required: ReadonlyArray<string>;
  readonly optional: ReadonlyArray<string>;
  /** Services the branch adds to the base's list, for the log. */
  readonly added: ReadonlyArray<string>;
  /** `ship_ci_env`, relative to the job's tree; "" for none. */
  readonly envFile: string;
}

/**
 * The repo's project prefix, `sq-<name>-<hash>-`. The hash (8 hex of SHA-256 of the lowercased
 * repo name as the job gives it) keeps apart repos whose names map to the same characters
 * (`app.api`, `app-api`), so the leftover cleanup, which matches this exact prefix, stops only
 * its own repo's projects.
 */
export function composeProjectPrefix(repo: string): string {
  const lower = repo.toLowerCase();
  const hash = NodeCrypto.createHash("sha256").update(lower).digest("hex").slice(0, 8);
  return `sq-${lower.replace(/[^a-z0-9]/g, "-")}-${hash}-`;
}

/** Every service name the plan may start, base order first, for routing and the log. */
export function plannedServiceNames(plan: CiServicePlan): ReadonlyArray<string> {
  return [...plan.required, ...plan.optional];
}

/**
 * The tool specs routing asks of a host: the declared ones, plus docker and its compose plugin
 * when the job starts a service and the declaration does not name them itself.
 */
export function serviceToolSpecs(
  ciTools: ReadonlyArray<string>,
  services: ReadonlyArray<string>,
): ReadonlyArray<string> {
  if (services.length === 0) return ciTools;
  const named = new Set(ciTools.map((spec) => spec.split("@", 1)[0]));
  return [...ciTools, ...SERVICE_TOOLS.filter((tool) => !named.has(tool))];
}

/** Merges the base's services with the tip's declaration (the legacy rule). */
export function mergeServiceLists(
  base: ReadonlyArray<string>,
  tip: ReadonlyArray<string>,
):
  | {
      readonly ok: true;
      readonly required: ReadonlyArray<string>;
      readonly optional: ReadonlyArray<string>;
      readonly added: ReadonlyArray<string>;
    }
  | { readonly ok: false; readonly reason: string } {
  for (const name of [...base, ...tip]) {
    if (!SERVICE_NAME_RE.test(name)) {
      return { ok: false, reason: `ship_ci_service '${name}' is not a compose service name` };
    }
  }
  const added = tip.filter((s, i) => !base.includes(s) && tip.indexOf(s) === i);
  const kept = base.filter((s) => tip.includes(s));
  const optional = base.filter((s) => !tip.includes(s));
  return { ok: true, required: [...kept, ...added], optional, added };
}

/**
 * The job's service plan, read at its tip in its own worktree: the base declaration's services,
 * the ones the tip's declaration adds, and the compose files compose itself picks there. Null
 * when the job starts no service.
 */
export async function planCiServices(input: {
  readonly run: ProcessRunner;
  readonly worktree: string;
  readonly tip: string;
  readonly repo: string;
  readonly jobId: string;
  readonly decl: ShipDeclaration;
}): Promise<
  | { readonly ok: true; readonly plan: CiServicePlan | null }
  | { readonly ok: false; readonly reason: string }
> {
  const { run, worktree, tip, decl } = input;
  const confSpec = `${tip}:.tree-guard.conf`;
  let tipServices: ReadonlyArray<string> = [];
  if ((await git(run, worktree, ["cat-file", "-e", confSpec])).exitCode === 0) {
    const conf = await gitOut(run, worktree, ["show", confSpec]);
    if (conf === null) return { ok: false, reason: `cannot read ${confSpec}` };
    const playbook = (await gitOut(run, worktree, ["show", `${tip}:playbook.json`])) ?? "";
    tipServices = parseShipDeclaration(conf, playbook, ".tree-guard.conf").ciServices;
  }
  if (decl.ciServices.length === 0 && tipServices.length === 0) return { ok: true, plan: null };
  const merged = mergeServiceLists(decl.ciServices, tipServices);
  if (!merged.ok) return merged;
  const listed = await gitOut(run, worktree, [
    "ls-tree",
    "--name-only",
    tip,
    "--",
    ...COMPOSE_FILES,
    ...COMPOSE_OVERRIDES,
  ]);
  if (listed === null) return { ok: false, reason: `cannot list the compose files at ${tip}` };
  const files = resolveComposeFiles(new Set(listed.split("\n").filter(Boolean)));
  if (!files.ok) {
    return {
      ok: false,
      reason: `the job starts services (${[...merged.required, ...merged.optional].join(" ")}), but at ${tip.slice(0, 12)} ${files.reason}`,
    };
  }
  const prefix = composeProjectPrefix(input.repo);
  return {
    ok: true,
    plan: {
      project: `${prefix}${input.jobId.toLowerCase().replace(/[^a-z0-9]/g, "-")}`,
      projectPrefix: prefix,
      composeFiles: files.files,
      required: merged.required,
      optional: merged.optional,
      added: merged.added,
      envFile: decl.ciEnv,
    },
  };
}

/**
 * The services the job starts, given the services its compose configuration has on the routed
 * host (with the env file sourced): each required one must be there; an optional one starts only
 * while it is.
 */
export function selectStartedServices(
  plan: CiServicePlan,
  configServices: ReadonlySet<string>,
):
  | { readonly ok: true; readonly services: ReadonlyArray<string> }
  | { readonly ok: false; readonly reason: string } {
  const has = [...configServices].toSorted().join(" ");
  for (const name of plan.required) {
    if (!configServices.has(name)) {
      return {
        ok: false,
        reason: `the declared service ${name} is not a service of the compose configuration (${has})`,
      };
    }
  }
  return {
    ok: true,
    services: [...plan.required, ...plan.optional.filter((s) => configServices.has(s))],
  };
}

/** An image reference pinned to a digest, or to a tag that is not `latest`. */
export function isPinnedImage(ref: string): boolean {
  if (/@sha256:[0-9a-f]{64}$/.test(ref)) return true;
  const last = ref.slice(ref.lastIndexOf("/") + 1);
  const colon = last.indexOf(":");
  if (colon < 0) return false;
  const tag = last.slice(colon + 1);
  return tag.length > 0 && tag !== "latest";
}

interface ComposeServiceJson {
  readonly image?: unknown;
  readonly build?: unknown;
  readonly depends_on?: unknown;
}

/** The service names of `docker compose config --format json` output. */
export function composeConfigServices(config: unknown): ReadonlyMap<string, ComposeServiceJson> {
  const services =
    config && typeof config === "object" ? (config as { services?: unknown }).services : undefined;
  const out = new Map<string, ComposeServiceJson>();
  if (!services || typeof services !== "object" || Array.isArray(services)) return out;
  for (const [name, svc] of Object.entries(services as Record<string, unknown>)) {
    if (svc && typeof svc === "object") out.set(name, svc as ComposeServiceJson);
  }
  return out;
}

/**
 * Every image the started services and the services they depend on pull, unpinned: an image a
 * service builds itself is the repo's own. Empty when all are pinned.
 */
export function unpinnedServiceImages(
  services: ReadonlyMap<string, ComposeServiceJson>,
  started: ReadonlyArray<string>,
): ReadonlyArray<string> {
  const seen = new Set<string>();
  const queue = [...started];
  const bad: string[] = [];
  while (queue.length > 0) {
    const name = queue.shift()!;
    if (seen.has(name)) continue;
    seen.add(name);
    const svc = services.get(name);
    if (!svc) continue;
    const deps = svc.depends_on;
    if (Array.isArray(deps)) queue.push(...deps.filter((d): d is string => typeof d === "string"));
    else if (deps && typeof deps === "object") queue.push(...Object.keys(deps));
    if (svc.build !== undefined && svc.build !== null) continue;
    const image = typeof svc.image === "string" ? svc.image : "";
    if (!isPinnedImage(image)) bad.push(`${name} (${image || "no image"})`);
  }
  return bad;
}
