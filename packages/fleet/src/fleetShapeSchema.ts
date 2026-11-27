/**
 * The one fleet shape for every repo (devtools' pb_fleet_shape): apps, roles, env,
 * stores, permissions and providers, plus optional decisions, backups and vendors.
 * Repo differences are declaration data; every object is closed.
 */
import { PROVIDER_NODE, openMap } from "./fleetProviderSchemas.ts";
import {
  Arr,
  Bool,
  Enum,
  Int,
  Json,
  Nullable,
  Obj,
  optional,
  Rec,
  type SchemaNode,
  Str,
  Union,
} from "./fleetSchemaNodes.ts";

const why = Str({ min: 1 });
const name = Str({ min: 1 });
const names = Arr(name);
const ENV_KEY = "^[A-Za-z_][A-Za-z0-9_]*$";
const KEY = "^[A-Za-z0-9][A-Za-z0-9_.-]*$";
const scalar = Union(Str(), Int(), Bool());

// A secret's rotation story: who issues it, why, how it is retired, where it lives.
const rotation = Obj({
  vendor: optional(Str({ min: 1 })),
  reason: optional(Str({ min: 10 })),
  retirement: optional(Str({ min: 10 })),
  vault: optional(Str({ min: 1 })),
  origin: optional(Str({ min: 1 })),
  probes: optional(Arr(Obj({}, Union(Str(), Arr(Str()))))),
  alsoLivesAt: optional(names),
  retireWith: optional(Str({ min: 1 })),
});
const status = Enum("planned", "defined", "provisioned", "integrated", "retired");
const sla = Obj({ maxSuccessAgeSeconds: Int(1), why });
// A drill is a file node runs, or a `.sh` file bash runs.
const drill = Str({ regex: "^.+\\.(mjs|cjs|js|sh)$" });
const release = Union(
  Obj({ store: optional(drill), ota: optional(Arr(drill, 1)) }),
  Obj({ none: Str({ min: 10 }) }),
);
const mobile = Obj({
  appId: Str({ min: 1 }),
  buildProfiles: names,
  iosAscAppId: optional(Str()),
  android: optional(Str()),
  firebaseAndroidAppId: optional(Str()),
  googleAndroidClientId: optional(Str()),
  signInWithApple: optional(Str()),
  release: optional(release),
});
const paths = Obj({
  deployment: optional(names),
  config: optional(names),
  ota: optional(names),
  native: optional(names),
});

export const APP_SCHEMA = Obj({
  why,
  provider: name,
  root: optional(Str()),
  roles: optional(names),
  status: optional(status),
  openDecision: optional(name),
  runsOn: optional(name),
  composeFiles: optional(names),
  image: optional(Str({ min: 1 })),
  dockerfile: optional(Str({ min: 1 })),
  containers: optional(names),
  identities: optional(names),
  vendor: optional(Str()),
  monitoring: optional(openMap),
  mobile: optional(mobile),
  paths: optional(paths),
  environment: optional(Str({ min: 1 })),
  secretsFrom: optional(Str({ min: 1 })),
  label: optional(Str({ min: 1 })),
});

export const ROLE_SCHEMA = Obj({
  why,
  reads: names,
  app: optional(name),
  server: optional(name),
  entry: optional(Str({ min: 1 })),
  module: optional(Str({ min: 1 })),
  source: optional(Str({ min: 1 })),
  index: optional(Int(0)),
  scheduled: optional(Union(Bool(), Str())),
  lease: optional(Bool()),
  jobRun: optional(Bool()),
  intervalMs: optional(Int(1)),
  intervalName: optional(Str({ regex: "^[A-Za-z_][A-Za-z0-9_]*$" })),
  sla: optional(sla),
  credentials: optional(names),
  runsAs: optional(Str({ min: 1 })),
});

