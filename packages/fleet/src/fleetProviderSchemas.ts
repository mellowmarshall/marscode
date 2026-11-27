/**
 * Each provider kind's closed shape (devtools' pb_fleet_providers). A kind with no
 * shape is refused, never accepted silently; a platform with no adapter is
 * declared as kind `declared`.
 */
import {
  Arr,
  Bool,
  Enum,
  Int,
  isObject,
  Obj,
  optional,
  pyRepr,
  Rec,
  type SchemaNode,
  Str,
  Union,
} from "./fleetSchemaNodes.ts";

const why = Str({ min: 1 });
const name = Str({ min: 1 });
const names = Arr(name);

const machine = Obj({
  count: Int(0),
  cpu_kind: Enum("shared", "performance"),
  cpus: Int(1),
  memory_mb: Int(1),
  group: optional(Str()),
  createdOutsideTheRepo: optional(Bool()),
  why: optional(why),
});
const volume = Obj({
  name,
  size_gb: Int(1),
  mount: Str({ regex: "^/[^\\s]*$" }),
  why: optional(why),
});
const flyApp = Obj({
  why: optional(why),
  machines: Arr(machine),
  volumes: Arr(volume),
  autostop: optional(Bool()),
  minRunning: optional(Int(0)),
  stopped: optional(Arr(Obj({ id: name, why }))),
  suspended: optional(Bool()),
  config: optional(
    Str({ min: 1, regex: "(^|/)fly[\\w.-]*\\.toml$", msg: "a Fly config is a fly*.toml path" }),
  ),
  env: optional(Rec(Str(), "^[A-Za-z_][A-Za-z0-9_]*$")),
});
const item = Obj({ why });
const cloudflareResource = Obj({ why, status: optional(Enum("planned", "provisioned")) });
const addresses = optional(Rec(Obj({ why, host: optional(name) })));
const vaultItem = Obj({
  why,
  item: optional(Str({ min: 1 })),
  feeds: optional(names),
  required: optional(names),
  optional: optional(names),
});
const scalarOrList = Union(Str(), Int(), Bool(), Arr(Str()));
export const openMap = Obj({}, Union(Str(), Int(), Bool(), Arr(Str()), Obj({}, scalarOrList)));
const hosts = optional(Rec(Obj({ state: Enum("closed", "open"), why })));
const variable = optional(Str({ regex: "^[A-Z][A-Z0-9_]*$" }));
// A declared live command never gets the host's own credentials (the ship queue's, an agent's, the override).
const declaredVariable = optional(
  Str({
    regex:
      "^(?!(?:GH_|GITHUB_|SSH_|DOPPLER_|OP_|ANTHROPIC_|OPENAI_|GEMINI_|GOOGLE_|CLAUDE_|HOST_GUARD_|SHIP_QUEUE_))[A-Z][A-Z0-9_]*$",
  }),
);

const hetznerServer = Obj({
  why,
  location: optional(Str()),
  serverType: optional(Str()),
  privateIp: optional(Str()),
  publicIp: optional(Str()),
  retiring: optional(Str()),
  status: optional(Str({ min: 1 })),
  openDecision: optional(name),
  role: optional(Str()),
  region: optional(Str()),
  memoryMb: optional(Int(1)),
  replicationSlot: optional(Str()),
  egressPorts: optional(Arr(Int(1))),
  composeDir: optional(Str()),
  composeProjects: optional(names),
  remoteDir: optional(Str()),
  sshHostVariable: optional(Str()),
  sshSourceVariable: optional(Str()),
  sshUser: optional(Str({ min: 1 })),
  files: optional(Rec(Str({ min: 1 }), "^/", "remote path must be absolute (start with /)")),
  monitoring: optional(openMap),
});

const cloudflarePage = Obj({
  why,
  env: optional(Obj({}, Str())),
  bindings: optional(
    Rec(
      Obj({
        kind: Str({ min: 1 }),
        namespace: optional(Str()),
        id: optional(Str()),
        why: optional(why),
      }),
    ),
  ),
});

