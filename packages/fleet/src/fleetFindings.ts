/**
 * The fleet shape's cross-reference and rotation rules (a port of devtools'
 * pb_fleet_shape.findings): the same rules for every repo. Each finding is
 * (rule, item, problem). The rules read a shape that passed its schema; a
 * field of the wrong type reads as absent.
 */
import { isObject, type JsonObject } from "./fleetSchemaNodes.ts";

export interface FleetFinding {
  readonly rule: "fleet/cross" | "fleet/rotation";
  readonly item: string;
  readonly problem: string;
}

const ROTATION_FIELDS = ["vendor", "reason", "retirement", "vault"] as const;
const OWNED_RESOURCES = [
  "zones",
  "hostnames",
  "buckets",
  "kv",
  "workers",
  "pages",
  "servers",
  "apps",
  "files",
];

function section(shape: JsonObject, key: string): Record<string, JsonObject> {
  const v = shape[key];
  if (!isObject(v)) return {};
  const out: Record<string, JsonObject> = {};
  for (const [k, x] of Object.entries(v)) out[k] = isObject(x) ? x : {};
  return out;
}

function str(o: JsonObject, key: string): string {
  const v = o[key];
  return typeof v === "string" ? v : "";
}

function strs(o: JsonObject, key: string): string[] {
  const v = o[key];
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
}

function truthy(v: unknown): boolean {
  if (Array.isArray(v)) return v.length > 0;
  if (isObject(v)) return Object.keys(v).length > 0;
  return Boolean(v);
}

/** What may read an env name: an app, a role, a backup, a tool, a code root, or `compose`. */
export function envReaders(shape: JsonObject): Set<string> {
  return new Set([
    ...Object.keys(section(shape, "apps")),
    ...Object.keys(section(shape, "roles")),
    ...Object.keys(section(shape, "backups")),
    ...Object.keys(section(shape, "tooling")),
    ...Object.keys(section(shape, "codeRoots")),
    "compose",
  ]);
}

