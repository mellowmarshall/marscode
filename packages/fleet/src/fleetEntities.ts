/**
 * The entities of a fleet shape, flattened for lookup (a port of devtools'
 * fleet parse_entities): every app, provider, server, hostname, role, env
 * name, store, permission, backup, decision and vendor, each with its kind.
 */
import { ONE_SCHEMA_SECTIONS } from "./fleetShapeSchema.ts";
import { isObject, type JsonObject } from "./fleetSchemaNodes.ts";

export type EntityKind =
  | "service"
  | "host"
  | "job"
  | "secret"
  | "name"
  | "datastore"
  | "volume"
  | "bucket"
  | "backup"
  | "route"
  | "decision"
  | "vendor"
  | "provider"
  | "permission";

export const KINDS: Readonly<Record<EntityKind, ReadonlyArray<string>>> = {
  service: [
    "service",
    "services",
    "app",
    "apps",
    "application",
    "applications",
    "workload",
    "workloads",
  ],
  host: ["host", "hosts", "machine", "machines", "server", "servers"],
  job: ["job", "jobs", "role", "roles", "worker", "workers", "workerrole", "workerroles"],
  secret: ["secret", "secrets", "credential", "credentials"],
  name: ["name", "names", "env", "variable", "variables"],
  datastore: ["datastore", "datastores", "database", "databases", "store", "stores"],
  volume: ["volume", "volumes"],
  bucket: ["bucket", "buckets"],
  backup: ["backup", "backups"],
  route: [
    "route",
    "routes",
    "routing",
    "domain",
    "domains",
    "hostname",
    "hostnames",
    "zone",
    "zones",
  ],
  decision: ["decision", "decisions"],
  vendor: ["vendor", "vendors"],
  provider: ["provider", "providers"],
  permission: ["permission", "permissions", "access", "policy", "policies"],
};

/** A kind word ("apps", "servers", "role") as its kind; an unknown word stays itself. */
export function normalizeKind(word: string | null | undefined): string | null {
  if (!word) return null;
  const k = word.trim().toLowerCase();
  for (const [kind, words] of Object.entries(KINDS)) if (words.includes(k)) return kind;
  return k;
}

/** One entity: its name, kind and type label, its why, then the declared fields. */
export interface FleetEntity {
  readonly name: string;
  readonly kind: EntityKind;
  readonly type: string;
  readonly why: unknown;
  readonly sourceFile: string;
  readonly [field: string]: unknown;
}

/** A file that is not in the one fleet schema. */
// @effect-diagnostics-next-line extendsNativeError:off - a plain CLI library; no Effect failure channel.
export class OldFleetForm extends Error {
  override readonly name = "OldFleetForm";
}

const OWN_FIELDS: ReadonlySet<string> = new Set(["name", "kind", "type", "sourceFile"]);

function entity(
  name: string,
  kind: EntityKind,
  type: string,
  data: JsonObject,
  sourceFile: string,
  extra: JsonObject = {},
): FleetEntity {
  const out: Record<string, unknown> = { name, kind, type, why: data.why ?? "" };
  // The entity's own name, kind and type win: a block's declared `kind` (a provider's
  // "compose", a store's "postgres") is kept as `declaredKind`, so `--kind` still finds it.
  for (const [k, v] of Object.entries(data)) {
    if (k === "why") continue;
    if (OWN_FIELDS.has(k)) out[`declared${k.charAt(0).toUpperCase()}${k.slice(1)}`] = v;
    else out[k] = v;
  }
  Object.assign(out, extra);
  out.sourceFile = sourceFile;
  return out as FleetEntity;
}

function entries(v: unknown): Array<[string, JsonObject]> {
  if (!isObject(v)) return [];
  return Object.entries(v).map(([k, x]) => [k, isObject(x) ? x : {}]);
}

function text(v: unknown): string {
  return typeof v === "string" ? v : "";
}