export const PROVIDER_SHAPES: Readonly<Record<string, SchemaNode>> = {
  fly: Obj({
    kind: Str(),
    why,
    apps: Rec(flyApp),
    unmanaged: optional(names),
    platformHostnames: hosts,
  }),
  hetzner: Obj({
    kind: Str(),
    why,
    tokenVariable: variable,
    labelSelector: optional(Str({ min: 3 })),
    unmanaged: optional(names),
    network: optional(
      Obj({ name: optional(Str()), subnet: Str({ regex: "^\\d+\\.\\d+\\.\\d+\\.\\d+/\\d+$" }) }),
    ),
    addresses,
    servers: Rec(hetznerServer),
  }),
  cloudflare: Obj({
    kind: Str(),
    why,
    account: optional(Str({ regex: "^[0-9a-f]{32}$" })),
    buckets: optional(Rec(cloudflareResource)),
    kv: optional(Rec(cloudflareResource)),
    workers: optional(Rec(cloudflareResource)),
    pages: optional(Rec(cloudflarePage)),
    zones: optional(Rec(Obj({ why, registrar: optional(Str()) }))),
    hostnames: optional(
      Rec(
        Obj({
          why,
          target: optional(name),
          type: optional(Str()),
          access: optional(Str()),
          status: optional(Str({ min: 1 })),
          openDecision: optional(name),
        }),
      ),
    ),
    platformHostnames: hosts,
    r2CustomDomains: optional(Rec(Obj({ bucket: name, why }))),
    unmanagedBuckets: optional(names),
    unmanaged: optional(names),
  }),
  compose: Obj({
    kind: Str(),
    why,
    host: optional(name),
    files: Rec(Obj({ why, environment: Enum("production", "development", "drill") })),
    addresses,
  }),
  neon: Obj({ kind: Str(), why, project: name, branches: Rec(item), tokenVariable: variable }),
  vercel: Obj({
    kind: Str(),
    why,
    team: optional(name),
    projects: Rec(item),
    tokenVariable: variable,
  }),
  upstash: Obj({
    kind: Str(),
    why,
    databases: Rec(item),
    emailVariable: variable,
    tokenVariable: variable,
  }),
  doppler: Obj({
    kind: Str(),
    why,
    project: name,
    configs: Rec(vaultItem),
    tokenVariable: variable,
  }),
  "1password": Obj({
    kind: Str(),
    why,
    vault: name,
    items: Rec(vaultItem),
    tokenVariable: variable,
  }),
  sqlite: Obj({ kind: Str(), why, files: Rec(item) }),
  planned: Obj({ kind: Str(), why }),
  declared: Obj({
    kind: Str(),
    why,
    platform: Str({ regex: "^[a-z0-9][a-z0-9.-]*$" }),
    files: optional(Rec(item)),
    resources: optional(Rec(item)),
    live: optional(Str({ min: 1 })),
    tokenVariable: declaredVariable,
  }),
};

export const PROVIDER_KINDS: ReadonlyArray<string> = Object.keys(PROVIDER_SHAPES).sort();

/** A provider block, judged by the shape of its kind. */
class ProviderNode implements SchemaNode {
  check(v: unknown, path: string, out: string[]): void {
    if (!isObject(v) || typeof v.kind !== "string") {
      out.push(`${path}: a provider is an object with a kind`);
      return;
    }
    const shape = PROVIDER_SHAPES[v.kind];
    if (shape === undefined || !Object.hasOwn(PROVIDER_SHAPES, v.kind)) {
      out.push(
        `${path}: no adapter for provider kind ${pyRepr(v.kind)} (known: ${PROVIDER_KINDS.join(", ")}); ` +
          "declare a platform with no adapter as kind 'declared' (its files, resources and live command)",
      );
      return;
    }
    shape.check(v, path, out);
  }
}

export const PROVIDER_NODE: SchemaNode = new ProviderNode();