/** Every cross-reference and rotation problem of a fleet shape. */
export function fleetFindings(shape: JsonObject): FleetFinding[] {
  const apps = section(shape, "apps");
  const roles = section(shape, "roles");
  const env = section(shape, "env");
  const stores = section(shape, "stores");
  const perms = section(shape, "permissions");
  const provs = section(shape, "providers");
  const out: FleetFinding[] = [];
  const cross = (item: string, problem: string) => out.push({ rule: "fleet/cross", item, problem });
  const used = new Set<string>();
  const carried = new Set<string>();

  for (const [app, a] of Object.entries(apps)) {
    const provider = str(a, "provider");
    if (!Object.hasOwn(provs, provider))
      cross(app, `app ${app} names provider ${provider}, which is not declared`);
    used.add(provider);
    const secretsFrom = str(a, "secretsFrom");
    if (secretsFrom) used.add(secretsFrom.split("/", 1)[0] ?? "");
    for (const role of strs(a, "roles")) {
      if (!Object.hasOwn(roles, role))
        cross(app, `app ${app} carries role ${role}, which is not declared`);
      carried.add(role);
    }
  }

  const servers = new Map<string, string>();
  for (const [p, b] of Object.entries(provs)) {
    const s = b.servers;
    if (isObject(s)) for (const server of Object.keys(s)) servers.set(server, p);
  }
  for (const [role, r] of Object.entries(roles)) {
    const app = str(r, "app");
    if (app) {
      if (!Object.hasOwn(apps, app))
        cross(role, `role ${role} names app ${app}, which is not declared`);
      carried.add(role);
    }
    const server = str(r, "server");
    if (server) {
      const owner = servers.get(server);
      if (owner === undefined) {
        cross(role, `role ${role} names server ${server}, which no provider declares`);
      } else {
        used.add(owner);
      }
      carried.add(role);
    }
    if (!carried.has(role)) cross(role, `role ${role} is declared but no app or server carries it`);
    const reads = strs(r, "reads");
    for (const n of reads) {
      if (!Object.hasOwn(env, n))
        cross(role, `role ${role} reads ${n}, which env does not declare`);
    }
    // A role reads only names its apps hold.
    const holders = new Set(
      Object.entries(apps)
        .filter(([, ap]) => strs(ap, "roles").includes(role))
        .map(([a]) => a),
    );
    if (app) holders.add(app);
    for (const n of reads) {
      const e = env[n];
      if (holders.size === 0 || e === undefined || e.tooling || strs(e, "apps").length === 0)
        continue;
      if (!strs(e, "apps").some((h) => holders.has(h))) {
        cross(
          role,
          `role ${role} reads ${n}, which none of its apps (${[...holders].sort().join(", ")}) holds`,
        );
      }
    }
  }

  const mayRead = envReaders(shape);
  for (const [n, e] of Object.entries(env)) {
    for (const a of strs(e, "apps")) {
      if (!mayRead.has(a)) {
        cross(
          n,
          `env ${n} names reader ${a}, which is no declared app, role, backup, tool or code root`,
        );
      }
    }
    if (str(e, "vault")) used.add(str(e, "vault"));
    if (!e.secret) continue;
    const rot = isObject(e.rotation) ? e.rotation : {};
    const gone = ROTATION_FIELDS.filter((f) => !truthy(rot[f]));
    if (gone.length > 0) {
      out.push({
        rule: "fleet/rotation",
        item: n,
        problem: `${n} is a secret with no rotation story: rotation.{${gone.join(", ")}}`,
      });
    }
    const elsewhere = strs(rot, "alsoLivesAt");
    if (elsewhere.length > 0 && !truthy(rot.retireWith)) {
      out.push({
        rule: "fleet/rotation",
        item: n,
        problem: `${n} lives outside the stores (${elsewhere.join(", ")}) but names no retire command that reaches it`,
      });
    }
  }

  for (const [s, st] of Object.entries(stores)) {
    const provider = str(st, "provider");
    if (!Object.hasOwn(provs, provider))
      cross(s, `store ${s} names provider ${provider}, which is not declared`);
    used.add(provider);
    for (const n of strs(st, "reads")) {
      if (!Object.hasOwn(env, n)) cross(s, `store ${s} reads ${n}, which env does not declare`);
    }
    const envs = isObject(st.environments) ? st.environments : {};
    for (const [name, d] of Object.entries(envs)) {
      for (const n of isObject(d) ? strs(d, "reads") : []) {
        if (!Object.hasOwn(env, n))
          cross(s, `store ${s} (${name}) reads ${n}, which env does not declare`);
      }
    }
  }

  const holders = new Set([...Object.keys(apps), ...Object.keys(roles)]);
  for (const [p, perm] of Object.entries(perms)) {
    for (const h of strs(perm, "holders")) {
      if (!holders.has(h))
        cross(p, `permission ${p} is held by ${h}, which is no declared app or role`);
    }
    const provider = str(perm, "provider");
    if (strs(perm, "holders").length === 0 && !provider) {
      cross(p, `permission ${p} names neither holders nor the provider that enforces it`);
    }
    if (provider) {
      if (!Object.hasOwn(provs, provider))
        cross(p, `permission ${p} names provider ${provider}, which is not declared`);
      used.add(provider);
    }
  }

  for (const [rule, c] of Object.entries(section(shape, "configRules"))) {
    const role = str(c, "role");
    if (role && !Object.hasOwn(roles, role))
      cross(rule, `config rule ${rule} is read by role ${role}, which is not declared`);
    const reader = str(c, "reader");
    if (reader !== "every" && reader !== "role" && !Object.hasOwn(apps, reader)) {
      cross(rule, `config rule ${rule} is read by ${reader}, which is no declared app`);
    }
    for (const n of strs(c, "reads")) {
      if (!Object.hasOwn(env, n))
        cross(rule, `config rule ${rule} reads ${n}, which env does not declare`);
    }
  }

  for (const [p, block] of Object.entries(provs)) {
    const host = str(block, "host");
    if (!host) continue;
    if (!Object.hasOwn(provs, host))
      cross(p, `provider ${p} runs on host provider ${host}, which is not declared`);
    used.add(host);
  }
  // A provider that declares resources of its own (zones, hostnames, buckets, servers ...) is in use.
  for (const [p, block] of Object.entries(provs)) {
    const owns = OWNED_RESOURCES.some((k) => truthy(block[k]));
    if (!used.has(p) && !owns) {
      cross(
        p,
        `provider ${p} is declared but no app, store, permission, vault or provider names it`,
      );
    }
  }
  return out;
}