const STORE_KINDS: Readonly<Record<string, EntityKind>> = {
  volume: "volume",
  bucket: "bucket",
  "cloudflare-r2": "bucket",
};

/** Every entity of a fleet shape in the one schema. */
export function parseEntities(shape: unknown, sourceFile: string): FleetEntity[] {
  if (!isObject(shape) || ONE_SCHEMA_SECTIONS.some((s) => !isObject(shape[s]))) {
    throw new OldFleetForm(
      `${sourceFile} is not in the one fleet schema (sections ${ONE_SCHEMA_SECTIONS.join(", ")})`,
    );
  }
  const out: FleetEntity[] = [];
  const providers = isObject(shape.providers) ? shape.providers : {};
  for (const [name, data] of entries(shape.apps)) {
    const provider = providers[text(data.provider)];
    const kind = isObject(provider) ? text(provider.kind) : "";
    out.push(entity(name, "service", `App (${kind || text(data.provider)})`, data, sourceFile));
  }
  for (const [pname, block] of entries(shape.providers)) {
    const kind = text(block.kind);
    const flat = Object.fromEntries(Object.entries(block).filter(([, v]) => !isObject(v)));
    out.push(entity(pname, "provider", `Provider (${kind})`, flat, sourceFile));
    const extra = { provider: pname };
    for (const [name, data] of entries(block.servers)) {
      out.push(entity(name, "host", `Server (${kind})`, data, sourceFile, extra));
    }
    for (const [name, data] of entries(block.hostnames)) {
      out.push(entity(name, "route", "Hostname", data, sourceFile, extra));
    }
    for (const [name, data] of entries(block.zones)) {
      out.push(entity(name, "route", "DNS Zone", data, sourceFile, extra));
    }
    for (const [name, data] of entries(block.platformHostnames)) {
      out.push(entity(name, "route", "Platform hostname", data, sourceFile, extra));
    }
  }
  for (const [name, data] of entries(shape.roles))
    out.push(entity(name, "job", "Role", data, sourceFile));
  for (const [name, data] of entries(shape.env)) {
    const secret = Boolean(data.secret);
    const rotation = isObject(data.rotation) ? data.rotation : {};
    out.push(
      entity(name, secret ? "secret" : "name", secret ? "Secret" : "Env name", data, sourceFile, {
        readers: data.apps ?? [],
        vendor: rotation.vendor ?? "",
      }),
    );
  }
  for (const [name, data] of entries(shape.stores)) {
    const kind = STORE_KINDS[text(data.kind)] ?? "datastore";
    out.push(entity(name, kind, `Store (${text(data.kind)})`, data, sourceFile));
  }
  for (const [name, data] of entries(shape.permissions)) {
    out.push(entity(name, "permission", "Permission", data, sourceFile));
  }
  const optionalSections: ReadonlyArray<[string, EntityKind, string]> = [
    ["backups", "backup", "Backup"],
    ["decisions", "decision", "Decision"],
    ["vendors", "vendor", "Vendor"],
  ];
  for (const [key, kind, label] of optionalSections) {
    for (const [name, data] of entries(shape[key]))
      out.push(entity(name, kind, label, data, sourceFile));
  }
  return out;
}

/** The entities a lookup matches: an exact name first, else a name, why, vendor or reader that contains the query. */
export function queryEntities(
  entities: ReadonlyArray<FleetEntity>,
  query: string,
  kind: string | null,
): FleetEntity[] {
  const scoped = kind ? entities.filter((e) => e.kind === kind) : [...entities];
  const q = query.trim().toLowerCase();
  if (!q) return scoped;
  const exact = scoped.filter((e) => e.name.toLowerCase() === q);
  if (exact.length > 0) return exact;
  return scoped.filter(
    (e) =>
      e.name.toLowerCase().includes(q) ||
      text(e.why).toLowerCase().includes(q) ||
      String(e.vendor ?? "")
        .toLowerCase()
        .includes(q) ||
      JSON.stringify(e.readers ?? [])
        .toLowerCase()
        .includes(q),
  );
}