export const ENV_SCHEMA = Obj({
  why,
  apps: names,
  secret: optional(Bool()),
  tooling: optional(Bool()),
  vault: optional(Str()),
  placement: optional(Str({ min: 1 })),
  mayBeUnset: optional(Str({ min: 1 })),
  rotation: optional(rotation),
  vaultItem: optional(Str({ min: 1 })),
  group: optional(Str({ min: 1 })),
  generatedFrom: optional(Str({ min: 1 })),
  description: optional(Str()),
  production: optional(Enum("set", "optional", "defaulted", "unset")),
  default: optional(scalar),
  example: optional(Str()),
  fixture: optional(scalar),
  fixtureOptional: optional(Union(Bool(), Str({ min: 1 }))),
  fixtureOverride: optional(scalar),
  operatorInput: optional(Bool()),
  compose: optional(Union(Str(), Obj({}, Str()))),
  composeNote: optional(Str()),
  matters: optional(Str()),
  tags: optional(names),
  // A name no code reads any more but a store still holds: what removes it.
  retired: optional(Str({ min: 1 })),
});

export const STORE_SCHEMA = Obj({
  why,
  provider: name,
  kind: Str({ min: 1 }),
  reads: optional(names),
  access: optional(Str()),
  service: optional(name),
  backup: optional(name),
  environments: optional(
    Rec(
      Obj({
        tier: Str({ min: 1 }),
        branch: optional(Str()),
        ha: optional(Bool()),
        autosuspend_seconds: optional(Int(0)),
        key_prefix: optional(Str()),
        reads: optional(names),
      }),
    ),
  ),
});

const PERMISSION_SCHEMA = Obj({
  why,
  grants: Arr(name, 1),
  holders: optional(Arr(name, 1)),
  provider: optional(name),
  identities: optional(openMap),
  policies: optional(Arr(Json())),
  detail: optional(Obj({}, Json())),
});

const BACKUP_SCHEMA = Obj({
  why,
  kind: Str({ min: 1 }),
  covers: name,
  schedule: optional(Str({ min: 1 })),
  status: optional(status),
  script: optional(Str({ min: 1 })),
  drill: optional(Str({ min: 1 })),
  rebuild: optional(Str({ min: 1 })),
  rpoMinutes: optional(Nullable(Int(0))),
  rtoMinutes: optional(Nullable(Int(0))),
  target: optional(Str()),
  retention: optional(Str()),
  openDecision: optional(name),
});

export const FLEET_SHAPE_SCHEMA: SchemaNode = Obj({
  $schema: optional(Str()),
  why: Arr(why, 1),
  apps: Rec(APP_SCHEMA, KEY),
  roles: Rec(ROLE_SCHEMA, KEY),
  env: Rec(ENV_SCHEMA, ENV_KEY),
  stores: Rec(STORE_SCHEMA, KEY),
  permissions: Rec(PERMISSION_SCHEMA, KEY),
  providers: Rec(PROVIDER_NODE, KEY),
  // Facts every repo may declare; an absent section is an empty one.
  decisions: optional(
    Rec(
      Obj({
        why,
        question: Str({ min: 1 }),
        refs: optional(names),
        decided: optional(Str()),
        outcome: optional(Str()),
      }),
      KEY,
    ),
  ),
  backups: optional(Rec(BACKUP_SCHEMA, KEY)),
  vendors: optional(
    Rec(Obj({ why, status, credentials: names, openDecision: optional(name) }), KEY),
  ),
  codeRoots: optional(Rec(Obj({ why, roots: Arr(Str({ min: 1 }), 1) }), KEY)),
  tooling: optional(Rec(Obj({ why, script: Str({ min: 1 }) }), KEY)),
  retiredRoleIndexes: optional(Obj({}, Str({ min: 1 }))),
  // Config rules and who reads them: `every` app, one app, or one role.
  configRules: optional(
    Rec(Obj({ reader: Str({ min: 1 }), role: optional(name), reads: names }), KEY),
  ),
  // The repo's own vocabulary, documented once.
  legends: optional(Obj({}, Obj({}, Str({ min: 1 })))),
  conventions: optional(
    Obj({
      jobRun: optional(Arr(Str({ min: 1 }))),
      lease: optional(Arr(Str({ min: 1 }))),
      opsFiles: optional(Str({ min: 1 })),
      registry: optional(Str({ min: 1 })),
      metricsFiles: optional(Str({ min: 1 })),
      metricsInstance: optional(Str({ min: 1 })),
      workerRolesVariable: optional(Str({ regex: "^[A-Z][A-Z0-9_]*$" })),
    }),
  ),
});

/** The sections a file must have to be in the one fleet schema. */
export const ONE_SCHEMA_SECTIONS = [
  "apps",
  "roles",
  "env",
  "stores",
  "permissions",
  "providers",
] as const;
